import { z } from "zod";
import { REPORT_VERSION } from "./version.ts";

/** Ordered from least to most severe. A transaction's overall outcome is the most severe effect among its findings. */
export const OUTCOMES = ["matched", "pending", "insufficient_evidence", "unsupported", "ambiguous", "discrepant"] as const;
export type Outcome = (typeof OUTCOMES)[number];
export const outcome = z.enum(OUTCOMES);

export const FINDING_CODES = [
  // record and timeline
  "status_unknown",
  "status_not_valid_for_kind",
  "status_history_conflict",
  "status_after_terminal",
  "timeline_time_unknown",
  "duplicate_snapshots_collapsed",
  "record_field_missing",
  "record_field_invalid",
  "record_amounts_inconsistent",
  "amount_formula_skipped",
  "fee_present_under_no_fee_policy",
  "expected_asset_unknown",
  "memo_not_declared",
  "memo_type_not_declared",
  // the Stellar leg
  "awaiting_onchain_transfer",
  "onchain_leg_matched",
  "payment_before_status_advanced",
  "funds_received_but_terminal_failure",
  "wrong_destination",
  "wrong_asset",
  "wrong_issuer",
  "amount_mismatch",
  "memo_mismatch",
  "source_mismatch",
  "multiple_candidate_operations",
  "multiple_candidate_transactions",
  "transaction_has_no_matching_payment",
  "onchain_transaction_failed",
  "linked_by_search",
  "muxed_destination_observed",
  "unrelated_operation_ignored",
  // unsupported forms
  "path_payment_not_supported",
  "claimable_balance_not_supported",
  "soroban_transfer_not_supported",
  "other_value_operation_not_supported",
  "unsupported_operation_alongside_match",
  "claimable_balance_deposit_not_supported",
  // missing or failed evidence
  "stellar_transaction_id_missing",
  "onchain_evidence_missing",
  "operations_incomplete",
  "absence_not_provable",
  "evidence_fetch_failed",
  "horizon_transaction_not_found",
  "evidence_network_mismatch",
  "cross_asset_not_converted",
  // refunds
  "refund_evidence_missing",
  "refund_not_observable",
  "refund_payment_matched",
  "refund_mismatch",
  // standing scope notes
  "external_payout_not_verified",
  "external_funds_not_verified",
] as const;
export type FindingCode = (typeof FINDING_CODES)[number];

const scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const opRef = z.strictObject({
  transactionHash: z.string(),
  operationId: z.string().nullable(),
  operationIndex: z.number().int().nonnegative().nullable(),
  sourceId: z.string().nullable(),
});

export const finding = z.strictObject({
  code: z.enum(FINDING_CODES),
  severity: z.enum(["info", "warning", "error"]),
  /** The outcome class this finding pushes toward, or null for purely informational notes. */
  effect: outcome.nullable(),
  message: z.string(),
  details: z.record(z.string(), scalar).optional(),
  refs: z.array(opRef).optional(),
});

