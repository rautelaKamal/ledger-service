"""A deterministic model and embeddings for the tests. No network, ever.

FakeChatModel is scripted: which category to return, which tool calls to make
in each round, which Answer to give on each answer call. It records every
prompt it was given so tests can assert what the model saw.
"""

import hashlib
import math
import re
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any

from langchain_core.callbacks import CallbackManagerForLLMRun
from langchain_core.embeddings import Embeddings
from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AIMessage, BaseMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langchain_core.runnables import Runnable, RunnableLambda
from langchain_core.tools import BaseTool
from pydantic import BaseModel, Field

from ledger_agent.graph import Classification
from ledger_agent.verify import Answer

USAGE = {"input_tokens": 100, "output_tokens": 20, "total_tokens": 120}


@dataclass
class ToolCall:
    name: str
    args: dict[str, Any]


@dataclass
class Script:
    category: str = "account"
    # one entry per model round in the fetch loop; an empty round means "no more tool calls"
    rounds: list[list[ToolCall]] = field(default_factory=list)
    # one Answer per answer call; the last one repeats if the graph asks again
    answers: list[Answer] = field(default_factory=list)
    fail_with: Exception | None = None


class FakeChatModel(BaseChatModel):
    """Scripted. `prompts` keeps every message list the graph sent, in order."""

    script: Script
    prompts: list[list[BaseMessage]] = Field(default_factory=list)
    answer_calls: int = 0
    round_index: int = 0

    @property
    def _llm_type(self) -> str:
        return "fake"

    def _generate(
        self,
        messages: list[BaseMessage],
        stop: list[str] | None = None,
        run_manager: CallbackManagerForLLMRun | None = None,
        **kwargs: Any,
    ) -> ChatResult:
        raise AssertionError("the graph must use bind_tools / with_structured_output, never a bare invoke")

    def _fail_if_scripted(self) -> None:
        if self.script.fail_with is not None:
            raise self.script.fail_with

    def with_structured_output(self, schema: Any, *, include_raw: bool = False, **kwargs: Any) -> Runnable[Any, Any]:
        def respond(messages: Any) -> Any:
            self._fail_if_scripted()
            self.prompts.append(list(messages))
            parsed: BaseModel
            if schema is Classification:
                parsed = Classification(category=self.script.category)
            elif schema is Answer:
                index = min(self.answer_calls, len(self.script.answers) - 1)
                self.answer_calls += 1
                parsed = self.script.answers[index]
            else:
                raise AssertionError(f"unexpected schema {schema}")
            raw = AIMessage(content="", usage_metadata=USAGE)
            return {"raw": raw, "parsed": parsed, "parsing_error": None} if include_raw else parsed

        return RunnableLambda(respond)

    def bind_tools(self, tools: Sequence[Any], **kwargs: Any) -> Runnable[Any, Any]:
        names = {t.name for t in tools if isinstance(t, BaseTool)}

        def respond(messages: Any) -> AIMessage:
            self._fail_if_scripted()
            self.prompts.append(list(messages))
            calls = self.script.rounds[self.round_index] if self.round_index < len(self.script.rounds) else []
            self.round_index += 1
            assert all(c.name in names or c.name.startswith("bogus") for c in calls), (
                f"script calls a tool the model was not given: {calls}"
            )
            return AIMessage(
                content="" if calls else "I have what I need.",
                tool_calls=[
                    {"name": c.name, "args": c.args, "id": f"call-{i}", "type": "tool_call"}
                    for i, c in enumerate(calls)
                ],
                usage_metadata=USAGE,
            )

        return RunnableLambda(respond)


def _tokens(text: str) -> list[str]:
    return re.findall(r"[a-z0-9]+", text.lower())


class FakeEmbeddings(Embeddings):
    """Bag-of-words hashing into 768 dimensions, L2-normalised: texts sharing words land close together."""

    dims = 768

    def _embed(self, text: str) -> list[float]:
        vector = [0.0] * self.dims
        for token in _tokens(text):
            if token in {"task", "query", "title", "text", "the", "a", "of", "and", "to", "is", "in"}:
                continue
            h = int(hashlib.sha256(token.encode()).hexdigest(), 16)
            vector[h % self.dims] += 1.0
        norm = math.sqrt(sum(v * v for v in vector)) or 1.0
        return [v / norm for v in vector]

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        return [self._embed(t) for t in texts]

    def embed_query(self, text: str) -> list[float]:
        return self._embed(text)


def generation(text: str) -> ChatResult:
    return ChatResult(generations=[ChatGeneration(message=AIMessage(content=text))])
