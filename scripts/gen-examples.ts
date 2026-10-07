// Run with: node --experimental-strip-types scripts/gen-examples.ts [--check]
// Builds the example cases (SYNTHETIC SEP-24 records around RECORDED Horizon testnet evidence), runs the real engine on
// each, and writes cases, reports, text renderings and the bundle the Studio ships. Output is deterministic.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { caseSchema, type Case } from "../src/input.ts";
import { renderText } from "../src/render.ts";
import { reconcileSupplied } from "../src/run.ts";
import { reportSchema } from "../src/reportSchema.ts";
import { CASE_VERSION, REPORT_VERSION, TOOL_VERSION } from "../src/version.ts";

const check = process.argv.includes("--check");
const NOW = new Date("2026-10-07T00:00:00Z");
const manifest = JSON.parse(readFileSync("fixtures/testnet/manifest.json", "utf8"));
const A = manifest.accounts as Record<string, string>;
const GOOD = `stellar:TRACEUSD:${A.issuer}`;

const XDR_KEYS = new Set(["envelope_xdr", "result_xdr", "result_meta_xdr", "fee_meta_xdr", "signatures", "_links", "paging_token", "source_account_sequence", "preconditions"]);
function trimmed(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(trimmed);
  if (v !== null && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([k]) => !XDR_KEYS.has(k)).map(([k, x]) => [k, trimmed(x)]));
  return v;
}
function evidenceOf(name: string | null) {
  if (name === null) return { evidenceVersion: "1", capture: { network: "testnet", note: "No evidence supplied for this case." }, items: [] as unknown[] };
  const f = JSON.parse(readFileSync(`fixtures/testnet/evidence/${name}.json`, "utf8"));
  return { evidenceVersion: "1", capture: { ...f.capture, note: "Raw Horizon responses recorded by scripts/testnet-fixtures.mjs; XDR blobs, signatures and _links trimmed for size." }, items: trimmed(f.items) as unknown[] };
}
const hashOf = (name: string): string => manifest.scenarios[name].hash;

function wd(fixture: string | null, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "syn-wd-001",
    kind: "withdrawal",
    status: "completed",
    started_at: "2026-10-07T13:55:00Z",
    updated_at: "2026-10-07T14:30:00Z",
    completed_at: "2026-10-07T14:30:00Z",
    amount_in: "100.0000000",
    amount_in_asset: GOOD,
    amount_out: "98.0000000",
    fee_details: { total: "2.0000000", asset: GOOD },
    withdraw_anchor_account: A.anchor,
    withdraw_memo: "1001",
    withdraw_memo_type: "id",
    from: A.wallet,
    ...(fixture === null ? {} : { stellar_transaction_id: hashOf(fixture) }),
    ...over,
  };
}
const nativeWd = (fixture: string, memo: string | null, over: Record<string, unknown> = {}) =>
  wd(fixture, { amount_in: "5.0000000", amount_in_asset: "stellar:native", amount_out: "4.0000000", fee_details: { total: "1.0000000", asset: "stellar:native" }, withdraw_memo: memo, withdraw_memo_type: memo === null ? null : "id", ...over });

interface Def {
  id: string;
  title: string;
  description: string;
  intendedOutcome: Case["intendedOutcome"];
  records: unknown[];
  fixture: string | null;
  options?: Case["options"];
}

