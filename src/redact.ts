/**
 * Redacted export of a report. Redaction replaces values with stable aliases (account-1, memo-1, ...) assigned from the
 * SORTED set of distinct values, so the same report always redacts the same way and equal values stay linkable
 * inside the export without revealing them. Mapping is returned to the caller and never embedded in the report.
 *
 * Not covered: free text that a record's author wrote (for example a SEP-24 `message`) is scanned for addresses, emails
 * and known memo values, but anything else in it is left as written. Review a redacted export before sharing it.
 */
import { reportSchema, type Report } from "./reportSchema.ts";

export type RedactCategory = "accounts" | "issuers" | "memos" | "emails" | "hashes";
export const REDACT_CATEGORIES: readonly RedactCategory[] = ["accounts", "issuers", "memos", "emails", "hashes"];
/** What `--redact` with no value means. Issuers and hashes are public identifiers that give a report its meaning, so they are opt-in. */
export const DEFAULT_REDACTION: readonly RedactCategory[] = ["accounts", "memos", "emails"];

const ADDRESS_RE = /([:]?)\b([GM][A-Z2-7]{55}(?:[A-Z2-7]{13})?)\b/g;
const SECRET_RE = /\bS[A-Z2-7]{55}\b/g;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const HASH_RE = /\b[0-9a-f]{64}\b/g;

export interface RedactionResult {
  report: Report;
  /** original -> alias. Keep it private: it reverses the redaction. */
  mapping: Record<string, string>;
}

type Kind = "account" | "issuer" | "memo" | "email" | "hash" | "reference";

interface Ctx {
  key: string | null;
  parent: Record<string, unknown> | null;
}

export function parseRedactCategories(input: string | undefined): RedactCategory[] {
  if (input === undefined || input === "" || input === "default") return [...DEFAULT_REDACTION];
  if (input === "all") return [...REDACT_CATEGORIES];
  const out: RedactCategory[] = [];
  for (const part of input.split(",").map((s) => s.trim()).filter(Boolean)) {
    if (!(REDACT_CATEGORIES as readonly string[]).includes(part)) throw new Error(`unknown redaction category "${part}" (use ${REDACT_CATEGORIES.join(", ")}, default or all)`);
    if (!out.includes(part as RedactCategory)) out.push(part as RedactCategory);
  }
  return out;
}

function isMemoSlot(c: Ctx): boolean {
  if (c.key === "memo") return true;
  return c.parent !== null && c.parent.field === "memo" && (c.key === "expected" || c.key === "observed");
}

function isIssuerSlot(c: Ctx): boolean {
  if (c.key !== null && /issuer/i.test(c.key)) return true;
  return c.parent !== null && c.parent.field === "issuer" && (c.key === "expected" || c.key === "observed");
}

function isReferenceSlot(c: Ctx): boolean {
  return c.key === "id" && c.parent !== null && c.parent.idType === "external";
}

export function redactReport(report: Report, categories: readonly RedactCategory[]): RedactionResult {
  const on = new Set(categories);
  const found: Record<Kind, Set<string>> = { account: new Set(), issuer: new Set(), memo: new Set(), email: new Set(), hash: new Set(), reference: new Set() };
  const wanted = (k: Kind): boolean => (k === "account" ? on.has("accounts") : k === "issuer" ? on.has("issuers") : k === "memo" || k === "reference" ? on.has("memos") : k === "email" ? on.has("emails") : on.has("hashes"));

  // Pass 1 collects distinct values per kind; pass 2 replaces them.
  let aliases: Record<Kind, Map<string, string>> | null = null;
  const mapping: Record<string, string> = {};
  // An address that appears anywhere as an asset issuer is treated as an issuer everywhere, so that keeping issuers
  // visible never leaves the same address redacted in a message and visible in a field.
  const issuerSet = new Set<string>();
  let scanning = true;

  const handle = (s: string, c: Ctx): string => {
    let out = s;
    if (c.key !== null && c.parent !== null && isReferenceSlot(c)) return sub("reference", out);
    if (isMemoSlot(c)) return sub("memo", out);
    // addresses (account-position unless in an issuer slot or written CODE:ISSUER)
    out = out.replace(SECRET_RE, "[secret-key-removed]");
    out = out.replace(ADDRESS_RE, (_m, colon: string, addr: string) => {
      if (scanning) {
        if (colon === ":" || isIssuerSlot(c)) issuerSet.add(addr);
        return `${colon}${addr}`;
      }
      const issuerPos = colon === ":" || isIssuerSlot(c) || issuerSet.has(addr);
      const replaced = sub(issuerPos ? "issuer" : "account", addr);
      return `${colon}${replaced}`;
    });
    out = out.replace(EMAIL_RE, (m) => sub("email", m));
    out = out.replace(HASH_RE, (m) => sub("hash", m));
    if (c.key === "message" && found.memo.size > 0) {
      for (const memo of [...found.memo].sort((a, b) => b.length - a.length)) if (memo.length >= 4 && on.has("memos")) out = out.split(memo).join(aliases?.memo.get(memo) ?? memo);
    }
    return out;
  };

  const sub = (kind: Kind, value: string): string => {
    if (!wanted(kind)) return value;
    if (aliases === null) {
      found[kind].add(value);
      return value;
    }
    const a = aliases[kind].get(value);
    if (a === undefined) return value;
    mapping[value] = a;
    return a;
  };

  const walk = (node: unknown, key: string | null, parent: Record<string, unknown> | null): unknown => {
    if (typeof node === "string") return handle(node, { key, parent });
    if (Array.isArray(node)) return node.map((x) => walk(x, key, parent));
    if (node !== null && typeof node === "object") {
      const o = node as Record<string, unknown>;
      return Object.fromEntries(Object.keys(o).map((k) => [k, walk(o[k], k, o)]));
    }
    return node;
  };

  walk(report, null, null);
  scanning = false;
  walk(report, null, null);
  aliases = { account: new Map(), issuer: new Map(), memo: new Map(), email: new Map(), hash: new Map(), reference: new Map() };
  const prefix: Record<Kind, string> = { account: "account", issuer: "issuer", memo: "memo", email: "email", hash: "hash", reference: "reference" };
  for (const kind of Object.keys(found) as Kind[]) {
    [...found[kind]].sort().forEach((v, i) => aliases![kind].set(v, `[${prefix[kind]}-${i + 1}]`));
  }
  const walked = walk(report, null, null) as Report;
  const out: Report = { ...walked, redaction: { categories: REDACT_CATEGORIES.filter((c) => on.has(c)) as Array<Exclude<RedactCategory, never>> } };
  const checked = reportSchema.safeParse(out);
  if (!checked.success) throw new Error("internal error: redacted report no longer matches the report schema");
  return { report: checked.data, mapping };
}
