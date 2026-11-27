"""The assistant's graph: fixed steps, not a free-roaming agent.

    route: a plain "what did I spend <period>?" -> spending (code) -> write (template) -> check; no model (fast.py)
    otherwise:
    classify -> fetch (ledger tools, at most 4 calls) -> retrieve (policies) -> answer -> verify
              \\-> refuse                                                          |      ^   |
                                                                                   +------+   +-> fallback
A LangGraph StateGraph with hard-wired edges. The model decides which tools
to call and what to write; it never decides which step comes next, how many
times to try, or whether its answer is good enough (verify.py decides that).
"""

import json
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any, Literal, TypedDict, cast
from uuid import UUID

import psycopg
from langchain_core.embeddings import Embeddings
from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_core.runnables import RunnableConfig
from langchain_core.tools import BaseTool, StructuredTool
from langgraph.graph import END, START, StateGraph
from langsmith import traceable
from psycopg.rows import DictRow
from psycopg_pool import ConnectionPool
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .dates import (
    NAMED_PERIODS,
    NamedPeriod,
    ist_midnight,
    named_period,
    parse_ist_date,
    period_bounds,
    period_named_in,
    period_text,
    today_ist,
)
from .db import ClientContext, client_scope
from .fast import spending_answer, spending_question
from .llm import UpstreamModelError, is_quota_error
from .notes import asks_about_notes
from .prompts import (
    ANSWER_INSTRUCTIONS,
    FALLBACK_TEXT,
    REFUSAL_TEXT,
    classify_instructions,
    feedback_block,
    new_boundary,
    system_prompt,
    wrap_policy,
    wrap_tool_result,
)
from .rag import RetrievedChunk, query_text, search
from .tools import DEFAULT_LIMIT, LedgerTools, NotFoundError, Spending
from .verify import Answer, Citation, Fetched, ToolCallRecord, is_final, verify, with_rupees

Category = Literal["account", "policy", "both", "out_of_scope"]

# Step 7c improvements, each switchable so its effect can be measured (eval/):
PREFETCH = "prefetch"  # the client's accounts (and totals per currency) fetched by code, not by a model round
ANSWER_TOOL = "answer_tool"  # the model submits its answer as a tool call: no 'done with tools' round, no answer call
COMPACT = "compact"  # tool output without indentation or empty fields, at most 20 transactions
TOPUPS = "topups"  # list_my_topups across all accounts, 'cover every item in the period', state every amount
CLASSIFY = "classify"  # two hints for the classifier: transfers naming the other party; 'can I ...?' is both
FEATURES = (PREFETCH, ANSWER_TOOL, COMPACT, TOPUPS, CLASSIFY)
MAX_TOOL_CALLS = 4
MAX_ATTEMPTS = 2

# Told when each step starts (seconds=None) and ends (its seconds), for live progress (POST /ask/stream).
Progress = Callable[[str, float | None], None]


class Classification(BaseModel):
    model_config = ConfigDict(frozen=True)

    category: Category
    reason: str = ""


# ───────────── tool argument schemas: what the MODEL may fill in (no client anywhere) ─────────────


class NoArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")


class AccountArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")
    account_id: UUID = Field(description="The account, from list_my_accounts")


class PeriodArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")
    account_id: UUID = Field(description="The account, from list_my_accounts")
    from_date: str | None = Field(
        default=None, description="First day, YYYY-MM-DD (IST), inclusive. Default: 30 days ago"
    )
    to_date: str | None = Field(default=None, description="Last day, YYYY-MM-DD (IST), inclusive. Default: today")


class TopupPeriodArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")
    from_date: str | None = Field(
        default=None, description="First day, YYYY-MM-DD (IST), inclusive. Default: 30 days ago"
    )
    to_date: str | None = Field(default=None, description="Last day, YYYY-MM-DD (IST), inclusive. Default: today")


class SpendingArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")
    period: Literal["yesterday", "this_week", "last_week", "last_7_days", "dates"] = Field(
        description=(
            "yesterday; this_week (Monday to today); last_week (the previous Monday to Sunday); last_7_days "
            "(today and the 6 days before); or dates, with from_date and to_date, for any other range"
        )
    )
    from_date: str | None = Field(default=None, description="Only with period=dates: first day, YYYY-MM-DD (IST)")
    to_date: str | None = Field(default=None, description="Only with period=dates: last day, YYYY-MM-DD (IST)")


class TransactionArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")
    transaction_id: UUID = Field(description="A transaction id from list_transactions")


@dataclass
class Usage:
    prompt_tokens: int = 0
    completion_tokens: int = 0
    chat_calls: int = 0
    embed_calls: int = 0
    tool_calls: int = 0
    model_seconds: float = 0.0  # waiting for the model API (chat and embeddings)
    tool_seconds: float = 0.0  # running ledger tools (SQL)
    step_seconds: dict[str, float] = field(default_factory=dict)  # wall time per graph step, summed over repeats

    def add(self, message: Any) -> None:
        """One chat-model response: one call, and its tokens."""
        self.chat_calls += 1
        meta = getattr(message, "usage_metadata", None) or {}
        self.prompt_tokens += int(meta.get("input_tokens", 0) or 0)
        self.completion_tokens += int(meta.get("output_tokens", 0) or 0)


@dataclass
class RunContext:
    """Per-question scratch space the nodes share outside the graph state: what tools fetched, tokens used."""

    fetched: Fetched = field(default_factory=Fetched)
    usage: Usage = field(default_factory=Usage)
    boundary: str = field(default_factory=new_boundary)  # this request's data-block tag (prompts.new_boundary)


@dataclass(frozen=True)
class Deps:
    chat: BaseChatModel
    embeddings: Embeddings
    ledger: LedgerTools
    pool: ConnectionPool[psycopg.Connection[DictRow]]
    ctx: ClientContext
    now: datetime
    max_tool_calls: int = MAX_TOOL_CALLS
    features: frozenset[str] = frozenset()
    progress: Progress | None = None


class State(TypedDict, total=False):
    question: str
    category: Category
    transcript: list[BaseMessage]
    context: list[str]  # data blocks the server added itself (prefetched accounts)
    retrieved: list[RetrievedChunk]
    draft: Answer | None
    failures: list[list[str]]
    attempts: int
    final_answer: str
    final_citations: list[Citation]
    verified: bool


@dataclass(frozen=True)
class Outcome:
    answer: str
    citations: list[Citation]
    verified: bool
    category: Category
    attempts: int
    failures: list[list[str]]
    retrieved_ids: list[int]
    tools_called: list[ToolCallRecord]
    usage: Usage


# ───────────── tools over LedgerTools, closed over the request's ClientContext ─────────────


def spending_report(ledger: LedgerTools, ctx: ClientContext, period: NamedPeriod, now: datetime) -> Spending:
    """A named period's spending: code resolves the dates (dates.named_period) and the range text."""
    start, end = named_period(period, today_ist(now))
    return ledger.spending(
        ctx, period, start, end, period_text(start, end), ist_midnight(start), ist_midnight(end) + timedelta(days=1)
    )


