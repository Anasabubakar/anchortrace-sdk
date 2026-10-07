/**
 * Evidence: Stellar classic transactions and their operations, as recorded from Horizon.
 * A supplied evidence file holds raw Horizon `/transactions/{hash}` and `/transactions/{hash}/operations` bodies,
 * so the same parser reads a file produced with curl and a live Horizon response.
 */
import { z } from "zod";
import { assetFromCanonicalString, assetFromHorizon, assetKey, type StellarAsset } from "./asset.ts";
import { canonicalAmount, tryParseAmount } from "./decimal.ts";
import { InputError } from "./errors.ts";
import { baseAccountOf } from "./strkey.ts";
import { EVIDENCE_VERSION } from "./version.ts";

const HASH_RE = /^[0-9a-f]{64}$/;

export const horizonTransactionSchema = z.looseObject({
  hash: z.string().regex(HASH_RE, "transaction hash must be 64 lowercase hex characters"),
  successful: z.boolean(),
  ledger: z.number().int().nonnegative(),
  created_at: z.string(),
  source_account: z.string(),
  memo_type: z.string().optional(),
  memo: z.string().nullish(),
  fee_charged: z.union([z.string(), z.number()]).optional(),
  operation_count: z.number().int().nonnegative(),
});

export const horizonOperationSchema = z.looseObject({
  id: z.string().regex(/^\d+$/, "operation id must be a decimal string"),
  type: z.string(),
  transaction_hash: z.string(),
  transaction_successful: z.boolean().optional(),
  source_account: z.string(),
});

const operationsInput = z.union([z.array(horizonOperationSchema), z.looseObject({ _embedded: z.looseObject({ records: z.array(horizonOperationSchema) }) })]);

export const evidenceItemSchema = z.looseObject({
  transaction: horizonTransactionSchema,
  operations: operationsInput,
});

export const evidenceFileSchema = z.looseObject({
  evidenceVersion: z.literal(EVIDENCE_VERSION),
  capture: z
    .looseObject({
      network: z.string().optional(),
      horizon: z.string().optional(),
      capturedAt: z.string().optional(),
      note: z.string().optional(),
    })
    .optional(),
  items: z.array(evidenceItemSchema),
});

export type EvidenceFile = z.infer<typeof evidenceFileSchema>;
export type EvidenceItem = z.infer<typeof evidenceItemSchema>;

export type OperationClass = "payment" | "unsupported" | "other";
export type UnsupportedKind = "path_payment" | "claimable_balance" | "soroban" | "other_value";

export interface EvidenceOperation {
  id: string;
  index: number;
  type: string;
  class: OperationClass;
  unsupportedKind: UnsupportedKind | null;
  sourceAccount: string;
  transactionSuccessful: boolean;
  from: string | null;
  to: string | null;
  toMuxed: string | null;
  asset: StellarAsset | null;
  /** Canonical 7-decimal amount, or null when the operation has none or it is malformed. */
  amount: string | null;
  /** Accounts a value-moving operation could credit. */
  involvedAccounts: string[];
  /** True when the operation could move value but the evidence does not say to whom (e.g. contract call without balance changes). */
  involvedUnknown: boolean;
}

export interface EvidenceTransaction {
  hash: string;
  successful: boolean;
  ledger: number;
  createdAt: string;
  sourceAccount: string;
  memoType: string;
  memo: string | null;
  feeCharged: string | null;
  operationCount: number;
  operations: EvidenceOperation[];
  operationsComplete: boolean;
  sourceId: string;
}

