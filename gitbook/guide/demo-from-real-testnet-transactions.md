# Demo from real testnet transactions

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
