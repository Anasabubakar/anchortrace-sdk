import { readFileSync, readdirSync } from "node:fs";
import Ajv2020Module from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { SCHEMA_TARGETS, jsonSchemaFor } from "../src/schemas.ts";
import { FINDING_CODES, OUTCOMES } from "../src/reportSchema.ts";

const read = (p: string) => JSON.parse(readFileSync(new URL(`../${p}`, import.meta.url), "utf8"));
// ajv ships CommonJS; under NodeNext the constructor is on `.default`.
const Ajv2020 = ((Ajv2020Module as unknown as { default?: typeof Ajv2020Module }).default ?? Ajv2020Module) as unknown as new (o: object) => { compile: (s: object) => { (d: unknown): boolean; errors?: unknown } };
const ajv = new Ajv2020({ strict: false, allErrors: true });
const report = ajv.compile(read("schema/report.v1.schema.json"));
const evidence = ajv.compile(read("schema/evidence.v1.schema.json"));
const caseFile = ajv.compile(read("schema/case.v1.schema.json"));

describe("published JSON Schemas", () => {
  it("are up to date with the zod schemas they are generated from", () => {
    for (const t of SCHEMA_TARGETS) expect(JSON.stringify(read(t.path), null, 2) + "\n").toBe(JSON.stringify(jsonSchemaFor(t.schema, t.title), null, 2) + "\n");
  });

  it("accept every shipped example report, case and recorded evidence file (validated by Ajv, not zod)", () => {
    const bundle = read("examples/examples.v1.json");
    expect(bundle.cases.length).toBeGreaterThanOrEqual(15);
    for (const c of bundle.cases) {
      expect(report(c.report), `${c.id} report: ${JSON.stringify(report.errors)}`).toBe(true);
      expect(caseFile(c.case), `${c.id} case: ${JSON.stringify(caseFile.errors)}`).toBe(true);
    }
    for (const f of readdirSync(new URL("../fixtures/testnet/evidence", import.meta.url))) {
      const e = read(`fixtures/testnet/evidence/${f}`);
      expect(evidence(e), `${f}: ${JSON.stringify(evidence.errors)}`).toBe(true);
    }
  });

  it("reject reports with an unknown outcome, an unknown finding code, a missing field or an extra property", () => {
    const base = read("examples/reports/wrong-issuer.report.json");
    const mutate = (fn: (r: any) => void) => {
      const r = structuredClone(base);
      fn(r);
      return report(r);
    };
    expect(mutate(() => {})).toBe(true);
    expect(mutate((r) => (r.transactions[0].outcome = "success"))).toBe(false);
    expect(mutate((r) => (r.transactions[0].findings[0].code = "made_up"))).toBe(false);
    expect(mutate((r) => delete r.transactions[0].findings)).toBe(false);
    expect(mutate((r) => (r.surprise = 1))).toBe(false);
    expect(mutate((r) => (r.reportVersion = "2"))).toBe(false);
  });

  it("list exactly the outcome classes and finding codes the engine can emit", () => {
    const s = JSON.stringify(read("schema/report.v1.schema.json"));
    for (const o of OUTCOMES) expect(s).toContain(`"${o}"`);
    for (const c of FINDING_CODES) expect(s).toContain(`"${c}"`);
    expect([...OUTCOMES].sort()).toEqual(["ambiguous", "discrepant", "insufficient_evidence", "matched", "pending", "unsupported"]);
  });
});
