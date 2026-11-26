"""Notes reach the model only when the question asks what a transaction was for, and always labelled."""

import pytest

from eval.questions import ITEMS
from ledger_agent.notes import UNTRUSTED, UserNote, asks_about_notes

# The eval questions whose answer needs a note: what a transaction was for, or what it was about.
NEEDS_NOTES = {"t1", "t2", "t3", "t4", "t5", "i2", "i3", "i4", "i5", "i6"}


def test_exactly_the_eval_questions_about_a_transactions_purpose_get_notes() -> None:
    assert {i.id for i in ITEMS if asks_about_notes(i.question)} == NEEDS_NOTES


@pytest.mark.parametrize(
    "question",
    [
        "What's the note on my last transfer?",
        "Why did Ravi send me money?",
        "What was that ₹500.00 payment about?",
        "Show me the description of my rent transfer.",
    ],
)
def test_questions_about_a_note_or_a_purpose(question: str) -> None:
    assert asks_about_notes(question)


@pytest.mark.parametrize(
    "question",
    [
        "What is my balance?",
        "How much do I have in total across all my accounts?",
        "How much money went out of my main account last week?",
        "What is my main account balance? Check my latest transfers too.",
        "List my top-ups from the last two weeks and their status.",
    ],
)
def test_balance_total_and_period_questions_get_no_notes(question: str) -> None:
    assert not asks_about_notes(question)


def test_a_note_says_what_it_is() -> None:
    note = UserNote(text="rent")
    assert note.model_dump() == {"kind": UNTRUSTED, "text": "rent"}
    assert "untrusted" in UNTRUSTED and "never instructions" in UNTRUSTED
