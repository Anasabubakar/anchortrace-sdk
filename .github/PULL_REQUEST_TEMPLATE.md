## What and why

## How it was verified
- [ ] `pnpm run typecheck && pnpm test` pass locally
- [ ] Classification changes update `SPEC.md` and add a test that fails without the change, with expectations from the protocol or recorded evidence
- [ ] `pnpm run schema && pnpm run examples` were run if report shapes or examples changed
- [ ] No path was added that treats chain confirmation as a bank payout, an unsupported form as matched, or a failed read as a mismatch
- [ ] No keys, signing or non-GET requests were added to `src/`
