# Overview

Explain a stuck or disputed anchor payment, from evidence, without trusting either side.

AnchorTrace reconciles a **SEP-24 transaction record** (what the anchor says) against **Stellar classic payment evidence** (what the ledger shows), one transaction at a time, and says why. It is read-only: no keys, no signing, no payment execution, `GET` requests only.

> **Confirmation on chain is not a bank payout.** For a withdrawal, a matching Stellar payment to the anchor shows only the wallet-side transfer. AnchorTrace cannot see the anchor's bank, cash or other external payout, and every report says so.

| Outcome | Meaning |
|---|---|
| `matched` | The Stellar leg agrees with a completed (or refunded) record: destination, asset **and issuer**, exact amount, memo, sender. Nothing is claimed about off-chain legs. |
| `pending` | In progress and consistent with the evidence, or no on-chain transfer is required yet. |
| `discrepant` | Evidence contradicts the record (wrong destination, issuer, amount, memo, sender, failed transaction, status says error but funds arrived, record's own amounts disagree). |
| `ambiguous` | More than one explanation fits, for example two payment operations to the anchor in one transaction, or a status history that cannot be ordered. |
| `unsupported` | Path payments, claimable balances, Soroban contract transfers and other forms. Never counted as success. |
| `insufficient_evidence` | Missing, truncated, wrong-network or unreadable evidence. A failed read is never a mismatch and never a pass. |

Source: [anchortrace-sdk on GitHub](https://github.com/Anchor-Trace/anchortrace-sdk). Releases: [GitHub releases](https://github.com/Anchor-Trace/anchortrace-sdk/releases).
