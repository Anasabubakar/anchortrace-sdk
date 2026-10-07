import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCli } from "../src/cli.ts";
import { parseReport } from "../src/reportSchema.ts";
import { ANCHOR, WALLET, withdrawal } from "./helpers/cases.ts";
import { startFakeHorizon, type FakeHorizon } from "./helpers/fakeHorizon.ts";

const EV = (n: string) => new URL(`../fixtures/testnet/evidence/${n}.json`, import.meta.url).pathname;
let dir: string;
let h: FakeHorizon;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "at-cli-"));
  h = await startFakeHorizon(["w01-correct-withdrawal-payment", "w02-wrong-destination"]);
});
afterAll(() => h.close());

async function write(name: string, body: unknown): Promise<string> {
  const p = join(dir, name);
  await writeFile(p, typeof body === "string" ? body : JSON.stringify(body));
  return p;
}
function cap() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { stdout: (s: string) => out.push(s), stderr: (s: string) => err.push(s) }, out: () => out.join(""), err: () => err.join("") };
}
const NOW = "2026-10-07T12:00:00Z";

describe("anchortrace reconcile", () => {
  it("exit 0 and text output for a matched withdrawal, with the not-a-bank-payout note", async () => {
    const rec = await write("ok.json", { transaction: withdrawal("w01-correct-withdrawal-payment") });
    const c = cap();
    expect(await runCli(["reconcile", rec, "--evidence", EV("w01-correct-withdrawal-payment"), "--now", NOW], c.io)).toBe(0);
    expect(c.out()).toMatch(/MATCHED/);
    expect(c.out()).toMatch(/confirmation on chain is not a bank payout/i);
    expect(c.out()).toMatch(/generated 2026-10-07T12:00:00.000Z/);
  });

  it("exit 1 for a discrepancy and the json report validates against the schema", async () => {
    const rec = await write("wrong.json", withdrawal("w02-wrong-destination", { withdraw_memo: "1002" }));
    const out = join(dir, "report.json");
    const c = cap();
    expect(await runCli(["reconcile", rec, "--evidence", EV("w02-wrong-destination"), "--format", "json", "--out", out, "--now", NOW], c.io)).toBe(1);
    const stdoutReport = JSON.parse(c.out());
    const fileReport = JSON.parse(await readFile(out, "utf8"));
    expect(stdoutReport).toEqual(fileReport);
    const p = parseReport(fileReport);
    expect(p.ok).toBe(true);
    expect(fileReport.transactions[0].outcome).toBe("discrepant");
    expect(fileReport.inputs[0].sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("pending passes by default and fails with --strict; --fail-on is configurable", async () => {
    const rec = await write("pending.json", withdrawal(null, { status: "pending_user_transfer_start", stellar_transaction_id: undefined }));
    expect(await runCli(["reconcile", rec, "--now", NOW], cap().io)).toBe(0);
    expect(await runCli(["reconcile", rec, "--strict", "--now", NOW], cap().io)).toBe(1);
    expect(await runCli(["reconcile", rec, "--fail-on", "pending", "--now", NOW], cap().io)).toBe(1);
    expect(await runCli(["reconcile", rec, "--fail-on", "nonsense"], cap().io)).toBe(2);
  });

  it("exit 1 for missing evidence (insufficient_evidence is not a pass)", async () => {
    const rec = await write("noev.json", withdrawal("w01-correct-withdrawal-payment"));
    const c = cap();
    expect(await runCli(["reconcile", rec, "--now", NOW], c.io)).toBe(1);
    expect(c.out()).toMatch(/INSUFFICIENT EVIDENCE/);
  });

  it("exit 2 for unreadable files, invalid JSON, invalid records and bad options", async () => {
    const bad = await write("bad.json", "{not json");
    const notrec = await write("notrec.json", { hello: "world" });
    expect(await runCli(["reconcile", join(dir, "missing.json")], cap().io)).toBe(2);
    const c1 = cap();
    expect(await runCli(["reconcile", bad], c1.io)).toBe(2);
    expect(c1.err()).toMatch(/not valid JSON/);
    expect(await runCli(["reconcile", notrec], cap().io)).toBe(2);
    const rec = await write("r.json", withdrawal(null, { status: "incomplete" }));
    expect(await runCli(["reconcile", rec, "--format", "yaml"], cap().io)).toBe(2);
    expect(await runCli(["reconcile", rec, "--fee-policy", "whatever"], cap().io)).toBe(2);
    expect(await runCli(["reconcile", rec, "--asset", "USD"], cap().io)).toBe(2);
    expect(await runCli(["nonsense"], cap().io)).toBe(2);
  });

  it("applies the fee policy option and echoes it in the report", async () => {
    const rec = await write("fee.json", withdrawal("w01-correct-withdrawal-payment", { amount_out: "100.0000000" }));
    const c = cap();
    expect(await runCli(["reconcile", rec, "--evidence", EV("w01-correct-withdrawal-payment"), "--fee-policy", "customer_paid_on_top", "--format", "json", "--now", NOW], c.io)).toBe(1);
    expect(JSON.parse(c.out()).options).toMatchObject({ feePolicy: "customer_paid_on_top", feePolicySource: "option" });
  });

  it("reads evidence live from Horizon with --horizon (local replay server), listing it in the provenance", async () => {
    const rec = await write("live.json", withdrawal("w01-correct-withdrawal-payment"));
    const c = cap();
    expect(await runCli(["reconcile", rec, "--horizon", h.url, "--allow-http", "--format", "json", "--now", NOW], c.io)).toBe(0);
    const r = JSON.parse(c.out());
    expect(r.transactions[0].outcome).toBe("matched");
    expect(r.inputs.map((i: any) => i.kind)).toEqual(["supplied_file", "horizon"]);
    expect(r.inputs[1].id).toBe("src-2");
    // a plain http:// Horizon without --allow-http is refused
    expect(await runCli(["reconcile", rec, "--horizon", h.url], cap().io)).toBe(2);
  });

  it("keeps working when Horizon is unreachable: insufficient evidence, exit 1", async () => {
    const rec = await write("down.json", withdrawal("w01-correct-withdrawal-payment"));
    const c = cap();
    expect(await runCli(["reconcile", rec, "--horizon", "http://127.0.0.1:1", "--allow-http", "--timeout", "300", "--now", NOW], c.io)).toBe(1);
    expect(c.out()).toMatch(/INSUFFICIENT EVIDENCE/);
    expect(c.out()).toMatch(/evidence_fetch_failed/);
  });

  it("--redact removes accounts and memos from the output and the written report", async () => {
    const rec = await write("red.json", withdrawal("w01-correct-withdrawal-payment"));
    const out = join(dir, "red-report.json");
    const c = cap();
    await runCli(["reconcile", rec, "--evidence", EV("w01-correct-withdrawal-payment"), "--redact", "--out", out, "--now", NOW], c.io);
    for (const s of [c.out(), await readFile(out, "utf8")]) {
      expect(s).not.toContain(ANCHOR);
      expect(s).not.toContain(WALLET);
    }
  });
});

describe("explain, export, validate, schema", () => {
  async function reportFile(): Promise<string> {
    const rec = await write("e.json", withdrawal("w03-wrong-issuer", { withdraw_memo: "1003" }));
    const c = cap();
    await runCli(["reconcile", rec, "--evidence", EV("w03-wrong-issuer"), "--format", "json", "--now", NOW], c.io);
    return write("e-report.json", c.out());
  }

  it("explain walks through expectation, evidence, checks, outcome and what would change it", async () => {
    const f = await reportFile();
    const c = cap();
    expect(await runCli(["explain", f], c.io)).toBe(0);
    expect(c.out()).toMatch(/is DISCREPANT/);
    expect(c.out()).toMatch(/issuer\s+DIFFERENT/);
    expect(c.out()).toMatch(/What would change it/);
    expect(c.out()).toMatch(/not a bank payout/);
    expect(await runCli(["explain", f, "--tx", "nope"], cap().io)).toBe(2);
  });

  it("export --redact writes a redacted report and a private mapping file", async () => {
    const f = await reportFile();
    const out = join(dir, "x.json");
    const map = join(dir, "x.map.json");
    expect(await runCli(["export", f, "--redact", "--out", out, "--mapping-out", map], cap().io)).toBe(0);
    const t = await readFile(out, "utf8");
    expect(t).not.toContain(WALLET);
    expect(parseReport(JSON.parse(t)).ok).toBe(true);
    expect(JSON.parse(await readFile(map, "utf8"))[WALLET]).toMatch(/^\[account-\d+\]$/);
    expect(await runCli(["export", f, "--mapping-out", map], cap().io)).toBe(2);
    expect(await runCli(["export", f, "--redact", "accounts,names"], cap().io)).toBe(2);
  });

  it("validate recognises records, evidence and reports; schema prints JSON Schema", async () => {
    const rec = await write("v.json", withdrawal(null, { status: "incomplete" }));
    const c = cap();
    expect(await runCli(["validate", rec], c.io)).toBe(0);
    expect(c.out()).toMatch(/SEP-24 records OK/);
    const c2 = cap();
    expect(await runCli(["validate", EV("w01-correct-withdrawal-payment")], c2.io)).toBe(0);
    expect(c2.out()).toMatch(/Evidence OK/);
    expect(await runCli(["validate", await reportFile()], cap().io)).toBe(0);
    const c3 = cap();
    expect(await runCli(["schema", "report"], c3.io)).toBe(0);
    expect(JSON.parse(c3.out()).$schema).toMatch(/2020-12/);
    expect(await runCli(["schema", "nope"], cap().io)).toBe(2);
  });

  it("--version and --help exit 0", async () => {
    const c = cap();
    expect(await runCli(["--version"], c.io)).toBe(0);
    expect(c.out()).toMatch(/0\.1\.0/);
    expect(await runCli(["--help"], cap().io)).toBe(0);
  });
});
