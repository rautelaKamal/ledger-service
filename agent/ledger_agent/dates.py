"""Dates for the assistant are Indian dates.

The ledger stores timestamps in UTC. The people asking questions live in
Asia/Kolkata, so "Tuesday", "last week" and "today" are resolved there, and a
calendar date given to a tool means that whole day in IST.
"""

import re
from datetime import UTC, date, datetime, timedelta
from typing import Literal
from zoneinfo import ZoneInfo

IST = ZoneInfo("Asia/Kolkata")
DEFAULT_PERIOD_DAYS = 30


def now_utc() -> datetime:
    return datetime.now(UTC)


def today_ist(now: datetime) -> date:
    return now.astimezone(IST).date()


def describe_today(now: datetime) -> str:
    """For the system prompt: 'Monday 16 November 2026 (Asia/Kolkata, UTC+05:30)'."""
    local = now.astimezone(IST)
    return f"{local.strftime('%A %d %B %Y')} (Asia/Kolkata, UTC+05:30)"


def parse_ist_date(value: str) -> date:
    """'YYYY-MM-DD' only. Anything else is the model's mistake, reported back to it."""
    try:
        return date.fromisoformat(value.strip())
    except ValueError as e:
        raise ValueError(f"dates must be YYYY-MM-DD, got {value!r}") from e


def ist_midnight(day: date) -> datetime:
    return datetime(day.year, day.month, day.day, tzinfo=IST)


def period_bounds(from_date: str | None, to_date: str | None, now: datetime) -> tuple[datetime, datetime]:
    """Inclusive calendar dates in IST -> [from, to) as aware datetimes.

    Defaults: the last DEFAULT_PERIOD_DAYS days up to and including today.
    """
    today = today_ist(now)
    end_day = parse_ist_date(to_date) if to_date else today
    start_day = parse_ist_date(from_date) if from_date else end_day - timedelta(days=DEFAULT_PERIOD_DAYS)
    if start_day > end_day:
        raise ValueError(f"from_date {start_day} is after to_date {end_day}")
    return ist_midnight(start_day), ist_midnight(end_day + timedelta(days=1))


# ───────────── named periods (step 7g): one meaning each, decided here, never by the model ─────────────
#
# Weeks run Monday to Sunday (the Indian and ISO convention). On Thursday 26 Nov 2026:
#   yesterday     Wed 25 Nov
#   this_week     Mon 23 Nov .. Thu 26 Nov (today)
#   last_week     Mon 16 Nov .. Sun 22 Nov
#   last_7_days   Fri 20 Nov .. Thu 26 Nov (today and the six days before it)
# The spending tool resolves the period with these functions, and the verifier requires the
# answer to state the same range (period_text), so the model and the checker cannot disagree.

EN_DASH = "\u2013"

NamedPeriod = Literal["yesterday", "this_week", "last_week", "last_7_days"]
NAMED_PERIODS: tuple[NamedPeriod, ...] = ("yesterday", "this_week", "last_week", "last_7_days")


def named_period(name: NamedPeriod, today: date) -> tuple[date, date]:
    """Inclusive IST calendar dates."""
    monday = today - timedelta(days=today.weekday())
    if name == "yesterday":
        return today - timedelta(days=1), today - timedelta(days=1)
    if name == "this_week":
        return monday, today
    if name == "last_week":
        return monday - timedelta(days=7), monday - timedelta(days=1)
    if name == "last_7_days":
        return today - timedelta(days=6), today
    raise ValueError(f"unknown period {name!r}")


def period_text(start: date, end: date) -> str:
    """'25 Nov 2026', '16-22 Nov 2026', '30 Nov-6 Dec 2026', '28 Dec 2026-3 Jan 2027', with an en dash, not "-"."""
    if start == end:
        return f"{start.day} {start:%b %Y}"
    if (start.year, start.month) == (end.year, end.month):
        return f"{start.day}{EN_DASH}{end.day} {end:%b %Y}"
    if start.year == end.year:
        return f"{start.day} {start:%b}{EN_DASH}{end.day} {end:%b %Y}"
    return f"{start.day} {start:%b %Y}{EN_DASH}{end.day} {end:%b %Y}"


# The phrases a question can use for each period. "past week" means the last 7 days.
_PERIOD_PHRASES: dict[NamedPeriod, re.Pattern[str]] = {
    "yesterday": re.compile(r"\byesterday\b"),
    "this_week": re.compile(r"\bthis week\b"),
    "last_week": re.compile(r"\b(?:last|previous) week\b"),
    "last_7_days": re.compile(r"\b(?:last|past) (?:7|seven) days\b|\bpast week\b"),
}


def period_named_in(question: str) -> NamedPeriod | None:
    """The one named period the question asks about, read by code; None if none or more than one."""
    q = re.sub(r"\s+", " ", question.lower())
    found = [name for name, pattern in _PERIOD_PHRASES.items() if pattern.search(q)]
    return found[0] if len(found) == 1 else None
