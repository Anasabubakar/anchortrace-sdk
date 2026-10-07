import { describe, expect, it } from "vitest";
import { ANCHOR, GOOD_ASSET, ISSUER, OTHER, ROGUE, WALLET, codes, evidence, find, hashOf, only, run, withdrawal } from "./helpers/cases.ts";

describe("matched", () => {
  it("a completed withdrawal whose recorded payment matches destination, asset+issuer, amount, memo and sender", () => {
    const t = only(run([withdrawal("w01-correct-withdrawal-payment")], ["w01-correct-withdrawal-payment"]));
    expect(t.outcome).toBe("matched");
    expect(t.matching.linkedBy).toBe("stellar_transaction_id");
    expect(t.matching.candidates).toHaveLength(1);
    expect(t.matching.candidates[0]).toMatchObject({ role: "matched", amount: "100.0000000", purpose: "transfer" });
    expect(t.expected).toMatchObject({ destination: ANCHOR, asset: `TRACEUSD:${ISSUER}`, amount: "100.0000000", memo: "1001", memoType: "id", source: WALLET });
    // Hard semantic rule: the report must say chain confirmation is not a bank payout.
    expect(find(t, "external_payout_not_verified")?.message).toMatch(/not a bank payout/);
    expect(t.summary).toMatch(/not proof of the external payout/);
  });

  it("a completed deposit paid on chain to the user with the declared memo", () => {
    const t = only(
      run(
        [{ id: "dep-1", kind: "deposit", status: "completed", amount_in: "50.0000000", amount_out: "50.0000000", amount_out_asset: GOOD_ASSET, fee_details: { total: "0.0000000", asset: GOOD_ASSET }, to: WALLET, deposit_memo: "dep-2001", deposit_memo_type: "text", stellar_transaction_id: hashOf("d01-correct-deposit-payment"), updated_at: "2026-10-07T14:10:00Z" }],
        ["d01-correct-deposit-payment"],
        { anchorAccount: ANCHOR },
      ),
    );
    expect(t.outcome).toBe("matched");
    expect(codes(t)).toContain("external_funds_not_verified");
    expect(t.expected?.direction).toBe("anchor_to_wallet");
  });
});

describe("discrepant: the four demo cases from real testnet transactions", () => {
  it("wrong destination", () => {
    const t = only(run([withdrawal("w02-wrong-destination", { withdraw_memo: "1002" })], ["w02-wrong-destination"]));
    expect(t.outcome).toBe("discrepant");
    const f = find(t, "wrong_destination")!;
    expect(f.message).toContain(OTHER);
    expect(f.refs?.[0]?.operationId).toBeTruthy();
    expect(t.matching.candidates[0]).toMatchObject({ role: "conflicting", to: OTHER });
  });

  it("wrong issuer with the same asset code is not accepted as the same asset", () => {
    const t = only(run([withdrawal("w03-wrong-issuer", { withdraw_memo: "1003" })], ["w03-wrong-issuer"]));
    expect(t.outcome).toBe("discrepant");
    const f = find(t, "wrong_issuer")!;
    expect(f.details).toMatchObject({ expectedIssuer: ISSUER, observedIssuer: ROGUE });
    expect(codes(t)).not.toContain("wrong_asset");
    const issuerCheck = t.matching.candidates[0]!.checks.find((c) => c.field === "issuer")!;
    expect(issuerCheck).toMatchObject({ expected: ISSUER, observed: ROGUE, result: "different" });
    expect(t.matching.candidates[0]!.checks.find((c) => c.field === "asset")!.result).toBe("equal");
  });

  it("wrong amount reports the exact decimal difference", () => {
    const t = only(run([withdrawal("w04-wrong-amount", { withdraw_memo: "1004" })], ["w04-wrong-amount"]));
    expect(t.outcome).toBe("discrepant");
    const f = find(t, "amount_mismatch")!;
    expect(f.details).toMatchObject({ expected: "100.0000000", observed: "99.5000000", differenceStroops: "-5000000" });
    expect(f.message).toMatch(/short by 0\.5000000/);
  });

  it("a multi-operation withdrawal is ambiguous, never matched, even when the operations sum to the amount", () => {
    const t = only(run([withdrawal("w05-multi-operation", { withdraw_memo: "1005" })], ["w05-multi-operation"]));
    expect(t.outcome).toBe("ambiguous");
    const f = find(t, "multiple_candidate_operations")!;
    expect(f.refs).toHaveLength(2);
    expect(f.message).toMatch(/60\.0000000 TRACEUSD \+ 40\.0000000 TRACEUSD; total 100\.0000000 TRACEUSD/);
    expect(t.matching.candidates.map((c) => c.role)).toEqual(["conflicting", "conflicting"]);
    expect(codes(t)).not.toContain("onchain_leg_matched");
  });

  it("a wrong memo is a discrepancy", () => {
    const t = only(run([withdrawal("w08-wrong-memo", { withdraw_memo: "1008" })], ["w08-wrong-memo"]));
    expect(t.outcome).toBe("discrepant");
    expect(codes(t)).toContain("memo_mismatch");
  });

  it("a wrong sender is a discrepancy", () => {
    const t = only(run([withdrawal("w01-correct-withdrawal-payment", { from: OTHER })], ["w01-correct-withdrawal-payment"]));
    expect(t.outcome).toBe("discrepant");
    expect(codes(t)).toContain("source_mismatch");
  });

  it("a failed on-chain transaction never counts as a transfer", () => {
    const t = only(run([withdrawal("w09-failed-transaction", { withdraw_memo: "1009", amount_in: "5000000.0000000", amount_out: "4999998.0000000" })], ["w09-failed-transaction"]));
    expect(t.outcome).toBe("discrepant");
    expect(codes(t)).toContain("onchain_transaction_failed");
    expect(t.matching.candidates[0]!.transactionSuccessful).toBe(false);
  });

  it("multiple findings are all reported, not just the first", () => {
    const t = only(run([withdrawal("w03-wrong-issuer", { withdraw_memo: "9", amount_in: "90.0000000", amount_out: "88.0000000" })], ["w03-wrong-issuer"]));
    expect(codes(t)).toEqual(expect.arrayContaining(["wrong_issuer", "amount_mismatch", "memo_mismatch"]));
  });
});

