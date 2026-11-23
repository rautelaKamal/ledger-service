"""asks_about_notes on ten questions it was NOT written against (step 7e).

The rule in notes.py was written while looking at the 50 eval questions. These ten were written
afterwards, with their expected answers, before the rule was run on them, and the rule was not
changed after seeing the result. Where it is wrong, the case is marked xfail(strict=True): the
miss is recorded, and the test starts failing (XPASS) if a later change fixes it, so the record
has to be updated then.
"""

import pytest

from ledger_agent.notes import asks_about_notes

MISSED = pytest.mark.xfail(strict=True, reason="missed by the rule; reported, not tuned (step 7e)")

# (question, does it ask what a transaction was for or about its note?)
# Result, as first run (23 Nov): 6 of 10 right. All 5 questions that do not ask about a note are
# right; 4 of the 5 that do are missed (three Hinglish, one "what did Ravi write"). A miss fails
# closed: the model gets no note, so it cannot say what the transaction was for, and no note text
# can reach it either.
UNSEEN: list[object] = [
    pytest.param("ye ₹2,895 kis cheez ka tha?", True, marks=MISSED),
    pytest.param("3 November ko jo ₹600 gaye, woh kisliye the?", True, marks=MISSED),
    pytest.param("What did Ravi write on the money he sent me?", True, marks=MISSED),
    ("Can you tell me what my ₹1,200.00 payment on Friday was meant for?", True),
    pytest.param("Bilal ne mujhe ₹450 kyun bheje?", True, marks=MISSED),
    ("Mera balance kitna hai?", False),
    ("Pichle hafte main account se kitna paisa gaya?", False),
    ("Did my ₹2,000 top-up yesterday go through?", False),
    ("How much did I spend in total in October?", False),
    ("Savings account mein abhi kitne paise hain?", False),
]


@pytest.mark.parametrize(("question", "expected"), UNSEEN)
def test_unseen_question(question: str, expected: bool) -> None:
    assert asks_about_notes(question) is expected
