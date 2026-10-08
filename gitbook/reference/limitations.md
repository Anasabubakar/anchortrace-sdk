# Limitations

- Classic direct `payment` operations only. SEP-24 tells anchors to also listen for path payments; v1 reports them `unsupported` so a human decides.
- The external leg (bank, cash, mobile money, crypto rail) is never observed. `matched` and `completed` say nothing about it.
- Evidence is what you supply or what one Horizon returned at one time. No cryptographic ledger verification; one Horizon instance is trusted for a live read.
- Absence cannot be proven: terminal failure statuses without evidence are `insufficient_evidence`, not "confirmed no payment". The tool reads transactions by hash; it does not scan an account's history.
- The SEP-24 record does not state the on-chain asset when `amount_in_asset`/`amount_out_asset` are omitted; you must pass `--asset`. Cross-asset (converted) amounts are not checked.
- The fee policy is an explicit interpretation, not something SEP-24 stores. Pick the one that matches the anchor; a wrong choice shows up as an amount mismatch, not silently.
- Redaction scans free text for addresses, emails and known memos only. Review exports before sharing.
- The shipped SEP-24 records are synthetic. No anchor, wallet or support team has used this tool; there is no adoption evidence.
- No Soroban/SEP-41 token transfers, liquidity pools, offers, SEP-6/31.
