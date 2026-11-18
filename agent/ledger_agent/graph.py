"""The assistant's graph: fixed steps, not a free-roaming agent.

    classify -> fetch (ledger tools, at most 4 calls) -> retrieve (policies) -> answer -> verify
              \\-> refuse                                                          |      ^   |
                                                                                   +------+   +-> fallback
A LangGraph StateGraph with hard-wired edges. The model decides which tools
to call and what to write; it never decides which step comes next, how many
times to try, or whether its answer is good enough (verify.py decides that).
"""

import json
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime
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
from pydantic import BaseModel, ConfigDict, Field

from .dates import period_bounds
from .db import ClientContext, client_scope
from .llm import UpstreamModelError
from .prompts import (
    ANSWER_INSTRUCTIONS,
    CLASSIFY_INSTRUCTIONS,
    FALLBACK_TEXT,
    REFUSAL_TEXT,
    feedback_block,
    system_prompt,
    wrap_policy,
    wrap_tool_result,
)
from .rag import RetrievedChunk, query_text, search
from .tools import LedgerTools, NotFoundError
from .verify import Answer, Citation, Fetched, ToolCallRecord, verify

Category = Literal["account", "policy", "both", "out_of_scope"]
MAX_TOOL_CALLS = 4
MAX_ATTEMPTS = 2


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


class TransactionArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")
    transaction_id: UUID = Field(description="A transaction id from list_transactions")


@dataclass
class Usage:
    prompt_tokens: int = 0
    completion_tokens: int = 0
    chat_calls: int = 0
    embed_calls: int = 0

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


@dataclass(frozen=True)
class Deps:
    chat: BaseChatModel
    embeddings: Embeddings
    ledger: LedgerTools
    pool: ConnectionPool[psycopg.Connection[DictRow]]
    ctx: ClientContext
    now: datetime
    max_tool_calls: int = MAX_TOOL_CALLS


class State(TypedDict, total=False):
    question: str
    category: Category
    transcript: list[BaseMessage]
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


def make_tools(ledger: LedgerTools, ctx: ClientContext, fetched: Fetched, now: datetime) -> list[BaseTool]:
    """LangChain tools whose only arguments are the ones in the schemas above.

    `ctx` is captured here, server-side. It is not a parameter, not in any
    schema the model sees, and cannot be supplied by a tool call.
    """

    def dump(payload: BaseModel) -> str:
        fetched.absorb(payload)
        return payload.model_dump_json(indent=1)

    def list_my_accounts() -> str:
        accounts = ledger.list_accounts(ctx)
        for a in accounts:
            fetched.absorb(a)
        return json.dumps([json.loads(a.model_dump_json()) for a in accounts], indent=1)

    def get_balance(account_id: UUID) -> str:
        return dump(ledger.get_balance(ctx, account_id))

    def list_transactions(account_id: UUID, from_date: str | None = None, to_date: str | None = None) -> str:
        start, end = period_bounds(from_date, to_date, now)
        return dump(ledger.list_transactions(ctx, account_id, start, end))

    def explain_transaction(transaction_id: UUID) -> str:
        return dump(ledger.explain_transaction(ctx, transaction_id))

    return [
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
            func=explain_transaction,
            name="explain_transaction",
            description=(
                "Every leg of one transaction the caller took part in, and its top-up status if it is a top-up."
            ),
            args_schema=TransactionArgs,
        ),
    ]


def _invoke_model(call: Callable[[], Any]) -> Any:
    """Any failure talking to the model provider is one kind of error to the rest of the service."""
    try:
        return call()
    except UpstreamModelError:
        raise
    except Exception as e:
        raise UpstreamModelError(f"{type(e).__name__}: {e}") from e


def _structured(deps: Deps, run: RunContext, schema: type[BaseModel], messages: list[BaseMessage]) -> BaseModel:
    runnable = deps.chat.with_structured_output(schema, include_raw=True)
    result = cast(dict[str, Any], _invoke_model(lambda: runnable.invoke(messages)))
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


