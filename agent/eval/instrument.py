"""Counting and timing what one question costs: model calls, embedding calls, tool time. And the throttle.

These wrap the real objects; the assistant does not know it is being measured.
"""

import time
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any
from uuid import UUID

from langchain_core.callbacks import BaseCallbackHandler
from langchain_core.embeddings import Embeddings
from langchain_core.outputs import LLMResult

from ledger_agent.db import ClientContext
from ledger_agent.tools import AccountInfo, Balance, LedgerTools, TransactionDetail, TransactionsReport


class Throttle:
    """At most `rpm` calls in any 60 s window: waits (never fails) before a call that would exceed it."""

    def __init__(self, rpm: int, clock: Any = time.monotonic, sleep: Any = time.sleep) -> None:
        self.rpm = rpm
        self._times: deque[float] = deque()
        self._clock = clock
        self._sleep = sleep
        self.waited_s = 0.0

    def acquire(self) -> float:
        """Returns the seconds it waited (0.0 if none), so callers can keep it out of latency."""
        now = self._clock()
        while self._times and now - self._times[0] >= 60:
            self._times.popleft()
        wait = 0.0
        if len(self._times) >= self.rpm:
            wait = 60 - (now - self._times[0]) + 0.05
            self.waited_s += wait
            self._sleep(wait)
            now = self._clock()
            while self._times and now - self._times[0] >= 60:
                self._times.popleft()
        self._times.append(now)
        return wait


@dataclass
class Meter:
    """What one question used. Reset per question."""

    chat_calls: int = 0
    embed_calls: int = 0
    model_s: float = 0.0
    embed_s: float = 0.0
    tool_s: float = 0.0
    wait_s: float = 0.0  # time spent in OUR throttle: not latency, subtracted by the runner
    _starts: dict[UUID, float] = field(default_factory=dict)

    def reset(self) -> None:
        self.chat_calls = self.embed_calls = 0
        self.model_s = self.embed_s = self.tool_s = self.wait_s = 0.0
        self._starts.clear()


class ChatMeter(BaseCallbackHandler):
    """Counts and times every chat-model call (classify, each tool round, each answer) and throttles them."""

    def __init__(self, meter: Meter, throttle: Throttle) -> None:
        self.meter = meter
        self.throttle = throttle

    def on_chat_model_start(
        self, serialized: dict[str, Any], messages: list[list[Any]], *, run_id: UUID, **kwargs: Any
    ) -> None:
        self.meter.wait_s += self.throttle.acquire()
        self.meter.chat_calls += 1
        self.meter._starts[run_id] = time.perf_counter()

    def _stop(self, run_id: UUID) -> None:
        started = self.meter._starts.pop(run_id, None)
        if started is not None:
            self.meter.model_s += time.perf_counter() - started

    def on_llm_end(self, response: LLMResult, *, run_id: UUID, **kwargs: Any) -> None:
        self._stop(run_id)

    def on_llm_error(self, error: BaseException, *, run_id: UUID, **kwargs: Any) -> None:
        self._stop(run_id)


class MeteredEmbeddings(Embeddings):
    def __init__(self, inner: Embeddings, meter: Meter, throttle: Throttle) -> None:
        self.inner, self.meter, self.throttle = inner, meter, throttle

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        return self.inner.embed_documents(texts)

    def embed_query(self, text: str) -> list[float]:
        self.meter.wait_s += self.throttle.acquire()
        self.meter.embed_calls += 1
        started = time.perf_counter()
        try:
            return self.inner.embed_query(text)
        finally:
            self.meter.embed_s += time.perf_counter() - started


class TimedLedgerTools(LedgerTools):
    """The same read-only tools, with the time spent in them added up."""

    def __init__(self, inner: LedgerTools, meter: Meter) -> None:
        self._inner, self._meter = inner, meter

    def _timed(self, fn: Any, *args: Any, **kwargs: Any) -> Any:
        started = time.perf_counter()
        try:
            return fn(*args, **kwargs)
        finally:
            self._meter.tool_s += time.perf_counter() - started

    def list_accounts(self, ctx: ClientContext) -> list[AccountInfo]:
        return self._timed(self._inner.list_accounts, ctx)  # type: ignore[no-any-return]

    def get_balance(self, ctx: ClientContext, account_id: UUID) -> Balance:
        return self._timed(self._inner.get_balance, ctx, account_id)  # type: ignore[no-any-return]

    def list_transactions(
        self,
        ctx: ClientContext,
        account_id: UUID,
        from_: datetime | None = None,
        to: datetime | None = None,
        limit: int = 50,
    ) -> TransactionsReport:
        return self._timed(self._inner.list_transactions, ctx, account_id, from_, to, limit)  # type: ignore[no-any-return]

    def explain_transaction(self, ctx: ClientContext, transaction_id: UUID) -> TransactionDetail:
        return self._timed(self._inner.explain_transaction, ctx, transaction_id)  # type: ignore[no-any-return]
