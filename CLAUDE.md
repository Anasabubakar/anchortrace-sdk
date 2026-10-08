# anchortrace-sdk: working notes

Commands: `pnpm install --frozen-lockfile`, `pnpm run typecheck`, `pnpm test`, `pnpm run build`, `pnpm run schema`, `pnpm run examples`, `pnpm run check:schema`, `pnpm run check:examples`, `pnpm test:live` (network, opt-in).
Constraints: pnpm 11; Node >= 22; TS 7 (`tsc`, NodeNext, `.ts` import specifiers with `rewriteRelativeImportExtensions`); zod 4 (`z.toJSONSchema`); scripts run with `node --experimental-strip-types` (no enums or parameter properties in `scripts/`). `src/index.ts` must stay browser-safe (no `node:` imports, no `@stellar/stellar-sdk`). Only `cli.ts` touches files.
Rules: never add a non-GET request, signing or key handling to `src/`. A failed read is `insufficient_evidence`, never a mismatch. `matched` never implies a bank payout. Unsupported forms never become `matched`. Amounts are strings/bigint, never floats.
Generated: `schema/` and `examples/` (CI fails if stale). The studio vendors a tarball of this package; after changing report/evidence/case schemas bump the schema version and update the studio pairing.
Testnet: fixture accounts are identities `at-issuer at-rogue at-wallet at-anchor at-other` in `~/.config/stellar`; keys never go in the repo. `scripts/testnet-fixtures.mjs` makes real testnet transactions (fixture tooling only).
Commit rules: one logical unit per commit, no AI co-author trailers, author is the repo owner.
Unfinished: a real anchor or support-team review of the outcome vocabulary; public-network live tests; Soroban/path-payment interpretation (deliberately out of v1).
