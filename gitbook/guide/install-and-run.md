# Install and run

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
