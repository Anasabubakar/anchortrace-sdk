# anchortrace-sdk

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

## Install and run

Published to npm as `@anas.abubakar/anchortrace-sdk`. From a clone (Node 22 or newer, pnpm 11):

```bash
git clone <this repo> && cd anchortrace-sdk
pnpm install --frozen-lockfile
pnpm build
node dist/cli.js reconcile examples/cases/wrong-issuer.case.json
```

```bash
# a SEP-24 record file plus evidence files (raw Horizon /transactions/{hash} and /operations bodies)
node dist/cli.js reconcile record.json --evidence ops.json

# the same, reading the transaction live from Horizon (read-only GET)
node dist/cli.js reconcile examples/sep24/wrong-issuer.sep24.json --horizon testnet --network testnet

node dist/cli.js reconcile record.json --evidence ops.json --format json --out report.json
node dist/cli.js explain report.json                 # step-by-step why, and what would change it
node dist/cli.js export report.json --redact --out shareable.json
node dist/cli.js validate record.json                # offline shape check
node dist/cli.js schema report > report.schema.json
```

Options that change the verdict are explicit: `--fee-policy anchor_deducted|customer_paid_on_top|no_fee` (default `anchor_deducted`, echoed in the report), `--asset CODE:ISSUER|native` when the record omits the asset (it is never guessed), `--tolerance-bps`, `--anchor-account` (deposits), `--network testnet|public`.

Exit codes: `0` no failing outcome; `1` an outcome named by `--fail-on` (default `discrepant,ambiguous,unsupported,insufficient_evidence`; `--strict` adds `pending`); `2` invalid input or usage; `3` unexpected error.

## Demo from real testnet transactions

`fixtures/testnet/` holds raw Horizon responses for real classic transactions made on Stellar testnet with throwaway accounts (see `fixtures/testnet/manifest.json` for accounts, asset and hashes). The anchor-side SEP-24 records in `examples/` are **synthetic**: no real anchor produced them. Each of the 18 cases in `examples/cases/` pairs one synthetic record with one recorded transaction, and `examples/reports/` holds what the engine produced:

| Case | Outcome | What it shows |
|---|---|---|
| `matched-withdrawal`, `matched-deposit`, `refunded-with-onchain-refund`, `reordered-and-duplicate-updates` | matched | the Stellar leg agrees |
| `wrong-destination`, `wrong-issuer`, `wrong-amount`, `wrong-memo`, `failed-onchain-transaction`, `error-status-funds-received` | discrepant | each is its own finding with the operation highlighted |
| `ambiguous-multi-operation`, `status-history-conflict` | ambiguous | 60 + 40 to the anchor is not one withdrawal of 100 |
| `unsupported-path-payment`, `unsupported-claimable-balance`, `unsupported-soroban-transfer` | unsupported | real chain forms v1 does not interpret |
| `pending-awaiting-user-transfer`, `pending-external-chain-confirmed` | pending | status drives what must be on chain |
| `insufficient-missing-evidence` | insufficient_evidence | missing is not a pass |

Excerpt (`wrong-issuer`, run against live Horizon testnet; full transcript in `docs/evidence/cli-live-horizon-wrong-issuer.txt`):

```
Transaction syn-wd-001 (withdrawal): DISCREPANT
  Operation 21782411972972545 paid TRACEUSD:GAZ3S5...ER6ZII but the record expects the same code from issuer GC7Q2W...JRJD. A same-code asset from a different issuer is a different asset.
  Evidence considered (linked by stellar_transaction_id):
    [conflicting] payment op 21782411972972545 in c44916ee...e810d9: 100.0000000 TRACEUSD:GAZ3S5... -> GBC4Y6...J7VI memo(id)=1003
```

## Evidence in this repository

| What | Where |
|---|---|
| Real testnet transaction hashes, accounts, asset, scenario notes | `fixtures/testnet/manifest.json` |
| Raw Horizon bodies for each transaction (11 files) | `fixtures/testnet/evidence/*.json` |
| Script that created them (stellar-sdk, fixture tooling only) | `scripts/testnet-fixtures.mjs` |
| Live adapter reproduces every recorded transaction from real Horizon testnet | `test/live/horizon.live.test.ts`, transcript `docs/evidence/live-horizon-testnet-test.txt` (run with `pnpm test:live`) |
| CLI runs against real Horizon testnet | `docs/evidence/cli-live-horizon-*.txt` |
| Engine-generated example reports | `examples/reports/`, bundle `examples/examples.v1.json` |
| Published JSON Schemas (zod-generated, validated with Ajv in tests) | `schema/` |

## Library use

```ts
import { reconcileSupplied, HorizonSource, renderText } from "@anas.abubakar/anchortrace-sdk";
const report = reconcileSupplied({ records: [{ label: "tx.json", value: sep24Json }], evidence: [{ label: "ops.json", value: horizonJson }] });
```

The root export is browser-safe (no Node built-ins, no `@stellar/stellar-sdk`); it is what the [anchortrace-studio](https://github.com/Anasabubakar/anchortrace-studio) browser app bundles. Versions: tool 0.1.0, report schema 1, evidence schema 1, case schema 1, SEP-24 v3.8.0.

## How it was verified

On 2026-10-07, from a clean clone: `pnpm install --frozen-lockfile`, `pnpm run typecheck`, `pnpm run check:schema`, `pnpm run check:examples`, `pnpm test` (150 tests pass; 3 live tests skipped unless `ANCHORTRACE_LIVE=1`), `pnpm build`, then the built CLI. The 3 live tests were run separately against the real Horizon testnet and passed (`docs/evidence/live-horizon-testnet-test.txt`). Expectations in the tests come from the SEP-24 text and from the recorded chain evidence, not from the engine's own output.

## Supported versions

Node >= 22 (CI on 24). Horizon JSON as returned by horizon-testnet.stellar.org on 2026-10-07 (`payment`, `path_payment_strict_send`, `create_claimable_balance`, `invoke_host_function` shapes were recorded). SEP-24 v3.8.0 statuses and fields. Public network reads use the same code path but were not exercised in tests.

## Limitations

- Classic direct `payment` operations only. SEP-24 tells anchors to also listen for path payments; v1 reports them `unsupported` so a human decides.
- The external leg (bank, cash, mobile money, crypto rail) is never observed. `matched` and `completed` say nothing about it.
- Evidence is what you supply or what one Horizon returned at one time. No cryptographic ledger verification; one Horizon instance is trusted for a live read.
- Absence cannot be proven: terminal failure statuses without evidence are `insufficient_evidence`, not "confirmed no payment". The tool reads transactions by hash; it does not scan an account's history.
- The SEP-24 record does not state the on-chain asset when `amount_in_asset`/`amount_out_asset` are omitted; you must pass `--asset`. Cross-asset (converted) amounts are not checked.
- The fee policy is an explicit interpretation, not something SEP-24 stores. Pick the one that matches the anchor; a wrong choice shows up as an amount mismatch, not silently.
- Redaction scans free text for addresses, emails and known memos only. Review exports before sharing.
- The shipped SEP-24 records are synthetic. No anchor, wallet or support team has used this tool; there is no adoption evidence.
- No Soroban/SEP-41 token transfers, liquidity pools, offers, SEP-6/31.

## Contributors

<a href="https://github.com/Anasabubakar/anchortrace-sdk/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=Anasabubakar/anchortrace-sdk" alt="Contributors to anchortrace-sdk" />
</a>
