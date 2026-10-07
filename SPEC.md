# AnchorTrace SDK: specification (v1)

Source of truth for behaviour. Tests cite sections of this document. Status: implemented in 0.1.0.

## 1. User and problem
Support and operations staff at anchors and wallets, and developers building their tooling. They hold a SEP-24 transaction record and want to know, per transaction and with reasons, whether the Stellar payment evidence agrees with it. They need a verdict they can defend, so the tool says when it does not know.

## 2. Scope
In scope (v1):
- SEP-24 deposit and withdrawal records (SEP-24 v3.8.0): status, amounts, assets, fee, memo, `stellar_transaction_id`, refunds.
- Classic **direct `payment` operations** as evidence, from supplied Horizon-shaped JSON files or live read-only Horizon reads.
- Operation-level matching: destination, asset code and issuer (or native), exact amount, memo, sender.
- Explicit fee policy, deterministic timelines, provenance, redacted exports, JSON report with a published schema, CLI.

Non-goals (will not be added in v1; some never):
- Custody, keys, signing, submitting or executing payments, refunds or any transaction. The Horizon adapter issues `GET` only.
- SEP-6, SEP-31, SEP-38 quote verification, generic invoice or ERP matching.
- Interpreting path payments, claimable balances, Soroban contract transfers, liquidity-pool operations or account merges as payments (reported `unsupported`).
- Observing any off-chain leg: bank, cash, mobile money or crypto rails.
- Proving history cryptographically, streaming/monitoring, an anchor-side database, a hosted service.
- Any "safe", "audited", "compliant" or "verified payout" claim.

## 3. The hard rule
A confirmed on-chain transfer for a withdrawal never implies the external payout happened. Every report carries this in `limitations[0]`, every withdrawal carries the finding `external_payout_not_verified`, every text rendering states it, and a `matched` withdrawal summary ends with "Chain confirmation is not proof of the external payout." The `matched` outcome means *the Stellar leg agrees with the record*, nothing more. For deposits the analogous note is `external_funds_not_verified`.

## 4. Data model
All JSON shapes are validated with zod; JSON Schemas (draft 2020-12) generated from them are published in `schema/`.

### 4.1 SEP-24 input
Accepted shapes: a `GET /transaction` response (`{"transaction": {...}}`), a `GET /transactions` response (`{"transactions": [...]}`), an array of records (for example `on_change_callback` payloads in the order received), or one bare record. Records with the same `id` are **snapshots** of one transaction's history. Unknown fields are ignored. `more_info_url`, `kyc_verified`, the external side of `from`/`to` (bank or IBAN) and `message` are never copied into reports except `message` in the timeline (scanned by redaction).
Amounts must be decimal **strings** with at most 7 fractional digits; JSON numbers are rejected as `record_field_invalid` because they cannot be exact.

### 4.2 Evidence file
`{"evidenceVersion":"1","capture":{...optional...},"items":[{"transaction":<Horizon /transactions/{hash} body>,"operations":<Horizon /operations body or array>}]}`. These are raw Horizon bodies, so a file made with `curl` and a live read normalise identically. Normalisation keeps transaction hash, ledger, success flag, memo type and value, operation ids and order (sorted by operation id), operation type, from/to (and `to_muxed`), asset code and issuer, and exact amounts. A transaction whose `operations` list is shorter than its `operation_count` is flagged incomplete. An operation that belongs to a different transaction hash is an input error.

### 4.3 Case file (`caseVersion:"1"`)
Self-contained: `records` (SEP-24 snapshots), `evidence` (an evidence file), `options`, `synthetic`, `evidenceNote`, `intendedOutcome`. Used for shipped examples and to share a reproducible investigation. `synthetic: true` is propagated into report provenance labels.

### 4.4 Report (`reportVersion:"1"`)
`tool`, `generatedAt`, `inputs[]` (provenance), `options` (fee policy and whether it was defaulted), `summary` counts, `overall` (worst outcome), `transactions[]`, `limitations[]`, `redaction`. Each transaction has: `outcome`; `summary`; `currentStatus` (value, known, expectation, how elected); `timeline[]`; `expected` (the Stellar leg the record implies, with the basis of every value); `amounts` as recorded; `matching` (`linkedBy`, `candidates[]` with per-field checks, `refunds[]`); `findings[]` (each with `code`, `severity`, `effect`, message, optional details and `refs` to transaction/operation ids and source ids).

### 4.5 Provenance
Every input gets an id (`src-1`...). A supplied file records its label and SHA-256 when the caller computed it (the CLI does). A live read records the Horizon URL, HTTP status, the network passphrase read from Horizon `/`, the derived network name and the time. Findings and candidates cite source ids, so each evidence item says where it came from.