export const provenance = z.strictObject({
  id: z.string(),
  role: z.enum(["sep24_record", "evidence"]),
  kind: z.enum(["supplied_file", "horizon"]),
  label: z.string(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  url: z.string().nullable(),
  network: z.string().nullable(),
  networkPassphrase: z.string().nullable(),
  fetchedAt: z.string().nullable(),
  httpStatus: z.number().int().nullable(),
});

export const timelineEntry = z.strictObject({
  index: z.number().int().nonnegative(),
  status: z.string(),
  statusKnown: z.boolean(),
  time: z.string().nullable(),
  timeSource: z.enum(["updated_at", "completed_at", "started_at"]).nullable(),
  occurrences: z.number().int().positive(),
  sourceIds: z.array(z.string()),
  stellarTransactionId: z.string().nullable(),
  message: z.string().nullable(),
  flags: z.array(z.enum(["time_unknown", "time_invalid", "conflicting_content", "after_terminal", "current"])),
});

export const fieldCheck = z.strictObject({
  field: z.enum(["destination", "asset", "issuer", "amount", "memo", "source"]),
  expected: z.string().nullable(),
  observed: z.string().nullable(),
  result: z.enum(["equal", "different", "not_checked"]),
});

export const candidate = z.strictObject({
  transactionHash: z.string(),
  operationId: z.string(),
  operationIndex: z.number().int().nonnegative(),
  type: z.string(),
  purpose: z.enum(["transfer", "refund"]),
  role: z.enum(["matched", "conflicting", "unsupported", "unrelated"]),
  sourceId: z.string(),
  from: z.string().nullable(),
  to: z.string().nullable(),
  asset: z.string().nullable(),
  amount: z.string().nullable(),
  memoType: z.string().nullable(),
  memo: z.string().nullable(),
  transactionSuccessful: z.boolean(),
  checks: z.array(fieldCheck),
});

export const expectedLeg = z.strictObject({
  direction: z.enum(["wallet_to_anchor", "anchor_to_wallet"]),
  destination: z.string().nullable(),
  asset: z.string().nullable(),
  amount: z.string().nullable(),
  memoType: z.string().nullable(),
  memo: z.string().nullable(),
  source: z.string().nullable(),
  transactionHash: z.string().nullable(),
  /** Where each expected value came from, for example `amount: "amount_in + fee_details.total (customer_paid_on_top)"`. */
  basis: z.record(z.string(), z.string()),
});

export const refundCheck = z.strictObject({
  id: z.string(),
  idType: z.string(),
  amount: z.string().nullable(),
  result: z.enum(["matched", "mismatch", "evidence_missing", "not_observable"]),
});

export const transactionReport = z.strictObject({
  id: z.string(),
  kind: z.enum(["deposit", "withdrawal"]),
  outcome,
  summary: z.string(),
  currentStatus: z.strictObject({
    value: z.string(),
    known: z.boolean(),
    expectation: z.enum(["none", "required", "inflight", "failure", "refunded"]).nullable(),
    electedBy: z.enum(["single_snapshot", "latest_timestamp", "lifecycle_rank"]),
  }),
  timeline: z.array(timelineEntry),
  expected: expectedLeg.nullable(),
  amounts: z.strictObject({
    amountIn: z.string().nullable(),
    amountInAsset: z.string().nullable(),
    amountOut: z.string().nullable(),
    amountOutAsset: z.string().nullable(),
    feeTotal: z.string().nullable(),
    feeAsset: z.string().nullable(),
    refundedTotal: z.string().nullable(),
    refundFeeTotal: z.string().nullable(),
  }),
  matching: z.strictObject({
    linkedBy: z.enum(["stellar_transaction_id", "search", "none"]),
    candidates: z.array(candidate),
    refunds: z.array(refundCheck),
  }),
  findings: z.array(finding),
});

export const reportSchema = z.strictObject({
  reportVersion: z.literal(REPORT_VERSION),
  tool: z.strictObject({ name: z.string(), version: z.string() }),
  generatedAt: z.iso.datetime(),
  inputs: z.array(provenance),
  options: z.strictObject({
    feePolicy: z.enum(["anchor_deducted", "customer_paid_on_top", "no_fee"]),
    feePolicySource: z.enum(["default", "option"]),
    assetOverride: z.string().nullable(),
    anchorAccount: z.string().nullable(),
    amountToleranceBps: z.number().int().nonnegative(),
    expectedNetwork: z.string().nullable(),
  }),
  summary: z.strictObject({
    matched: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative(),
    insufficient_evidence: z.number().int().nonnegative(),
    unsupported: z.number().int().nonnegative(),
    ambiguous: z.number().int().nonnegative(),
    discrepant: z.number().int().nonnegative(),
  }),
  overall: outcome.nullable(),
  transactions: z.array(transactionReport),
  limitations: z.array(z.string()),
  redaction: z.strictObject({ categories: z.array(z.enum(["accounts", "issuers", "memos", "emails", "hashes"])) }).nullable(),
});

export type Report = z.infer<typeof reportSchema>;
export type TransactionReport = z.infer<typeof transactionReport>;
export type Finding = z.infer<typeof finding>;
export type Provenance = z.infer<typeof provenance>;
export type TimelineEntry = z.infer<typeof timelineEntry>;
export type Candidate = z.infer<typeof candidate>;
export type FieldCheck = z.infer<typeof fieldCheck>;
export type OpRef = z.infer<typeof opRef>;
export type ExpectedLeg = z.infer<typeof expectedLeg>;

/**
 * Headline fields must follow from the evidence in the same document: each transaction's outcome is the most severe
 * effect among its findings, the summary counts its transactions' outcomes, and `overall` is the most severe outcome.
 * Returns a problem description, or null when the report agrees with itself.
 */
export function reportConsistencyProblem(report: Report): string | null {
  const counts: Record<Outcome, number> = { matched: 0, pending: 0, insufficient_evidence: 0, unsupported: 0, ambiguous: 0, discrepant: 0 };
  for (const t of report.transactions) {
    const expected = worst(t.findings.flatMap((f) => (f.effect === null ? [] : [f.effect])));
    if (expected !== t.outcome) return `Inconsistent report: transaction ${t.id} has outcome "${t.outcome}" but its findings give "${expected ?? "none"}".`;
    counts[t.outcome] += 1;
  }
  for (const k of Object.keys(counts) as Outcome[]) {
    if (report.summary[k] !== counts[k]) return `Inconsistent report: summary says ${report.summary[k]} ${k} but the transactions have ${counts[k]}.`;
  }
  const overall = worst(report.transactions.map((t) => t.outcome));
  if (report.overall !== overall) return `Inconsistent report: overall is "${report.overall ?? "null"}" but the transactions give "${overall ?? "null"}".`;
  return null;
}

export function parseReport(input: unknown): { ok: true; report: Report } | { ok: false; error: string } {
  const r = reportSchema.safeParse(input);
  if (!r.success) return { ok: false, error: r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ") };
  const problem = reportConsistencyProblem(r.data);
  return problem ? { ok: false, error: problem } : { ok: true, report: r.data };
}

export function outcomeRank(o: Outcome): number {
  return OUTCOMES.indexOf(o);
}

export function worst(outcomes: Outcome[]): Outcome | null {
  let best: Outcome | null = null;
  for (const o of outcomes) if (best === null || outcomeRank(o) > outcomeRank(best)) best = o;
  return best;
}
