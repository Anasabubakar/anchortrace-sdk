import { isAccountId } from "./strkey.ts";

/** An asset as it exists on the Stellar ledger. Code AND issuer identify an issued asset. */
export type StellarAsset = { kind: "native" } | { kind: "issued"; code: string; issuer: string };

/** An asset identifier that is not a Stellar asset (for example SEP-38 `iso4217:USD`). */
export interface OffChainAsset {
  kind: "offchain";
  raw: string;
}

export type ParsedAsset = StellarAsset | OffChainAsset;

const CODE_RE = /^[A-Za-z0-9]{1,12}$/;

export function assetKey(a: StellarAsset): string {
  return a.kind === "native" ? "native" : `${a.code}:${a.issuer}`;
}

export function assetsEqual(a: StellarAsset, b: StellarAsset): boolean {
  return assetKey(a) === assetKey(b);
}

/**
 * Parse an asset string. Accepts `native`, `CODE:ISSUER`, and the SEP-38 asset identification forms
 * `stellar:native`, `stellar:CODE:ISSUER` and any other `scheme:...` (returned as offchain).
 * Returns an error string for malformed Stellar assets, never guesses an issuer.
 */
export function parseAsset(input: string): ParsedAsset | { error: string } {
  const s = input.trim();
  if (s === "native" || s === "stellar:native") return { kind: "native" };
  const parts = s.split(":");
  let code: string | undefined;
  let issuer: string | undefined;
  if (parts[0] === "stellar") {
    if (parts.length !== 3) return { error: `"${input}" is not stellar:CODE:ISSUER` };
    code = parts[1];
    issuer = parts[2];
  } else if (parts.length === 2 && parts[0] !== undefined && parts[0] !== "iso4217" && CODE_RE.test(parts[0]) && parts[1]?.startsWith("G")) {
    code = parts[0];
    issuer = parts[1];
  } else if (parts.length >= 2 && /^[a-z][a-z0-9+.-]*$/.test(parts[0] ?? "")) {
    return { kind: "offchain", raw: s };
  } else {
    return { error: `"${input}" is not native, CODE:ISSUER or a SEP-38 asset identifier` };
  }
  if (code === undefined || !CODE_RE.test(code)) return { error: `"${code ?? ""}" is not a valid asset code (1-12 alphanumeric characters)` };
  if (code === "native" || code === "XLM") return { error: `"${code}" cannot be an issued asset code without a real issuer` };
  if (issuer === undefined || !isAccountId(issuer)) return { error: `"${issuer ?? ""}" is not a valid issuer account (G... with a valid checksum)` };
  return { kind: "issued", code, issuer };
}

export function parseStellarAsset(input: string): StellarAsset | { error: string } {
  const p = parseAsset(input);
  if ("error" in p) return p;
  if (p.kind === "offchain") return { error: `"${input}" is not a Stellar asset` };
  return p;
}

/** Build an asset from Horizon's asset_type / asset_code / asset_issuer fields (or their source_/selling_ prefixed forms). */
export function assetFromHorizon(o: { asset_type?: string; asset_code?: string; asset_issuer?: string }): StellarAsset | { error: string } {
  if (o.asset_type === "native") return { kind: "native" };
  if (o.asset_type === "credit_alphanum4" || o.asset_type === "credit_alphanum12") {
    if (o.asset_code === undefined || o.asset_issuer === undefined) return { error: "issued asset without code or issuer" };
    return parseStellarAsset(`${o.asset_code}:${o.asset_issuer}`);
  }
  return { error: `unsupported asset_type ${String(o.asset_type)}` };
}

/** Horizon's single-string form used by claimable balances: `native` or `CODE:ISSUER`. */
export function assetFromCanonicalString(s: string): StellarAsset | { error: string } {
  return parseStellarAsset(s);
}