const defs: Def[] = [
  { id: "matched-withdrawal", title: "Matched withdrawal payment", description: "The anchor says the withdrawal is completed. The recorded testnet payment has the declared destination, asset and issuer, amount, memo and sender. Only the Stellar leg is matched: this says nothing about the bank payout.", intendedOutcome: "matched", records: [wd("w01-correct-withdrawal-payment")], fixture: "w01-correct-withdrawal-payment" },
  { id: "wrong-destination", title: "Wrong destination", description: "The payment is real and the right asset and amount, but it went to a different account than withdraw_anchor_account.", intendedOutcome: "discrepant", records: [wd("w02-wrong-destination", { withdraw_memo: "1002" })], fixture: "w02-wrong-destination" },
  { id: "wrong-issuer", title: "Wrong issuer", description: "Same asset code TRACEUSD, but issued by a different account than the anchor's asset. A same-code asset from another issuer is a different asset.", intendedOutcome: "discrepant", records: [wd("w03-wrong-issuer", { withdraw_memo: "1003" })], fixture: "w03-wrong-issuer" },
  { id: "wrong-amount", title: "Amount mismatch", description: "The payment is 99.5 TRACEUSD; the record says amount_in is 100. The difference is computed in exact 7-decimal arithmetic.", intendedOutcome: "discrepant", records: [wd("w04-wrong-amount", { withdraw_memo: "1004" })], fixture: "w04-wrong-amount" },
  { id: "ambiguous-multi-operation", title: "Ambiguous multi-operation withdrawal", description: "One transaction pays the anchor twice (60 + 40 = 100). AnchorTrace refuses to attribute the operations to one withdrawal even though the sum equals amount_in.", intendedOutcome: "ambiguous", records: [wd("w05-multi-operation", { withdraw_memo: "1005" })], fixture: "w05-multi-operation" },
  { id: "wrong-memo", title: "Wrong memo", description: "Right destination, asset and amount, but the transaction memo is 9999 while the record declares 1008.", intendedOutcome: "discrepant", records: [wd("w08-wrong-memo", { withdraw_memo: "1008" })], fixture: "w08-wrong-memo" },
  { id: "failed-onchain-transaction", title: "Failed on-chain transaction", description: "The record cites a transaction that is on the ledger but failed (op_underfunded). A failed transaction moves no funds.", intendedOutcome: "discrepant", records: [wd("w09-failed-transaction", { withdraw_memo: "1009", amount_in: "5000000.0000000", amount_out: "4999998.0000000" })], fixture: "w09-failed-transaction" },
  { id: "unsupported-path-payment", title: "Unsupported: path payment", description: "The withdrawal was funded with a path payment (strict send, XLM to XLM). v1 does not interpret path payments, so this is unsupported, not matched.", intendedOutcome: "unsupported", records: [nativeWd("w06-path-payment", "1006")], fixture: "w06-path-payment" },
  { id: "unsupported-claimable-balance", title: "Unsupported: claimable balance", description: "The transfer was a claimable balance. Not a delivered payment until claimed; unsupported in v1.", intendedOutcome: "unsupported", records: [nativeWd("w07-claimable-balance", "1007")], fixture: "w07-claimable-balance" },
  { id: "unsupported-soroban-transfer", title: "Unsupported: Soroban contract transfer", description: "The transfer was a call to the native Stellar Asset Contract (invoke_host_function). Unsupported in v1.", intendedOutcome: "unsupported", records: [nativeWd("w10-soroban-sac-transfer", null)], fixture: "w10-soroban-sac-transfer" },
  { id: "pending-awaiting-user-transfer", title: "Pending: waiting for the user's transfer", description: "Status is pending_user_transfer_start. No on-chain transfer is expected yet, so none is required.", intendedOutcome: "pending", records: [wd(null, { status: "pending_user_transfer_start", completed_at: undefined, updated_at: "2026-10-07T13:56:00Z" })], fixture: null },
  { id: "pending-external-chain-confirmed", title: "Pending: chain confirmed, payout not", description: "Status is pending_external. The Stellar payment matches, but the transaction is not complete and the external payout is not observable. Confirmation on chain is not a bank payout.", intendedOutcome: "pending", records: [wd("w01-correct-withdrawal-payment", { status: "pending_external", completed_at: undefined, updated_at: "2026-10-07T14:05:00Z" })], fixture: "w01-correct-withdrawal-payment" },
  { id: "insufficient-missing-evidence", title: "Insufficient evidence: transaction not supplied", description: "The record says completed and cites a transaction id, but no evidence for that transaction was supplied. A missing transaction is never a pass.", intendedOutcome: "insufficient_evidence", records: [wd("w01-correct-withdrawal-payment")], fixture: null },
  { id: "error-status-funds-received", title: "Error status but funds arrived", description: "The anchor reports error, yet a payment matching the record is on chain. Funds may have been received without the transaction completing.", intendedOutcome: "discrepant", records: [wd("w01-correct-withdrawal-payment", { status: "error", completed_at: undefined })], fixture: "w01-correct-withdrawal-payment" },
  {
    id: "reordered-and-duplicate-updates",
    title: "Reordered and duplicate status updates",
    description: "Callback payloads arrived out of order and some were delivered twice. The timeline sorts by updated_at with fixed tie-breaking, collapses identical snapshots, and gives the same result in any arrival order.",
    intendedOutcome: "matched",
    records: [
      wd("w01-correct-withdrawal-payment", { status: "completed", updated_at: "2026-10-07T14:30:00Z" }),
      wd("w01-correct-withdrawal-payment", { status: "pending_anchor", completed_at: undefined, updated_at: "2026-10-07T14:01:00Z" }),
      wd("w01-correct-withdrawal-payment", { status: "pending_anchor", completed_at: undefined, updated_at: "2026-10-07T14:01:00Z" }),
      wd(null, { status: "pending_user_transfer_start", completed_at: undefined, updated_at: "2026-10-07T13:56:00Z" }),
      wd("w01-correct-withdrawal-payment", { status: "pending_external", completed_at: undefined, updated_at: "2026-10-07T14:05:00Z" }),
      wd("w01-correct-withdrawal-payment", { status: "completed", updated_at: "2026-10-07T14:30:00Z" }),
    ],
    fixture: "w01-correct-withdrawal-payment",
  },
  {
    id: "status-history-conflict",
    title: "Conflicting status history",
    description: "Two snapshots report different terminal statuses (completed and error) at the same instant. The order cannot be established, so the outcome is ambiguous.",
    intendedOutcome: "ambiguous",
    records: [wd("w01-correct-withdrawal-payment", { status: "completed", updated_at: "2026-10-07T14:30:00Z" }), wd("w01-correct-withdrawal-payment", { status: "error", completed_at: undefined, updated_at: "2026-10-07T14:30:00Z" })],
    fixture: "w01-correct-withdrawal-payment",
  },
  {
    id: "matched-deposit",
    title: "Matched deposit payment",
    description: "A completed deposit: the anchor paid 50 TRACEUSD to the user's account with the declared memo. The user's external funds are not observable.",
    intendedOutcome: "matched",
    records: [{ id: "syn-dep-001", kind: "deposit", status: "completed", started_at: "2026-10-07T14:00:00Z", updated_at: "2026-10-07T14:10:00Z", completed_at: "2026-10-07T14:10:00Z", amount_in: "52.0000000", amount_out: "50.0000000", amount_out_asset: GOOD, fee_details: { total: "2.0000000", asset: GOOD }, to: A.wallet, deposit_memo: "dep-2001", deposit_memo_type: "text", stellar_transaction_id: hashOf("d01-correct-deposit-payment") }],
    fixture: "d01-correct-deposit-payment",
    options: { anchorAccount: A.anchor },
  },
  {
    id: "refunded-with-onchain-refund",
    title: "Refunded with an on-chain refund payment",
    description: "A withdrawal of 50 TRACEUSD was refunded in full by a Stellar payment back to the sender. The refund transaction is checked for destination, asset and issuer, and amount.",
    intendedOutcome: "matched",
    records: [wd(null, { status: "refunded", amount_in: "50.0000000", amount_out: "0.0000000", fee_details: { total: "0.0000000", asset: GOOD }, refunds: { amount_refunded: "50.0000000", amount_fee: "0.0000000", payments: [{ id: hashOf("d01-correct-deposit-payment"), id_type: "stellar", amount: "50.0000000", fee: "0.0000000" }] } })],
    fixture: "d01-correct-deposit-payment",
  },
];

