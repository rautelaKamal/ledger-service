"""The verifier: amounts in both groupings, ids, citations, forbidden words."""

from ledger_agent.verify import Answer, Citation, Fetched, amounts_in_text, format_paise, verify


def test_amounts_in_both_groupings_and_paise() -> None:
    text = "₹1,00,000.00 and ₹100,000 and Rs 50 and INR 12.5 and Rs.7.05 and 1,234 paise"
    assert amounts_in_text(text) == {10_000_000, 5_000, 1_250, 705, 1_234}


def test_format_paise_uses_indian_grouping() -> None:
    assert format_paise(12_345_678) == "₹1,23,456.78"
    assert format_paise(100) == "₹1.00"
    assert format_paise(10_000_000) == "₹1,00,000.00"
    assert format_paise(-250) == "-₹2.50"


def _fetched(amounts: set[int], ids: set[str]) -> Fetched:
    f = Fetched()
    f.amounts_paise |= amounts
    f.ids |= ids
    return f


TX = "11111111-2222-3333-4444-555555555555"
OTHER = "99999999-2222-3333-4444-555555555555"


def test_verified_when_everything_was_fetched() -> None:
    answer = Answer(
        answer=f"You paid ₹2.00 on Tuesday (transaction {TX}).", citations=[Citation(type="transaction", id=TX)]
    )
    assert verify(answer, _fetched({200, 10_000}, {TX}), {7}, "") == []


def test_invented_amount_is_a_failure() -> None:
    answer = Answer(answer="Your balance is ₹999.99.")
    failures = verify(answer, _fetched({200, 10_000}, {TX}), set(), "")
    assert failures == ["amount ₹999.99 does not appear in the fetched data"]


def test_amount_quoted_from_a_retrieved_policy_is_allowed() -> None:
    answer = Answer(answer="The limit is ₹2,00,000.00 per transfer.", citations=[Citation(type="policy", id="7")])
    assert verify(answer, Fetched(), {7}, "A single transfer can be at most ₹2,00,000.00.") == []


def test_unfetched_transaction_id_is_a_failure_in_text_and_in_citations() -> None:
    answer = Answer(answer=f"See transaction {OTHER}.", citations=[Citation(type="transaction", id=OTHER)])
    failures = verify(answer, _fetched(set(), {TX}), set(), "")
    assert failures == [f"id {OTHER} was not fetched", f"cited transaction {OTHER} was not fetched"]


def test_unretrieved_policy_citation_is_a_failure() -> None:
    answer = Answer(answer="Refunds take 1 to 3 business days.", citations=[Citation(type="policy", id="42")])
    assert verify(answer, Fetched(), {7, 8}, "") == ["cited policy chunk 42 was not retrieved"]
    assert verify(answer, Fetched(), {7, 42}, "") == []


def test_lakh_and_crore_are_refused() -> None:
    answer = Answer(answer="You have about 1 lakh.")
    assert verify(answer, Fetched(), set(), "") == [
        "the word 'lakh' is not allowed: state the exact figure in rupees and paise"
    ]


def test_fetched_absorbs_paise_and_ids_from_nested_data() -> None:
    f = Fetched()
    f.absorb(
        {"transactions": [{"transaction_id": TX, "amount_paise": 500, "flag": True}], "closing_balance_paise": 9_500}
    )
    assert f.amounts_paise == {500, 9_500}
    assert f.ids == {TX}
