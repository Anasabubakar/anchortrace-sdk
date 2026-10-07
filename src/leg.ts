/**
 * Operation-level matching of the Stellar leg of a SEP-24 transaction against evidence.
 * This module only compares; it never fetches and never signs.
 */
import { assetKey, type StellarAsset } from "./asset.ts";
import { parseAmount, withinToleranceBps } from "./decimal.ts";
import type { EvidenceOperation, EvidenceTransaction } from "./evidence.ts";
import type { Candidate, FieldCheck, Finding, OpRef } from "./reportSchema.ts";
import { baseAccountOf, isMuxedAccount } from "./strkey.ts";

export interface Leg {
  purpose: "transfer" | "refund";
  destination: string;
  asset: StellarAsset;
  amount: bigint;
  memoType: string | null;
  memo: string | null;
  source: string | null;
  transactionHash: string | null;
  toleranceBps: number;
}

export interface AcquisitionFailure {
  hash: string;
  kind: "not_found" | "unavailable" | "timeout" | "invalid_response" | "too_large";
  detail: string;
  sourceId: string;
}

export interface EvidenceSet {
  transactions: EvidenceTransaction[];
  failures: AcquisitionFailure[];
}

export type LegState = "matched" | "mismatch" | "ambiguous" | "unsupported" | "tx_failed" | "evidence_missing";

export interface LegEvaluation {
  state: LegState;
  linkedBy: "stellar_transaction_id" | "search" | "none";
  candidates: Candidate[];
  findings: Finding[];
}

function ref(tx: EvidenceTransaction, op: EvidenceOperation | null): OpRef {
  return { transactionHash: tx.hash, operationId: op?.id ?? null, operationIndex: op?.index ?? null, sourceId: tx.sourceId };
}

/** Memo comparison respecting memo type: id memos compare numerically, hash memos compare bytes (hex or base64). */
export function memoEquals(type: string | null, expected: string, observedType: string, observed: string | null): boolean {
  if (observed === null) return false;
  if (type !== null && type !== observedType) return false;
  const t = type ?? observedType;
  if (t === "id") {
    return /^\d+$/.test(expected) && /^\d+$/.test(observed) && BigInt(expected) === BigInt(observed);
  }
  if (t === "hash" || t === "return") {
    const a = bytesOf(expected);
    const b = bytesOf(observed);
    return a !== null && b !== null && a === b;
  }
  return expected === observed;
}

