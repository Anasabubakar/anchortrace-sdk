/**
 * Exact Stellar amount arithmetic. Amounts are decimal strings with at most 7 fractional digits
 * (1 unit = 10_000_000 stroops) and are held as bigint stroops. No floating point anywhere.
 */
export const STROOPS_PER_UNIT = 10_000_000n;
export const INT64_MAX = 9_223_372_036_854_775_807n;

export class AmountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AmountError";
  }
}

const AMOUNT_RE = /^(\d+)(?:\.(\d{1,7}))?$/;

/** Parse a non-negative decimal string into stroops. Throws AmountError on anything else. */
export function parseAmount(input: unknown): bigint {
  if (typeof input !== "string") {
    throw new AmountError(`amount must be a decimal string, not ${typeof input} (JSON numbers cannot be exact)`);
  }
  const m = AMOUNT_RE.exec(input);
  if (m === null) throw new AmountError(`"${input}" is not a decimal amount with at most 7 fractional digits`);
  const whole = BigInt(m[1] as string);
  const frac = BigInt((m[2] ?? "").padEnd(7, "0") || "0");
  const stroops = whole * STROOPS_PER_UNIT + frac;
  if (stroops > INT64_MAX) throw new AmountError(`"${input}" exceeds the maximum Stellar amount`);
  return stroops;
}

export function tryParseAmount(input: unknown): bigint | null {
  try {
    return parseAmount(input);
  } catch {
    return null;
  }
}

/** Canonical 7-decimal rendering, e.g. 1005000000n -> "100.5000000". Negative values keep a leading "-". */
export function formatAmount(stroops: bigint): string {
  const neg = stroops < 0n;
  const abs = neg ? -stroops : stroops;
  const whole = abs / STROOPS_PER_UNIT;
  const frac = (abs % STROOPS_PER_UNIT).toString().padStart(7, "0");
  return `${neg ? "-" : ""}${whole.toString()}.${frac}`;
}

/** Canonicalise a decimal string ("100" -> "100.0000000"). Throws AmountError if invalid. */
export function canonicalAmount(input: unknown): string {
  return formatAmount(parseAmount(input));
}

/** True when |observed - expected| <= expected * toleranceBps / 10000, using integer math only. */
export function withinToleranceBps(expected: bigint, observed: bigint, toleranceBps: number): boolean {
  if (!Number.isInteger(toleranceBps) || toleranceBps < 0) throw new AmountError("toleranceBps must be a non-negative integer");
  const diff = observed >= expected ? observed - expected : expected - observed;
  return diff * 10_000n <= expected * BigInt(toleranceBps);
}
