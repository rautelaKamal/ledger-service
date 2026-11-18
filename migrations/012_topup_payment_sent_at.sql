-- Step 7d: the top-up timeline shows WHEN the payment command was delivered to
-- the provider (the outbox row's sent_at), not "time not recorded".
--
-- The API's role (ledger_app) still cannot read the outbox: migration 005 keeps
-- it to "ask for work, nothing more", and that stays true. Instead it may call
-- this one function, which answers one question about one top-up and nothing
-- else: when was its provider.create_payment command sent? (NULL while the
-- worker has not delivered it yet.) The API calls it only after checking that
-- the top-up belongs to the caller.

-- The lookup by top-up id, cheap whatever the size of the outbox.
CREATE INDEX outbox_payment_topup_idx ON outbox ((payload->>'topupId'))
    WHERE type = 'provider.create_payment';

CREATE FUNCTION topup_payment_sent_at(p_topup_id uuid) RETURNS timestamptz
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT min(sent_at)
      FROM outbox
     WHERE type = 'provider.create_payment'
       AND payload->>'topupId' = p_topup_id::text
$$;

REVOKE ALL ON FUNCTION topup_payment_sent_at(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION topup_payment_sent_at(uuid) TO ledger_app;
