# Contributing

Bug reports with a record, the evidence and the outcome you expected are the most useful contribution.

## Setup
Node >= 22, pnpm 11. `pnpm install --frozen-lockfile`, then `pnpm run typecheck`, `pnpm test`, `pnpm run build`. Network tests are opt-in: `pnpm test:live`.

## Rules that keep the tool honest
- Classification changes update `SPEC.md` and add a test that fails without the change. Expectations come from the protocol or the recorded evidence, never from running the engine and pasting its answer.
- A missing or unreadable input is never a pass and never a mismatch: it is `insufficient_evidence`.
- Never add a path where chain confirmation is described as a bank payout, or where an unsupported form becomes `matched`.
- Amounts are exact: strings in, bigint stroops inside. No floats.
- Read-only: no key handling, no signing, no transaction submission, no non-`GET` requests. Fixture tooling in `scripts/` may sign on testnet only.
- Generated files (`schema/`, `examples/`) are produced by `pnpm schema` and `pnpm examples`; CI fails when they are stale.
- Synthetic data is labelled synthetic. Do not add real customer data; redact first.
- Scripts under `scripts/` run with `node --experimental-strip-types`: no enums or parameter properties there.
- Commits: one logical unit each, conventional prefixes (`feat`, `fix`, `test`, `docs`, `build`, `ci`, `chore`). No AI co-author trailers.