def make_tools(
    ledger: LedgerTools,
    ctx: ClientContext,
    fetched: Fetched,
    now: datetime,
    compact: bool = False,
    topups: bool = False,
    include_notes: bool = False,
    asked_period: NamedPeriod | None = None,
) -> list[BaseTool]:
    """LangChain tools whose only arguments are the ones in the schemas above.

    `ctx` is captured here, server-side. It is not a parameter, not in any
    schema the model sees, and cannot be supplied by a tool call.
    """

    indent = None if compact else 1

    def as_json(data: Any) -> str:
        # Every *_paise amount also as code-written rupees (*_inr), for the model to copy.
        return json.dumps(with_rupees(data), indent=indent, ensure_ascii=False)

    def dump(payload: BaseModel) -> str:
        fetched.absorb(payload)
        return as_json(payload.model_dump(mode="json", exclude_none=compact))

    def list_my_accounts() -> str:
        accounts = ledger.list_accounts(ctx)
        for a in accounts:
            fetched.absorb(a)
        return as_json([a.model_dump(mode="json") for a in accounts])

    def spending(period: str, from_date: str | None = None, to_date: str | None = None) -> str:
        # The question's own words decide the period when they name one: the model cannot pick another.
        if asked_period is not None and period != asked_period:
            raise ValueError(
                f"the question asks about {asked_period.replace('_', ' ')}: call spending with period={asked_period}"
            )
        if period in NAMED_PERIODS:
            return dump(spending_report(ledger, ctx, period, now))
        if not (from_date and to_date):
            raise ValueError("period=dates needs from_date and to_date (YYYY-MM-DD)")
        start, end = parse_ist_date(from_date), parse_ist_date(to_date)
        if start > end:
            raise ValueError(f"from_date {start} is after to_date {end}")
        report = ledger.spending(
            ctx, period, start, end, period_text(start, end), ist_midnight(start), ist_midnight(end) + timedelta(days=1)
        )
        return dump(report)

    def get_balance(account_id: UUID) -> str:
        return dump(ledger.get_balance(ctx, account_id))

    def list_transactions(account_id: UUID, from_date: str | None = None, to_date: str | None = None) -> str:
        start, end = period_bounds(from_date, to_date, now)
        limit = 20 if compact else DEFAULT_LIMIT
        return dump(ledger.list_transactions(ctx, account_id, start, end, limit=limit, include_notes=include_notes))

    def list_my_topups(from_date: str | None = None, to_date: str | None = None) -> str:
        start, end = period_bounds(from_date, to_date, now)
        items = ledger.list_topups(ctx, start, end)
        for t in items:
            fetched.absorb(t)
        return as_json([t.model_dump(mode="json") for t in items])

    def explain_transaction(transaction_id: UUID) -> str:
        return dump(ledger.explain_transaction(ctx, transaction_id, include_notes=include_notes))

    tools: list[BaseTool] = [
        StructuredTool.from_function(
            func=list_my_accounts,
            name="list_my_accounts",
            description="The caller's own accounts with their current balances. Call this first to get account ids.",
            args_schema=NoArgs,
        ),
        StructuredTool.from_function(
            func=get_balance,
            name="get_balance",
            description="The current balance of one of the caller's accounts.",
            args_schema=AccountArgs,
        ),
        StructuredTool.from_function(
            func=list_transactions,
            name="list_transactions",
            description=(
                "Movements on one of the caller's accounts in a period (IST calendar dates), newest first, with the "
                "period's opening balance, closing balance, total in, total out and net change, all in paise."
            ),
            args_schema=PeriodArgs,
        ),
        StructuredTool.from_function(
            func=spending,
            name="spending",
            description=(
                "How much the caller spent in a period, over all their accounts: payments to other people only "
                "(moving money between their own accounts and top-ups are not spending). Code resolves the "
                "period and returns period_text, the date range to state with the total."
            ),
            args_schema=SpendingArgs,
        ),
        StructuredTool.from_function(
            func=explain_transaction,
            name="explain_transaction",
            description=(
                "Every leg of one transaction the caller took part in, and its top-up status if it is a top-up."
            ),
            args_schema=TransactionArgs,
        ),
    ]
    if topups:
        tools.append(
            StructuredTool.from_function(
                func=list_my_topups,
                name="list_my_topups",
                description=(
                    "Every top-up onto any of the caller's accounts in a period (IST calendar dates), newest first, "
                    "with its status: posted (credited), pending (waiting for the provider) or failed (never credited)."
                ),
                args_schema=TopupPeriodArgs,
            )
        )
    return tools


def _invoke_model(call: Callable[[], Any]) -> Any:
    """Any failure talking to the model provider is one kind of error to the rest of the service."""
    try:
        return call()
    except UpstreamModelError:
        raise
    except Exception as e:
        raise UpstreamModelError(f"{type(e).__name__}: {e}", quota=is_quota_error(e)) from e


@contextmanager
def _step(run: RunContext, progress: Progress | None, name: str) -> Iterator[None]:
    """Wall time of one step (model + tools + our code), summed when a step repeats; reported as it happens."""
    if progress is not None:
        progress(name, None)
    started = time.perf_counter()
    try:
        yield
    finally:
        seconds = time.perf_counter() - started
        run.usage.step_seconds[name] = run.usage.step_seconds.get(name, 0.0) + seconds
    if progress is not None:
        progress(name, seconds)  # only when the step succeeded


