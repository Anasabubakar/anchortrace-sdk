# ADR 0001: What AnchorTrace adds over existing tools

Status: accepted, 2026-10-07. Evidence below is what was read on that date; it is not a survey of every tool, and no competitor was installed or executed.

## Context
Support staff at anchors and wallets get tickets of the form "my withdrawal is stuck" or "I was paid the wrong amount". They have two partial views: the anchor's SEP-24 transaction record (status, amounts, memo, `stellar_transaction_id`) and the Stellar ledger (the payment operations). Reconciling the two by hand is slow and error-prone because details matter: an asset code is only meaningful with its issuer, a transaction can hold several payment operations, path payments and claimable balances are not direct payments, and a confirmed on-chain payment says nothing about the bank side of a withdrawal.

## Existing tools inspected
- **SEP-24 itself** (stellar-protocol `ecosystem/sep-0024.md`, version 3.8.0, read in full for the status list, transaction fields and amount formulas). It defines the record AnchorTrace consumes and states that anchors must listen for `payment` and `path_payment` operations to detect a withdrawal. It defines no reconciliation procedure or verdict vocabulary.
- **Stellar Wallet SDK** (`stellar/typescript-wallet-sdk` README, and the developers.stellar.org "Hosted Deposits and Withdrawals (SEP-24)" wallet guide). The guide shows a `Watcher` (`watchOneTransaction` / `watchAllTransactions`) that polls the anchor and calls `onMessage`, `onSuccess` and `onError` as the status changes, `getTransactionBy` to fetch a transaction by anchor id, Stellar transaction id or external id, and a `transferWithdrawalTransaction` helper that builds the user's payment from `withdraw_anchor_account`, `withdraw_memo` and `amount_in`. It is a toolkit for building wallets. In what I read, it tracks the anchor's reported status; I found no function that compares the anchor's record with the payment operations on the ledger, and it submits payments, which AnchorTrace never does.
- **Anchor Platform** (`stellar/anchor-platform` README and the Anchor Platform admin-guide architecture page). It is a deployable anchor server implementing SEP-1, 6, 10, 12, 24, 31, 38 and 45, with a platform server, a business-server callback model, an event service and a Payment Observer that "monitors the Stellar blockchain using Stellar RPC or Horizon, automatically detects payments related to the business, and updates the corresponding transaction". It keeps the anchor's own transaction state consistent with chain events as part of operating an anchor. It is infrastructure for running an anchor, not an after-the-fact explainer that a support person or a wallet team can point at an arbitrary record plus a transaction hash. I did not read its source, and I did not run it.
- **Reconciliation in generic payment products** was not inspected; no claim is made about them.

## What is left that AnchorTrace does
1. A read-only, offline-capable, deterministic judgment of one SEP-24 record against specific operation-level evidence, with a closed vocabulary (matched, pending, discrepant, ambiguous, unsupported, insufficient_evidence) and an explanation of every field comparison.
2. Refusals that a wallet SDK or an anchor's own state machine has no reason to make: it will not call a multi-operation transaction matched, will not treat a path payment, claimable balance or Soroban transfer as success, will not guess an issuer, and treats a missing or failed read as insufficient evidence instead of a mismatch.
3. An explicit statement, in every report and rendering, that confirmation on chain is not a bank payout.
4. Provenance on every input (supplied file with hash, or live Horizon with URL, network and time) and redacted exports for sharing a case.

## Decision
Build a small TypeScript engine, CLI and report schema, with a plain-`fetch` Horizon adapter and no `@stellar/stellar-sdk` runtime dependency (the engine parses Horizon JSON and validates StrKey itself, which keeps the browser bundle small). Do not rebuild a wallet SDK, an anchor server, or a payment observer. If the Wallet SDK or the Anchor Platform later ships record-versus-ledger verification, contribute the evidence model and test cases there instead of competing.

## Consequences
- v1 deliberately covers classic direct `payment` operations only. SEP-24 says anchors listen for path payments too; AnchorTrace reports them as unsupported so a human decides, instead of guessing a delivered amount.
- The verdicts are only as good as the evidence supplied. The README states this; the engine states it in every report.
- Anchors using the Anchor Platform already get Payment Observer matching on their side; AnchorTrace's value there is as an independent second opinion that does not trust the anchor's database.
