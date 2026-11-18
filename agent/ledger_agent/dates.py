"""Dates for the assistant are Indian dates.

The ledger stores timestamps in UTC. The people asking questions live in
Asia/Kolkata, so "Tuesday", "last week" and "today" are resolved there, and a
calendar date given to a tool means that whole day in IST.
"""

from datetime import UTC, date, datetime, timedelta
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