def _timed_model(run: RunContext, call: Callable[[], Any]) -> Any:
    started = time.perf_counter()
    try:
        return _invoke_model(call)
    finally:
        run.usage.model_seconds += time.perf_counter() - started


def _structured(deps: Deps, run: RunContext, schema: type[BaseModel], messages: list[BaseMessage]) -> BaseModel:
    runnable = deps.chat.with_structured_output(schema, include_raw=True)
    result = cast(dict[str, Any], _timed_model(run, lambda: runnable.invoke(messages)))
    run.usage.add(result.get("raw"))
    parsed = result.get("parsed")
    if not isinstance(parsed, schema):
        raise UpstreamModelError(f"the model returned no valid {schema.__name__}: {result.get('parsing_error')}")
    return parsed


def _run_tool(tool: BaseTool, args: dict[str, Any], fetched: Fetched) -> str:
    """Run one tool call the model asked for. Unknown arguments are refused, not ignored."""
    schema = tool.args_schema
    allowed = set(schema.model_fields) if isinstance(schema, type) and issubclass(schema, BaseModel) else set()
    unknown = sorted(set(args) - allowed)
    if unknown:
        fetched.calls.append(ToolCallRecord(name=tool.name, args=args, ok=False))
        return json.dumps({"error": f"unknown argument(s): {', '.join(unknown)}"})
    try:
        result = tool.invoke(args)
    except (NotFoundError, ValueError) as e:
        fetched.calls.append(ToolCallRecord(name=tool.name, args=args, ok=False))
        return json.dumps({"error": str(e)})
    fetched.calls.append(ToolCallRecord(name=tool.name, args=args, ok=True))
    return str(result)


# ───────────── the graph ─────────────


SUBMIT_ANSWER = "submit_answer"


def _submit_answer_tool() -> BaseTool:
    """The model hands over its final answer as a tool call (feature answer_tool). Never executed: intercepted."""

    def submit_answer(answer: str, citations: list[Citation] | None = None) -> str:  # pragma: no cover
        return "received"

    return StructuredTool.from_function(
        func=submit_answer,
        name=SUBMIT_ANSWER,
        description=(
            "Submit your final answer to the caller, with citations: the transaction ids and policy chunk ids "
            "you relied on. Call this once you have the data; do not reply with plain text."
        ),
        args_schema=Answer,
    )


def _prefetch_accounts(deps: Deps, run: RunContext, compact: bool) -> str:
    """The client's accounts and, per currency, the total: fetched by code, so no model round is spent on it."""
    accounts = deps.ledger.list_accounts(deps.ctx)
    totals: dict[str, int] = {}
    for a in accounts:
        totals[a.currency] = totals.get(a.currency, 0) + a.balance_paise
    payload = {
        "accounts": [json.loads(a.model_dump_json()) for a in accounts],
        "totals": [{"currency": c, "total_balance_paise": t} for c, t in sorted(totals.items())],
    }
    run.fetched.absorb(payload)
    run.fetched.calls.append(ToolCallRecord(name="list_my_accounts", args={"prefetched": True}, ok=True))
    return wrap_tool_result(run.boundary, "list_my_accounts", json.dumps(payload, indent=None if compact else 1))


