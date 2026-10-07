import { readFileSync } from "node:fs";
import { reconcileSupplied, type RunInput } from "../../src/run.ts";
import type { Report, TransactionReport } from "../../src/reportSchema.ts";
import type { ReconcileOptions } from "../../src/reconcile.ts";

export const ANCHOR = "GBC4Y6VLSLAMPSRSHPRF4WQ7UVUYCG3RYUZMDZX6UUE6AHBVNCVIJ7VI";
export const ISSUER = "GC7Q2WPYYUISJ2FL26UVAEDSYJG2OBIFIGZSW2NYQCMOUKPM4LI3JRJD";
export const ROGUE = "GAZ3S5TXIUUSAW7UC2RPQXNYWUJZSTSH5CPHG5RYNMOUBMJL45ER6ZII";
export const WALLET = "GCWEQIIHHZN2BS5Y7VPXMTMNHFL7Y5GEWJFG4QKPGRUIOP76JBVUXFWH";
export const OTHER = "GAJF3UA262M4GDTH4SC6BKOVML5WEH2IRS4LRV7Y2FXJPX7XOBSWWWAZ";
export const NOW = new Date("2026-10-07T12:00:00Z");
export const GOOD_ASSET = `stellar:TRACEUSD:${ISSUER}`;

export function evidence(name: string): any {
  return JSON.parse(readFileSync(new URL(`../../fixtures/testnet/evidence/${name}.json`, import.meta.url), "utf8"));
}
export function hashOf(name: string): string {
  return evidence(name).items[0].transaction.hash;
}

/** A withdrawal record whose fields come from the recorded testnet scenario named by `fixture`. */
export function withdrawal(fixture: string | null, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "wd-1",
    kind: "withdrawal",
    status: "completed",
    started_at: "2026-10-07T13:55:00Z",
    updated_at: "2026-10-07T14:30:00Z",
    amount_in: "100.0000000",
    amount_in_asset: GOOD_ASSET,
    amount_out: "98.0000000",
    fee_details: { total: "2.0000000", asset: GOOD_ASSET },
    withdraw_anchor_account: ANCHOR,
    withdraw_memo: "1001",
    withdraw_memo_type: "id",
    from: WALLET,
    ...(fixture === null ? {} : { stellar_transaction_id: hashOf(fixture) }),
    ...over,
  };
}

export function run(records: unknown[], fixtures: Array<string | object> = [], options?: ReconcileOptions, extra: Partial<RunInput> = {}): Report {
  return reconcileSupplied({
    records: records.map((r, i) => ({ label: `record-${i + 1}.json`, value: r })),
    evidence: fixtures.map((f, i) => ({ label: typeof f === "string" ? `${f}.json` : `evidence-${i + 1}.json`, value: typeof f === "string" ? evidence(f) : f })),
    ...(options ? { options } : {}),
    now: NOW,
    ...extra,
  });
}

export function only(report: Report): TransactionReport {
  if (report.transactions.length !== 1) throw new Error("expected one transaction");
  return report.transactions[0] as TransactionReport;
}
export const codes = (t: TransactionReport) => t.findings.map((f) => f.code);
export const find = (t: TransactionReport, code: string) => t.findings.find((f) => f.code === code);
