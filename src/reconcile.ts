import { assetKey, parseAsset, parseStellarAsset, type StellarAsset } from "./asset.ts";
import { formatAmount, parseAmount } from "./decimal.ts";
import { InputError } from "./errors.ts";
import { evaluateLeg, type EvaluateContext, type EvidenceSet, type Leg, type LegEvaluation, type SourceInfo } from "./leg.ts";
import {
  OUTCOMES,
  outcomeRank,
  worst,
  type Candidate,
  type ExpectedLeg,
  type Finding,
  type Outcome,
  type Provenance,
  type Report,
  type TransactionReport,
} from "./reportSchema.ts";
import { expectationFor, isKnownStatus, type Expectation, type Kind, type Sep24Record } from "./sep24.ts";
import { isStellarAddress } from "./strkey.ts";
import { buildTimeline, type Snapshot } from "./timeline.ts";
import { REPORT_VERSION, TOOL_VERSION } from "./version.ts";

export type FeePolicy = "anchor_deducted" | "customer_paid_on_top" | "no_fee";
export const FEE_POLICIES: readonly FeePolicy[] = ["anchor_deducted", "customer_paid_on_top", "no_fee"];

export interface ReconcileOptions {
  /**
   * How the anchor fee relates to the on-chain amount (explicit; defaults to anchor_deducted, the SEP-24 amount formula):
   * - anchor_deducted: amount_out = amount_in - fee - refunds; a withdrawal's on-chain amount is amount_in.
   * - customer_paid_on_top: the fee is charged in addition to amount_in; a withdrawal's on-chain amount is amount_in + fee;
   *   amount_out = amount_in - refunds.
   * - no_fee: any non-zero fee is a discrepancy; on-chain amount is amount_in.
   * A deposit's on-chain amount is amount_out under every policy (SEP-24 defines it net of fees).
   */
  feePolicy?: FeePolicy;
  /** Stellar asset (native or CODE:ISSUER) to expect when the record omits amount_in_asset / amount_out_asset. Never guessed. */
  assetOverride?: string;
  /** For deposits: the account the anchor is expected to pay from. */
  anchorAccount?: string;
  /** Allowed amount deviation in basis points (SEP-24 suggests anchors tolerate up to 10% for wallet-side exchange). Default 0. */
  amountToleranceBps?: number;
  /** `testnet`, `public` or a network passphrase; evidence from a different network cannot support the record. */
  expectedNetwork?: string;
}

export interface ReconcileInput {
  records: Snapshot[];
  evidence: EvidenceSet;
  /** Describes every input file or fetch, in the order the caller wants them listed. */
  sources: Provenance[];
  options?: ReconcileOptions;
  now?: Date;
}

export const LIMITATIONS: readonly string[] = [
  "Confirmation on chain is not a bank payout. For a withdrawal, a confirmed Stellar payment to the anchor shows only the wallet-side transfer. AnchorTrace cannot observe the anchor's bank, cash or other external payout; a status of completed or an external_transaction_id is the anchor's own claim and stays unverified.",
  "Only SEP-24 transactions and classic direct payment operations are reconciled. Path payments, claimable balances, Soroban contract transfers and other value-moving forms are reported as unsupported, never as matched.",
  "Absence of evidence is not evidence of absence: supplied files and single-hash Horizon reads cannot prove that no payment happened. A failed or missing read is reported as insufficient_evidence, never as a mismatch.",
  "Evidence is exactly what the supplied file or the named Horizon returned at the recorded time. AnchorTrace does not verify ledger history cryptographically.",
  "The Stellar network fee (fee_charged) is not the anchor fee and is not compared. Anchor fees come only from the SEP-24 record.",
];

const WITHDRAWAL_NOTE =
  "Confirmation on chain is not a bank payout: AnchorTrace checks only the Stellar leg. The external payout (bank, cash or other rail) is not observable here and remains the anchor's claim.";
const DEPOSIT_NOTE = "AnchorTrace checks only the Stellar leg. The user's external deposit (bank, crypto or other rail) is not observable here and remains the anchor's claim.";

type ReadAmount = { state: "absent" } | { state: "invalid" } | { state: "ok"; value: bigint };

function present(v: unknown): boolean {
  return v !== undefined && v !== null && v !== "";
}

