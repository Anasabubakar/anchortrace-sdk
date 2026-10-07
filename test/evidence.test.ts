import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { InputError } from "../src/errors.ts";
import { parseEvidenceFile } from "../src/evidence.ts";

const load = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/testnet/evidence/${name}.json`, import.meta.url), "utf8"));
const ANCHOR = "GBC4Y6VLSLAMPSRSHPRF4WQ7UVUYCG3RYUZMDZX6UUE6AHBVNCVIJ7VI";
const ISSUER = "GC7Q2WPYYUISJ2FL26UVAEDSYJG2OBIFIGZSW2NYQCMOUKPM4LI3JRJD";

describe("evidence normalisation from real Horizon testnet bodies", () => {
  it("reads a direct payment with identity, issuer-aware asset, exact amount and tx memo", () => {
    const { transactions } = parseEvidenceFile(load("w01-correct-withdrawal-payment"), "src-1");
    expect(transactions).toHaveLength(1);
    const tx = transactions[0]!;
    expect(tx.hash).toBe("70e181ec6b886344c1853d078aeb7a36d1ba25431fffa058ef00fe68a1400efd");
    expect(tx.successful).toBe(true);
    expect(tx.memoType).toBe("id");
    expect(tx.memo).toBe("1001");
    expect(tx.operationsComplete).toBe(true);
    const op = tx.operations[0]!;
    expect(op).toMatchObject({ type: "payment", class: "payment", to: ANCHOR, amount: "100.0000000" });
    expect(op.asset).toEqual({ kind: "issued", code: "TRACEUSD", issuer: ISSUER });
    expect(op.id).toBe("21782403383037953");
  });

  it("classifies the unsupported forms from real chain evidence", () => {
    const path = parseEvidenceFile(load("w06-path-payment"), "s").transactions[0]!.operations[0]!;
    expect(path).toMatchObject({ class: "unsupported", unsupportedKind: "path_payment", to: ANCHOR });
    const cb = parseEvidenceFile(load("w07-claimable-balance"), "s").transactions[0]!.operations[0]!;
    expect(cb).toMatchObject({ class: "unsupported", unsupportedKind: "claimable_balance", involvedAccounts: [ANCHOR], amount: "5.0000000" });
    const sor = parseEvidenceFile(load("w10-soroban-sac-transfer"), "s").transactions[0]!;
    expect(sor.memoType).toBe("none");
    expect(sor.operations[0]).toMatchObject({ class: "unsupported", unsupportedKind: "soroban", involvedAccounts: [ANCHOR] });
  });

  it("keeps a failed transaction's operations marked as not successful", () => {
    const tx = parseEvidenceFile(load("w09-failed-transaction"), "s").transactions[0]!;
    expect(tx.successful).toBe(false);
    expect(tx.operations[0]!.transactionSuccessful).toBe(false);
  });

  it("orders operations of a multi-operation transaction by operation id", () => {
    const tx = parseEvidenceFile(load("w05-multi-operation"), "s").transactions[0]!;
    expect(tx.operations.map((o) => o.amount)).toEqual(["60.0000000", "40.0000000"]);
    expect(tx.operations.map((o) => o.index)).toEqual([0, 1]);
    expect(BigInt(tx.operations[0]!.id)).toBeLessThan(BigInt(tx.operations[1]!.id));
  });

  it("flags truncated operation lists instead of treating them as complete", () => {
    const f = load("w05-multi-operation");
    f.items[0].operations._embedded.records.pop();
    expect(parseEvidenceFile(f, "s").transactions[0]!.operationsComplete).toBe(false);
  });

  it("rejects wrong versions, mismatched operation ownership and malformed bodies", () => {
    expect(() => parseEvidenceFile({ evidenceVersion: "2", items: [] }, "s")).toThrow(InputError);
    expect(() => parseEvidenceFile({}, "s")).toThrow(InputError);
    const f = load("w01-correct-withdrawal-payment");
    f.items[0].operations._embedded.records[0].transaction_hash = "0".repeat(64);
    expect(() => parseEvidenceFile(f, "s")).toThrow(/belongs to transaction/);
    const g = load("w01-correct-withdrawal-payment");
    g.items[0].transaction.hash = "NOT-A-HASH";
    expect(() => parseEvidenceFile(g, "s")).toThrow(InputError);
  });

  it("collapses an identical transaction listed twice and rejects a contradictory one", () => {
    const f = load("w01-correct-withdrawal-payment");
    f.items.push(structuredClone(f.items[0]));
    expect(parseEvidenceFile(f, "s").transactions).toHaveLength(1);
    f.items[1].operations._embedded.records[0].amount = "1.0000000";
    expect(() => parseEvidenceFile(f, "s")).toThrow(/appears twice/);
  });
});
