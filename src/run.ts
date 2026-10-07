import { InputError } from "./errors.ts";
import { parseEvidenceFile, type EvidenceTransaction } from "./evidence.ts";
import { looksLikeCase, parseCase, parseSep24Records } from "./input.ts";
import type { AcquisitionFailure, EvidenceSet } from "./leg.ts";
import type { Provenance, Report } from "./reportSchema.ts";
import { reconcile, type ReconcileOptions } from "./reconcile.ts";
import type { Snapshot } from "./timeline.ts";

export interface SuppliedFile {
  /** Display name (a file name or "pasted JSON"). */
  label: string;
  value: unknown;
  /** Hex SHA-256 of the bytes as supplied, when the caller computed it. */
  sha256?: string | null;
}

export interface RunInput {
  /** SEP-24 record files, or one case file. */
  records: SuppliedFile[];
  evidence?: SuppliedFile[];
  /** Evidence already acquired elsewhere (for example live from Horizon), with its provenance. */
  acquired?: { transactions: EvidenceTransaction[]; failures: AcquisitionFailure[]; provenance: Provenance[] };
  options?: ReconcileOptions;
  now?: Date;
}

function nextId(n: number): string {
  return `src-${n}`;
}

/** Parse supplied JSON, reconcile and return the report. The only I/O-free entry point used by both the CLI and the browser studio. */
export function reconcileSupplied(input: RunInput): Report {
  const sources: Provenance[] = [];
  const snapshots: Snapshot[] = [];
  const transactions: EvidenceTransaction[] = [];
  let options: ReconcileOptions | undefined = input.options;
  let counter = 0;
  const supplied = (role: Provenance["role"], f: SuppliedFile): string => {
    const id = nextId(++counter);
    sources.push({ id, role, kind: "supplied_file", label: f.label, sha256: f.sha256 ?? null, url: null, network: null, networkPassphrase: null, fetchedAt: null, httpStatus: null });
    return id;
  };

  const first = input.records[0];
  if (first !== undefined && looksLikeCase(first.value)) {
    if (input.records.length > 1) throw new InputError("A case file must be the only record input");
    const c = parseCase(first.value);
    const rid = supplied("sep24_record", first);
    for (const r of parseSep24Records(c.records)) snapshots.push({ record: r, sourceId: rid });
    const ev = parseEvidenceFile(c.evidence, rid);
    const evSourceId = nextId(++counter);
    sources.push({ id: evSourceId, role: "evidence", kind: "supplied_file", label: `${first.label} (embedded evidence)`, sha256: null, url: null, network: c.evidence.capture?.network ?? null, networkPassphrase: null, fetchedAt: c.evidence.capture?.capturedAt ?? null, httpStatus: null });
    transactions.push(...ev.transactions.map((t) => ({ ...t, sourceId: evSourceId })));
    options = { ...c.options, ...(input.options ?? {}) };
  } else {
    for (const f of input.records) {
      const id = supplied("sep24_record", f);
      for (const r of parseSep24Records(f.value)) snapshots.push({ record: r, sourceId: id });
    }
  }
  for (const f of input.evidence ?? []) {
    const id = supplied("evidence", f);
    const ev = parseEvidenceFile(f.value, id);
    const net = ev.capture?.network ?? null;
    const p = sources.find((s) => s.id === id) as Provenance;
    p.network = net;
    p.fetchedAt = ev.capture?.capturedAt ?? null;
    p.url = ev.capture?.horizon ?? null;
    transactions.push(...ev.transactions);
  }
  const failures: AcquisitionFailure[] = [];
  if (input.acquired) {
    sources.push(...input.acquired.provenance);
    transactions.push(...input.acquired.transactions);
    failures.push(...input.acquired.failures);
  }
  const evidence: EvidenceSet = { transactions: dedupe(transactions), failures };
  return reconcile({ records: snapshots, evidence, sources, ...(options ? { options } : {}), ...(input.now ? { now: input.now } : {}) });
}

function dedupe(txs: EvidenceTransaction[]): EvidenceTransaction[] {
  const seen = new Map<string, string>();
  const out: EvidenceTransaction[] = [];
  for (const t of txs) {
    // The same transaction may arrive from several sources; keep the first (callers list authoritative sources first).
    const k = t.hash;
    const prior = seen.get(k);
    const sig = JSON.stringify([t.successful, t.memoType, t.memo, t.operations.map((o) => [o.id, o.type, o.to, o.amount, o.asset])]);
    if (prior !== undefined) {
      if (prior !== sig) throw new InputError(`Evidence for transaction ${k} differs between sources; refusing to pick one silently`);
      continue;
    }
    seen.set(k, sig);
    out.push(t);
  }
  return out;
}
