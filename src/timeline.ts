import type { Finding, TimelineEntry } from "./reportSchema.ts";
import { canonicalJson, isKnownStatus, isTerminal, lifecycleRank, type Sep24Record } from "./sep24.ts";

export interface Snapshot {
  record: Sep24Record;
  /** Provenance id of the file the snapshot came from. */
  sourceId: string;
}

export interface TimelineResult {
  entries: TimelineEntry[];
  /** The snapshot elected as the current state of the transaction. */
  current: Sep24Record;
  electedBy: "single_snapshot" | "latest_timestamp" | "lifecycle_rank";
  findings: Finding[];
}

interface Group {
  record: Sep24Record;
  key: string;
  occurrences: number;
  sourceIds: Set<string>;
  time: number | null;
  timeText: string | null;
  timeSource: TimelineEntry["timeSource"];
  timeInvalid: boolean;
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function deriveTime(r: Sep24Record): Pick<Group, "time" | "timeText" | "timeSource" | "timeInvalid"> {
  // Explicit rule: updated_at is "the date and time of transaction reaching the current status" (SEP-24).
  // If absent, a terminal completed/refunded snapshot may use completed_at; otherwise started_at is NOT a status time.
  const candidates: Array<[TimelineEntry["timeSource"], string | null | undefined]> = [["updated_at", r.updated_at]];
  if (r.status === "completed" || r.status === "refunded") candidates.push(["completed_at", r.completed_at]);
  let invalid = false;
  for (const [src, text] of candidates) {
    if (text === null || text === undefined || text === "") continue;
    const ms = ISO_RE.test(text) ? Date.parse(text) : Number.NaN;
    if (Number.isNaN(ms)) {
      invalid = true;
      continue;
    }
    return { time: ms, timeText: new Date(ms).toISOString(), timeSource: src, timeInvalid: false };
  }
  return { time: null, timeText: null, timeSource: null, timeInvalid: invalid };
}

function compareGroups(a: Group, b: Group): number {
  // Snapshots without a usable time come first so that "the last entry" is always the best-ordered current state.
  if ((a.time === null) !== (b.time === null)) return a.time === null ? -1 : 1;
  if (a.time !== null && b.time !== null && a.time !== b.time) return a.time - b.time;
  const ra = lifecycleRank(a.record.status);
  const rb = lifecycleRank(b.record.status);
  if (ra !== rb) return ra - rb;
  if (a.record.status !== b.record.status) return a.record.status < b.record.status ? -1 : 1;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/**
 * Build a deterministic status timeline from SEP-24 snapshots of ONE transaction.
 *
 * Rules (see SPEC.md "Timeline determinism"):
 * 1. Snapshots whose canonical JSON (sorted keys) is identical collapse into one entry; occurrences and sources are kept.
 * 2. Order key: (has usable time? untimed first) -> time ascending -> lifecycle rank ascending -> status name -> canonical JSON.
 *    Input order never participates, so duplicated or reordered updates give the same timeline.
 * 3. The current state is the last entry. Equal timestamps are resolved by lifecycle rank (terminal states win).
 * 4. Conflicts the rules cannot resolve (same status and time with different content, different terminal states at the same time,
 *    a different status after a terminal one) are reported as findings instead of being silently resolved.
 */
export function buildTimeline(snapshots: Snapshot[]): TimelineResult {
  if (snapshots.length === 0) throw new Error("buildTimeline requires at least one snapshot");
  const byKey = new Map<string, Group>();
  for (const s of snapshots) {
    const key = canonicalJson(s.record);
    const g = byKey.get(key);
    if (g) {
      g.occurrences += 1;
      g.sourceIds.add(s.sourceId);
    } else {
      byKey.set(key, { record: s.record, key, occurrences: 1, sourceIds: new Set([s.sourceId]), ...deriveTime(s.record) });
    }
  }
  const groups = [...byKey.values()].sort(compareGroups);
  const findings: Finding[] = [];
  const last = groups[groups.length - 1] as Group;

  const flagsByIndex: TimelineEntry["flags"][] = groups.map((g) => {
    const f: TimelineEntry["flags"] = [];
    if (g.time === null) f.push("time_unknown");
    if (g.timeInvalid) f.push("time_invalid");
    return f;
  });

  // Conflicts at identical timestamps.
  for (let i = 0; i < groups.length; i++) {
    for (let j = i + 1; j < groups.length; j++) {
      const a = groups[i] as Group;
      const b = groups[j] as Group;
      if (a.time === null || a.time !== b.time) continue;
      const sameStatus = a.record.status === b.record.status;
      const bothTerminal = isTerminal(a.record.status) && isTerminal(b.record.status);
      if (sameStatus || bothTerminal) {
        for (const k of [i, j]) if (!(flagsByIndex[k] as TimelineEntry["flags"]).includes("conflicting_content")) (flagsByIndex[k] as TimelineEntry["flags"]).push("conflicting_content");
        findings.push({
          code: "status_history_conflict",
          severity: "error",
          effect: "ambiguous",
          message: sameStatus
            ? `Two snapshots report status ${a.record.status} at ${a.timeText} with different content; the current state cannot be established from the records.`
            : `Snapshots report different terminal statuses (${a.record.status}, ${b.record.status}) at the same time ${a.timeText}; order cannot be established.`,
          details: { statusA: a.record.status, statusB: b.record.status, time: a.timeText },
        });
      }
    }
  }

  // A different status after a terminal one (timed entries only, input order irrelevant).
  const timed = groups.map((g, i) => ({ g, i })).filter((x) => x.g.time !== null);
  const firstTerminal = timed.find((x) => isTerminal(x.g.record.status));
  if (firstTerminal) {
    for (const x of timed) {
      if (x.i === firstTerminal.i) continue;
      const later = (x.g.time as number) > (firstTerminal.g.time as number);
      if (later && x.g.record.status !== firstTerminal.g.record.status) {
        (flagsByIndex[x.i] as TimelineEntry["flags"]).push("after_terminal");
        findings.push({
          code: "status_after_terminal",
          severity: "error",
          effect: "ambiguous",
          message: `Status ${x.g.record.status} at ${x.g.timeText} follows terminal status ${firstTerminal.g.record.status} at ${firstTerminal.g.timeText}; SEP-24 terminal states are final, so the history is inconsistent.`,
          details: { terminalStatus: firstTerminal.g.record.status, laterStatus: x.g.record.status },
        });
      }
    }
  }

  const collapsed = groups.filter((g) => g.occurrences > 1).length;
  if (collapsed > 0) {
    findings.push({
      code: "duplicate_snapshots_collapsed",
      severity: "info",
      effect: null,
      message: `${snapshots.length - groups.length} duplicate snapshot(s) with identical content were collapsed into ${collapsed} timeline entr${collapsed === 1 ? "y" : "ies"}.`,
      details: { snapshots: snapshots.length, entries: groups.length },
    });
  }
  const untimed = groups.filter((g) => g.time === null).length;
  if (groups.length > 1 && untimed > 0) {
    findings.push({
      code: "timeline_time_unknown",
      severity: "warning",
      effect: null,
      message: `${untimed} snapshot(s) have no usable updated_at/completed_at; their order is established only by SEP-24 lifecycle rank.`,
      details: { untimed },
    });
  }

  let electedBy: TimelineResult["electedBy"];
  if (groups.length === 1) electedBy = "single_snapshot";
  else if (last.time === null || groups.some((g) => g !== last && g.time === last.time)) electedBy = "lifecycle_rank";
  else electedBy = "latest_timestamp";

  (flagsByIndex[groups.length - 1] as TimelineEntry["flags"]).push("current");

  const entries: TimelineEntry[] = groups.map((g, index) => ({
    index,
    status: g.record.status,
    statusKnown: isKnownStatus(g.record.status),
    time: g.timeText,
    timeSource: g.timeSource,
    occurrences: g.occurrences,
    sourceIds: [...g.sourceIds].sort(),
    stellarTransactionId: g.record.stellar_transaction_id ?? null,
    message: g.record.message ?? null,
    flags: flagsByIndex[index] as TimelineEntry["flags"],
  }));
  return { entries, current: last.record, electedBy, findings: dedupeFindings(findings) };
}

function dedupeFindings(fs: Finding[]): Finding[] {
  const seen = new Set<string>();
  const out: Finding[] = [];
  for (const f of fs) {
    const k = JSON.stringify([f.code, f.message]);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(f);
  }
  return out.sort((a, b) => (a.code + a.message < b.code + b.message ? -1 : 1));
}