function readAmount(field: string, v: unknown, findings: Finding[]): ReadAmount {
  if (!present(v)) return { state: "absent" };
  try {
    return { state: "ok", value: parseAmount(v) };
  } catch (e) {
    findings.push({
      code: "record_field_invalid",
      severity: "error",
      effect: "insufficient_evidence",
      message: `Record field ${field} is not a usable amount: ${e instanceof Error ? e.message : String(e)}.`,
      details: { field },
    });
    return { state: "invalid" };
  }
}

function readAssetField(field: string, v: unknown, findings: Finding[]): StellarAsset | "offchain" | null {
  if (!present(v)) return null;
  const p = parseAsset(String(v));
  if ("error" in p) {
    findings.push({ code: "record_field_invalid", severity: "error", effect: "insufficient_evidence", message: `Record field ${field}: ${p.error}.`, details: { field } });
    return null;
  }
  return p.kind === "offchain" ? "offchain" : p;
}

function fmt(v: bigint | null): string | null {
  return v === null ? null : formatAmount(v);
}

function normalizeSource(s: Provenance): SourceInfo {
  return { network: s.network, networkPassphrase: s.networkPassphrase };
}

function effectFindings(fs: Finding[]): Finding[] {
  return fs.filter((f) => f.effect !== null);
}

const SEVERITY_RANK = { error: 0, warning: 1, info: 2 } as const;

function sortFindings(fs: Finding[]): Finding[] {
  const key = (f: Finding) => (f.effect === null ? 99 : 10 - outcomeRank(f.effect));
  return [...fs].sort((a, b) => key(a) - key(b) || SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0) || (a.message < b.message ? -1 : a.message > b.message ? 1 : 0));
}

interface TxContext {
  evidence: EvidenceSet;
  sources: Map<string, SourceInfo>;
  options: Required<Pick<ReconcileOptions, "amountToleranceBps">> & ReconcileOptions & { feePolicy: FeePolicy };
}

