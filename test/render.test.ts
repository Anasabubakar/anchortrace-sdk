import { describe, expect, it } from "vitest";
import { renderExplain, renderMarkdown, renderText } from "../src/render.ts";
import { run, withdrawal } from "./helpers/cases.ts";

const r = run([withdrawal("w05-multi-operation", { withdraw_memo: "1005" })], ["w05-multi-operation"]);

describe("renderings", () => {
  it("text lists the outcome, expected leg, the conflicting operations, findings, provenance and limitations", () => {
    const t = renderText(r);
    expect(t).toMatch(/Overall: AMBIGUOUS/);
    expect(t).toMatch(/Expected leg: 100\.0000000 TRACEUSD:G/);
    expect(t).toMatch(/\[conflicting\] payment op \d+ in/g);
    expect(t.match(/\[conflicting\]/g)).toHaveLength(2);
    expect(t).toMatch(/Inputs:/);
    expect(t).toMatch(/Limitations:/);
    expect(t).toMatch(/Confirmation on chain is not a bank payout/);
  });
  it("markdown has a summary table and the same note", () => {
    const m = renderMarkdown(r);
    expect(m).toMatch(/\| Transaction \| Kind \| Status \| Outcome \|/);
    expect(m).toMatch(/\*\*AMBIGUOUS\*\*/);
    expect(m).toMatch(/not a bank payout/);
  });
  it("explain gives the five steps and a hint that never suggests moving funds", () => {
    const e = renderExplain(r);
    for (const step of ["1. What the record says", "2. What was expected on chain", "3. What the evidence showed", "4. Why this outcome", "5. What would change it"]) expect(e).toContain(step);
    expect(e).toMatch(/AnchorTrace deliberately does not choose one/);
    expect(e).not.toMatch(/\b(send|transfer|refund the)\b.*(funds|payment) to/i);
  });
  it("marks a redacted export in the text", async () => {
    const { redactReport } = await import("../src/redact.ts");
    expect(renderText(redactReport(r, ["accounts"]).report)).toMatch(/REDACTED export: accounts/);
  });
});