def build_graph(deps: Deps, run: RunContext) -> Any:
    features = deps.features
    answer_tool = ANSWER_TOOL in features
    compact = COMPACT in features
    system = SystemMessage(system_prompt(deps.now, run.boundary, features))

    def classify(state: State) -> State:
        parsed = _structured(
            deps,
            run,
            Classification,
            [system, HumanMessage(f"{classify_instructions(features)}\nQuestion: {state['question']}")],
        )
        return {"category": cast(Classification, parsed).category}

    def fetch(state: State) -> State:
        tools = make_tools(
            deps.ledger,
            deps.ctx,
            run.fetched,
            deps.now,
            compact=compact,
            topups=TOPUPS in features,
            include_notes=asks_about_notes(state["question"]),
            asked_period=period_named_in(state["question"]),
        )
        by_name = {t.name: t for t in tools}
        bound = deps.chat.bind_tools([*tools, _submit_answer_tool()] if answer_tool else tools)
        context = [_prefetch_accounts(deps, run, compact)] if PREFETCH in features else []
        first: list[str] = [*context]
        if answer_tool and state.get("retrieved"):
            # 'both' with answer_tool: the policies were retrieved first, so the answer can be submitted here.
            first += [
                wrap_policy(run.boundary, c.id, c.source_file, c.heading, c.content)
                for c in state.get("retrieved") or []
            ]
        first.append(state["question"])
        messages: list[BaseMessage] = [system, HumanMessage("\n\n".join(first))]
        calls = 0
        draft: Answer | None = None
        # With answer_tool, one extra round: the model may need it to submit after its last tool.
        for _round in range(deps.max_tool_calls + (1 if answer_tool else 0)):
            ai = cast(AIMessage, _timed_model(run, lambda: bound.invoke(messages)))
            run.usage.add(ai)
            messages.append(ai)
            if not ai.tool_calls:
                break
            submitted = [tc for tc in ai.tool_calls if tc["name"] == SUBMIT_ANSWER]
            if answer_tool and submitted:
                try:
                    draft = Answer.model_validate(submitted[0]["args"])
                except ValidationError:
                    draft = None  # malformed: the answer step will write it instead
                break
            for tc in ai.tool_calls:
                name = tc["name"]
                args, call_id = dict(tc["args"] or {}), tc.get("id") or name
                if calls >= deps.max_tool_calls:
                    content = json.dumps({"error": "tool call budget exhausted"})
                elif name not in by_name:
                    content = json.dumps({"error": f"unknown tool {name}"})
                    run.fetched.calls.append(ToolCallRecord(name=name, args=args, ok=False))
                else:
                    calls += 1
                    started = time.perf_counter()
                    content = _run_tool(by_name[name], args, run.fetched)
                    run.usage.tool_seconds += time.perf_counter() - started
                    run.usage.tool_calls += 1
                block = wrap_tool_result(run.boundary, name, content)
                messages.append(ToolMessage(content=block, tool_call_id=call_id))
            if calls >= deps.max_tool_calls and not answer_tool:
                break
        out: State = {"transcript": messages[2:], "context": context}
        if draft is not None:
            out["draft"] = draft
            out["attempts"] = (state.get("attempts") or 0) + 1
        return out

    # Traced as their own spans (no-ops when tracing is off), so a trace shows
    # where retrieval time goes: the embedding API call vs the vector search.
    @traceable(run_type="embedding", name="embed_question")
    def embed_question(question: str) -> list[float]:
        run.usage.embed_calls += 1
        return cast(list[float], _timed_model(run, lambda: deps.embeddings.embed_query(query_text(question))))

    @traceable(run_type="retriever", name="policy_search")
    def policy_search(vector: list[float]) -> list[RetrievedChunk]:
        with client_scope(deps.pool, deps.ctx) as conn:
            return search(conn, vector)

    def retrieve(state: State) -> State:
        return {"retrieved": policy_search(embed_question(state["question"]))}

    def answer(state: State) -> State:
        parts: list[str] = [ANSWER_INSTRUCTIONS]
        failures = state.get("failures") or []
        if failures:
            parts.append(feedback_block(failures[-1]))
        parts += state.get("context") or []
        for message in state.get("transcript") or []:
            if isinstance(message, ToolMessage):
                parts.append(str(message.content))
        for chunk in state.get("retrieved") or []:
            parts.append(wrap_policy(run.boundary, chunk.id, chunk.source_file, chunk.heading, chunk.content))
        parts.append(f"Question: {state['question']}")
        draft = cast(Answer, _structured(deps, run, Answer, [system, HumanMessage("\n\n".join(parts))]))
        return {"draft": draft, "attempts": (state.get("attempts") or 0) + 1}

    def check(state: State) -> State:
        draft = state.get("draft")
        assert draft is not None
        retrieved = state.get("retrieved") or []
        problems = verify(draft, run.fetched, {c.id for c in retrieved}, "\n".join(c.content for c in retrieved))
        if not problems:
            return {"final_answer": draft.answer, "final_citations": list(draft.citations), "verified": True}
        failures = [*(state.get("failures") or []), problems]
        if (state.get("attempts") or 0) >= MAX_ATTEMPTS or any(is_final(p) for p in problems):
            return {"failures": failures, "final_answer": FALLBACK_TEXT, "final_citations": [], "verified": False}
        return {"failures": failures}

    def refuse(_state: State) -> State:
        return {"final_answer": REFUSAL_TEXT, "final_citations": [], "verified": True, "attempts": 0}

    def after_classify(state: State) -> str:
        # With answer_tool, 'both' retrieves first so fetch can submit the answer with the policies in view.
        both = "retrieve" if answer_tool else "fetch"
        return {"account": "fetch", "both": both, "policy": "retrieve", "out_of_scope": "refuse"}[state["category"]]

    def after_retrieve(state: State) -> str:
        return "fetch" if answer_tool and state["category"] == "both" else "answer"

    def after_fetch(state: State) -> str:
        if state.get("draft") is not None:
            return "check"  # submitted through submit_answer: no separate answer call
        if state["category"] == "both" and not answer_tool:
            return "retrieve"
        return "answer"

    def after_check(state: State) -> str:
        return END if "final_answer" in state else "answer"

    def timed(name: str, step: Callable[[State], State]) -> Callable[[State], State]:
        def run_step(state: State) -> State:
            with _step(run, deps.progress, name):
                return step(state)

        return run_step

    graph = StateGraph(State)
    node = cast(Callable[[Callable[[State], State]], Any], lambda fn: fn)  # LangGraph's node overloads defeat mypy
    for name, step in (
        ("classify", classify),
        ("fetch", fetch),
        ("retrieve", retrieve),
        ("answer", answer),
        ("check", check),
        ("refuse", refuse),
    ):
        graph.add_node(name, node(timed(name, step)))
    graph.add_edge(START, "classify")
    graph.add_conditional_edges(
        "classify", after_classify, {"fetch": "fetch", "retrieve": "retrieve", "refuse": "refuse"}
    )
    graph.add_conditional_edges("fetch", after_fetch, {"retrieve": "retrieve", "answer": "answer", "check": "check"})
    graph.add_conditional_edges("retrieve", after_retrieve, {"fetch": "fetch", "answer": "answer"})
    graph.add_edge("answer", "check")
    graph.add_conditional_edges("check", after_check, {END: END, "answer": "answer"})
    graph.add_edge("refuse", END)
    return graph.compile()