const OTHER_VALUE_TYPES = new Set(["account_merge", "create_account"]);

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function normalizeOperation(raw: z.infer<typeof horizonOperationSchema>, index: number, txSuccessful: boolean): EvidenceOperation {
  const o = raw as Record<string, unknown>;
  const base: EvidenceOperation = {
    id: raw.id,
    index,
    type: raw.type,
    class: "other",
    unsupportedKind: null,
    sourceAccount: raw.source_account,
    transactionSuccessful: raw.transaction_successful ?? txSuccessful,
    from: null,
    to: null,
    toMuxed: null,
    asset: null,
    amount: null,
    involvedAccounts: [],
    involvedUnknown: false,
  };
  const amountOf = (v: unknown): string | null => (tryParseAmount(v) === null ? null : canonicalAmount(v));
  switch (raw.type) {
    case "payment": {
      const a = assetFromHorizon(o as { asset_type?: string; asset_code?: string; asset_issuer?: string });
      return {
        ...base,
        class: "payment",
        from: str(o.from),
        to: str(o.to),
        toMuxed: str(o.to_muxed),
        asset: "error" in a ? null : a,
        amount: amountOf(o.amount),
      };
    }
    case "path_payment_strict_receive":
    case "path_payment_strict_send": {
      const a = assetFromHorizon(o as { asset_type?: string; asset_code?: string; asset_issuer?: string });
      const to = str(o.to);
      return {
        ...base,
        class: "unsupported",
        unsupportedKind: "path_payment",
        from: str(o.from),
        to,
        toMuxed: str(o.to_muxed),
        asset: "error" in a ? null : a,
        amount: amountOf(o.amount),
        involvedAccounts: to ? [to] : [],
        involvedUnknown: to === null,
      };
    }
    case "create_claimable_balance": {
      const claimants = Array.isArray(o.claimants) ? (o.claimants as Array<Record<string, unknown>>) : [];
      const a = typeof o.asset === "string" ? assetFromCanonicalString(o.asset) : null;
      return {
        ...base,
        class: "unsupported",
        unsupportedKind: "claimable_balance",
        asset: a === null || "error" in a ? null : a,
        amount: amountOf(o.amount),
        involvedAccounts: claimants.map((c) => str(c.destination)).filter((x): x is string => x !== null),
        involvedUnknown: claimants.length === 0,
      };
    }
    case "claim_claimable_balance": {
      const claimant = str(o.claimant);
      return { ...base, class: "unsupported", unsupportedKind: "claimable_balance", involvedAccounts: claimant ? [claimant] : [], involvedUnknown: claimant === null };
    }
    case "invoke_host_function": {
      const changes = Array.isArray(o.asset_balance_changes) ? (o.asset_balance_changes as Array<Record<string, unknown>>) : null;
      return {
        ...base,
        class: "unsupported",
        unsupportedKind: "soroban",
        involvedAccounts: changes === null ? [] : changes.map((c) => str(c.to)).filter((x): x is string => x !== null),
        involvedUnknown: changes === null,
      };
    }
    default:
      if (OTHER_VALUE_TYPES.has(raw.type)) {
        const target = raw.type === "account_merge" ? str(o.into) : str(o.account);
        return {
          ...base,
          class: "unsupported",
          unsupportedKind: "other_value",
          involvedAccounts: target === null ? [] : [target],
          involvedUnknown: target === null,
          amount: amountOf(o.starting_balance),
        };
      }
      return base;
  }
}

/** Normalise one parsed evidence item. `sourceId` is the provenance id of the file or fetch it came from. */
export function normalizeEvidenceItem(item: EvidenceItem, sourceId: string): EvidenceTransaction {
  const t = item.transaction;
  const rawOps = Array.isArray(item.operations) ? item.operations : item.operations._embedded.records;
  for (const op of rawOps) {
    if (op.transaction_hash !== t.hash) {
      throw new InputError(`operation ${op.id} belongs to transaction ${op.transaction_hash}, not ${t.hash}`);
    }
  }
  const ordered = [...rawOps].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0));
  const ids = new Set<string>();
  for (const op of ordered) {
    if (ids.has(op.id)) throw new InputError(`duplicate operation id ${op.id} in transaction ${t.hash}`);
    ids.add(op.id);
  }
  const fee = t.fee_charged === undefined ? null : String(t.fee_charged);
  return {
    hash: t.hash,
    successful: t.successful,
    ledger: t.ledger,
    createdAt: t.created_at,
    sourceAccount: t.source_account,
    memoType: t.memo_type ?? "none",
    memo: t.memo ?? null,
    feeCharged: fee,
    operationCount: t.operation_count,
    operations: ordered.map((op, i) => normalizeOperation(op, i, t.successful)),
    operationsComplete: ordered.length === t.operation_count,
    sourceId,
  };
}

/** Parse and normalise a whole evidence file's JSON value. Throws InputError with readable issues. */
export function parseEvidenceFile(value: unknown, sourceId: string): { transactions: EvidenceTransaction[]; capture: EvidenceFile["capture"] } {
  const parsed = evidenceFileSchema.safeParse(value);
  if (!parsed.success) {
    throw new InputError(
      "Not a valid AnchorTrace evidence file (evidenceVersion \"1\" with items of raw Horizon transaction and operations bodies)",
      parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    );
  }
  const seen = new Map<string, string>();
  const transactions: EvidenceTransaction[] = [];
  for (const item of parsed.data.items) {
    const tx = normalizeEvidenceItem(item, sourceId);
    const prior = seen.get(tx.hash);
    const sig = JSON.stringify(tx.operations.map((o) => [o.id, o.type, o.to, o.amount, o.asset === null ? null : assetKey(o.asset)]));
    if (prior !== undefined) {
      if (prior !== sig) throw new InputError(`transaction ${tx.hash} appears twice in one evidence file with different operations`);
      continue;
    }
    seen.set(tx.hash, sig);
    transactions.push(tx);
  }
  return { transactions, capture: parsed.data.capture };
}

/** True when `account` (G... or M...) is the same base account as `other`. */
export function sameBaseAccount(a: string, b: string): boolean {
  const x = baseAccountOf(a);
  const y = baseAccountOf(b);
  return x !== null && y !== null && x === y;
}