const writes: Array<[string, string]> = [];
const bundleCases: unknown[] = [];
for (const d of defs) {
  const c = caseSchema.parse({
    caseVersion: CASE_VERSION,
    id: d.id,
    title: d.title,
    description: d.description,
    synthetic: true,
    evidenceNote: d.fixture === null ? "No evidence supplied for this case." : `Recorded Horizon testnet responses for transaction ${hashOf(d.fixture)} (see fixtures/testnet/manifest.json). The SEP-24 record is SYNTHETIC: no real anchor produced it.`,
    intendedOutcome: d.intendedOutcome,
    records: JSON.parse(JSON.stringify(d.records)),
    evidence: evidenceOf(d.fixture),
    options: d.options ?? {},
  });
  const report = reconcileSupplied({ records: [{ label: `${d.id}.case.json`, value: c }], now: NOW });
  reportSchema.parse(report);
  const got = report.transactions.map((t) => t.outcome);
  if (got.some((o) => o !== d.intendedOutcome)) throw new Error(`case ${d.id}: intended ${d.intendedOutcome} but the engine produced ${got.join(",")}`);
  writes.push([`examples/cases/${d.id}.case.json`, JSON.stringify(c, null, 2) + "\n"]);
  writes.push([`examples/sep24/${d.id}.sep24.json`, JSON.stringify(c.records.length === 1 ? { transaction: c.records[0] } : { transactions: c.records }, null, 2) + "\n"]);
  writes.push([`examples/reports/${d.id}.report.json`, JSON.stringify(report, null, 2) + "\n"]);
  writes.push([`examples/reports/${d.id}.report.txt`, renderText(report)]);
  bundleCases.push({ id: d.id, case: c, report });
}
writes.push([
  "examples/examples.v1.json",
  JSON.stringify({ examplesVersion: "1", toolVersion: TOOL_VERSION, reportVersion: REPORT_VERSION, generatedWith: "scripts/gen-examples.ts (the real engine; nothing here is hand-written output)", generatedAt: NOW.toISOString(), cases: bundleCases }, null, 2) + "\n",
]);

mkdirSync("examples/cases", { recursive: true });
mkdirSync("examples/sep24", { recursive: true });
mkdirSync("examples/reports", { recursive: true });
let stale = false;
for (const [path, text] of writes) {
  if (check) {
    let cur = "";
    try {
      cur = readFileSync(path, "utf8");
    } catch {
      /* missing is stale */
    }
    if (cur !== text) {
      console.error(`${path} is out of date; run pnpm examples`);
      stale = true;
    }
  } else writeFileSync(path, text);
}
if (stale) process.exit(1);
if (!check) console.log(`wrote ${writes.length} files for ${defs.length} cases`);
