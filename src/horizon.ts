/**
 * Read-only live evidence acquisition from a Stellar Horizon server using plain fetch.
 * It issues only GET requests, holds no keys, signs nothing and submits nothing.
 * Endpoints used (Horizon API): GET /, GET /transactions/{hash}, GET /transactions/{hash}/operations.
 */
import { evidenceItemSchema, horizonOperationSchema, horizonTransactionSchema, normalizeEvidenceItem, type EvidenceTransaction } from "./evidence.ts";
import { InputError } from "./errors.ts";
import type { AcquisitionFailure } from "./leg.ts";
import type { Provenance } from "./reportSchema.ts";
import { z } from "zod";

export const HORIZON_PRESETS: Record<string, string> = {
  testnet: "https://horizon-testnet.stellar.org",
  public: "https://horizon.stellar.org",
};

export interface HorizonOptions {
  timeoutMs?: number;
  /** Permit http:// (local standalone networks only). */
  allowHttp?: boolean;
  /** Maximum response body size in bytes. */
  maxBytes?: number;
  fetch?: typeof fetch;
  now?: () => Date;
}

type FetchOutcome = { ok: true; status: number; body: unknown } | { ok: false; status: number | null; kind: AcquisitionFailure["kind"]; detail: string };

export interface Acquisition {
  transactions: EvidenceTransaction[];
  failures: AcquisitionFailure[];
  provenance: Provenance[];
}

export function resolveHorizonUrl(input: string, allowHttp = false): string {
  const raw = HORIZON_PRESETS[input] ?? input;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new InputError(`Horizon URL "${input}" is not a valid URL (use testnet, public or a full https:// URL)`);
  }
  if (u.username !== "" || u.password !== "") throw new InputError("Horizon URL must not contain credentials");
  if (u.protocol !== "https:" && !(allowHttp && u.protocol === "http:")) throw new InputError("Horizon URL must be https:// (http:// only with --allow-http for local networks)");
  if (u.search !== "" || u.hash !== "") throw new InputError("Horizon URL must not contain a query string or fragment");
  return u.origin + u.pathname.replace(/\/+$/, "");
}

export class HorizonSource {
  readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly doFetch: typeof fetch;
  private readonly now: () => Date;

  constructor(url: string, opts: HorizonOptions = {}) {
    this.baseUrl = resolveHorizonUrl(url, opts.allowHttp === true);
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.maxBytes = opts.maxBytes ?? 2_000_000;
    this.doFetch = opts.fetch ?? fetch;
    this.now = opts.now ?? (() => new Date());
  }

  private async getJson(path: string): Promise<FetchOutcome> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      const res = await this.doFetch(this.baseUrl + path, { method: "GET", headers: { accept: "application/json" }, signal: ctl.signal, redirect: "error" });
      if (res.status === 404) return { ok: false, status: 404, kind: "not_found", detail: "HTTP 404" };
      if (!res.ok) return { ok: false, status: res.status, kind: "unavailable", detail: `HTTP ${res.status}` };
      const text = await this.readCapped(res);
      if (text === null) return { ok: false, status: res.status, kind: "too_large", detail: `response exceeds ${this.maxBytes} bytes` };
      try {
        return { ok: true, status: res.status, body: JSON.parse(text) };
      } catch {
        return { ok: false, status: res.status, kind: "invalid_response", detail: "response is not JSON" };
      }
    } catch (e) {
      if (ctl.signal.aborted) return { ok: false, status: null, kind: "timeout", detail: `no complete response within ${this.timeoutMs} ms` };
      return { ok: false, status: null, kind: "unavailable", detail: e instanceof Error ? e.message : String(e) };
    } finally {
      clearTimeout(timer);
    }
  }

  private async readCapped(res: Response): Promise<string | null> {
    if (res.body === null) return await res.text();
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > this.maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    const all = new Uint8Array(total);
    let o = 0;
    for (const c of chunks) {
      all.set(c, o);
      o += c.byteLength;
    }
    return new TextDecoder().decode(all);
  }

  /** Network passphrase reported by the Horizon root, or null when it cannot be read. */
  async networkPassphrase(): Promise<string | null> {
    const r = await this.getJson("/");
    if (!r.ok) return null;
    const p = z.looseObject({ network_passphrase: z.string() }).safeParse(r.body);
    return p.success ? p.data.network_passphrase : null;
  }

  /**
   * Fetch evidence for each transaction hash. Never throws for network or content problems: those become
   * AcquisitionFailure entries so the engine reports insufficient_evidence instead of a false mismatch.
   */
  async acquire(hashes: string[], nextSourceId: () => string): Promise<Acquisition> {
    const out: Acquisition = { transactions: [], failures: [], provenance: [] };
    const passphrase = await this.networkPassphrase();
    const network = passphrase === "Test SDF Network ; September 2015" ? "testnet" : passphrase === "Public Global Stellar Network ; September 2015" ? "public" : passphrase;
    for (const hash of [...new Set(hashes)].sort()) {
      const sourceId = nextSourceId();
      const url = `${this.baseUrl}/transactions/${hash}`;
      const prov = (httpStatus: number | null): Provenance => ({ id: sourceId, role: "evidence", kind: "horizon", label: `Horizon ${url}`, sha256: null, url, network, networkPassphrase: passphrase, fetchedAt: this.now().toISOString(), httpStatus });
      const fail = (kind: AcquisitionFailure["kind"], detail: string, status: number | null) => {
        out.failures.push({ hash, kind, detail, sourceId });
        out.provenance.push(prov(status));
      };
      if (!/^[0-9a-f]{64}$/.test(hash)) {
        fail("invalid_hash", "not a 64-character lowercase hex transaction hash", null);
        continue;
      }
      const txRes = await this.getJson(`/transactions/${hash}`);
      if (!txRes.ok) {
        fail(txRes.kind, txRes.detail, txRes.status);
        continue;
      }
      const tx = horizonTransactionSchema.safeParse(txRes.body);
      if (!tx.success) {
        fail("invalid_response", "transaction body is not a Horizon transaction record", txRes.status);
        continue;
      }
      if (tx.data.hash !== hash) {
        fail("invalid_response", `Horizon returned transaction ${tx.data.hash} for ${hash}`, txRes.status);
        continue;
      }
      const opsRes = await this.getJson(`/transactions/${hash}/operations?limit=200&order=asc`);
      if (!opsRes.ok) {
        fail(opsRes.kind, `operations: ${opsRes.detail}`, opsRes.status);
        continue;
      }
      const item = evidenceItemSchema.safeParse({ transaction: txRes.body, operations: opsRes.body });
      const embedded = z.looseObject({ _embedded: z.looseObject({ records: z.array(horizonOperationSchema) }) }).safeParse(opsRes.body);
      if (!item.success || !embedded.success) {
        fail("invalid_response", "operations body is not a Horizon operations page", opsRes.status);
        continue;
      }
      try {
        out.transactions.push(normalizeEvidenceItem(item.data, sourceId));
        out.provenance.push(prov(txRes.status));
      } catch (e) {
        fail("invalid_response", e instanceof Error ? e.message : String(e), txRes.status);
      }
    }
    return out;
  }
}
