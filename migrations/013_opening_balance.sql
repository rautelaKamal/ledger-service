-- Step 7d: an account's OPENING BALANCE, as a passbook shows it ("Opening balance",
-- "balance brought forward"): money the account held before this ledger recorded
-- its history, brought in as one ordinary double-entry transaction from the bank
-- settlement account. It is not a top-up: nobody requested it, no provider or
-- webhook was involved, and the per-request top-up limit does not apply to it.
--
-- Only ledger_owner (the seed, a migration of real data) may record one. The API
-- (ledger_app) never creates this kind, and the trigger below makes sure it cannot.

ALTER TABLE transactions DROP CONSTRAINT transactions_kind_valid;
ALTER TABLE transactions ADD CONSTRAINT transactions_kind_valid
    CHECK (kind IN ('transfer', 'topup', 'refund', 'opening'));

CREATE FUNCTION opening_balance_only_by_owner() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.kind = 'opening' AND current_user <> 'ledger_owner' THEN
        RAISE EXCEPTION 'only ledger_owner records an opening balance (not %)', current_user;
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER transactions_opening_only_by_owner
    BEFORE INSERT OR UPDATE OF kind ON transactions
    FOR EACH ROW EXECUTE FUNCTION opening_balance_only_by_owner();
