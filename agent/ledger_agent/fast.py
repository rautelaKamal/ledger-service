"""The fast path (step 7h): a plain "what did I spend <period>?" is answered by code, with no model call.

The 7g live check took 8 to 24 s for these questions, over 90% of it waiting for four model
calls (classify, two fetch rounds, answer), although code already decides the period, the sum
and the range (dates.py, tools.spending). So when the question is nothing more than that, code
calls the spending tool, writes the answer from a template, and the same verifier checks it.

Recognising the question is deliberately narrow: every word must come from a small list, one of
them a spending verb, and the question must name exactly one period (dates.period_named_in).
Anything else, such as a payee ("to Arjun"), a category ("on groceries"), an account ("from
savings"), a comparison ("more than") or a "why", goes through the full graph as before.
"""

import re
from datetime import datetime

from .dates import IST, NamedPeriod, period_named_in
from .tools import Spending
from .verify import Answer, Citation, format_paise

_SPEND_WORDS = frozenset({"spend", "spent", "spending"})
# Words that can only ask "how much did I spend in that period", in some phrasing. Nothing that
# names a person, an account, a category, a comparison or a reason.
_ALLOWED = _SPEND_WORDS | frozenset(
    {
        "what", "how", "much", "did", "do", "i", "i've", "have", "has", "been", "my", "me", "total", "in",
        "was", "is", "the", "last", "past", "previous", "this", "week", "yesterday", "7", "seven", "days",
        "so", "far", "overall", "altogether", "all", "money", "of", "during", "over", "tell", "please",
        "can", "you", "show",
    }
)  # fmt: skip
_WORD = re.compile(r"[a-z0-9']+")
_OTHER_CHARACTERS = re.compile(r"[^a-z0-9'\s?.!,]")
MAX_WORDS = 20
MAX_CITED = 10


def spending_question(question: str) -> NamedPeriod | None:
    """The period, when the question only asks how much was spent in it; None means: use the graph."""
    q = question.lower().replace("\u2019", "'")
    if _OTHER_CHARACTERS.search(q):
        return None
    words = _WORD.findall(q)
    if not words or len(words) > MAX_WORDS or not _SPEND_WORDS & set(words):
        return None
    if any(w not in _ALLOWED for w in words):
        return None
    return period_named_in(q)


def _day(moment: datetime) -> str:
    local = moment.astimezone(IST)
    return f"{local.day} {local:%b}"


def spending_answer(report: Spending) -> Answer:
    """The answer, written by code from the spending report: every amount and the range come from it."""
    lead = f"On {report.period_text}" if report.from_date == report.to_date else f"From {report.period_text}"
    total = format_paise(report.total_spent_paise)
    count = report.payment_count
    if count == 0:
        text = f"{lead} you spent {total}: no payments to other people."
    else:
        text = f"{lead} you spent {total} in {count} payment{'' if count == 1 else 's'} to other people."
        if count > 1:
            largest = max(report.payments, key=lambda p: (p.amount_paise, p.created_at))
            text += f" The largest was {format_paise(largest.amount_paise)} on {_day(largest.created_at)}."
    text += " Moving money between your own accounts, and top-ups, are not spending."
    citations = [Citation(type="transaction", id=str(p.transaction_id)) for p in report.payments[:MAX_CITED]]
    return Answer(answer=text, citations=citations)
