import { describe, expect, it } from "vitest";
import { evidence, GOOD_ASSET, codes, find, only, run, withdrawal } from "./helpers/cases.ts";

const w01 = "w01-correct-withdrawal-payment";
/** The recorded 100 TRACEUSD payment with the amount changed in-test (clearly derived, not a recorded transaction). */
function withAmount(amount: string): object {
  const f = evidence(w01);
  f.items[0].operations._embedded.records[0].amount = amount;
  return f;
}

describe("explicit fee policy", () => {
  it("defaults to anchor_deducted and says whether it was chosen or defaulted", () => {
    const r = run([withdrawal(w01)], [w01]);
    expect(r.options).toMatchObject({ feePolicy: "anchor_deducted", feePolicySource: "default" });
    expect(run([withdrawal(w01)], [w01], { feePolicy: "anchor_deducted" }).options.feePolicySource).toBe("option");
  });

  it("anchor_deducted: the on-chain amount is amount_in (the fee is taken off the payout, not added to the payment)", () => {
    const t = only(run([withdrawal(w01)], [w01], { feePolicy: "anchor_deducted" }));
    expect(t.expected?.amount).toBe("100.0000000");
    expect(t.expected?.basis.amount).toMatch(/amount_in \(anchor_deducted\)/);
    expect(t.outcome).toBe("matched");
  });

  it("customer_paid_on_top: the on-chain amount is amount_in + fee, so the 100 payment no longer matches", () => {
    const t = only(run([withdrawal(w01, { amount_out: "100.0000000" })], [w01], { feePolicy: "customer_paid_on_top" }));
    expect(t.expected?.amount).toBe("102.0000000");
    expect(t.outcome).toBe("discrepant");
    expect(find(t, "amount_mismatch")!.details).toMatchObject({ expected: "102.0000000", observed: "100.0000000" });
    const ok = only(run([withdrawal(w01, { amount_out: "100.0000000" })], [withAmount("102.0000000")], { feePolicy: "customer_paid_on_top" }));
    expect(ok.outcome).toBe("matched");
  });

  it("customer_paid_on_top needs a recorded fee and never guesses it", () => {
    const rec = withdrawal(w01, { amount_out: "100.0000000" });
    delete rec.fee_details;
    const t = only(run([rec], [w01], { feePolicy: "customer_paid_on_top" }));
    expect(t.outcome).toBe("insufficient_evidence");
    expect(codes(t)).toContain("record_field_missing");
  });

  it("no_fee: any non-zero fee is a discrepancy", () => {
    const t = only(run([withdrawal(w01, { amount_out: "100.0000000" })], [w01], { feePolicy: "no_fee" }));
    expect(codes(t)).toContain("fee_present_under_no_fee_policy");
    expect(t.outcome).toBe("discrepant");
    const zero = only(run([withdrawal(w01, { amount_out: "100.0000000", fee_details: { total: "0.0000000", asset: GOOD_ASSET } })], [w01], { feePolicy: "no_fee" }));
    expect(zero.outcome).toBe("matched");
  });

  it("falls back to the deprecated amount_fee when fee_details is absent", () => {
    const rec = withdrawal(w01);
    delete rec.fee_details;
    rec.amount_fee = "2.0000000";
    expect(only(run([rec], [w01])).outcome).toBe("matched");
    expect(only(run([rec], [w01])).amounts.feeTotal).toBe("2.0000000");
  });

  it("a deposit's on-chain amount is amount_out under every policy", () => {
    for (const feePolicy of ["anchor_deducted", "customer_paid_on_top", "no_fee"] as const) {
      const t = only(run([{ id: "d", kind: "deposit", status: "pending_stellar", amount_in: "52.0000000", amount_out: "50.0000000", to: "GCWEQIIHHZN2BS5Y7VPXMTMNHFL7Y5GEWJFG4QKPGRUIOP76JBVUXFWH", amount_out_asset: GOOD_ASSET, fee_details: { total: "2.0000000", asset: GOOD_ASSET } }], [], { feePolicy }));
      expect(t.expected?.amount).toBe("50.0000000");
    }
  });
});

describe("the record's own SEP-24 amount formula", () => {
  it("amount_out = amount_in - fee - refunds holds for a consistent record", () => {
    expect(codes(only(run([withdrawal(w01)], [w01])))).not.toContain("record_amounts_inconsistent");
  });
  it("flags a record whose amounts disagree, with exact decimals", () => {
    const t = only(run([withdrawal(w01, { amount_out: "97.0000000" })], [w01]));
    expect(codes(t)).toContain("record_amounts_inconsistent");
    expect(t.outcome).toBe("discrepant");
    expect(find(t, "record_amounts_inconsistent")!.details).toMatchObject({ amountOut: "97.0000000", computed: "98.0000000" });
  });
  it("is not checked across different assets (no conversion is attempted)", () => {
    const t = only(run([withdrawal(w01, { amount_out: "5000.0000000", amount_out_asset: "iso4217:NGN" })], [w01]));
    expect(codes(t)).toContain("cross_asset_not_converted");
    expect(t.outcome).toBe("matched");
  });
  it("rejects float-like and malformed amounts instead of rounding", () => {
    const t = only(run([withdrawal(w01, { amount_in: 100 })], [w01]));
    expect(t.outcome).toBe("insufficient_evidence");
    expect(find(t, "record_field_invalid")!.message).toMatch(/JSON numbers/);
    const u = only(run([withdrawal(w01, { amount_in: "100.00000001" })], [w01]));
    expect(u.outcome).toBe("insufficient_evidence");
  });
});

describe("amount tolerance (basis points, integer math)", () => {
  it("0 bps is exact; 100 bps accepts a 0.5% shortfall", () => {
    const f = "w04-wrong-amount";
    const rec = withdrawal(f, { withdraw_memo: "1004" });
    expect(only(run([rec], [f])).outcome).toBe("discrepant");
    expect(only(run([rec], [f], { amountToleranceBps: 10 })).outcome).toBe("discrepant");
    expect(only(run([rec], [f], { amountToleranceBps: 50 })).outcome).toBe("matched");
  });
  it("rejects invalid options", () => {
    expect(() => run([withdrawal(w01)], [w01], { amountToleranceBps: -1 })).toThrow();
    expect(() => run([withdrawal(w01)], [w01], { amountToleranceBps: 1.5 })).toThrow();
    expect(() => run([withdrawal(w01)], [w01], { assetOverride: "USD" })).toThrow(/asset/i);
    expect(() => run([withdrawal(w01)], [w01], { anchorAccount: "nope" })).toThrow(/anchorAccount/);
  });
});
