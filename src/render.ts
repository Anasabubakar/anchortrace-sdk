import type { Candidate, FindingCode, Outcome, Report, TransactionReport } from "./reportSchema.ts";
import { outcomeRank } from "./reportSchema.ts";

const LABEL: Record<Outcome, string> = {
  matched: "MATCHED",
  pending: "PENDING",
  insufficient_evidence: "INSUFFICIENT EVIDENCE",
  unsupported: "UNSUPPORTED",
  ambiguous: "AMBIGUOUS",
  discrepant: "DISCREPANT",
};

/** What a person could do to move a finding forward. Advice about evidence, never about moving funds. */
const HINTS: Partial<Record<FindingCode, string>> = {
  wrong_destination: "Confirm which account the anchor expected (withdraw_anchor_account). If the funds went elsewhere the anchor cannot credit them automatically; this is a matter for the anchor and the customer.",
  wrong_issuer: "Compare the issuer with the anchor's published stellar.toml currency entry. A same-code asset from another issuer is a different asset and will not be credited as the intended one.",
  wrong_asset: "Compare the asset code with amount_in_asset / the anchor's configured asset.",
  amount_mismatch: "Check the fee policy (--fee-policy) and the SEP-24 amount_in; use --tolerance-bps only if the anchor documents a tolerance.",
  memo_mismatch: "The memo ties the payment to the anchor's transaction. A different memo means the anchor may not be able to attribute it.",
  source_mismatch: "Check whether the payment was sent by a different account than the one that started the withdrawal.",
  multiple_candidate_operations: "Provide the anchor's own ledger entry for which operation it credited. AnchorTrace deliberately does not choose one.",
  multiple_candidate_transactions: "Add the record's stellar_transaction_id so the right transaction is linked directly.",
  path_payment_not_supported: "Reconcile this transaction by hand; v1 handles classic direct payments only.",
  claimable_balance_not_supported: "Reconcile this transaction by hand; v1 handles classic direct payments only.",
  soroban_transfer_not_supported: "Reconcile this transaction by hand; v1 handles classic direct payments only.",
  onchain_evidence_missing: "Supply the transaction with --evidence, or read it live with --horizon.",
  stellar_transaction_id_missing: "Ask the anchor for the stellar_transaction_id, or supply evidence that pays the destination with the declared memo.",
  evidence_fetch_failed: "Retry the read or supply the transaction as a file. The report did not treat the failed read as a mismatch.",
  horizon_transaction_not_found: "Check the network (testnet vs public) and the hash, then retry; or supply the transaction as a file.",
  absence_not_provable: "A terminal failure cannot be confirmed from the supplied transactions alone; look up the destination account's payments in Horizon for the relevant period.",
  expected_asset_unknown: "Add --asset CODE:ISSUER (or native) or ask the anchor to include amount_in_asset / amount_out_asset.",
  refund_not_observable: "External refunds (bank, cash) cannot be observed from the Stellar ledger.",
  refund_evidence_missing: "Supply the refund transaction listed in refunds.payments.",
  operations_incomplete: "Fetch the transaction's full operation list (Horizon /transactions/{hash}/operations).",
  status_history_conflict: "Obtain the anchor's authoritative status history; the supplied snapshots contradict each other.",
  status_after_terminal: "Obtain the anchor's authoritative status history; a terminal SEP-24 status should not change.",
  record_amounts_inconsistent: "Check the fee policy (--fee-policy) against how the anchor reports amount_in, amount_out and fees.",
  payment_before_status_advanced: "Re-fetch the record from the anchor; the status may simply be behind the chain.",
  funds_received_but_terminal_failure: "Ask the anchor whether the funds were refunded; look for a refunds object or a refund transaction.",
};

function shortHash(h: string): string {
  return h.length > 16 ? `${h.slice(0, 8)}...${h.slice(-6)}` : h;
}

function line(c: Candidate): string {
  const memo = c.memo === null ? "" : ` memo(${c.memoType ?? "?"})=${c.memo}`;
  const ok = c.transactionSuccessful ? "" : " [TRANSACTION FAILED]";
  return `${c.type} op ${c.operationId} in ${shortHash(c.transactionHash)}: ${c.amount ?? "?"} ${c.asset ?? "?"} ${c.from ?? "?"} -> ${c.to ?? "?"}${memo}${ok}`;
}

