# Evidence in this repository

| What | Where |
|---|---|
| Real testnet transaction hashes, accounts, asset, scenario notes | `fixtures/testnet/manifest.json` |
| Raw Horizon bodies for each transaction (11 files) | `fixtures/testnet/evidence/*.json` |
| Script that created them (stellar-sdk, fixture tooling only) | `scripts/testnet-fixtures.mjs` |
| Live adapter reproduces every recorded transaction from real Horizon testnet | `test/live/horizon.live.test.ts`, transcript `docs/evidence/live-horizon-testnet-test.txt` (run with `pnpm test:live`) |
| CLI runs against real Horizon testnet | `docs/evidence/cli-live-horizon-*.txt` |
| Engine-generated example reports | `examples/reports/`, bundle `examples/examples.v1.json` |
| Published JSON Schemas (zod-generated, validated with Ajv in tests) | `schema/` |
