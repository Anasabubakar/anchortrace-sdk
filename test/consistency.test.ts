import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseReport } from "../src/index.ts";

const files = readdirSync("examples/reports").filter((f) => f.endsWith(".report.json"));
const load = (f: string) => JSON.parse(readFileSync(`examples/reports/${f}`, "utf8"));

describe("report self-consistency", () => {
  it("accepts every shipped example report", () => {
    expect(files.length).toBeGreaterThan(10);
    for (const f of files) expect(parseReport(load(f)), f).toMatchObject({ ok: true });
  });

  it("rejects a discrepant report whose headline was changed to matched", () => {
    const f = files.find((n) => load(n).overall === "discrepant")!;
    const raw = load(f);
    raw.overall = "matched";
    const r = parseReport(raw);
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.error).toMatch(/overall is "matched"/);
  });

  it("rejects a changed transaction outcome and changed summary counts", () => {
    const f = files.find((n) => load(n).overall === "discrepant")!;
    const a = load(f);
    a.transactions[0].outcome = "matched";
    expect(parseReport(a)).toMatchObject({ ok: false });
    const b = load(f);
    b.summary.matched += 1;
    expect(parseReport(b)).toMatchObject({ ok: false });
  });
});
