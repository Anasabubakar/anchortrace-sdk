import { describe, expect, it } from "vitest";
import { buildTimeline, type Snapshot } from "../src/timeline.ts";
import type { Sep24Record } from "../src/sep24.ts";

function snap(status: string, updated_at: string | undefined, extra: Record<string, unknown> = {}, sourceId = "src-1"): Snapshot {
  return { record: { id: "tx-1", kind: "withdrawal", status, ...(updated_at ? { updated_at } : {}), ...extra } as Sep24Record, sourceId };
}

const history: Snapshot[] = [
  snap("incomplete", "2026-01-01T10:00:00Z"),
  snap("pending_user_transfer_start", "2026-01-01T10:01:00Z"),
  snap("pending_anchor", "2026-01-01T10:05:00Z"),
  snap("pending_external", "2026-01-01T10:06:00Z"),
  snap("completed", "2026-01-01T10:30:00Z"),
];

const strip = (r: ReturnType<typeof buildTimeline>) => JSON.stringify({ e: r.entries, c: r.current, b: r.electedBy, f: r.findings });

function shuffle<T>(xs: T[], seed: number): T[] {
  const a = [...xs];
  let s = seed;
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

describe("timeline determinism", () => {
  it("orders by updated_at and elects the latest as current", () => {
    const t = buildTimeline(history);
    expect(t.entries.map((e) => e.status)).toEqual(["incomplete", "pending_user_transfer_start", "pending_anchor", "pending_external", "completed"]);
    expect(t.current.status).toBe("completed");
    expect(t.electedBy).toBe("latest_timestamp");
    expect(t.entries.at(-1)!.flags).toContain("current");
  });

  it("gives the same result for every reordering of the same updates", () => {
    const base = strip(buildTimeline(history));
    for (let seed = 1; seed <= 40; seed++) expect(strip(buildTimeline(shuffle(history, seed)))).toBe(base);
  });

  it("collapses duplicate status updates and reports how many, independent of position", () => {
    const dup = [...history, history[2]!, history[2]!, history[4]!];
    const t = buildTimeline(dup);
    expect(t.entries).toHaveLength(5);
    expect(t.entries.find((e) => e.status === "pending_anchor")!.occurrences).toBe(3);
    expect(t.entries.find((e) => e.status === "completed")!.occurrences).toBe(2);
    expect(t.findings.map((f) => f.code)).toContain("duplicate_snapshots_collapsed");
    expect(strip(buildTimeline(shuffle(dup, 7)))).toBe(strip(t));
    // The collapsed entries differ from the clean history only in occurrences and the duplicate note.
    const clean = buildTimeline(history);
    expect(t.entries.map((e) => e.status)).toEqual(clean.entries.map((e) => e.status));
    expect(t.current).toEqual(clean.current);
  });

  it("resolves equal timestamps by lifecycle rank so terminal states win, in any input order", () => {
    const a = snap("pending_external", "2026-01-01T10:00:00Z");
    const b = snap("completed", "2026-01-01T10:00:00Z");
    expect(buildTimeline([a, b]).current.status).toBe("completed");
    expect(buildTimeline([b, a]).current.status).toBe("completed");
    expect(buildTimeline([a, b]).electedBy).toBe("lifecycle_rank");
  });

  it("uses completed_at only for completed or refunded snapshots when updated_at is missing", () => {
    const t = buildTimeline([snap("pending_anchor", "2026-01-01T09:00:00Z"), snap("completed", undefined, { completed_at: "2026-01-01T09:30:00Z" })]);
    expect(t.entries[1]!.time).toBe("2026-01-01T09:30:00.000Z");
    expect(t.entries[1]!.timeSource).toBe("completed_at");
    // started_at is never a status time.
    const u = buildTimeline([snap("pending_anchor", undefined, { started_at: "2026-01-01T09:00:00Z" })]);
    expect(u.entries[0]!.time).toBeNull();
  });

  it("orders untimed snapshots by lifecycle rank only and says so", () => {
    const t = buildTimeline([snap("completed", undefined), snap("pending_anchor", undefined), snap("incomplete", undefined)]);
    expect(t.entries.map((e) => e.status)).toEqual(["incomplete", "pending_anchor", "completed"]);
    expect(t.electedBy).toBe("lifecycle_rank");
    expect(t.findings.map((f) => f.code)).toContain("timeline_time_unknown");
  });

  it("treats timestamps with different offsets as the same instant", () => {
    const t = buildTimeline([snap("completed", "2026-01-01T12:00:00+02:00"), snap("pending_external", "2026-01-01T10:00:00Z")]);
    expect(t.entries.every((e) => e.time === "2026-01-01T10:00:00.000Z")).toBe(true);
    expect(t.current.status).toBe("completed");
  });

  it("flags unparseable timestamps rather than guessing", () => {
    const t = buildTimeline([snap("pending_anchor", "yesterday"), snap("completed", "2026-01-01T10:00:00Z")]);
    expect(t.entries[0]!.flags).toContain("time_invalid");
    expect(t.entries[0]!.time).toBeNull();
  });
});

describe("timeline conflicts are surfaced, not silently resolved", () => {
  it("flags the same status at the same time with different content", () => {
    const t = buildTimeline([snap("completed", "2026-01-01T10:00:00Z", { stellar_transaction_id: "a".repeat(64) }), snap("completed", "2026-01-01T10:00:00Z", { stellar_transaction_id: "b".repeat(64) })]);
    expect(t.findings.some((f) => f.code === "status_history_conflict" && f.effect === "ambiguous")).toBe(true);
    expect(t.entries.every((e) => e.flags.includes("conflicting_content"))).toBe(true);
    // deterministic even so
    const rev = buildTimeline([snap("completed", "2026-01-01T10:00:00Z", { stellar_transaction_id: "b".repeat(64) }), snap("completed", "2026-01-01T10:00:00Z", { stellar_transaction_id: "a".repeat(64) })]);
    expect(strip(rev)).toBe(strip(t));
  });

  it("flags different terminal statuses at the same instant", () => {
    const t = buildTimeline([snap("completed", "2026-01-01T10:00:00Z"), snap("error", "2026-01-01T10:00:00Z")]);
    expect(t.findings.some((f) => f.code === "status_history_conflict")).toBe(true);
  });

  it("flags a different status after a terminal one", () => {
    const t = buildTimeline([snap("completed", "2026-01-01T10:00:00Z"), snap("pending_anchor", "2026-01-01T11:00:00Z")]);
    expect(t.findings.some((f) => f.code === "status_after_terminal" && f.effect === "ambiguous")).toBe(true);
    expect(t.entries[1]!.flags).toContain("after_terminal");
  });

  it("does not flag a repeated terminal status", () => {
    const t = buildTimeline([snap("completed", "2026-01-01T10:00:00Z"), snap("completed", "2026-01-01T10:05:00Z")]);
    expect(t.findings.filter((f) => f.code === "status_after_terminal")).toHaveLength(0);
  });
});
