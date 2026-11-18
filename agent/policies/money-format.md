# How amounts are shown
> **Fictional policy.** This document belongs to the ledger-service demo, a made-up ledger. It is not the policy of any real bank, wallet or company, and it is not financial or legal advice.

## Rupees and paise

The ledger stores every amount as a whole number of paise. Amounts are shown as rupees with two decimal places, for example ₹1,234.56, using Indian digit grouping (₹1,00,000.00 for one lakh). The assistant always states exact figures with paise and never rounds to words like lakh or crore.

## Negative balances

User accounts can never go below ₹0.00. Only the ledger's own settlement account can carry a negative balance, which is expected and is not an error.
