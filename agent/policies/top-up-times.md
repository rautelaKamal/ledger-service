# Top-up processing times
> **Fictional policy.** This document belongs to the ledger-service demo, a made-up ledger. It is not the policy of any real bank, wallet or company, and it is not financial or legal advice.

## How long a top-up takes

A top-up is credited only after the payment provider confirms the payment by webhook. Most confirmations arrive within 2 minutes. Until then the top-up shows as **pending** and the amount is not part of your balance.

## When a top-up is slow

If the provider has not confirmed within 30 minutes, the top-up is marked as delayed in your statement but keeps its pending status. Pending top-ups are re-checked by the reconciliation job every night at 02:00 IST. A top-up that is still pending after 24 hours is reported to support automatically.

## Bank holidays

Top-ups are processed on every calendar day, including weekends and bank holidays. The provider's own cut-off times can still delay a confirmation by up to one business day.
