import { describe, expect, it } from "vitest";
import { DEFAULT_REDACTION, parseRedactCategories, redactReport } from "../src/redact.ts";
import { parseReport } from "../src/reportSchema.ts";
import { ANCHOR, ISSUER, OTHER, WALLET, ROGUE, hashOf, run, withdrawal } from "./helpers/cases.ts";

const email = "alice@example.org";
function sample() {
  return run([withdrawal("w03-wrong-issuer", { withdraw_memo: "1003", message: `Customer ${email} asked about memo 1003 from ${WALLET}` })], ["w03-wrong-issuer"]);
}
const text = (r: unknown) => JSON.stringify(r);

describe("redacted export", () => {
  it("default redaction removes account addresses, memos and emails but keeps issuers and hashes", () => {
    const { report } = redactReport(sample(), DEFAULT_REDACTION);
    const t = text(report);
    for (const secret of [ANCHOR, WALLET, email, "alice"]) expect(t, secret).not.toContain(secret);
    // memo values are gone from structured fields and from free text
    expect(t).not.toMatch(/"memo":"1003"/);
    expect(t).not.toContain("1003");
    // issuers and hashes stay: they give the report its meaning
    expect(t).toContain(ISSUER);
    expect(t).toContain(ROGUE);
    expect(t).toContain(hashOf("w03-wrong-issuer"));
    expect(report.redaction).toEqual({ categories: ["accounts", "memos", "emails"] });
    expect(report.transactions[0]!.outcome).toBe("discrepant");
  });

  it("is deterministic: aliases follow sorted distinct values, so input order cannot change them", () => {
    const a = redactReport(sample(), DEFAULT_REDACTION);
    const b = redactReport(sample(), DEFAULT_REDACTION);
    expect(text(a.report)).toBe(text(b.report));
    const accounts = Object.entries(a.mapping).filter(([, v]) => v.startsWith("[account-")).sort(([x], [y]) => (x < y ? -1 : 1));
    expect(accounts.map(([, v]) => v)).toEqual(accounts.map((_, i) => `[account-${i + 1}]`));
  });

  it("keeps equal values linkable: the same address always gets the same alias", () => {
    const { report, mapping } = redactReport(sample(), DEFAULT_REDACTION);
    const alias = mapping[ANCHOR]!;
    expect(alias).toMatch(/^\[account-\d+\]$/);
    expect(report.transactions[0]!.expected!.destination).toBe(alias);
    expect(report.transactions[0]!.matching.candidates[0]!.to).toBe(alias);
  });

  it("still validates against the published report schema and says what was redacted", () => {
    const { report } = redactReport(sample(), ["accounts", "issuers", "memos", "emails", "hashes"]);
    expect(parseReport(report).ok).toBe(true);
    const t = text(report);
    for (const s of [ANCHOR, WALLET, ISSUER, ROGUE, hashOf("w03-wrong-issuer"), email]) expect(t, s).not.toContain(s);
    expect(report.redaction!.categories).toEqual(["accounts", "issuers", "memos", "emails", "hashes"]);
  });

  it("redacts only the requested categories", () => {
    const { report } = redactReport(sample(), ["emails"]);
    const t = text(report);
    expect(t).not.toContain(email);
    expect(t).toContain(ANCHOR);
    expect(t).toContain("1003");
  });

  it("never lets a secret key through, in any category selection", () => {
    const secretLike = "S" + "A".repeat(55);
    const r = run([withdrawal("w01-correct-withdrawal-payment", { message: `oops ${secretLike}` })], ["w01-correct-withdrawal-payment"]);
    expect(text(redactReport(r, ["emails"]).report)).not.toContain(secretLike);
  });

  it("redacts external refund references under the memo category", () => {
    const r = run([withdrawal(null, { status: "refunded", refunds: { amount_refunded: "100.0000000", amount_fee: "0.0000000", payments: [{ id: "BANK-REF-77", id_type: "external", amount: "100.0000000", fee: "0.0000000" }] } })]);
    const t = text(redactReport(r, DEFAULT_REDACTION).report);
    expect(t).not.toContain("BANK-REF-77");
  });

  it("parses category lists and rejects unknown ones", () => {
    expect(parseRedactCategories(undefined)).toEqual(["accounts", "memos", "emails"]);
    expect(parseRedactCategories("all")).toHaveLength(5);
    expect(parseRedactCategories("accounts,hashes")).toEqual(["accounts", "hashes"]);
    expect(() => parseRedactCategories("accounts,names")).toThrow(/unknown redaction category/);
  });

  it("keeps an address that is also a Stellar issuer visible when only accounts are redacted", () => {
    const { report } = redactReport(run([withdrawal("w02-wrong-destination", { withdraw_memo: "1002" })], ["w02-wrong-destination"]), ["accounts"]);
    const t = text(report);
    expect(t).not.toContain(OTHER);
    expect(t).toContain(ISSUER);
  });
});