export function renderText(report: Report): string {
  const o: string[] = [];
  o.push(`AnchorTrace report v${report.reportVersion} (anchortrace ${report.tool.version}), generated ${report.generatedAt}`);
  o.push(`Fee policy: ${report.options.feePolicy} (${report.options.feePolicySource === "default" ? "default" : "chosen"})${report.options.amountToleranceBps > 0 ? `, amount tolerance ${report.options.amountToleranceBps} bps` : ""}`);
  if (report.redaction) o.push(`REDACTED export: ${report.redaction.categories.join(", ")}`);
  o.push("");
  const summary = (Object.entries(report.summary) as Array<[Outcome, number]>).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k}`).join(", ");
  o.push(`Overall: ${report.overall === null ? "no transactions" : LABEL[report.overall]} (${summary || "none"})`);
  o.push("Note: confirmation on chain is not a bank payout. AnchorTrace checks only the Stellar leg.");
  for (const t of report.transactions) {
    o.push("", `Transaction ${t.id} (${t.kind}): ${LABEL[t.outcome]}`);
    o.push(`  Status: ${t.currentStatus.value}${t.currentStatus.known ? "" : " (not a SEP-24 status)"}, elected by ${t.currentStatus.electedBy.replaceAll("_", " ")}`);
    o.push(`  ${t.summary}`);
    if (t.expected) {
      const e = t.expected;
      o.push(`  Expected leg: ${e.amount} ${e.asset} ${e.source ?? "?"} -> ${e.destination}${e.memo !== null ? ` memo(${e.memoType ?? "?"})=${e.memo}` : ""}${e.transactionHash ? `, tx ${shortHash(e.transactionHash)}` : ""}`);
    }
    o.push("  Timeline:");
    for (const e of t.timeline) o.push(`    ${e.index + 1}. ${e.time ?? "(no time)"}  ${e.status}${e.occurrences > 1 ? `  x${e.occurrences}` : ""}${e.flags.filter((f) => f !== "current").length ? `  [${e.flags.filter((f) => f !== "current").join(", ")}]` : ""}${e.flags.includes("current") ? "  <- current" : ""}`);
    if (t.matching.candidates.length > 0) {
      o.push(`  Evidence considered (${t.matching.linkedBy === "stellar_transaction_id" ? "linked by stellar_transaction_id" : t.matching.linkedBy === "search" ? "linked by search, not by id" : "no link"}):`);
      for (const c of t.matching.candidates) o.push(`    [${c.role}] ${c.purpose === "refund" ? "(refund) " : ""}${line(c)}`);
    }
    o.push("  Findings:");
    for (const f of t.findings) o.push(`    [${f.severity}] ${f.effect ?? "note"} ${f.code}: ${f.message}`);
  }
  o.push("", "Inputs:");
  for (const s of report.inputs) o.push(`  ${s.id} ${s.role} ${s.kind === "horizon" ? `live Horizon (${s.network ?? "network unknown"}, HTTP ${s.httpStatus ?? "none"}, ${s.fetchedAt ?? ""})` : "supplied file"} ${s.label}${s.sha256 ? ` sha256 ${s.sha256.slice(0, 12)}...` : ""}`);
  o.push("", "Limitations:");
  for (const l of report.limitations) o.push(`  - ${l}`);
  return o.join("\n") + "\n";
}

export function renderMarkdown(report: Report): string {
  const o: string[] = [];
  o.push(`# AnchorTrace report`, "", `Schema v${report.reportVersion}, anchortrace ${report.tool.version}, generated ${report.generatedAt}. Fee policy: \`${report.options.feePolicy}\`.`, "");
  o.push("> Confirmation on chain is not a bank payout. AnchorTrace checks only the Stellar leg.", "");
  o.push("| Transaction | Kind | Status | Outcome |", "|---|---|---|---|");
  for (const t of report.transactions) o.push(`| \`${t.id}\` | ${t.kind} | \`${t.currentStatus.value}\` | **${LABEL[t.outcome]}** |`);
  for (const t of report.transactions) {
    o.push("", `## ${t.id}: ${LABEL[t.outcome]}`, "", t.summary, "", "Findings:", "");
    for (const f of t.findings) o.push(`- \`${f.code}\` (${f.effect ?? "note"}, ${f.severity}): ${f.message}`);
    if (t.matching.candidates.length) {
      o.push("", "Operations considered:", "");
      for (const c of t.matching.candidates) o.push(`- ${c.role}: ${line(c)}`);
    }
  }
  o.push("", "## Limitations", "");
  for (const l of report.limitations) o.push(`- ${l}`);
  return o.join("\n") + "\n";
}