function reconcileTransaction(id: string, snaps: Snapshot[], ctx: TxContext): TransactionReport {
  const tl = buildTimeline(snaps);
  const rec: Sep24Record = tl.current;
  const kind: Kind = rec.kind;
  const findings: Finding[] = [...tl.findings];
  const known = isKnownStatus(rec.status);
  const expectation: Expectation | null = known ? expectationFor(kind, rec.status as Parameters<typeof expectationFor>[1]) : null;
  const opts = ctx.options;

  const base = {
    id,
    kind,
    currentStatus: { value: rec.status, known, expectation, electedBy: tl.electedBy },
    timeline: tl.entries,
  };
  const emptyAmounts = { amountIn: null, amountInAsset: null, amountOut: null, amountOutAsset: null, feeTotal: null, feeAsset: null, refundedTotal: null, refundFeeTotal: null };

  if (!known || expectation === null) {
    findings.push({
      code: "status_unknown",
      severity: "error",
      effect: "unsupported",
      message: `Status "${rec.status}" is not one of the SEP-24 v3.8.0 statuses; AnchorTrace does not guess its meaning.`,
      details: { status: rec.status },
    });
    return finish(base, null, emptyAmounts, "none", [], [], findings, kind);
  }

  if (kind === "deposit" && rec.status === "pending_user_transfer_complete") {
    findings.push({ code: "status_not_valid_for_kind", severity: "warning", effect: null, message: "SEP-24 uses pending_user_transfer_complete only for withdrawals; treated as not yet on chain.", details: { status: rec.status, kind } });
  }

  // ---- amounts as recorded -------------------------------------------------
  const amountIn = readAmount("amount_in", rec.amount_in, findings);
  const amountOut = readAmount("amount_out", rec.amount_out, findings);
  const feeSource = present(rec.fee_details?.total) ? "fee_details.total" : present(rec.amount_fee) ? "amount_fee" : null;
  const fee = feeSource === "fee_details.total" ? readAmount("fee_details.total", rec.fee_details?.total, findings) : readAmount("amount_fee", rec.amount_fee, findings);
  const refunded = readAmount("refunds.amount_refunded", rec.refunds?.amount_refunded, findings);
  const refundFee = readAmount("refunds.amount_fee", rec.refunds?.amount_fee, findings);
  const inAsset = readAssetField("amount_in_asset", rec.amount_in_asset, findings);
  const outAsset = readAssetField("amount_out_asset", rec.amount_out_asset, findings);
  const feeAssetRaw = present(rec.fee_details?.asset) ? rec.fee_details?.asset : rec.amount_fee_asset;
  const feeAsset = readAssetField(present(rec.fee_details?.asset) ? "fee_details.asset" : "amount_fee_asset", feeAssetRaw, findings);
  const val = (r: ReadAmount): bigint | null => (r.state === "ok" ? r.value : null);
  const assetStr = (a: StellarAsset | "offchain" | null, raw: string | null | undefined): string | null => (a === null ? null : a === "offchain" ? (raw ?? null) : assetKey(a));

  const amounts = {
    amountIn: fmt(val(amountIn)),
    amountInAsset: assetStr(inAsset, rec.amount_in_asset),
    amountOut: fmt(val(amountOut)),
    amountOutAsset: assetStr(outAsset, rec.amount_out_asset),
    feeTotal: fmt(val(fee)),
    feeAsset: assetStr(feeAsset, feeAssetRaw),
    refundedTotal: fmt(val(refunded)),
    refundFeeTotal: fmt(val(refundFee)),
  };

  // ---- the record's own arithmetic (SEP-24 "Amount Formulas") under the chosen fee policy ----
  const crossAsset = inAsset !== null && outAsset !== null && (inAsset === "offchain" || outAsset === "offchain" || assetKey(inAsset) !== assetKey(outAsset));
  const feeOtherAsset = feeAsset !== null && inAsset !== null && (feeAsset === "offchain" || inAsset === "offchain" || assetKey(feeAsset) !== assetKey(inAsset));
  if (opts.feePolicy === "no_fee" && fee.state === "ok" && fee.value !== 0n) {
    findings.push({
      code: "fee_present_under_no_fee_policy",
      severity: "error",
      effect: "discrepant",
      message: `Fee policy is no_fee but the record charges a fee of ${formatAmount(fee.value)}.`,
      details: { fee: formatAmount(fee.value), policy: opts.feePolicy },
    });
  }
  if (amountIn.state === "ok" && amountOut.state === "ok") {
    if (crossAsset) {
      findings.push({ code: "cross_asset_not_converted", severity: "info", effect: null, message: "amount_in_asset and amount_out_asset differ; AnchorTrace does not convert between assets, so the SEP-24 amount formula is not checked." });
    } else if (feeOtherAsset && fee.state === "ok") {
      findings.push({ code: "amount_formula_skipped", severity: "info", effect: null, message: "The fee is expressed in a different asset than amount_in; AnchorTrace does not convert, so the SEP-24 amount formula is not checked." });
    } else if (opts.feePolicy === "anchor_deducted" && fee.state === "absent") {
      findings.push({ code: "amount_formula_skipped", severity: "info", effect: null, message: "No fee is recorded (fee_details/amount_fee absent), so amount_out = amount_in - fee - refunds cannot be checked under anchor_deducted." });
    } else if (fee.state !== "invalid" && refunded.state !== "invalid" && refundFee.state !== "invalid") {
      const r = refunded.state === "ok" ? refunded.value : 0n;
      const rf = refundFee.state === "ok" ? refundFee.value : 0n;
      const f = opts.feePolicy === "anchor_deducted" && fee.state === "ok" ? fee.value : 0n;
      const expectedOut = amountIn.value - f - r - rf;
      if (expectedOut !== amountOut.value) {
        findings.push({
          code: "record_amounts_inconsistent",
          severity: "error",
          effect: "discrepant",
          message: `The record's own amounts disagree under fee policy ${opts.feePolicy}: amount_out is ${formatAmount(amountOut.value)} but amount_in${opts.feePolicy === "anchor_deducted" ? " - fee" : ""} - refunds is ${formatAmount(expectedOut)}.`,
          details: { amountOut: formatAmount(amountOut.value), computed: formatAmount(expectedOut), policy: opts.feePolicy },
        });
      }
    }
  }

  // ---- the expected Stellar leg -------------------------------------------
  const basis: Record<string, string> = {};
  let leg: Leg | null = null;
  const direction: ExpectedLeg["direction"] = kind === "withdrawal" ? "wallet_to_anchor" : "anchor_to_wallet";
  const needLeg = expectation !== "none" || present(rec.stellar_transaction_id);
  const problems: string[] = [];
  const assetField = kind === "withdrawal" ? "amount_in_asset" : "amount_out_asset";
  const recAsset = kind === "withdrawal" ? inAsset : outAsset;
  let legAsset: StellarAsset | null = null;
  if (recAsset === "offchain") {
    problems.push(`${assetField} is an off-chain asset; the Stellar leg needs a Stellar asset`);
    findings.push({ code: "record_field_invalid", severity: "error", effect: "insufficient_evidence", message: `Record field ${assetField} is ${kind === "withdrawal" ? rec.amount_in_asset : rec.amount_out_asset}, which is not a Stellar asset, so the on-chain leg cannot be matched.`, details: { field: assetField } });
  } else if (recAsset !== null) {
    legAsset = recAsset;
    basis.asset = assetField;
  } else if (opts.assetOverride !== undefined) {
    const p = parseStellarAsset(opts.assetOverride);
    if ("error" in p) throw new InputError(`Invalid asset option: ${p.error}`);
    legAsset = p;
    basis.asset = "--asset option (the record omits " + assetField + ")";
  } else if (needLeg) {
    problems.push("asset");
    findings.push({
      code: "expected_asset_unknown",
      severity: "error",
      effect: "insufficient_evidence",
      message: `The record omits ${assetField} and no asset option was given. AnchorTrace will not guess the issuer, so the payment's asset and issuer cannot be checked.`,
      details: { field: assetField },
    });
  }

  let destination: string | null = null;
  if (kind === "withdrawal") {
    destination = present(rec.withdraw_anchor_account) ? (rec.withdraw_anchor_account as string) : null;
    if (destination === null) problems.push("withdraw_anchor_account");
    else basis.destination = "withdraw_anchor_account";
  } else {
    destination = present(rec.to) ? (rec.to as string) : null;
    if (destination === null) problems.push("to");
    else if (!isStellarAddress(destination)) {
      problems.push("to");
      findings.push({ code: "record_field_invalid", severity: "error", effect: "insufficient_evidence", message: "Record field to is not a valid Stellar address (G... or M...), so the destination cannot be matched.", details: { field: "to" } });
      destination = null;
    } else basis.destination = "to";
  }
  if (destination !== null && kind === "withdrawal" && !isStellarAddress(destination)) {
    problems.push("withdraw_anchor_account");
    findings.push({ code: "record_field_invalid", severity: "error", effect: "insufficient_evidence", message: "Record field withdraw_anchor_account is not a valid Stellar address (G... or M...).", details: { field: "withdraw_anchor_account" } });
    destination = null;
  }

  let expectedAmount: bigint | null = null;
  if (kind === "withdrawal") {
    if (amountIn.state === "ok") {
      if (opts.feePolicy === "customer_paid_on_top") {
        if (fee.state === "ok" && !feeOtherAsset) {
          expectedAmount = amountIn.value + fee.value;
          basis.amount = "amount_in + fee (customer_paid_on_top)";
        } else if (fee.state === "absent") {
          problems.push("fee");
          findings.push({ code: "record_field_missing", severity: "error", effect: "insufficient_evidence", message: "Fee policy customer_paid_on_top needs fee_details.total (or amount_fee) to compute the on-chain amount, but the record has none.", details: { field: "fee_details.total" } });
        } else if (feeOtherAsset) {
          problems.push("fee asset");
          findings.push({ code: "record_field_invalid", severity: "error", effect: "insufficient_evidence", message: "The fee is expressed in a different asset than amount_in; AnchorTrace does not convert, so the on-chain amount under customer_paid_on_top cannot be computed.", details: { field: "fee_details.asset" } });
        }
      } else {
        expectedAmount = amountIn.value;
        basis.amount = `amount_in (${opts.feePolicy})`;
      }
    } else problems.push("amount_in");
  } else if (amountOut.state === "ok") {
    expectedAmount = amountOut.value;
    basis.amount = `amount_out (${opts.feePolicy}; SEP-24 defines it net of fees)`;
  } else problems.push("amount_out");

  const memoType = kind === "withdrawal" ? rec.withdraw_memo_type : rec.deposit_memo_type;
  const memoVal = kind === "withdrawal" ? rec.withdraw_memo : rec.deposit_memo;
  let source: string | null = null;
  if (kind === "withdrawal" && present(rec.from)) {
    if (isStellarAddress(rec.from as string)) {
      source = rec.from as string;
      basis.source = "from";
    } else findings.push({ code: "record_field_invalid", severity: "warning", effect: null, message: "Record field from is not a Stellar address; the sender is not checked.", details: { field: "from" } });
  } else if (kind === "deposit" && opts.anchorAccount !== undefined) {
    source = opts.anchorAccount;
    basis.source = "--anchor-account option";
  }

  const hasHash = present(rec.stellar_transaction_id);
  const unsupportedDeposit = kind === "deposit" && present(rec.claimable_balance_id);
  let main: LegEvaluation = { state: "evidence_missing", linkedBy: "none", candidates: [], findings: [] };
  let expectedReport: ExpectedLeg | null = null;

  if (unsupportedDeposit) {
    findings.push({
      code: "claimable_balance_deposit_not_supported",
      severity: "warning",
      effect: "unsupported",
      message: `The deposit delivers through claimable balance ${rec.claimable_balance_id}; AnchorTrace does not interpret claimable balances and does not reconcile them as payments.`,
      details: { claimableBalanceId: rec.claimable_balance_id ?? null },
    });
  } else if (destination !== null && legAsset !== null && expectedAmount !== null) {
    if (present(memoVal)) {
      basis.memo = kind === "withdrawal" ? "withdraw_memo" : "deposit_memo";
      if (!present(memoType)) findings.push({ code: "memo_type_not_declared", severity: "info", effect: null, message: "The record declares a memo but no memo type; the memo value is compared without its type." });
    } else if (needLeg && expectation !== "failure") {
      findings.push({ code: "memo_not_declared", severity: "info", effect: null, message: "The record declares no memo, so the transaction memo is not checked." });
    }
    leg = {
      purpose: "transfer",
      destination,
      asset: legAsset,
      amount: expectedAmount,
      memoType: present(memoVal) && present(memoType) ? (memoType as string) : null,
      memo: present(memoVal) ? (memoVal as string) : null,
      source,
      transactionHash: hasHash ? (rec.stellar_transaction_id as string) : null,
      toleranceBps: opts.amountToleranceBps,
    };
    expectedReport = {
      direction,
      destination,
      asset: assetKey(legAsset),
      amount: formatAmount(expectedAmount),
      memoType: leg.memoType,
      memo: leg.memo,
      source,
      transactionHash: leg.transactionHash,
      basis,
    };
    main = evaluateLeg(leg, { evidence: ctx.evidence, sources: ctx.sources, expectedNetwork: opts.expectedNetwork ?? null } satisfies EvaluateContext);
    findings.push(...main.findings);
  } else if (needLeg) {
    for (const p of problems) {
      if (["asset", "fee", "fee asset"].includes(p)) continue; // already explained above
      findings.push({ code: "record_field_missing", severity: "error", effect: "insufficient_evidence", message: `Record field ${p} is required to match the Stellar leg at status ${rec.status} but is missing or unusable.`, details: { field: p } });
    }
  }
  if (!hasHash && expectation === "required" && main.state === "evidence_missing" && leg !== null) {
    findings.push({ code: "stellar_transaction_id_missing", severity: "warning", effect: "insufficient_evidence", message: `Status ${rec.status} implies the Stellar transfer happened, but the record has no stellar_transaction_id and no supplied evidence pays the expected destination${leg.memo !== null ? " with the declared memo" : ""}.` });
  }

  // ---- combine the leg state with what the status promises ------------------
  const state = main.state;
  const hash = leg?.transactionHash ?? null;
  const matchedNote = (code: Finding["code"], effect: Outcome | null, msg: string, sev: Finding["severity"] = "info"): void => {
    findings.push({ code, severity: sev, effect, message: msg, refs: main.candidates.filter((c) => c.role === "matched").map((c) => ({ transactionHash: c.transactionHash, operationId: c.operationId, operationIndex: c.operationIndex, sourceId: c.sourceId })) });
  };
  if (leg !== null) {
    if (state === "matched") {
      if (expectation === "required") matchedNote("onchain_leg_matched", rec.status === "completed" ? "matched" : "pending", `The on-chain transfer matches the record (destination, asset and issuer, amount${leg.memo !== null ? ", memo" : ""}${leg.source !== null ? ", sender" : ""}). The record's status is ${rec.status}.`);
      else if (expectation === "inflight") matchedNote("onchain_leg_matched", "pending", `The transfer is confirmed on chain and matches the record, but the record still says ${rec.status}.`);
      else if (expectation === "none") matchedNote("payment_before_status_advanced", "discrepant", `A payment matching this record is already on chain but the record still says ${rec.status}. This may be status lag, or the anchor's status is wrong.`, "warning");
      else if (expectation === "failure") matchedNote("funds_received_but_terminal_failure", "discrepant", `A payment matching this record is on chain but the record's terminal status is ${rec.status}. Funds may have been received without the transaction completing; check for a refund.`, "error");
      else matchedNote("onchain_leg_matched", null, "The original on-chain transfer matches the record; refund payments are checked separately.");
    } else if (state === "evidence_missing") {
      const noEffectYet = effectFindings(main.findings).length === 0;
      if (noEffectYet) {
        if (expectation === "none") {
          if (hash === null) findings.push({ code: "awaiting_onchain_transfer", severity: "info", effect: "pending", message: `Status ${rec.status} does not yet imply an on-chain transfer, and none was supplied.` });
          else findings.push({ code: "onchain_evidence_missing", severity: "warning", effect: "insufficient_evidence", message: `The record references transaction ${hash} but no evidence for it was supplied.` });
        } else if (expectation === "inflight") findings.push({ code: "awaiting_onchain_transfer", severity: "info", effect: "pending", message: `Status ${rec.status}: the transfer was submitted to Stellar; no confirmation evidence was supplied.` });
        else if (expectation === "failure") findings.push({ code: "absence_not_provable", severity: "warning", effect: "insufficient_evidence", message: `Status ${rec.status} is a terminal failure, but supplied evidence cannot prove that no payment was made (absence of evidence is not evidence of absence).` });
        // required: stellar_transaction_id_missing / onchain_evidence_missing were added above or by the leg
      }
      if (hash !== null && expectation === "required" && noEffectYet) {
        findings.push({ code: "onchain_evidence_missing", severity: "warning", effect: "insufficient_evidence", message: `Status ${rec.status} implies the transfer happened but no evidence for transaction ${hash} was supplied.` });
      }
    }
    // mismatch / ambiguous / unsupported / tx_failed carry their own effects from the leg evaluation.
  } else if (!unsupportedDeposit) {
    // The leg could not be built from the record.
    if (expectation === "none" && !needLeg) findings.push({ code: "awaiting_onchain_transfer", severity: "info", effect: "pending", message: `Status ${rec.status} does not yet imply an on-chain transfer, and the record has no Stellar transaction id.` });
    else if (expectation === "inflight" && effectFindings(findings).length === 0) findings.push({ code: "awaiting_onchain_transfer", severity: "info", effect: "pending", message: `Status ${rec.status}: the transfer was submitted to Stellar; the record lacks fields needed to match it.` });
    else if (expectation === "failure" && effectFindings(findings).length === 0) findings.push({ code: "absence_not_provable", severity: "warning", effect: "insufficient_evidence", message: `Status ${rec.status} is a terminal failure; no payment can be matched from the record and absence cannot be proven.` });
  }

  // ---- refunds -------------------------------------------------------------
  const refundCandidates: Candidate[] = [];
  const refundChecks: TransactionReport["matching"]["refunds"] = [];
  const payments = rec.refunds?.payments ?? [];
  if (payments.length > 0) {
    let sumAmt = 0n;
    let sumFee = 0n;
    let amtOk = true;
    let feeOk = true;
    for (const p of payments) {
      const a = readAmount("refunds.payments[].amount", p.amount, findings);
      const f = readAmount("refunds.payments[].fee", p.fee, findings);
      if (a.state === "ok") sumAmt += a.value;
      else amtOk = false;
      if (f.state === "ok") sumFee += f.value;
      else if (f.state === "invalid") feeOk = false;
    }
    if (amtOk && refunded.state === "ok" && refunded.value !== sumAmt) findings.push({ code: "record_amounts_inconsistent", severity: "error", effect: "discrepant", message: `refunds.amount_refunded is ${formatAmount(refunded.value)} but the refund payments sum to ${formatAmount(sumAmt)}.`, details: { amountRefunded: formatAmount(refunded.value), paymentsSum: formatAmount(sumAmt) } });
    if (feeOk && refundFee.state === "ok" && refundFee.value !== sumFee) findings.push({ code: "record_amounts_inconsistent", severity: "error", effect: "discrepant", message: `refunds.amount_fee is ${formatAmount(refundFee.value)} but the refund payment fees sum to ${formatAmount(sumFee)}.`, details: { amountFee: formatAmount(refundFee.value), paymentsSum: formatAmount(sumFee) } });
  }
  let stellarRefunds = 0;
  let matchedRefunds = 0;
  for (const p of payments) {
    const amt = readAmount("refunds.payments[].amount", p.amount, []);
    const label = fmt(amt.state === "ok" ? amt.value : null);
    if (p.id_type !== "stellar") {
      refundChecks.push({ id: p.id, idType: p.id_type, amount: label, result: "not_observable" });
      continue;
    }
    stellarRefunds += 1;
    const refundDest = kind === "withdrawal" && present(rec.from) && isStellarAddress(rec.from as string) ? (rec.from as string) : null;
    if (refundDest === null || legAsset === null || amt.state !== "ok") {
      refundChecks.push({ id: p.id, idType: p.id_type, amount: label, result: "not_observable" });
      findings.push({ code: "refund_not_observable", severity: "warning", effect: "insufficient_evidence", message: `Refund payment ${p.id} cannot be matched: ${kind === "deposit" ? "a deposit refund destination is not a Stellar address in the record" : "the refund destination (from), the asset or the refund amount is missing or unusable"}.`, details: { id: p.id } });
      continue;
    }
    const rl: Leg = { purpose: "refund", destination: refundDest, asset: legAsset, amount: amt.value, memoType: null, memo: null, source: null, transactionHash: p.id, toleranceBps: 0 };
    const ev = evaluateLeg(rl, { evidence: ctx.evidence, sources: ctx.sources, expectedNetwork: opts.expectedNetwork ?? null });
    refundCandidates.push(...ev.candidates);
    findings.push(...ev.findings);
    if (ev.state === "matched") {
      matchedRefunds += 1;
      refundChecks.push({ id: p.id, idType: p.id_type, amount: label, result: "matched" });
    } else if (ev.state === "evidence_missing") refundChecks.push({ id: p.id, idType: p.id_type, amount: label, result: "evidence_missing" });
    else {
      refundChecks.push({ id: p.id, idType: p.id_type, amount: label, result: "mismatch" });
      if (!effectFindings(ev.findings).some((f) => f.effect === "discrepant" || f.effect === "ambiguous" || f.effect === "unsupported")) {
        findings.push({ code: "refund_mismatch", severity: "error", effect: "discrepant", message: `Refund payment ${p.id} does not match the record.` });
      }
    }
  }
  const externalRefunds = payments.length - stellarRefunds;
  if (rec.status === "refunded") {
    if (stellarRefunds === 0) {
      findings.push({ code: "refund_not_observable", severity: "warning", effect: "insufficient_evidence", message: payments.length === 0 ? "Status is refunded but the record lists no refund payments." : "Status is refunded but every listed refund is external (not a Stellar transaction); AnchorTrace cannot observe it.", details: { externalRefunds } });
    } else if (matchedRefunds === stellarRefunds) {
      findings.push({ code: "refund_payment_matched", severity: "info", effect: "matched", message: `${matchedRefunds} on-chain refund payment(s) match the record (destination, asset and issuer, amount).` });
      if (externalRefunds > 0) findings.push({ code: "refund_not_observable", severity: "info", effect: null, message: `${externalRefunds} additional refund(s) are external and not observable here.` });
    }
  } else if (externalRefunds > 0) {
    findings.push({ code: "refund_not_observable", severity: "info", effect: null, message: `${externalRefunds} refund(s) are external (not a Stellar transaction) and not observable here.` });
  }

  // ---- standing scope note --------------------------------------------------
  findings.push(
    kind === "withdrawal"
      ? { code: "external_payout_not_verified", severity: "info", effect: null, message: WITHDRAWAL_NOTE }
      : { code: "external_funds_not_verified", severity: "info", effect: null, message: DEPOSIT_NOTE },
  );

  return finish(base, expectedReport, amounts, main.linkedBy, [...main.candidates, ...refundCandidates], refundChecks, findings, kind);
}

