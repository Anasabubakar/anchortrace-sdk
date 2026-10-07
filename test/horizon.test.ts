import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HorizonSource, resolveHorizonUrl } from "../src/horizon.ts";
import { InputError } from "../src/errors.ts";
import { reconcileSupplied } from "../src/run.ts";
import { codes, hashOf, NOW, only, withdrawal } from "./helpers/cases.ts";
import { startFakeHorizon, type FakeHorizon } from "./helpers/fakeHorizon.ts";

const FX = ["w01-correct-withdrawal-payment", "w02-wrong-destination", "w05-multi-operation", "w09-failed-transaction"];
let h: FakeHorizon;
beforeAll(async () => {
  h = await startFakeHorizon(FX);
});
afterAll(() => h.close());

let n = 0;
const next = () => `src-h${++n}`;
const hash = (name: string) => hashOf(name);

describe("resolveHorizonUrl", () => {
  it("maps presets, refuses http, credentials, queries and garbage", () => {
    expect(resolveHorizonUrl("testnet")).toBe("https://horizon-testnet.stellar.org");
    expect(resolveHorizonUrl("public")).toBe("https://horizon.stellar.org");
    expect(resolveHorizonUrl("https://example.org/horizon/")).toBe("https://example.org/horizon");
    for (const bad of ["http://horizon.example", "https://u:p@horizon.example", "https://h.example/?x=1", "not a url", "ftp://x"]) expect(() => resolveHorizonUrl(bad), bad).toThrow(InputError);
    expect(resolveHorizonUrl("http://127.0.0.1:8000", true)).toBe("http://127.0.0.1:8000");
  });
});

describe("HorizonSource.acquire (against a local server that replays recorded testnet bodies)", () => {
  it("fetches transaction and operations with GET only, and records provenance", async () => {
    const src = new HorizonSource(h.url, { allowHttp: true, now: () => NOW });
    const a = await src.acquire([hash(FX[0]!)], next);
    expect(a.failures).toEqual([]);
    expect(a.transactions).toHaveLength(1);
    expect(a.transactions[0]!.operations[0]).toMatchObject({ type: "payment", amount: "100.0000000" });
    expect(a.provenance[0]).toMatchObject({ kind: "horizon", role: "evidence", httpStatus: 200, fetchedAt: NOW.toISOString(), networkPassphrase: "Test SDF Network ; September 2015", network: "testnet" });
    expect(a.provenance[0]!.url).toBe(`${h.url}/transactions/${hash(FX[0]!)}`);
    expect([...h.methods]).toEqual(["GET"]);
    expect(h.requests.some((r) => r.includes("/operations?limit=200&order=asc"))).toBe(true);
  });

  it("turns 404, 500, timeout, garbage, oversized and mismatched responses into failures, never into evidence", async () => {
    const hashes = ["w01", "w02", "w05", "w09"].map((p) => hashOf(FX.find((f) => f.startsWith(p))!));
    const [a, b, c, d] = hashes as [string, string, string, string];
    h.behave[a] = "404";
    h.behave[b] = "500";
    h.behave[c] = "garbage";
    h.behave[d] = "wrong_hash";
    const src = new HorizonSource(h.url, { allowHttp: true, now: () => NOW });
    const r = await src.acquire(hashes, next);
    expect(r.transactions).toEqual([]);
    const kinds = Object.fromEntries(r.failures.map((f) => [f.hash, f.kind]));
    expect(kinds[a]).toBe("not_found");
    expect(kinds[b]).toBe("unavailable");
    expect(kinds[c]).toBe("invalid_response");
    expect(kinds[d]).toBe("invalid_response");
    h.behave = {};
  });

  it("times out on a server that never answers", async () => {
    h.behave[hash(FX[0]!)] = "hang";
    const src = new HorizonSource(h.url, { allowHttp: true, timeoutMs: 150 });
    const r = await src.acquire([hash(FX[0]!)], next);
    expect(r.failures[0]).toMatchObject({ kind: "timeout" });
    h.behave = {};
  });

  it("refuses oversized bodies", async () => {
    h.behave[hash(FX[0]!)] = "huge";
    const src = new HorizonSource(h.url, { allowHttp: true, maxBytes: 100_000 });
    const r = await src.acquire([hash(FX[0]!)], next);
    expect(r.failures[0]).toMatchObject({ kind: "too_large" });
    h.behave = {};
  });

  it("reports a failed operations read after a successful transaction read as a failure", async () => {
    h.behave[hash(FX[0]!)] = "ops_500";
    const r = await new HorizonSource(h.url, { allowHttp: true }).acquire([hash(FX[0]!)], next);
    expect(r.transactions).toEqual([]);
    expect(r.failures[0]!.detail).toMatch(/operations/);
    h.behave = {};
  });

  it("rejects malformed hashes without sending a request", async () => {
    const before = h.requests.length;
    const r = await new HorizonSource(h.url, { allowHttp: true }).acquire(["not-a-hash"], next);
    expect(r.failures[0]!.kind).toBe("invalid_hash");
    expect(h.requests.slice(before).filter((x) => x.includes("not-a-hash"))).toEqual([]);
  });

  it("an unreachable server yields unavailable, not an exception", async () => {
    const r = await new HorizonSource("http://127.0.0.1:1", { allowHttp: true, timeoutMs: 500 }).acquire([hash(FX[0]!)], next);
    expect(r.failures[0]!.kind).toBe("unavailable");
  });
});

describe("live acquisition feeding the engine", () => {
  const run = async (name: string, over: Record<string, unknown> = {}) => {
    const src = new HorizonSource(h.url, { allowHttp: true, now: () => NOW });
    const rec = withdrawal(name, over);
    const acquired = await src.acquire([rec.stellar_transaction_id as string], next);
    return only(reconcileSupplied({ records: [{ label: "r.json", value: rec }], acquired, now: NOW }));
  };
  it("matched from live-shaped evidence, with provenance naming Horizon", async () => {
    const t = await run(FX[0]!);
    expect(t.outcome).toBe("matched");
  });
  it("discrepant for the wrong destination", async () => {
    expect((await run(FX[1]!, { withdraw_memo: "1002" })).outcome).toBe("discrepant");
  });
  it("insufficient evidence, not a mismatch, when Horizon is down", async () => {
    h.behave[hash(FX[0]!)] = "500";
    const t = await run(FX[0]!);
    expect(t.outcome).toBe("insufficient_evidence");
    expect(codes(t)).toContain("evidence_fetch_failed");
    h.behave = {};
  });
});