function bytesOf(s: string): string | null {
  if (/^[0-9a-fA-F]{64}$/.test(s)) return s.toLowerCase();
  if (/^[A-Za-z0-9+/]{43}=$/.test(s)) {
    try {
      return [...atob(s)].map((c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
    } catch {
      return null;
    }
  }
  return null;
}

type DestMatch = "no" | "yes" | "yes_muxed_observed" | "yes_muxed_not_in_evidence";

function destMatch(expected: string, op: EvidenceOperation): DestMatch {
  const expBase = baseAccountOf(expected);
  if (expBase === null || op.to === null || op.to !== expBase) return "no";
  if (isMuxedAccount(expected)) {
    if (op.toMuxed === null) return "yes_muxed_not_in_evidence";
    return op.toMuxed === expected ? "yes" : "no";
  }
  return op.toMuxed === null ? "yes" : "yes_muxed_observed";
}

function relatedToDestination(op: EvidenceOperation, destination: string): boolean {
  if (op.involvedUnknown) return true;
  const base = baseAccountOf(destination);
  return op.involvedAccounts.some((a) => baseAccountOf(a) === base);
}

function sameAccount(a: string | null, b: string): boolean {
  if (a === null) return false;
  const x = baseAccountOf(a);
  return x !== null && x === baseAccountOf(b);
}

function describeAsset(a: StellarAsset | null): string | null {
  return a === null ? null : assetKey(a);
}

function checksFor(leg: Leg, tx: EvidenceTransaction, op: EvidenceOperation): FieldCheck[] {
  const checks: FieldCheck[] = [{ field: "destination", expected: leg.destination, observed: op.toMuxed ?? op.to, result: "equal" }];
  const exp = leg.asset;
  const obs = op.asset;
  const codeOf = (a: StellarAsset | null) => (a === null ? null : a.kind === "native" ? "native" : a.code);
  const issuerOf = (a: StellarAsset | null) => (a === null || a.kind === "native" ? null : a.issuer);
  checks.push({ field: "asset", expected: codeOf(exp), observed: codeOf(obs), result: codeOf(exp) === codeOf(obs) && obs !== null ? "equal" : "different" });
  checks.push({ field: "issuer", expected: issuerOf(exp), observed: issuerOf(obs), result: obs !== null && issuerOf(exp) === issuerOf(obs) ? "equal" : "different" });
  let amountResult: FieldCheck["result"] = "different";
  if (op.amount !== null && obs !== null) amountResult = withinToleranceBps(leg.amount, parseAmount(op.amount), leg.toleranceBps) ? "equal" : "different";
  checks.push({ field: "amount", expected: canon(leg.amount), observed: op.amount, result: amountResult });
  if (leg.memo === null) checks.push({ field: "memo", expected: null, observed: tx.memo, result: "not_checked" });
  else checks.push({ field: "memo", expected: leg.memo, observed: tx.memo, result: memoEquals(leg.memoType, leg.memo, tx.memoType, tx.memo) ? "equal" : "different" });
  if (leg.source === null) checks.push({ field: "source", expected: null, observed: op.from, result: "not_checked" });
  else checks.push({ field: "source", expected: leg.source, observed: op.from, result: sameAccount(op.from, leg.source) ? "equal" : "different" });
  return checks;
}

function canon(stroops: bigint): string {
  const whole = stroops / 10_000_000n;
  const frac = (stroops % 10_000_000n).toString().padStart(7, "0");
  return `${whole}.${frac}`;
}

function candidateOf(leg: Leg, tx: EvidenceTransaction, op: EvidenceOperation, role: Candidate["role"], checks: FieldCheck[]): Candidate {
  return {
    transactionHash: tx.hash,
    operationId: op.id,
    operationIndex: op.index,
    type: op.type,
    purpose: leg.purpose,
    role,
    sourceId: tx.sourceId,
    from: op.from,
    to: op.toMuxed ?? op.to,
    asset: describeAsset(op.asset),
    amount: op.amount,
    memoType: tx.memoType,
    memo: tx.memo,
    transactionSuccessful: tx.successful && op.transactionSuccessful,
    checks,
  };
}

const UNSUPPORTED_CODES = {
  path_payment: "path_payment_not_supported",
  claimable_balance: "claimable_balance_not_supported",
  soroban: "soroban_transfer_not_supported",
  other_value: "other_value_operation_not_supported",
} as const;

const UNSUPPORTED_TEXT = {
  path_payment: "A path payment can deliver to the expected destination but is not a direct payment; AnchorTrace does not interpret it, so it is unsupported rather than matched.",
  claimable_balance: "A claimable balance is not a delivered payment until it is claimed; AnchorTrace does not interpret claimable balances, so it is unsupported rather than matched.",
  soroban: "A Soroban contract call may transfer assets (see asset_balance_changes) but is not a classic payment; AnchorTrace does not interpret contract transfers, so it is unsupported rather than matched.",
  other_value: "This operation can move funds but is not a classic payment; AnchorTrace does not interpret it, so it is unsupported rather than matched.",
} as const;

function networkOf(label: string | null | undefined): string | null {
  if (!label) return null;
  if (label === "Test SDF Network ; September 2015") return "testnet";
  if (label === "Public Global Stellar Network ; September 2015") return "public";
  return label;
}

export interface SourceInfo {
  network: string | null;
  networkPassphrase: string | null;
}

export interface EvaluateContext {
  evidence: EvidenceSet;
  sources: Map<string, SourceInfo>;
  expectedNetwork: string | null;
}

function failureFinding(hash: string, f: AcquisitionFailure, what: string): Finding {
  if (f.kind === "not_found") {
    return {
      code: "horizon_transaction_not_found",
      severity: "warning",
      effect: "insufficient_evidence",
      message: `${what} ${hash} was not found at the queried Horizon. A 404 does not prove the transaction does not exist (wrong network, ingestion lag or history retention).`,
      details: { hash, kind: f.kind },
      refs: [{ transactionHash: hash, operationId: null, operationIndex: null, sourceId: f.sourceId }],
    };
  }
  return {
    code: "evidence_fetch_failed",
    severity: "warning",
    effect: "insufficient_evidence",
    message: `Could not read ${what} ${hash} (${f.kind}: ${f.detail}). A failed read is not a mismatch; the transfer is unverified.`,
    details: { hash, kind: f.kind },
    refs: [{ transactionHash: hash, operationId: null, operationIndex: null, sourceId: f.sourceId }],
  };
}

/** Evaluate one expected transfer (the main leg, or one refund payment) against the evidence set. */
export function evaluateLeg(leg: Leg, ctx: EvaluateContext): LegEvaluation {
  const what = leg.purpose === "refund" ? "refund transaction" : "Stellar transaction";
  const findings: Finding[] = [];
  let linkedBy: LegEvaluation["linkedBy"] = "none";
  let tx: EvidenceTransaction | undefined;

  if (leg.transactionHash !== null) {
    tx = ctx.evidence.transactions.find((t) => t.hash === leg.transactionHash);
    if (tx === undefined) {
      const fail = ctx.evidence.failures.find((f) => f.hash === leg.transactionHash);
      if (fail) findings.push(failureFinding(leg.transactionHash, fail, what));
      else {
        findings.push({
          code: leg.purpose === "refund" ? "refund_evidence_missing" : "onchain_evidence_missing",
          severity: "warning",
          effect: "insufficient_evidence",
          message: `The record references ${what} ${leg.transactionHash} but no evidence for it was supplied.`,
          details: { hash: leg.transactionHash },
          refs: [{ transactionHash: leg.transactionHash, operationId: null, operationIndex: null, sourceId: null }],
        });
      }
      return { state: "evidence_missing", linkedBy: "stellar_transaction_id", candidates: [], findings };
    }
    linkedBy = "stellar_transaction_id";
  } else {
    // No transaction id in the record: look for evidence that pays the expected destination with the declared memo.
    const hits = ctx.evidence.transactions.filter(
      (t) =>
        t.successful &&
        t.operations.some((op) => op.class === "payment" && destMatch(leg.destination, op) !== "no") &&
        (leg.memo === null || memoEquals(leg.memoType, leg.memo, t.memoType, t.memo)),
    );
    if (hits.length === 0) return { state: "evidence_missing", linkedBy: "none", candidates: [], findings };
    if (hits.length > 1) {
      const candidates: Candidate[] = [];
      for (const t of hits) for (const op of t.operations) if (op.class === "payment" && destMatch(leg.destination, op) !== "no") candidates.push(candidateOf(leg, t, op, "conflicting", checksFor(leg, t, op)));
      findings.push({
        code: "multiple_candidate_transactions",
        severity: "error",
        effect: "ambiguous",
        message: `The record has no Stellar transaction id and ${hits.length} supplied transactions pay the expected destination${leg.memo !== null ? " with the declared memo" : ""}; AnchorTrace cannot tell which one belongs to this record.`,
        details: { transactions: hits.length },
        refs: hits.map((t) => ref(t, null)),
      });
      return { state: "ambiguous", linkedBy: "search", candidates, findings };
    }
    tx = hits[0] as EvidenceTransaction;
    linkedBy = "search";
    findings.push({
      code: "linked_by_search",
      severity: "warning",
      effect: null,
      message: `The record has no stellar_transaction_id; transaction ${tx.hash} was linked only because it pays the expected destination${leg.memo !== null ? " with the declared memo" : ""}.`,
      details: { hash: tx.hash },
      refs: [ref(tx, null)],
    });
  }

  // Network check on the evidence actually used.
  const info = ctx.sources.get(tx.sourceId);
  const evNet = networkOf(info?.network) ?? networkOf(info?.networkPassphrase);
  if (ctx.expectedNetwork !== null && evNet !== null && evNet !== networkOf(ctx.expectedNetwork)) {
    findings.push({
      code: "evidence_network_mismatch",
      severity: "error",
      effect: "insufficient_evidence",
      message: `Evidence for ${tx.hash} comes from network ${evNet} but the expected network is ${ctx.expectedNetwork}; it cannot support this record.`,
      details: { hash: tx.hash, evidenceNetwork: evNet, expectedNetwork: ctx.expectedNetwork },
      refs: [ref(tx, null)],
    });
    return { state: "evidence_missing", linkedBy, candidates: [], findings };
  }

  const payments = tx.operations.filter((o) => o.class === "payment");

  if (!tx.successful) {
    findings.push({
      code: "onchain_transaction_failed",
      severity: "error",
      effect: "discrepant",
      message: `Transaction ${tx.hash} is on the ledger but FAILED (successful=false); none of its operations moved funds, so it cannot be the transfer the record describes.`,
      details: { hash: tx.hash, ledger: tx.ledger },
      refs: [ref(tx, null)],
    });
    const candidates = payments.map((op) => candidateOf(leg, tx!, op, "conflicting", destMatch(leg.destination, op) === "no" ? [] : checksFor(leg, tx!, op)));
    return { state: "tx_failed", linkedBy, candidates, findings };
  }
  if (!tx.operationsComplete) {
    findings.push({
      code: "operations_incomplete",
      severity: "warning",
      effect: "insufficient_evidence",
      message: `Transaction ${tx.hash} declares ${tx.operationCount} operation(s) but evidence lists ${tx.operations.length}; the evidence is truncated, so an exact or unique match cannot be established.`,
      details: { hash: tx.hash, declared: tx.operationCount, supplied: tx.operations.length },
      refs: [ref(tx, null)],
    });
    return { state: "evidence_missing", linkedBy, candidates: [], findings };
  }

  const destOps = payments.filter((op) => destMatch(leg.destination, op) !== "no");
  const otherPayments = payments.filter((op) => destMatch(leg.destination, op) === "no");
  const relatedUnsupported = tx.operations.filter((o) => o.class === "unsupported" && relatedToDestination(o, leg.destination));
  const unrelatedUnsupported = tx.operations.filter((o) => o.class === "unsupported" && !relatedToDestination(o, leg.destination));
  const candidates: Candidate[] = [];

  if (unrelatedUnsupported.length > 0) {
    findings.push({
      code: "unrelated_operation_ignored",
      severity: "info",
      effect: null,
      message: `${unrelatedUnsupported.length} operation(s) of unsupported type in ${tx.hash} do not involve the expected destination and were ignored.`,
      details: { count: unrelatedUnsupported.length },
      refs: unrelatedUnsupported.map((o) => ref(tx!, o)),
    });
  }
  const addUnsupported = () => {
    for (const op of relatedUnsupported) {
      const kind = op.unsupportedKind ?? "other_value";
      candidates.push(candidateOf(leg, tx!, op, "unsupported", []));
      findings.push({
        code: UNSUPPORTED_CODES[kind],
        severity: "warning",
        effect: "unsupported",
        message: `Operation ${op.id} (${op.type}) in ${tx!.hash}: ${UNSUPPORTED_TEXT[kind]}`,
        details: { operationType: op.type },
        refs: [ref(tx!, op)],
      });
    }
  };

  for (const op of destOps) {
    const m = destMatch(leg.destination, op);
    if (m === "yes_muxed_observed" || m === "yes_muxed_not_in_evidence") {
      findings.push({
        code: "muxed_destination_observed",
        severity: "info",
        effect: null,
        message:
          m === "yes_muxed_observed"
            ? `Operation ${op.id} paid muxed account ${op.toMuxed ?? ""} on the expected base account; the muxed id was not part of the expectation.`
            : `The expected destination is a muxed address but evidence for operation ${op.id} shows only the base account; the muxed id is unverified.`,
        refs: [ref(tx, op)],
      });
    }
  }

  if (destOps.length >= 2) {
    for (const op of destOps) candidates.push(candidateOf(leg, tx, op, "conflicting", checksFor(leg, tx, op)));
    const byAsset = new Map<string, bigint>();
    for (const op of destOps) if (op.asset && op.amount) byAsset.set(assetKey(op.asset), (byAsset.get(assetKey(op.asset)) ?? 0n) + parseAmount(op.amount));
    findings.push({
      code: "multiple_candidate_operations",
      severity: "error",
      effect: "ambiguous",
      message: `Transaction ${tx.hash} contains ${destOps.length} payment operations to the expected destination (${[...byAsset].map(([k, v]) => `${canon(v)} ${k === "native" ? "XLM" : k.split(":")[0]}`).join(" + ")}); AnchorTrace cannot attribute them to a single withdrawal. Do not treat any single operation as the match.`,
      details: { operations: destOps.length },
      refs: destOps.map((o) => ref(tx!, o)),
    });
    addUnsupported();
    return { state: "ambiguous", linkedBy, candidates, findings };
  }

  if (destOps.length === 1) {
    const op = destOps[0] as EvidenceOperation;
    const checks = checksFor(leg, tx, op);
    const bad = checks.filter((c) => c.result === "different");
    candidates.push(candidateOf(leg, tx, op, bad.length === 0 ? "matched" : "conflicting", checks));
    for (const c of bad) {
      const r = [ref(tx, op)];
      if (c.field === "issuer") {
        if (checks.find((x) => x.field === "asset")?.result === "equal") {
          findings.push({
            code: "wrong_issuer",
            severity: "error",
            effect: "discrepant",
            message: `Operation ${op.id} paid ${op.asset ? assetKey(op.asset) : "an unreadable asset"} but the record expects the same code from issuer ${c.expected}. A same-code asset from a different issuer is a different asset.`,
            details: { expectedIssuer: c.expected, observedIssuer: c.observed },
            refs: r,
          });
        }
      } else if (c.field === "asset") {
        findings.push({
          code: "wrong_asset",
          severity: "error",
          effect: "discrepant",
          message: `Operation ${op.id} paid asset ${c.observed ?? "(unreadable)"} but the record expects ${c.expected}.`,
          details: { expected: c.expected, observed: c.observed },
          refs: r,
        });
      } else if (c.field === "amount") {
        const diff = op.amount !== null ? parseAmount(op.amount) - leg.amount : null;
        findings.push({
          code: "amount_mismatch",
          severity: "error",
          effect: "discrepant",
          message: `Operation ${op.id} paid ${c.observed ?? "(unreadable)"} but the record expects ${c.expected}${diff === null ? "" : ` (${diff < 0n ? "short by" : "over by"} ${canon(diff < 0n ? -diff : diff)})`}${leg.toleranceBps > 0 ? ` within a ${leg.toleranceBps} bps tolerance` : ""}.`,
          details: { expected: c.expected, observed: c.observed, differenceStroops: diff === null ? null : diff.toString() },
          refs: r,
        });
      } else if (c.field === "memo") {
        findings.push({
          code: "memo_mismatch",
          severity: "error",
          effect: "discrepant",
          message: `Transaction ${tx.hash} carries memo (${tx.memoType}) that differs from the record's declared memo; the payment cannot be tied to this record by memo.`,
          details: { expectedType: leg.memoType, observedType: tx.memoType },
          refs: r,
        });
      } else if (c.field === "source") {
        findings.push({
          code: "source_mismatch",
          severity: "error",
          effect: "discrepant",
          message: `Operation ${op.id} was sent from ${c.observed ?? "(unknown)"} but the expected sender is ${c.expected}.`,
          details: { expected: c.expected, observed: c.observed },
          refs: r,
        });
      }
    }
    if (relatedUnsupported.length > 0) {
      addUnsupported();
      findings.push({
        code: "unsupported_operation_alongside_match",
        severity: "warning",
        effect: "unsupported",
        message: `Transaction ${tx.hash} also contains an operation AnchorTrace does not interpret that may credit the same destination; whether the direct payment is the only credit cannot be established.`,
        refs: relatedUnsupported.map((o) => ref(tx!, o)),
      });
    }
    for (const op2 of otherPayments) candidates.push(candidateOf(leg, tx, op2, "unrelated", []));
    const state: LegState = bad.length > 0 ? "mismatch" : relatedUnsupported.length > 0 ? "unsupported" : "matched";
    return { state, linkedBy, candidates, findings };
  }

  // No direct payment reached the expected destination.
  addUnsupported();
  if (otherPayments.length > 0) {
    for (const op of otherPayments) candidates.push(candidateOf(leg, tx, op, "conflicting", []));
    const lookalike = otherPayments.filter((o) => o.asset !== null && assetKey(o.asset) === assetKey(leg.asset) && o.amount !== null && parseAmount(o.amount) === leg.amount);
    findings.push({
      code: "wrong_destination",
      severity: "error",
      effect: "discrepant",
      message: `No payment in ${tx.hash} reached the expected destination${lookalike.length > 0 ? `; ${lookalike.length} payment(s) of the expected asset and amount went to ${[...new Set(lookalike.map((o) => o.to))].join(", ")} instead` : `; payment(s) went to ${[...new Set(otherPayments.map((o) => o.to))].join(", ")} instead`}.`,
      details: { expected: leg.destination, observedDestinations: [...new Set(otherPayments.map((o) => o.to ?? "?"))].join(",") },
      refs: otherPayments.map((o) => ref(tx!, o)),
    });
    return { state: "mismatch", linkedBy, candidates, findings };
  }
  if (relatedUnsupported.length > 0) return { state: "unsupported", linkedBy, candidates, findings };
  findings.push({
    code: "transaction_has_no_matching_payment",
    severity: "error",
    effect: "discrepant",
    message: `Transaction ${tx.hash} contains no payment to the expected destination (operation types: ${[...new Set(tx.operations.map((o) => o.type))].join(", ") || "none"}).`,
    refs: [ref(tx, null)],
  });
  return { state: "mismatch", linkedBy, candidates, findings };
}