## 5. SEP-24 semantics used
Source: https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0024.md (v3.8.0, updated 2025-09-10): "Single historical transaction", "Shared fields for both deposits and withdrawals", "Fields for deposit transactions", "Fields for withdraw transactions", the `status` list, "Refunds Object Schema", "Fee Details Object Schema" and "Amount Formulas".

Fields: `amount_in` (received by the anchor at the start; excludes fees charged before), `amount_out` (sent by the anchor at the end; excludes XLM funding and external fees), `fee_details.total`/`asset` (preferred) or deprecated `amount_fee`, `*_asset` in SEP-38 format (`stellar:CODE:ISSUER`, `stellar:native`, `iso4217:USD`), `stellar_transaction_id` ("transaction_id on Stellar network of the transfer that either completed the deposit or started the withdrawal"), `withdraw_anchor_account` + `withdraw_memo` + `withdraw_memo_type`, `deposit_memo` + `deposit_memo_type`, `to` (deposit destination), `from` (withdrawal sender), `claimable_balance_id`, `refunds.payments[]` (`id`, `id_type` stellar or external, `amount`, `fee`).

Statuses (all 16 in v3.8.0) and what the Stellar leg should look like (`expectation`):

| Status | Withdrawal | Deposit |
|---|---|---|
| `incomplete`, `pending_user_transfer_start`, `pending_user`, `pending_trust` | none (not yet) | none |
| `pending_user_transfer_complete` | required (SEP: withdrawals only) | none, plus warning `status_not_valid_for_kind` |
| `pending_anchor`, `pending_external`, `on_hold` | required (user's payment already received) | none (anchor has not paid yet) |
| `pending_stellar` | inflight | inflight |
| `completed` | required | required |
| `refunded` | refunded | refunded |
| `expired`, `no_market`, `too_small`, `too_large`, `error` | failure | failure |

Any other status string is `unsupported` (`status_unknown`); it is never guessed.

Amount formula (SEP-24, assuming equal assets): `amount_out = amount_in - amount_fee - refunds.amount_refunded - refunds.amount_fee`, `refunds.amount_refunded = sum(payments.amount)`, `refunds.amount_fee = sum(payments.fee)`. AnchorTrace checks them under the chosen fee policy (5.1). Across different assets they are not checked (`cross_asset_not_converted`): AnchorTrace never converts.

SEP-24 says anchors "must listen for `payment` and `path_payment` operations". AnchorTrace v1 reconciles `payment` only; path payments are `unsupported`. This is a scope decision, not a claim that path payments are invalid.

### 5.1 Fee policy (explicit; `--fee-policy`, default `anchor_deducted`)
| Policy | Withdrawal on-chain amount | Record formula checked | Notes |
|---|---|---|---|
| `anchor_deducted` | `amount_in` | `amount_out = amount_in - fee - refunds` | The SEP-24 formula. The fee is taken off the payout, not added to the payment. |
| `customer_paid_on_top` | `amount_in + fee` (fee needed, same asset) | `amount_out = amount_in - refunds` | The fee is charged in addition. Without a recorded fee: `record_field_missing`. |
| `no_fee` | `amount_in` | `amount_out = amount_in - refunds` | A non-zero fee is `fee_present_under_no_fee_policy` (discrepant). |

A deposit's on-chain amount is `amount_out` under every policy (SEP-24 defines it net of fees). The report records the policy and whether it was defaulted. The Stellar network fee (`fee_charged`) is unrelated and never compared. `--tolerance-bps` allows an integer basis-point deviation (default 0; SEP-24 suggests anchors tolerate up to 10% for wallet-side exchange).

## 6. Matching
### 6.1 Expected leg
Withdrawal (wallet to anchor): destination `withdraw_anchor_account`; asset `amount_in_asset` (or `--asset`); amount per 5.1; memo `withdraw_memo` (+ type when declared); sender `from`; transaction `stellar_transaction_id`.
Deposit (anchor to user): destination `to`; asset `amount_out_asset` (or `--asset`); amount `amount_out`; memo `deposit_memo`; sender `--anchor-account` if given. `claimable_balance_id` present means the deposit is `unsupported`.
The asset is never guessed: if the record omits it and no `--asset` is given, `expected_asset_unknown`. An off-chain asset (`iso4217:...`) cannot be a Stellar leg: `record_field_invalid`.
Asset identity is code **and issuer** (or native). Same code with a different issuer is a different asset (`wrong_issuer`).

### 6.2 Candidates
- Linked mode (record has `stellar_transaction_id`): the evidence transaction with that hash. Absent from the evidence: `onchain_evidence_missing` (or the acquisition failure). 
- Search mode (no id): successful evidence transactions with a payment to the expected destination and the declared memo. None: evidence missing. One: linked with warning `linked_by_search`. Several: `multiple_candidate_transactions` (ambiguous). A mismatching payment can only be judged when the id links it; unrelated evidence is never turned into `wrong_destination`.
- A failed transaction (`successful=false`) never counts: `onchain_transaction_failed` (discrepant).
- A truncated operation list: `operations_incomplete` (insufficient_evidence).
- Network: when `--network`/`expectedNetwork` is set and the evidence source's network differs, `evidence_network_mismatch` (insufficient_evidence).

### 6.3 Decision within one transaction
Payment operations paying the expected destination (base account; muxed ids compared when expected is muxed) are the **destination operations**.
- 2 or more: `multiple_candidate_operations` (ambiguous), even if they sum to the amount. No single operation is declared the match.
- Exactly 1: compare asset code, issuer, amount (exact stroops, or within tolerance), memo (id numerically, hash by bytes, text exactly), sender. Any difference is its own finding (`wrong_asset`, `wrong_issuer`, `amount_mismatch` with signed difference in stroops, `memo_mismatch`, `source_mismatch`), all discrepant.
- 0: payments elsewhere: `wrong_destination`; no payments at all: `transaction_has_no_matching_payment`.
- Unsupported operations (path payment, claimable balance create/claim, `invoke_host_function`, `account_merge`, `create_account`) that **could credit the expected destination** (named as recipient/claimant/`asset_balance_changes.to`, or contract calls without `asset_balance_changes`) yield `*_not_supported` findings (unsupported). Alongside a full direct match they still make the result unsupported (`unsupported_operation_alongside_match`), because the direct payment may not be the only credit. Unrelated ones are noted and ignored.

### 6.4 Combining with the status expectation
| Expectation | Leg matched | Evidence missing (no id or no evidence) | Other leg states |
|---|---|---|---|
| none | `payment_before_status_advanced` (discrepant) | no id: pending; id given: insufficient | their findings |
| required | `completed`: matched; else pending | insufficient (`stellar_transaction_id_missing` / `onchain_evidence_missing`) | their findings |
| inflight | pending | pending | their findings |
| failure | `funds_received_but_terminal_failure` (discrepant) | `absence_not_provable` (insufficient) | their findings |
| refunded | no effect (refund decides) | no effect (refund decides) | their findings |

Refunds: each `id_type: stellar` payment is checked as a leg of its own (destination = withdrawal `from`, same asset, exact `amount`; deposit refunds on Stellar are `refund_not_observable`). Status `refunded` is `matched` only when every on-chain refund matches and at least one exists; external-only or absent refunds are `refund_not_observable` (insufficient_evidence). Refund totals are checked against the listed payments.
If the status history is contradictory (6.6) the status-dependent conclusions are withheld; evidence-versus-record mismatches still stand.

### 6.5 Outcome
Each finding has an `effect` (an outcome class or null for notes). The transaction outcome is the most severe effect: `discrepant` > `ambiguous` > `unsupported` > `insufficient_evidence` > `pending` > `matched`. Every transaction receives at least one effect finding. `overall` is the most severe across transactions.

| Outcome | Meaning |
|---|---|
| matched | The Stellar leg agrees with a completed (or refunded) record. Says nothing about off-chain legs. |
| pending | The record is in progress and the evidence is consistent with that, or no transfer is required yet. |
| discrepant | Evidence contradicts the record, or the record contradicts itself. |
| ambiguous | More than one explanation fits (several operations/transactions, or the status history cannot be ordered). |
| unsupported | The payment form or status is outside v1. Never success. |
| insufficient_evidence | The evidence needed is missing, truncated, from the wrong network or could not be read. Never a mismatch and never a pass. |

### 6.6 Timeline determinism
Snapshots with identical canonical JSON (sorted keys) collapse into one entry (occurrences and source ids retained). Status time: `updated_at`; for `completed`/`refunded` snapshots without it, `completed_at`; `started_at` is never a status time; unparseable times are `time_invalid`. Order key: untimed first, then time ascending, then lifecycle rank (`incomplete` 0, `pending_user_transfer_start` 1, `pending_user`/`pending_trust` 2, `pending_anchor`/`on_hold` 3, `pending_user_transfer_complete` 4, `pending_external` 5, `pending_stellar` 6, terminal 10, unknown 5), then status name, then canonical JSON. The current state is the last entry; equal timestamps are resolved by rank, so terminal states win ties. Input order never participates. Unresolvable situations are findings: same status and time with different content, or different terminal statuses at one instant (`status_history_conflict`), or a different status after a terminal one (`status_after_terminal`), both ambiguous.

## 7. Redaction
`export --redact [accounts,issuers,memos,emails,hashes|all]` (default accounts, memos, emails). Values become `[account-N]`, `[issuer-N]`, `[memo-N]`, `[email-N]`, `[hash-N]`, `[reference-N]`, numbered over the **sorted** distinct values, so output is deterministic and equal values stay linkable. An address seen anywhere as an asset issuer is treated as an issuer everywhere. Secret keys (`S...`) are always removed. External refund references are redacted with memos. The mapping can be written to a separate private file. Free text in `message` is scanned for addresses, emails and known memos only; review before sharing.

## 8. Interfaces
CLI `anchortrace`: `reconcile <sep24...> [--evidence f]... [--horizon testnet|public|url] [--fee-policy] [--asset] [--anchor-account] [--tolerance-bps] [--network] [--format text|json|markdown] [--out] [--redact] [--fail-on] [--strict] [--timeout] [--allow-http] [--now]`, `explain <report> [--tx]`, `export <report> [--redact] [--format] [--out] [--mapping-out]`, `validate <file>`, `schema report|evidence|case`.
Exit codes: `0` no transaction has a failing outcome; `1` an outcome named by `--fail-on` (default `discrepant,ambiguous,unsupported,insufficient_evidence`; `--strict` adds `pending`); `2` invalid input or usage (including unreadable files); `3` unexpected error.
Library: `reconcileSupplied`, `reconcile`, `HorizonSource`, `redactReport`, `renderText|Markdown|Explain`, schemas. The root export is browser-safe (no Node modules, no `@stellar/stellar-sdk`).

## 9. Failure classes
- Input errors (exit 2): unreadable file, invalid JSON, not a SEP-24 record, invalid evidence shape, operation/transaction hash mismatch, two sources disagreeing about one transaction's contents.
- Evidence acquisition failures (become findings, never exceptions): not found, HTTP error, timeout, oversize, malformed response, hash mismatch, invalid hash. The Horizon adapter has timeouts (default 15 s), a body cap (2 MB), refuses redirects, and refuses plain `http://` unless `--allow-http`.
- Never a failure but a finding: unknown status, missing fields, unsupported forms.

## 10. Architecture
`decimal.ts` (bigint stroops), `strkey.ts`, `asset.ts`, `sep24.ts` (schema, statuses, expectations), `timeline.ts`, `evidence.ts` (Horizon normalisation), `leg.ts` (operation matching), `reconcile.ts` (expectations, fee policy, refunds, outcomes), `horizon.ts` (GET-only adapter), `input.ts` and `run.ts` (parsing, provenance, `reconcileSupplied`), `redact.ts`, `render.ts`, `reportSchema.ts`, `schemas.ts`, `cli.ts`. Only `cli.ts` and `horizon.ts`' use of `fetch` touch the outside world.

## 11. Acceptance (each is an automated test, see `test/`)
- Wrong destination, wrong issuer, wrong amount, wrong memo, wrong sender, failed transaction: discrepant, with the specific finding (`reconcile.test.ts`, real testnet transactions).
- Multi-operation withdrawal: ambiguous, never matched (`reconcile.test.ts`).
- Path payment, claimable balance, Soroban contract transfer, claimable-balance deposit, unknown status: unsupported (`reconcile.test.ts`).
- Missing evidence, failed/404 reads, truncated operations, wrong network, missing asset: insufficient_evidence (`reconcile.test.ts`, `horizon.test.ts`).
- Duplicate and reordered status updates yield identical reports for every permutation (`timeline.test.ts`, `determinism.test.ts`).
- error/refunded/expired/too_small/too_large/no_market handling, refund verification (`reconcile.test.ts`).
- Fee policies and exact decimal arithmetic including above 2^53 stroops (`policy.test.ts`, `decimal.test.ts`).
- Redaction removes accounts, memos, emails; deterministic aliases; schema-valid (`redact.test.ts`).
- Every example report validates against the published JSON Schema with an independent validator and is reproduced by the engine (`schema.test.ts`, `examples.test.ts`).
- Live adapter reproduces every recorded testnet transaction from the real Horizon (`test/live`, opt-in; transcript in `docs/evidence/`).

## 12. Known gaps
See README "Limitations".