function finish(
  base: { id: string; kind: Kind; currentStatus: TransactionReport["currentStatus"]; timeline: TransactionReport["timeline"] },
  expected: ExpectedLeg | null,
  amounts: TransactionReport["amounts"],
  linkedBy: TransactionReport["matching"]["linkedBy"],
  candidates: Candidate[],
  refunds: TransactionReport["matching"]["refunds"],
  findingsIn: Finding[],
  kind: Kind,
): TransactionReport {
  let findings = findingsIn;
  const effects = effectFindings(findings).map((f) => f.effect as Outcome);
  let outcome = worst(effects);
  if (outcome === null) {
    // Defensive: every rule path emits an effect. If none did, say so rather than claiming a verdict.
    findings = [...findings, { code: "record_field_missing", severity: "error", effect: "insufficient_evidence", message: "No reconciliation rule produced a verdict for this record." }];
    outcome = "insufficient_evidence";
  }
  const sorted = sortFindings(findings);
  const top = sorted.find((f) => f.effect === outcome);
  const tail = kind === "withdrawal" && (outcome === "matched" || outcome === "pending") ? " Chain confirmation is not proof of the external payout." : "";
  const summary = `${(top?.message ?? "").trim()}${tail}`;
  return { ...base, outcome, summary, expected, amounts, matching: { linkedBy, candidates, refunds }, findings: sorted };
}

