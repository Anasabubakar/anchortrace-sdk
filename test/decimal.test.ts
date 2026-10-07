import { describe, expect, it } from "vitest";
import { AmountError, INT64_MAX, canonicalAmount, formatAmount, parseAmount, tryParseAmount, withinToleranceBps } from "../src/decimal.ts";

describe("decimal amounts", () => {
  it("parses whole and fractional amounts to stroops exactly", () => {
    expect(parseAmount("0")).toBe(0n);
    expect(parseAmount("1")).toBe(10_000_000n);
    expect(parseAmount("100.5")).toBe(1_005_000_000n);
    expect(parseAmount("0.0000001")).toBe(1n);
    expect(parseAmount("922337203685.4775807")).toBe(INT64_MAX);
  });

  it("does not lose precision where binary floating point would", () => {
    // 0.1 + 0.2 !== 0.3 in IEEE doubles; in stroops it is exact.
    expect(parseAmount("0.1") + parseAmount("0.2")).toBe(parseAmount("0.3"));
    // 9007199254740993 stroops is above Number.MAX_SAFE_INTEGER.
    expect(parseAmount("900719925.4740993")).toBe(9_007_199_254_740_993n);
    expect(formatAmount(9_007_199_254_740_993n)).toBe("900719925.4740993");
  });

  it("rejects more than 7 decimals, signs, exponents, empty parts and non-strings", () => {
    for (const bad of ["0.00000001", "-1", "+1", "1e3", ".5", "5.", "", " 1", "1 ", "1,5", "0x10", "922337203685.4775808"]) {
      expect(() => parseAmount(bad), bad).toThrow(AmountError);
      expect(tryParseAmount(bad), bad).toBeNull();
    }
    expect(() => parseAmount(100)).toThrow(/JSON numbers/);
    expect(() => parseAmount(null)).toThrow(AmountError);
  });

  it("formats canonically with 7 decimals", () => {
    expect(formatAmount(0n)).toBe("0.0000000");
    expect(formatAmount(1n)).toBe("0.0000001");
    expect(formatAmount(-15_000_000n)).toBe("-1.5000000");
    expect(canonicalAmount("100")).toBe("100.0000000");
    expect(canonicalAmount("99.5")).toBe("99.5000000");
  });

  it("applies basis-point tolerance with integer math", () => {
    const e = parseAmount("100");
    expect(withinToleranceBps(e, parseAmount("100"), 0)).toBe(true);
    expect(withinToleranceBps(e, parseAmount("99.9999999"), 0)).toBe(false);
    expect(withinToleranceBps(e, parseAmount("90"), 1000)).toBe(true);
    expect(withinToleranceBps(e, parseAmount("89.9999999"), 1000)).toBe(false);
    expect(withinToleranceBps(e, parseAmount("110"), 1000)).toBe(true);
    expect(() => withinToleranceBps(e, e, -1)).toThrow(AmountError);
    expect(() => withinToleranceBps(e, e, 1.5)).toThrow(AmountError);
  });
});