describe("unsupported payment forms are never success", () => {
  const nativeRecord = (fx: string, memo: string) => withdrawal(fx, { amount_in: "5.0000000", amount_in_asset: "stellar:native", amount_out: "4.0000000", fee_details: { total: "1.0000000", asset: "stellar:native" }, withdraw_memo: memo });
  it("path payment", () => {
    const t = only(run([nativeRecord("w06-path-payment", "1006")], ["w06-path-payment"]));
    expect(t.outcome).toBe("unsupported");
    expect(codes(t)).toContain("path_payment_not_supported");
    expect(t.matching.candidates[0]).toMatchObject({ role: "unsupported", type: "path_payment_strict_send" });
  });
  it("claimable balance", () => {
    const t = only(run([nativeRecord("w07-claimable-balance", "1007")], ["w07-claimable-balance"]));
    expect(t.outcome).toBe("unsupported");
    expect(codes(t)).toContain("claimable_balance_not_supported");
  });
  it("Soroban contract transfer", () => {
    const t = only(run([withdrawal("w10-soroban-sac-transfer", { amount_in: "5.0000000", amount_in_asset: "stellar:native", amount_out: "4.0000000", fee_details: { total: "1.0000000", asset: "stellar:native" }, withdraw_memo: null, withdraw_memo_type: null })], ["w10-soroban-sac-transfer"]));
    expect(t.outcome).toBe("unsupported");
    expect(codes(t)).toContain("soroban_transfer_not_supported");
  });
  it("a deposit delivered by claimable balance", () => {
    const t = only(run([{ id: "d", kind: "deposit", status: "completed", amount_out: "5.0000000", amount_out_asset: "stellar:native", to: WALLET, claimable_balance_id: "0000000000000000000000000000000000000000000000000000000000000000", updated_at: "2026-10-07T14:00:00Z" }]));
    expect(t.outcome).toBe("unsupported");
    expect(codes(t)).toContain("claimable_balance_deposit_not_supported");
  });
  it("an unknown status is unsupported, not guessed", () => {
    const t = only(run([withdrawal(null, { status: "pending_receiver" })]));
    expect(t.outcome).toBe("unsupported");
    expect(t.currentStatus.known).toBe(false);
    expect(codes(t)).toContain("status_unknown");
  });
  it("a direct match plus a path payment to the same destination in one transaction is unsupported, not matched", () => {
    const f = evidence("w01-correct-withdrawal-payment");
    const path = evidence("w06-path-payment").items[0].operations._embedded.records[0];
    path.transaction_hash = f.items[0].transaction.hash;
    path.id = "21782403383037954";
    f.items[0].transaction.operation_count = 2;
    f.items[0].operations._embedded.records.push(path);
    const t = only(run([withdrawal("w01-correct-withdrawal-payment")], [f]));
    expect(t.outcome).toBe("unsupported");
    expect(codes(t)).toContain("unsupported_operation_alongside_match");
  });
});

