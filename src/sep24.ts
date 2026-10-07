/**
 * SEP-24 (Hosted Deposit and Withdrawal, v3.8.0) transaction records and status semantics.
 * Source: https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0024.md
 * ("Single historical transaction" response and the `status` list under "Shared fields").
 */
import { z } from "zod";

/** Every status value listed by SEP-24 v3.8.0. */
export const SEP24_STATUSES = [
  "incomplete",
  "pending_user_transfer_start",
  "pending_user_transfer_complete",
  "pending_external",
  "pending_anchor",
  "on_hold",
  "pending_stellar",
  "pending_trust",
  "pending_user",
  "completed",
  "refunded",
  "expired",
  "no_market",
  "too_small",
  "too_large",
  "error",
] as const;
export type Sep24Status = (typeof SEP24_STATUSES)[number];

export type Kind = "deposit" | "withdrawal";

/**
 * What the Stellar leg should look like for a given (kind, status):
 * - none: the transfer has not happened yet, no on-chain evidence is required;
 * - required: the transfer should be on chain already;
 * - inflight: submitted to Stellar, may or may not be confirmed;
 * - failure: terminal failure; funds are not expected to have been accepted;
 * - refunded: fully refunded; refund payments (if on Stellar) are what can be checked.
 */
export type Expectation = "none" | "required" | "inflight" | "failure" | "refunded";

export const TERMINAL_STATUSES: readonly Sep24Status[] = ["completed", "refunded", "expired", "no_market", "too_small", "too_large", "error"];

export function isKnownStatus(s: string): s is Sep24Status {
  return (SEP24_STATUSES as readonly string[]).includes(s);
}

export function isTerminal(s: string): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(s);
}

export function expectationFor(kind: Kind, status: Sep24Status): Expectation {
  switch (status) {
    case "incomplete":
    case "pending_user_transfer_start":
    case "pending_user":
    case "pending_trust":
      return "none";
    case "pending_user_transfer_complete":
      // SEP-24: only used for withdrawals. For a deposit it is not a valid status; treated as not yet on chain.
      return kind === "withdrawal" ? "required" : "none";
    case "pending_anchor":
    case "pending_external":
    case "on_hold":
      // After the user's Stellar payment (withdrawal) the transfer is already on chain; for a deposit the anchor has not paid yet.
      return kind === "withdrawal" ? "required" : "none";
    case "pending_stellar":
      return "inflight";
    case "completed":
      return "required";
    case "refunded":
      return "refunded";
    case "expired":
    case "no_market":
    case "too_small":
    case "too_large":
    case "error":
      return "failure";
  }
}

/**
 * Order used ONLY to break ties between snapshots that carry the same timestamp (or none).
 * It follows the SEP-24 state diagram's forward direction; it does not claim the real flow is linear.
 */
export function lifecycleRank(status: string): number {
  switch (status) {
    case "incomplete":
      return 0;
    case "pending_user_transfer_start":
      return 1;
    case "pending_user":
    case "pending_trust":
      return 2;
    case "pending_anchor":
    case "on_hold":
      return 3;
    case "pending_user_transfer_complete":
      return 4;
    case "pending_external":
      return 5;
    case "pending_stellar":
      return 6;
    case "completed":
    case "refunded":
    case "expired":
    case "no_market":
    case "too_small":
    case "too_large":
    case "error":
      return 10;
    default:
      return 5; // unknown statuses sit mid-flow
  }
}

const amountField = z.union([z.string(), z.number()]).nullish();
const strField = z.string().nullish();

const refundPayment = z.looseObject({
  id: z.string(),
  id_type: z.string(),
  amount: amountField,
  fee: amountField,
});

/** A SEP-24 transaction record as returned by GET /transaction(s) or sent to on_change_callback. Unknown fields are tolerated and ignored. */
export const sep24RecordSchema = z.looseObject({
  id: z.string().min(1),
  kind: z.enum(["deposit", "withdrawal"]),
  status: z.string().min(1),
  status_eta: z.number().nullish(),
  more_info_url: strField,
  amount_in: amountField,
  amount_in_asset: strField,
  amount_out: amountField,
  amount_out_asset: strField,
  amount_fee: amountField,
  amount_fee_asset: strField,
  fee_details: z
    .looseObject({
      total: amountField,
      asset: strField,
      breakdown: z.array(z.looseObject({ name: z.string(), amount: amountField })).nullish(),
    })
    .nullish(),
  quote_id: strField,
  started_at: strField,
  completed_at: strField,
  updated_at: strField,
  user_action_required_by: strField,
  stellar_transaction_id: strField,
  external_transaction_id: strField,
  message: strField,
  refunded: z.boolean().nullish(),
  refunds: z
    .looseObject({
      amount_refunded: amountField,
      amount_fee: amountField,
      payments: z.array(refundPayment).nullish(),
    })
    .nullish(),
  from: strField,
  to: strField,
  deposit_memo: strField,
  deposit_memo_type: strField,
  claimable_balance_id: strField,
  withdraw_anchor_account: strField,
  withdraw_memo: strField,
  withdraw_memo_type: strField,
});

export type Sep24Record = z.infer<typeof sep24RecordSchema>;

/** Stable JSON with sorted keys, used to compare snapshots and as a deterministic tie-break. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return Object.fromEntries(Object.keys(o).sort().map((k) => [k, sortKeys(o[k])]));
  }
  return v;
}
