"""Prometheus metrics for the assistant, served on their own internal port.

Same rule as the ledger API (step 6b): /metrics is never on the public port.
The agent's HTTP port (8000) is for its one caller; the metrics port (9102)
is for Prometheus, and a NetworkPolicy keeps it that way.

Labels are low-cardinality on purpose: category and outcome are small fixed
sets, tool names are four. No client ids, questions or answers, ever.
"""

from prometheus_client import CollectorRegistry, Counter, Histogram, start_http_server

from .service import AskResult

# outcome: what the caller got
#   verified        an answer every figure of which was checked against fetched data
#   fallback        "I couldn't verify this" (verification failed twice)
#   refused         out of scope, politely declined
#   rate_limited    429: over the client's daily questions
#   upstream_failed 503: the model API failed (not counted against the client)
#   upstream_quota  503: the model API refused on a rate/quota limit (not counted either)
#   bad_request     400/422 (no X-Client-Id, empty question)
OUTCOMES = ("verified", "fallback", "refused", "rate_limited", "upstream_failed", "upstream_quota", "bad_request")
LATENCY_BUCKETS = (0.5, 1, 2, 3, 5, 8, 13, 21, 34, 55)


class AgentMetrics:
    def __init__(self, registry: CollectorRegistry | None = None) -> None:
        self.registry = registry or CollectorRegistry()
        self.questions = Counter(
            "agent_questions",
            "Questions handled, by category and outcome",
            ["category", "outcome"],
            registry=self.registry,
        )
        self.model_calls = Counter("agent_model_calls", "Model API calls, by kind", ["kind"], registry=self.registry)
        self.tokens = Counter("agent_tokens", "Model tokens, by direction", ["direction"], registry=self.registry)
        self.tool_calls = Counter(
            "agent_tool_calls", "Ledger tool calls, by tool and result", ["tool", "ok"], registry=self.registry
        )
        self.duration = Histogram(
            "agent_question_duration_seconds",
            "End-to-end time to answer a question, by category",
            ["category"],
            buckets=LATENCY_BUCKETS,
            registry=self.registry,
        )

    def answered(self, result: AskResult, refusal_text: str, fallback_text: str, seconds: float) -> None:
        if result.answer == refusal_text:
            outcome = "refused"
        elif result.answer == fallback_text:
            outcome = "fallback"
        else:
            outcome = "verified" if result.verified else "fallback"
        category = result.category or "unknown"
        self.questions.labels(category, outcome).inc()
        self.model_calls.labels("chat").inc(result.chat_calls)
        self.model_calls.labels("embedding").inc(result.embed_calls)
        self.tokens.labels("in").inc(result.prompt_tokens)
        self.tokens.labels("out").inc(result.completion_tokens)
        for tool, ok in result.tools:
            self.tool_calls.labels(tool, str(ok).lower()).inc()
        self.duration.labels(category).observe(seconds)

    def not_answered(self, outcome: str) -> None:
        self.questions.labels("none", outcome).inc()

    def serve(self, port: int) -> None:
        """A separate HTTP server (a daemon thread) that serves only this registry."""
        start_http_server(port, registry=self.registry)
