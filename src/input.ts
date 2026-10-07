/** Parsing of user-supplied JSON into SEP-24 snapshots and AnchorTrace cases. Browser-safe: takes parsed JSON, never touches files. */
import { z } from "zod";
import { InputError } from "./errors.ts";
import { evidenceFileSchema } from "./evidence.ts";
import { sep24RecordSchema, type Sep24Record } from "./sep24.ts";
import { CASE_VERSION } from "./version.ts";

function issuesOf(e: z.ZodError): string[] {
  return e.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
}

/**
 * Accepts: a SEP-24 `/transaction` response ({transaction}), a `/transactions` response ({transactions: [...]}),
 * an array of records (for example callback payloads in the order received), or one bare record.
 * Repeated records with the same id are snapshots of one transaction's history.
 */
export function parseSep24Records(value: unknown): Sep24Record[] {
  let list: unknown[];
  if (Array.isArray(value)) list = value;
  else if (value !== null && typeof value === "object" && "transactions" in value && Array.isArray((value as { transactions: unknown }).transactions)) list = (value as { transactions: unknown[] }).transactions;
  else if (value !== null && typeof value === "object" && "transaction" in value) list = [(value as { transaction: unknown }).transaction];
  else list = [value];
  if (list.length === 0) throw new InputError("The SEP-24 input contains no transaction records");
  const out: Sep24Record[] = [];
  list.forEach((item, i) => {
    const r = sep24RecordSchema.safeParse(item);
    if (!r.success) throw new InputError(`Not a valid SEP-24 transaction record (item ${i})`, issuesOf(r.error).map((m) => `[${i}] ${m}`));
    out.push(r.data);
  });
  return out;
}

export const optionsSchema = z.strictObject({
  feePolicy: z.enum(["anchor_deducted", "customer_paid_on_top", "no_fee"]).optional(),
  assetOverride: z.string().optional(),
  anchorAccount: z.string().optional(),
  amountToleranceBps: z.number().int().nonnegative().optional(),
  expectedNetwork: z.string().optional(),
});

/** A self-contained case: records plus evidence plus options. Used for the shipped examples and for sharing a reproducible investigation. */
export const caseSchema = z.strictObject({
  caseVersion: z.literal(CASE_VERSION),
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  title: z.string(),
  description: z.string(),
  /** True when the SEP-24 record was authored for the example and is not an anchor's real data. */
  synthetic: z.boolean(),
  /** Where the evidence came from, in words (for example "recorded Horizon testnet responses"). */
  evidenceNote: z.string(),
  /** The outcome the case author intends to demonstrate; verified against the engine when examples are generated. */
  intendedOutcome: z.enum(["matched", "pending", "insufficient_evidence", "unsupported", "ambiguous", "discrepant"]),
  records: z.array(z.unknown()).min(1),
  evidence: evidenceFileSchema,
  options: optionsSchema,
});
export type Case = z.infer<typeof caseSchema>;

export function parseCase(value: unknown): Case {
  const r = caseSchema.safeParse(value);
  if (!r.success) throw new InputError("Not a valid AnchorTrace case file (caseVersion \"1\")", issuesOf(r.error));
  return r.data;
}

export function looksLikeCase(value: unknown): boolean {
  return value !== null && typeof value === "object" && "caseVersion" in value;
}

export function looksLikeEvidence(value: unknown): boolean {
  return value !== null && typeof value === "object" && "evidenceVersion" in value;
}
