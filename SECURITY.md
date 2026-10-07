# Security

AnchorTrace is a read-only reporting tool. It holds no keys, signs nothing and submits nothing. Its results are observations, not a security or compliance assessment.

Report a vulnerability (for example input that makes the engine report `matched` for a different asset or issuer, a way to leak an account, memo or secret key past `--redact`, or a way to make the Horizon adapter send anything other than a `GET`) through GitHub's private vulnerability reporting for this repository (Security tab, "Report a vulnerability"). Please do not open a public issue for it.

Out of scope: the testnet fixture accounts and keys used to create `fixtures/testnet` (testnet only, keys are not in this repository); the correctness of any anchor's own records.