/** A step-by-step account of why each transaction got its outcome, what was compared, and what would change it. */
export function renderExplain(report: Report, transactionId?: string): string {
  const list = transactionId === undefined ? report.transactions : report.transactions.filter((t) => t.id === transactionId);
  if (list.length === 0) throw new Error(`No transaction "${transactionId}" in the report`);
  const o: string[] = [];
  for (const t of list) o.push(explainOne(t, report));
  o.push("Standing limits of this tool:");
  for (const l of report.limitations) o.push(`  - ${l}`);
  return o.join("\n") + "\n";
}

function explainOne(t: TransactionReport, report: Report): string {
  const o: string[] = [];
  o.push(`Transaction ${t.id} (${t.kind}) is ${LABEL[t.outcome]}.`, "");
  o.push("1. What the record says");
  o.push(`   Current status ${t.currentStatus.value} was chosen from ${t.timeline.length} distinct snapshot(s) by ${t.currentStatus.electedBy.replaceAll("_", " ")}.`);
  const exp = t.currentStatus.expectation;
  if (exp !== null) {
    const meaning = { none: "the Stellar transfer has not happened yet", required: "the Stellar transfer should already be on chain", inflight: "the transfer was submitted and may or may not be confirmed", failure: "this is a terminal failure; funds are not expected to have been accepted", refunded: "the transaction was refunded; refund payments are what can be checked" }[exp];
    o.push(`   For a ${t.kind}, that status means ${meaning}.`);
  }
  o.push("", "2. What was expected on chain");
  if (t.expected === null) o.push("   Nothing could be expected: the record lacks fields needed to describe the Stellar leg (see findings).");
  else {
    const e = t.expected;
    o.push(`   ${e.amount} of ${e.asset}, to ${e.destination}${e.source ? `, from ${e.source}` : ""}${e.memo !== null ? `, memo (${e.memoType ?? "type not declared"}) ${e.memo}` : ", no memo declared"}.`);
    for (const [k, v] of Object.entries(e.basis)) o.push(`   - ${k}: from ${v}`);
  }
  o.push("", "3. What the evidence showed");
  if (t.matching.candidates.length === 0) o.push("   No operation from the supplied or fetched evidence was a candidate.");
  for (const c of t.matching.candidates) {
    o.push(`   ${c.role.toUpperCase()}: ${line(c)}`);
    for (const k of c.checks) o.push(`     ${k.field.padEnd(11)} ${k.result === "equal" ? "equal    " : k.result === "different" ? "DIFFERENT" : "not checked"}  expected ${k.expected ?? "-"}  observed ${k.observed ?? "-"}`);
  }
  for (const r of t.matching.refunds) o.push(`   Refund ${r.id} (${r.idType}) ${r.amount ?? ""}: ${r.result}`);
  o.push("", "4. Why this outcome");
  const decisive = [...t.findings].filter((f) => f.effect !== null).sort((a, b) => outcomeRank(b.effect as Outcome) - outcomeRank(a.effect as Outcome));
  for (const f of decisive) o.push(`   [${f.effect}] ${f.code}: ${f.message}`);
  o.push("", "5. What would change it");
  const seen = new Set<string>();
  for (const f of decisive) {
    const hint = HINTS[f.code];
    if (hint && !seen.has(hint)) {
      seen.add(hint);
      o.push(`   - ${hint}`);
    }
  }
  if (seen.size === 0) o.push("   - Nothing further is needed from the evidence AnchorTrace can see.");
  if (t.kind === "withdrawal") o.push("", "Scope: confirmation on chain is not a bank payout. Even a MATCHED withdrawal says nothing about whether the external payout happened.");
  o.push("");
  void report;
  return o.join("\n");
}

/** Exit code for `reconcile`: 1 when any transaction has an outcome in `failOn`, else 0. */
export function exitCodeFor(report: Report, failOn: readonly Outcome[]): number {
  return report.transactions.some((t) => failOn.includes(t.outcome)) ? 1 : 0;
}
