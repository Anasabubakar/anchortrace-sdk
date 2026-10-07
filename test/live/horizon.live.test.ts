// Opt-in: ANCHORTRACE_LIVE=1 vitest run test/live
// Reads the REAL testnet Horizon for the transactions recorded in fixtures/testnet and checks the live adapter
// returns the same operations as the recorded files, then reconciles synthetic SEP-24 records against live evidence.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HorizonSource } from "../../src/horizon.ts";
import { parseEvidenceFile } from "../../src/evidence.ts";
import { reconcileSupplied } from "../../src/run.ts";
import { ANCHOR, GOOD_ASSET, WALLET } from "../helpers/cases.ts";

const live = process.env.ANCHORTRACE_LIVE === "1";
const manifest = JSON.parse(readFileSync(new URL("../../fixtures/testnet/manifest.json", import.meta.url), "utf8"));

describe.skipIf(!live)("live Horizon testnet", () => {
  const src = new HorizonSource("testnet", { timeoutMs: 20_000 });
  let n = 0;
  const next = () => `src-live-${++n}`;

  it("returns the same normalised operations as the recorded evidence for every scenario", async () => {
    for (const [name, s] of Object.entries(manifest.scenarios) as Array<[string, { hash: string }]>) {
      const recorded = parseEvidenceFile(JSON.parse(readFileSync(new URL(`../../fixtures/testnet/evidence/${name}.json`, import.meta.url), "utf8")), "rec").transactions[0]!;
      const a = await src.acquire([s.hash], next);
      expect(a.failures, name).toEqual([]);
      const strip = (t: typeof recorded) => ({ ...t, sourceId: "x", operations: t.operations });
      expect(strip(a.transactions[0]!), name).toEqual(strip(recorded));
      expect(a.provenance[0]!.network).toBe("testnet");
    }
  }, 120_000);

  it("reconciles a synthetic withdrawal record against live chain evidence", async () => {
    const hash = manifest.scenarios["w01-correct-withdrawal-payment"].hash as string;
    const acquired = await src.acquire([hash], next);
    const record = { id: "synthetic-live-1", kind: "withdrawal", status: "completed", amount_in: "100.0000000", amount_in_asset: GOOD_ASSET, amount_out: "98.0000000", fee_details: { total: "2.0000000", asset: GOOD_ASSET }, withdraw_anchor_account: ANCHOR, withdraw_memo: "1001", withdraw_memo_type: "id", from: WALLET, stellar_transaction_id: hash, updated_at: "2026-10-07T14:30:00Z" };
    const report = reconcileSupplied({ records: [{ label: "synthetic.json", value: record }], acquired, options: { expectedNetwork: "testnet" } });
    expect(report.transactions[0]!.outcome).toBe("matched");
    expect(report.inputs.some((i) => i.kind === "horizon" && i.httpStatus === 200)).toBe(true);
  }, 60_000);

  it("a random unknown hash is reported as not found, not as a mismatch", async () => {
    const a = await src.acquire(["0".repeat(64)], next);
    expect(a.failures[0]!.kind).toBe("not_found");
  }, 30_000);
});