def build_graph(deps: Deps, run: RunContext) -> Any:
    system = SystemMessage(system_prompt(deps.now))

    def classify(state: State) -> State:
        parsed = _structured(
            deps, run, Classification, [system, HumanMessage(f"{CLASSIFY_INSTRUCTIONS}\nQuestion: {state['question']}")]
        )
        return {"category": cast(Classification, parsed).category}

    def fetch(state: State) -> State:
        tools = make_tools(deps.ledger, deps.ctx, run.fetched, deps.now)
        by_name = {t.name: t for t in tools}
        bound = deps.chat.bind_tools(tools)
        messages: list[BaseMessage] = [system, HumanMessage(state["question"])]
        calls = 0
        for _round in range(deps.max_tool_calls):
            ai = cast(AIMessage, _invoke_model(lambda: bound.invoke(messages)))
            run.usage.add(ai)
            messages.append(ai)
            if not ai.tool_calls:
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
                    content = _run_tool(by_name[name], args, run.fetched)
                messages.append(ToolMessage(content=wrap_tool_result(name, content), tool_call_id=call_id))
            if calls >= deps.max_tool_calls:
                break
        return {"transcript": messages[2:]}

    # Traced as their own spans (no-ops when tracing is off), so a trace shows
    # where retrieval time goes: the embedding API call vs the vector search.
    @traceable(run_type="embedding", name="embed_question")
    def embed_question(question: str) -> list[float]:
        run.usage.embed_calls += 1
        return cast(list[float], _invoke_model(lambda: deps.embeddings.embed_query(query_text(question))))

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
        for message in state.get("transcript") or []:
            if isinstance(message, ToolMessage):
                parts.append(str(message.content))
        for chunk in state.get("retrieved") or []:
            parts.append(wrap_policy(chunk.id, chunk.source_file, chunk.heading, chunk.content))
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
        if (state.get("attempts") or 0) >= MAX_ATTEMPTS:
            return {"failures": failures, "final_answer": FALLBACK_TEXT, "final_citations": [], "verified": False}
        return {"failures": failures}

    def refuse(_state: State) -> State:
        return {"final_answer": REFUSAL_TEXT, "final_citations": [], "verified": True, "attempts": 0}

    def after_classify(state: State) -> str:
        return {"account": "fetch", "both": "fetch", "policy": "retrieve", "out_of_scope": "refuse"}[state["category"]]

    def after_fetch(state: State) -> str:
        return "retrieve" if state["category"] == "both" else "answer"

    def after_check(state: State) -> str:
        return END if "final_answer" in state else "answer"

    graph = StateGraph(State)
    node = cast(Callable[[Callable[[State], State]], Any], lambda fn: fn)  # LangGraph's node overloads defeat mypy
    graph.add_node("classify", node(classify))
    graph.add_node("fetch", node(fetch))
    graph.add_node("retrieve", node(retrieve))
    graph.add_node("answer", node(answer))
    graph.add_node("check", node(check))
    graph.add_node("refuse", node(refuse))
    graph.add_edge(START, "classify")
    graph.add_conditional_edges(
        "classify", after_classify, {"fetch": "fetch", "retrieve": "retrieve", "refuse": "refuse"}
    )
    graph.add_conditional_edges("fetch", after_fetch, {"retrieve": "retrieve", "answer": "answer"})
    graph.add_edge("retrieve", "answer")
    graph.add_edge("answer", "check")
    graph.add_conditional_edges("check", after_check, {END: END, "answer": "answer"})
    graph.add_edge("refuse", END)
    return graph.compile()


def run_question(deps: Deps, question: str, config: RunnableConfig | None = None) -> Outcome:
    """config: run name, tags and metadata for the trace (the eval tags each item); never affects behaviour."""
    run = RunContext()
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
