# Reconciliation
> **Fictional policy.** This document belongs to the ledger-service demo, a made-up ledger. It is not the policy of any real bank, wallet or company, and it is not financial or legal advice.

## Nightly checks

Every night at 02:00 IST a reconciliation job checks that every balance equals the sum of its posted entries, that every posted transaction balances, and that no top-up has been pending for more than 24 hours.

## If something is found

A discrepancy never changes your balance automatically. Support reviews each finding and, if a correction is needed, posts a reversing or adjusting transaction that appears on your statement with a note.