describe("missing evidence is never a pass and a failed read is never a mismatch", () => {
  it("completed with a transaction id but no evidence", () => {
    const t = only(run([withdrawal("w01-correct-withdrawal-payment")]));
    expect(t.outcome).toBe("insufficient_evidence");
    expect(codes(t)).toContain("onchain_evidence_missing");
  });
  it("completed with no transaction id and no evidence", () => {
    const t = only(run([withdrawal(null)]));
    expect(t.outcome).toBe("insufficient_evidence");
    expect(codes(t)).toContain("stellar_transaction_id_missing");
  });
  it("a Horizon timeout is insufficient evidence", () => {
    const hash = hashOf("w01-correct-withdrawal-payment");
    const t = only(run([withdrawal("w01-correct-withdrawal-payment")], [], undefined, { acquired: { transactions: [], failures: [{ hash, kind: "timeout", detail: "no response in 15000 ms", sourceId: "src-9" }], provenance: [] } }));
    expect(t.outcome).toBe("insufficient_evidence");
    expect(codes(t)).toContain("evidence_fetch_failed");
    expect(codes(t)).not.toContain("wrong_destination");
  });
  it("a Horizon 404 is insufficient evidence and says 404 does not prove absence", () => {
    const hash = hashOf("w01-correct-withdrawal-payment");
    const t = only(run([withdrawal("w01-correct-withdrawal-payment")], [], undefined, { acquired: { transactions: [], failures: [{ hash, kind: "not_found", detail: "HTTP 404", sourceId: "src-9" }], provenance: [] } }));
    expect(t.outcome).toBe("insufficient_evidence");
    expect(find(t, "horizon_transaction_not_found")!.message).toMatch(/does not prove/);
  });
  it("truncated operation lists are insufficient evidence", () => {
    const f = evidence("w05-multi-operation");
    f.items[0].operations._embedded.records.pop();
    const t = only(run([withdrawal("w05-multi-operation", { withdraw_memo: "1005" })], [f]));
    expect(t.outcome).toBe("insufficient_evidence");
    expect(codes(t)).toContain("operations_incomplete");
  });
  it("a missing asset is never guessed", () => {
    const rec = withdrawal("w01-correct-withdrawal-payment");
    delete rec.amount_in_asset;
    const t = only(run([rec], ["w01-correct-withdrawal-payment"]));
    expect(t.outcome).toBe("insufficient_evidence");
    expect(codes(t)).toContain("expected_asset_unknown");
    const t2 = only(run([rec], ["w01-correct-withdrawal-payment"], { assetOverride: `TRACEUSD:${ISSUER}` }));
    expect(t2.outcome).toBe("matched");
    expect(t2.expected?.basis.asset).toMatch(/--asset option/);
    const t3 = only(run([rec], ["w03-wrong-issuer"].slice(0, 0).concat(["w01-correct-withdrawal-payment"]), { assetOverride: `TRACEUSD:${ROGUE}` }));
    expect(t3.outcome).toBe("discrepant");
  });
  it("evidence from the wrong network cannot support the record", () => {
    const t = only(run([withdrawal("w01-correct-withdrawal-payment")], ["w01-correct-withdrawal-payment"], { expectedNetwork: "public" }));
    expect(t.outcome).toBe("insufficient_evidence");
    expect(codes(t)).toContain("evidence_network_mismatch");
    expect(only(run([withdrawal("w01-correct-withdrawal-payment")], ["w01-correct-withdrawal-payment"], { expectedNetwork: "testnet" })).outcome).toBe("matched");
  });
  it("without a transaction id, unrelated evidence is not turned into a wrong-destination verdict", () => {
    const t = only(run([withdrawal(null)], ["w02-wrong-destination"]));
    expect(t.outcome).toBe("insufficient_evidence");
    expect(codes(t)).not.toContain("wrong_destination");
  });
  it("without a transaction id, evidence that pays the destination with the declared memo is linked and flagged", () => {
    const t = only(run([withdrawal(null)], ["w01-correct-withdrawal-payment", "w02-wrong-destination"]));
    expect(t.outcome).toBe("matched");
    expect(t.matching.linkedBy).toBe("search");
    expect(codes(t)).toContain("linked_by_search");
  });
  it("two transactions that both fit an unlinked record are ambiguous", () => {
    const clone = evidence("w01-correct-withdrawal-payment");
    clone.items[0].transaction.hash = "a".repeat(64);
    clone.items[0].operations._embedded.records[0].transaction_hash = "a".repeat(64);
    clone.items[0].operations._embedded.records[0].id = "21782403383037999";
    const t = only(run([withdrawal(null)], ["w01-correct-withdrawal-payment", clone]));
    expect(t.outcome).toBe("ambiguous");
    expect(codes(t)).toContain("multiple_candidate_transactions");
  });
});

