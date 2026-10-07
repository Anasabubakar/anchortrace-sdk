import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderText } from "../src/render.ts";
import { reconcileSupplied } from "../src/run.ts";
import { parseReport } from "../src/reportSchema.ts";

const bundle = JSON.parse(readFileSync(new URL("../examples/examples.v1.json", import.meta.url), "utf8"));
const NOW = new Date(bundle.generatedAt);

describe("shipped examples", () => {
  it("every case is labelled synthetic and says where its evidence came from", () => {
    for (const c of bundle.cases) {
      expect(c.case.synthetic, c.id).toBe(true);
      expect(c.case.evidenceNote.length, c.id).toBeGreaterThan(20);
    }
  });

  it("recomputing each case with the engine reproduces the shipped report exactly", () => {
    for (const c of bundle.cases) {
      const again = reconcileSupplied({ records: [{ label: `${c.id}.case.json`, value: c.case }], now: NOW });
      expect(again, c.id).toEqual(c.report);
      expect(parseReport(c.report).ok, c.id).toBe(true);
    }
  });

  it("the outcome of each case equals the outcome its author intended (written independently of the engine)", () => {
    const expected: Record<string, string> = {
      "matched-withdrawal": "matched",
      "wrong-destination": "discrepant",
      "wrong-issuer": "discrepant",
      "wrong-amount": "discrepant",
      "ambiguous-multi-operation": "ambiguous",
      "wrong-memo": "discrepant",
      "failed-onchain-transaction": "discrepant",
      "unsupported-path-payment": "unsupported",
      "unsupported-claimable-balance": "unsupported",
      "unsupported-soroban-transfer": "unsupported",
      "pending-awaiting-user-transfer": "pending",
      "pending-external-chain-confirmed": "pending",
      "insufficient-missing-evidence": "insufficient_evidence",
      "error-status-funds-received": "discrepant",
      "reordered-and-duplicate-updates": "matched",
      "status-history-conflict": "ambiguous",
      "matched-deposit": "matched",
      "refunded-with-onchain-refund": "matched",
    };
    expect(bundle.cases.map((c: any) => c.id).sort()).toEqual(Object.keys(expected).sort());
    for (const c of bundle.cases) expect(c.report.transactions.map((t: any) => t.outcome), c.id).toEqual([expected[c.id]]);
  });

  it("all six finding classes appear among the examples", () => {
    const seen = new Set(bundle.cases.flatMap((c: any) => c.report.transactions.map((t: any) => t.outcome)));
    expect([...seen].sort()).toEqual(["ambiguous", "discrepant", "insufficient_evidence", "matched", "pending", "unsupported"]);
  });

  it("every withdrawal report states that chain confirmation is not a bank payout", () => {
    for (const c of bundle.cases) {
      const r = c.report;
      expect(r.limitations[0]).toMatch(/not a bank payout/);
      for (const t of r.transactions.filter((x: any) => x.kind === "withdrawal")) {
        expect(t.findings.map((f: any) => f.code)).toContain("external_payout_not_verified");
        expect(renderText(r)).toMatch(/not a bank payout/i);
      }
    }
  });

  it("no example claims a bank payout happened", () => {
    for (const c of bundle.cases) expect(JSON.stringify(c.report)).not.toMatch(/payout (was|has been) (made|completed|confirmed)|bank (paid|payment confirmed)/i);
  });
});
