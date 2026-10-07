import { describe, expect, it } from "vitest";
import { run, withdrawal } from "./helpers/cases.ts";

const w01 = "w01-correct-withdrawal-payment";
const base = { stellar_transaction_id: undefined };

function updates(): Record<string, unknown>[] {
  return [
    withdrawal(null, { ...base, status: "pending_user_transfer_start", updated_at: "2026-10-07T13:56:00Z" }),
    withdrawal(w01, { status: "pending_anchor", updated_at: "2026-10-07T14:01:00Z" }),
    withdrawal(w01, { status: "pending_external", updated_at: "2026-10-07T14:05:00Z" }),
    withdrawal(w01, { status: "completed", updated_at: "2026-10-07T14:30:00Z", completed_at: "2026-10-07T14:30:00Z" }),
  ];
}

const norm = (r: ReturnType<typeof run>) => JSON.stringify({ ...r, inputs: undefined });

function permutations<T>(xs: T[]): T[][] {
  if (xs.length <= 1) return [xs];
  return xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]));
}

describe("whole-report determinism", () => {
  it("every ordering of the same status updates yields an identical report", () => {
    const list = updates();
    const reference = norm(run([list], [w01]));
    for (const p of permutations(list)) expect(norm(run([p], [w01]))).toBe(reference);
    expect(JSON.parse(reference).transactions[0].outcome).toBe("matched");
    expect(JSON.parse(reference).transactions[0].currentStatus.value).toBe("completed");
  });

  it("duplicated status updates change only the recorded occurrence counts and one note", () => {
    const list = updates();
    const clean = JSON.parse(norm(run([list], [w01])));
    const dup = JSON.parse(norm(run([[...list, list[1]!, list[3]!, list[3]!, list[1]!]], [w01])));
    expect(dup.transactions[0].outcome).toBe(clean.transactions[0].outcome);
    expect(dup.transactions[0].timeline.map((e: any) => e.status)).toEqual(clean.transactions[0].timeline.map((e: any) => e.status));
    expect(dup.transactions[0].findings.map((f: any) => f.code).filter((c: string) => c !== "duplicate_snapshots_collapsed")).toEqual(clean.transactions[0].findings.map((f: any) => f.code));
    expect(dup.transactions[0].timeline.map((e: any) => e.occurrences)).toEqual([1, 3, 1, 3]);
    expect(dup.transactions[0].matching).toEqual(clean.transactions[0].matching);
  });

  it("the same input twice gives byte-identical JSON", () => {
    expect(JSON.stringify(run([updates()], [w01]))).toBe(JSON.stringify(run([updates()], [w01])));
  });

  it("a reordered or duplicated history that ends in error still ends in error", () => {
    const list = [
      withdrawal(null, { ...base, status: "pending_anchor", updated_at: "2026-10-07T14:01:00Z" }),
      withdrawal(null, { ...base, status: "error", updated_at: "2026-10-07T14:10:00Z" }),
    ];
    for (const p of permutations([...list, list[1]!])) expect(run([p]).transactions[0]!.currentStatus.value).toBe("error");
  });

  it("when updates arrive in separate files, only the source ids (which file said what) depend on file order", () => {
    const list = updates();
    const strip = (r: ReturnType<typeof run>) => JSON.stringify({ ...r, inputs: undefined, transactions: r.transactions.map((t) => ({ ...t, timeline: t.timeline.map((e) => ({ ...e, sourceIds: undefined })), matching: undefined, findings: t.findings.map((f) => ({ ...f, refs: undefined })) })) });
    expect(strip(run(list, [w01]))).toBe(strip(run([...list].reverse(), [w01])));
  });

  it("separate transactions in one input are reported in id order regardless of input order", () => {
    const a = withdrawal(null, { ...base, id: "b-2", status: "incomplete" });
    const b = withdrawal(null, { ...base, id: "a-1", status: "incomplete" });
    expect(run([a, b]).transactions.map((t) => t.id)).toEqual(["a-1", "b-2"]);
    expect(run([b, a]).transactions.map((t) => t.id)).toEqual(["a-1", "b-2"]);
  });
});