describe("status drives what the on-chain leg must look like", () => {
  const w01 = "w01-correct-withdrawal-payment";
  it.each(["incomplete", "pending_user_transfer_start", "pending_user"])("%s with no transfer yet is pending", (status) => {
    const t = only(run([withdrawal(null, { status, stellar_transaction_id: undefined })]));
    expect(t.outcome).toBe("pending");
    expect(codes(t)).toContain("awaiting_onchain_transfer");
  });
  it.each(["pending_user_transfer_complete", "pending_anchor", "pending_external", "on_hold"])("%s with a matching payment is pending (leg matched, transaction not complete)", (status) => {
    const t = only(run([withdrawal(w01, { status })], [w01]));
    expect(t.outcome).toBe("pending");
    expect(codes(t)).toContain("onchain_leg_matched");
    expect(t.summary).toMatch(/not proof of the external payout/);
  });
  it("pending_anchor without any evidence is insufficient: the payment should already exist", () => {
    expect(only(run([withdrawal(w01, { status: "pending_anchor" })])).outcome).toBe("insufficient_evidence");
  });
  it("pending_stellar without evidence is pending", () => {
    expect(only(run([withdrawal(null, { status: "pending_stellar" })])).outcome).toBe("pending");
  });
  it("a matching payment while the status still waits for the user is a discrepancy", () => {
    const t = only(run([withdrawal(w01, { status: "pending_user_transfer_start" })], [w01]));
    expect(t.outcome).toBe("discrepant");
    expect(codes(t)).toContain("payment_before_status_advanced");
  });
  it.each(["error", "expired", "too_small", "too_large", "no_market"])("terminal failure %s with no evidence cannot prove absence", (status) => {
    const t = only(run([withdrawal(null, { status })]));
    expect(t.outcome).toBe("insufficient_evidence");
    expect(codes(t)).toContain("absence_not_provable");
  });
  it.each(["error", "expired"])("terminal failure %s with a matching payment on chain is a discrepancy", (status) => {
    const t = only(run([withdrawal(w01, { status })], [w01]));
    expect(t.outcome).toBe("discrepant");
    expect(codes(t)).toContain("funds_received_but_terminal_failure");
  });
});

describe("refunds", () => {
  const refundRecord = (refundAmount: string, over: Record<string, unknown> = {}) =>
    withdrawal(null, {
      status: "refunded",
      amount_in: "50.0000000",
      amount_out: "0.0000000",
      fee_details: { total: "0.0000000", asset: GOOD_ASSET },
      withdraw_memo: "1001",
      refunds: { amount_refunded: refundAmount, amount_fee: "0.0000000", payments: [{ id: hashOf("d01-correct-deposit-payment"), id_type: "stellar", amount: refundAmount, fee: "0.0000000" }] },
      ...over,
    });
  it("a refunded status with a verified on-chain refund payment is matched", () => {
    const t = only(run([refundRecord("50.0000000")], ["d01-correct-deposit-payment"]));
    expect(t.outcome).toBe("matched");
    expect(t.matching.refunds).toEqual([expect.objectContaining({ result: "matched", idType: "stellar" })]);
    expect(codes(t)).toContain("refund_payment_matched");
  });
  it("a refund payment of the wrong amount is a discrepancy", () => {
    const t = only(run([refundRecord("49.0000000", { amount_in: "49.0000000" })], ["d01-correct-deposit-payment"]));
    expect(t.outcome).toBe("discrepant");
    expect(t.matching.refunds[0]!.result).toBe("mismatch");
  });
  it("a refunded status with only an external refund cannot be observed", () => {
    const t = only(run([withdrawal(null, { status: "refunded", refunds: { amount_refunded: "100.0000000", amount_fee: "0.0000000", payments: [{ id: "BANK-REF-1", id_type: "external", amount: "100.0000000", fee: "0.0000000" }] }, amount_out: "0.0000000", fee_details: { total: "0.0000000", asset: GOOD_ASSET } })]));
    expect(t.outcome).toBe("insufficient_evidence");
    expect(codes(t)).toContain("refund_not_observable");
  });
  it("a refunded status with no refund payments listed is insufficient", () => {
    expect(only(run([withdrawal(null, { status: "refunded" })])).outcome).toBe("insufficient_evidence");
  });
  it("a missing refund transaction is insufficient evidence", () => {
    const t = only(run([refundRecord("50.0000000")]));
    expect(t.outcome).toBe("insufficient_evidence");
    expect(codes(t)).toContain("refund_evidence_missing");
  });
  it("refund totals that disagree with the listed payments are a record inconsistency", () => {
    const t = only(run([refundRecord("50.0000000", { refunds: { amount_refunded: "40.0000000", amount_fee: "0.0000000", payments: [{ id: hashOf("d01-correct-deposit-payment"), id_type: "stellar", amount: "50.0000000", fee: "0.0000000" }] } })], ["d01-correct-deposit-payment"]));
    expect(codes(t)).toContain("record_amounts_inconsistent");
    expect(t.outcome).toBe("discrepant");
  });
});
