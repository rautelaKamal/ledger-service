"""Dates are Indian dates."""

from datetime import UTC, datetime

import pytest

from ledger_agent.dates import describe_today, period_bounds, today_ist

# 20:00 UTC on Monday 16 Nov 2026 is already Tuesday 17 Nov in Asia/Kolkata.
NOW = datetime(2026, 11, 16, 20, 0, tzinfo=UTC)


def test_today_and_its_description_are_in_ist() -> None:
    assert today_ist(NOW).isoformat() == "2026-11-17"
    assert describe_today(NOW) == "Tuesday 17 November 2026 (Asia/Kolkata, UTC+05:30)"


def test_period_bounds_are_whole_ist_days() -> None:
    start, end = period_bounds("2026-11-10", "2026-11-12", NOW)
    assert start.isoformat() == "2026-11-10T00:00:00+05:30"
    assert end.isoformat() == "2026-11-13T00:00:00+05:30"  # inclusive to_date -> next midnight
    assert start.astimezone(UTC).isoformat() == "2026-11-09T18:30:00+00:00"


def test_period_defaults_to_the_last_30_days_up_to_today() -> None:
    start, end = period_bounds(None, None, NOW)
    assert end.isoformat() == "2026-11-18T00:00:00+05:30"
    assert start.isoformat() == "2026-10-18T00:00:00+05:30"


def test_bad_dates_are_reported_not_guessed() -> None:
    with pytest.raises(ValueError, match="YYYY-MM-DD"):
        period_bounds("last tuesday", None, NOW)
    with pytest.raises(ValueError, match="after"):
        period_bounds("2026-11-12", "2026-11-10", NOW)