export function reconcile(input: ReconcileInput): Report {
  const o = input.options ?? {};
  const tolerance = o.amountToleranceBps ?? 0;
  if (!Number.isInteger(tolerance) || tolerance < 0 || tolerance > 10_000) throw new InputError("amountToleranceBps must be an integer between 0 and 10000");
  if (o.feePolicy !== undefined && !FEE_POLICIES.includes(o.feePolicy)) throw new InputError(`feePolicy must be one of ${FEE_POLICIES.join(", ")}`);
  if (o.anchorAccount !== undefined && !isStellarAddress(o.anchorAccount)) throw new InputError("anchorAccount must be a valid Stellar address (G... or M...)");
  if (o.assetOverride !== undefined) {
    const a = parseStellarAsset(o.assetOverride);
    if ("error" in a) throw new InputError(`Invalid asset option: ${a.error}`);
  }
  if (input.records.length === 0) throw new InputError("No SEP-24 transaction records were supplied");
  const options = { ...o, feePolicy: o.feePolicy ?? "anchor_deducted", amountToleranceBps: tolerance } as TxContext["options"];

  const byId = new Map<string, Snapshot[]>();
  for (const s of input.records) {
    const list = byId.get(s.record.id) ?? [];
    if (list[0] && list[0].record.kind !== s.record.kind) throw new InputError(`Transaction ${s.record.id} appears as both a ${list[0].record.kind} and a ${s.record.kind}`);
    list.push(s);
    byId.set(s.record.id, list);
  }
  const sources = new Map<string, SourceInfo>(input.sources.map((s) => [s.id, normalizeSource(s)]));
  const ctx: TxContext = { evidence: input.evidence, sources, options };
  const transactions = [...byId.keys()].sort().map((id) => reconcileTransaction(id, byId.get(id) as Snapshot[], ctx));

  const summary = Object.fromEntries(OUTCOMES.map((k) => [k, 0])) as Report["summary"];
  for (const t of transactions) summary[t.outcome] += 1;
  return {
    reportVersion: REPORT_VERSION,
    tool: { name: "anchortrace", version: TOOL_VERSION },
    generatedAt: (input.now ?? new Date()).toISOString(),
    inputs: [...input.sources].sort((a, b) => (a.id < b.id ? -1 : 1)),
    options: {
      feePolicy: options.feePolicy,
      feePolicySource: o.feePolicy === undefined ? "default" : "option",
      assetOverride: o.assetOverride ?? null,
      anchorAccount: o.anchorAccount ?? null,
      amountToleranceBps: tolerance,
      expectedNetwork: o.expectedNetwork ?? null,
    },
    summary,
    overall: worst(transactions.map((t) => t.outcome)),
    transactions,
    limitations: [...LIMITATIONS],
    redaction: null,
  };
}
