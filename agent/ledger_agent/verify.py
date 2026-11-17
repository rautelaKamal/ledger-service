"""The safety net: plain code that checks an answer against what was actually fetched.

A model can be told not to invent figures; it cannot be trusted to comply.
So after the model answers, this module checks, mechanically:

  * every rupee or paise amount in the answer equals an amount in the fetched
    tool data or in the retrieved policy text;
  * every UUID in the answer is an account or transaction id that was fetched;
  * every citation points at something fetched (transaction) or retrieved (policy);
  * no "lakh"/"crore" wording (the model must state exact figures).

Anything it cannot match is a failure. The graph feeds failures back to the
model once; if the second answer still fails, the user gets the fallback text
and verified=false. No LLM is involved in this step on purpose: a judge model
could be talked into approving what the first model was talked into writing.
"""

import re
from dataclasses import dataclass, field
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

# ₹1,234.56   Rs 1,00,000   INR 50   Rs.12 — Indian or western grouping, optional paise.
RUPEE_RE = re.compile(r"(?:₹|Rs\.?|INR)\s*([0-9][0-9,]*)(?:\.([0-9]{1,2}))?", re.IGNORECASE)
# 1,234 paise
PAISE_RE = re.compile(r"([0-9][0-9,]*)\s*paise", re.IGNORECASE)
UUID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.IGNORECASE)
FORBIDDEN_WORDS = ("lakh", "lakhs", "crore", "crores")


class Citation(BaseModel):
    model_config = ConfigDict(frozen=True)

    type: Literal["transaction", "policy"]
    id: str = Field(min_length=1, max_length=64)


class Answer(BaseModel):
    """What the model must produce: the text, and what it relied on."""

    model_config = ConfigDict(frozen=True)

    answer: str = Field(min_length=1, max_length=4000)
    citations: list[Citation] = Field(default_factory=list)


@dataclass
class ToolCallRecord:
    name: str
    args: dict[str, Any]
    ok: bool


@dataclass
class Fetched:
    """Everything the tools returned during one question, flattened for the verifier."""

    amounts_paise: set[int] = field(default_factory=set)
    ids: set[str] = field(default_factory=set)
    calls: list[ToolCallRecord] = field(default_factory=list)

    def absorb(self, payload: Any) -> None:
        """Walk a tool result (pydantic models, dicts, lists) for *_paise ints and UUID-looking strings."""
        if isinstance(payload, BaseModel):
            self.absorb(payload.model_dump(mode="json"))
        elif isinstance(payload, dict):
            for key, value in payload.items():
                if (
                    isinstance(key, str)
                    and key.endswith("_paise")
                    and isinstance(value, int)
                    and not isinstance(value, bool)
                ):
                    self.amounts_paise.add(value)
                self.absorb(value)
        elif isinstance(payload, list):
            for item in payload:
                self.absorb(item)
        elif isinstance(payload, str) and UUID_RE.fullmatch(payload):
            self.ids.add(payload.lower())


def _to_paise(rupees: str, paise: str | None) -> int:
    whole = int(rupees.replace(",", ""))
    fraction = int((paise or "0").ljust(2, "0"))
    return whole * 100 + fraction


def amounts_in_text(text: str) -> set[int]:
    """Every amount in the text, in paise. Both ₹1,00,000.00 and ₹100,000.00 are 10000000."""
    found = {_to_paise(m.group(1), m.group(2)) for m in RUPEE_RE.finditer(text)}
    found |= {int(m.group(1).replace(",", "")) for m in PAISE_RE.finditer(text)}
    return found


def verify(answer: Answer, fetched: Fetched, retrieved_ids: set[int], retrieved_text: str) -> list[str]:
    """Empty list = verified. Otherwise one line per problem, written for the model to act on."""
    failures: list[str] = []
    allowed_amounts = fetched.amounts_paise | amounts_in_text(retrieved_text)
    for amount in sorted(amounts_in_text(answer.answer)):
        if amount not in allowed_amounts:
            failures.append(f"amount {format_paise(amount)} does not appear in the fetched data")
    for uuid in sorted({m.group(0).lower() for m in UUID_RE.finditer(answer.answer)}):
        if uuid not in fetched.ids:
            failures.append(f"id {uuid} was not fetched")
    for citation in answer.citations:
        if citation.type == "transaction" and citation.id.lower() not in fetched.ids:
            failures.append(f"cited transaction {citation.id} was not fetched")
        if citation.type == "policy" and not (citation.id.isdigit() and int(citation.id) in retrieved_ids):
            failures.append(f"cited policy chunk {citation.id} was not retrieved")
    lowered = answer.answer.lower()
    for word in FORBIDDEN_WORDS:
        if re.search(rf"\b{word}\b", lowered):
            failures.append(f"the word '{word}' is not allowed: state the exact figure in rupees and paise")
            break
    return failures


def format_paise(paise: int) -> str:
    """Integer paise -> ₹ with Indian grouping: 12345678 -> ₹1,23,456.78."""
    sign = "-" if paise < 0 else ""
    paise = abs(paise)
    rupees, fraction = divmod(paise, 100)
    digits = str(rupees)
    if len(digits) > 3:
        head, tail = digits[:-3], digits[-3:]
        groups: list[str] = []
        while len(head) > 2:
            groups.insert(0, head[-2:])
            head = head[:-2]
        if head:
            groups.insert(0, head)
        digits = ",".join([*groups, tail])
    return f"{sign}₹{digits}.{fraction:02d}"
