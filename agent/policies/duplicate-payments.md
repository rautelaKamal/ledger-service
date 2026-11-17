# Duplicate payments and retries
> **Fictional policy.** This document belongs to the ledger-service demo, a made-up ledger. It is not the policy of any real bank, wallet or company, and it is not financial or legal advice.

## Why you never pay twice

Every transfer request carries an idempotency key. If a request is sent again with the same key, for example after a network timeout, the ledger returns the original result instead of moving money a second time.

## If you see two similar transfers

Two transfers with the same amount and the same recipient are two separate requests with two different keys. Check the transaction ids: they will differ. The assistant can explain each one.

## Retries by the provider

The payment provider may send the same confirmation more than once. The ledger records a confirmation only once; a repeated one is acknowledged and ignored.
