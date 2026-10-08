# Library use

```ts
import { reconcileSupplied, HorizonSource, renderText } from "@anas.abubakar/anchortrace-sdk";
const report = reconcileSupplied({ records: [{ label: "tx.json", value: sep24Json }], evidence: [{ label: "ops.json", value: horizonJson }] });
```

The root export is browser-safe (no Node built-ins, no `@stellar/stellar-sdk`); it is what the [anchortrace-studio](https://github.com/Anchor-Trace/anchortrace-studio) browser app bundles. Versions: tool 0.1.0, report schema 1, evidence schema 1, case schema 1, SEP-24 v3.8.0.
