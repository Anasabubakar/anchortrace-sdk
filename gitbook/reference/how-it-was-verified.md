# How it was verified

On 2026-10-07, from a clean clone: `pnpm install --frozen-lockfile`, `pnpm run typecheck`, `pnpm run check:schema`, `pnpm run check:examples`, `pnpm test` (150 tests pass; 3 live tests skipped unless `ANCHORTRACE_LIVE=1`), `pnpm build`, then the built CLI. The 3 live tests were run separately against the real Horizon testnet and passed (`docs/evidence/live-horizon-testnet-test.txt`). Expectations in the tests come from the SEP-24 text and from the recorded chain evidence, not from the engine's own output.