def _answer_spending(deps: Deps, run: RunContext, period: NamedPeriod) -> Outcome:
    """The fast path (fast.py): the spending tool, a template, the verifier. No model call."""
    with _step(run, deps.progress, "spending"):
        started = time.perf_counter()
        report = spending_report(deps.ledger, deps.ctx, period, deps.now)
        run.usage.tool_seconds += time.perf_counter() - started
        run.usage.tool_calls += 1
        run.fetched.absorb(report)
        run.fetched.calls.append(ToolCallRecord(name="spending", args={"period": period, "by": "code"}, ok=True))
    with _step(run, deps.progress, "write"):
        draft = spending_answer(report)
    with _step(run, deps.progress, "check"):
        # The same checker as every model answer: a template is code, but so was the bug it would hide.
        problems = verify(draft, run.fetched, set(), "")
    return Outcome(
        answer=FALLBACK_TEXT if problems else draft.answer,
        citations=[] if problems else list(draft.citations),
        verified=not problems,
        category="account",
        attempts=1,
        failures=[problems] if problems else [],
        retrieved_ids=[],
        tools_called=list(run.fetched.calls),
        usage=run.usage,
    )


def run_question(deps: Deps, question: str, config: RunnableConfig | None = None) -> Outcome:
    """config: run name, tags and metadata for the trace (the eval tags each item); never affects behaviour."""
    run = RunContext()
    with _step(run, deps.progress, "route"):
        period = spending_question(question)
    if period is not None:
        return _answer_spending(deps, run, period)
    initial: State = {"question": question, "attempts": 0, "failures": []}
    final = cast(State, build_graph(deps, run).invoke(initial, config=config))
    return Outcome(
        answer=final["final_answer"],
        citations=list(final.get("final_citations") or []),
        verified=bool(final.get("verified")),
        category=final["category"],
        attempts=int(final.get("attempts") or 0),
        failures=list(final.get("failures") or []),
        retrieved_ids=[c.id for c in final.get("retrieved") or []],
        tools_called=list(run.fetched.calls),
        usage=run.usage,
    )
