#!/usr/bin/env node
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { Command, CommanderError, InvalidArgumentError } from "commander";
import { InputError } from "./errors.ts";
import { evidenceFileSchema } from "./evidence.ts";
import { HorizonSource } from "./horizon.ts";
import { caseSchema, looksLikeCase, looksLikeEvidence, parseSep24Records } from "./input.ts";
import { parseRedactCategories, redactReport } from "./redact.ts";
import { exitCodeFor, renderExplain, renderMarkdown, renderText } from "./render.ts";
import { FEE_POLICIES, type FeePolicy, type ReconcileOptions } from "./reconcile.ts";
import { OUTCOMES, parseReport, reportSchema, type Outcome, type Report } from "./reportSchema.ts";
import { SCHEMA_TARGETS, jsonSchemaFor } from "./schemas.ts";
import { collectTransactionHashes, reconcileSupplied, suppliedSourceCount, type SuppliedFile } from "./run.ts";
import { TOOL_VERSION } from "./version.ts";

export interface CliIo {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
}

const FORMATS = ["text", "json", "markdown"] as const;
type Format = (typeof FORMATS)[number];
const DEFAULT_FAIL_ON: Outcome[] = ["discrepant", "ambiguous", "unsupported", "insufficient_evidence"];

function parseFailOn(value: string): Outcome[] {
  const parts = value.split(",").map((s) => s.trim()).filter(Boolean);
  for (const p of parts) if (!(OUTCOMES as readonly string[]).includes(p)) throw new InvalidArgumentError(`--fail-on takes a comma list of ${OUTCOMES.join(", ")} (got "${p}")`);
  return parts as Outcome[];
}

function parsePositiveInt(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new InvalidArgumentError("must be a positive integer");
  return n;
}

function parseNonNegInt(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new InvalidArgumentError("must be a non-negative integer");
  return n;
}

function parseFeePolicy(value: string): FeePolicy {
  if (!(FEE_POLICIES as readonly string[]).includes(value)) throw new InvalidArgumentError(`must be one of ${FEE_POLICIES.join(", ")}`);
  return value as FeePolicy;
}

function collect(value: string, prev: string[]): string[] {
  return [...prev, value];
}

async function readJson(path: string): Promise<SuppliedFile> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (e) {
    throw new InputError(`Cannot read ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (e) {
    throw new InputError(`${path} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  return { label: path, value, sha256: createHash("sha256").update(bytes).digest("hex") };
}

function fmtOf(opt: string): Format {
  if (!(FORMATS as readonly string[]).includes(opt)) throw new InputError(`--format must be ${FORMATS.join(", ")}`);
  return opt as Format;
}

function emit(report: Report, format: Format): string {
  return format === "json" ? JSON.stringify(report, null, 2) + "\n" : format === "markdown" ? renderMarkdown(report) : renderText(report);
}

/**
 * Exit codes: 0 no transaction has a failing outcome; 1 at least one outcome named by --fail-on
 * (default: discrepant, ambiguous, unsupported, insufficient_evidence; --strict adds pending);
 * 2 invalid input or usage; 3 unexpected error.
 */
export async function runCli(argv: string[], io: CliIo): Promise<number> {
  let exit = 0;
  const program = new Command();
  program
    .name("anchortrace")
    .description("Explainable, read-only reconciliation of SEP-24 anchor transactions against Stellar classic payment evidence. Confirmation on chain is not a bank payout.")
    .version(TOOL_VERSION)
    .exitOverride()
    .configureOutput({ writeOut: io.stdout, writeErr: io.stderr });

  const guard = (fn: (...args: any[]) => Promise<void>) => async (...args: any[]) => {
    try {
      await fn(...args);
    } catch (e) {
      if (e instanceof InputError) {
        io.stderr(`${e.message}\n`);
        for (const i of e.issues) io.stderr(`  ${i}\n`);
        exit = 2;
      } else throw e;
    }
  };

  program
    .command("reconcile")
    .argument("<sep24...>", "SEP-24 record file(s): a /transaction or /transactions response, callback payloads, or one AnchorTrace case file")
    .option("--evidence <file>", "Horizon evidence file (repeatable): raw /transactions/{hash} and /operations bodies", collect, [] as string[])
    .option("--horizon <url>", "read evidence live from Horizon: testnet, public or an https:// URL (read-only GET requests)")
    .option("--fee-policy <policy>", `${FEE_POLICIES.join(" | ")} (default anchor_deducted)`, parseFeePolicy)
    .option("--asset <asset>", "expected Stellar asset (native or CODE:ISSUER) when the record omits amount_in_asset/amount_out_asset")
    .option("--anchor-account <G...>", "deposits: the account the anchor is expected to pay from")
    .option("--tolerance-bps <n>", "allowed amount deviation in basis points (default 0, exact)", parseNonNegInt, 0)
    .option("--network <network>", "expected network: testnet, public or a passphrase; evidence from another network is rejected")
    .option("--format <format>", "text, json or markdown", "text")
    .option("--out <file>", "also write the JSON report to this file")
    .option("--redact [categories]", "redact the output: accounts,issuers,memos,emails,hashes (default accounts,memos,emails; all)")
    .option("--fail-on <outcomes>", "exit 1 when any transaction has one of these outcomes", parseFailOn, DEFAULT_FAIL_ON)
    .option("--strict", "shorthand for also failing on pending")
    .option("--timeout <ms>", "per-request Horizon timeout in milliseconds", parsePositiveInt, 15000)
    .option("--allow-http", "permit http:// Horizon URLs (local standalone networks only)")
    .option("--now <iso>", "timestamp to record as generatedAt (for reproducible reports)")
    .description("Reconcile SEP-24 transaction records with Stellar payment evidence and classify each as matched, pending, discrepant, ambiguous, unsupported or insufficient_evidence.")
    .action(
      guard(async (files: string[], opts) => {
        const format = fmtOf(opts.format);
        const records = await Promise.all(files.map(readJson));
        const evidence = await Promise.all((opts.evidence as string[]).map(readJson));
        const options: ReconcileOptions = {
          ...(opts.feePolicy ? { feePolicy: opts.feePolicy as FeePolicy } : {}),
          ...(opts.asset ? { assetOverride: opts.asset as string } : {}),
          ...(opts.anchorAccount ? { anchorAccount: opts.anchorAccount as string } : {}),
          ...(opts.toleranceBps > 0 ? { amountToleranceBps: opts.toleranceBps as number } : {}),
          ...(opts.network ? { expectedNetwork: opts.network as string } : {}),
        };
        const now = opts.now ? new Date(opts.now as string) : undefined;
        if (now !== undefined && Number.isNaN(now.getTime())) throw new InputError("--now must be an ISO 8601 timestamp");
        let acquired;
        if (opts.horizon) {
          const source = new HorizonSource(opts.horizon as string, { timeoutMs: opts.timeout as number, allowHttp: opts.allowHttp === true });
          let n = suppliedSourceCount(records, evidence);
          acquired = await source.acquire(collectTransactionHashes(records), () => `src-${++n}`);
        }
        let report = reconcileSupplied({ records, evidence, ...(acquired ? { acquired } : {}), options, ...(now ? { now } : {}) });
        if (opts.redact !== undefined) report = redactReport(report, parseRedactCategories(opts.redact === true ? undefined : (opts.redact as string))).report;
        if (opts.out) await writeFile(opts.out as string, JSON.stringify(report, null, 2) + "\n");
        io.stdout(emit(report, format));
        const failOn: Outcome[] = opts.strict ? [...new Set<Outcome>([...(opts.failOn as Outcome[]), "pending"])] : (opts.failOn as Outcome[]);
        exit = exitCodeFor(report, failOn);
      }),
    );

  program
    .command("explain")
    .argument("<report>", "a report JSON file written by `reconcile --format json` or `--out`")
    .option("--tx <id>", "explain only this SEP-24 transaction id")
    .description("Explain, step by step, why each transaction got its outcome, what was compared and what would change it.")
    .action(
      guard(async (path: string, opts) => {
        const f = await readJson(path);
        const p = parseReport(f.value);
        if (!p.ok) throw new InputError(`${path} is not a valid AnchorTrace report`, [p.error]);
        try {
          io.stdout(renderExplain(p.report, opts.tx as string | undefined));
        } catch (e) {
          throw new InputError(e instanceof Error ? e.message : String(e));
        }
      }),
    );

  program
    .command("export")
    .argument("<report>", "a report JSON file")
    .option("--redact [categories]", "accounts,issuers,memos,emails,hashes (default accounts,memos,emails; all)")
    .option("--format <format>", "text, json or markdown", "json")
    .option("--out <file>", "write here instead of stdout")
    .option("--mapping-out <file>", "write the alias-to-original mapping here (keep it private; it reverses the redaction)")
    .description("Re-render a report, optionally redacted for sharing. Redaction aliases are assigned from sorted distinct values, so output is deterministic.")
    .action(
      guard(async (path: string, opts) => {
        const format = fmtOf(opts.format);
        const f = await readJson(path);
        const p = parseReport(f.value);
        if (!p.ok) throw new InputError(`${path} is not a valid AnchorTrace report`, [p.error]);
        let report = p.report;
        if (opts.redact !== undefined) {
          let cats;
          try {
            cats = parseRedactCategories(opts.redact === true ? undefined : (opts.redact as string));
          } catch (e) {
            throw new InputError(e instanceof Error ? e.message : String(e));
          }
          const r = redactReport(report, cats);
          report = r.report;
          if (opts.mappingOut) await writeFile(opts.mappingOut as string, JSON.stringify(r.mapping, null, 2) + "\n", { mode: 0o600 });
        } else if (opts.mappingOut) throw new InputError("--mapping-out needs --redact");
        const text = emit(report, format);
        if (opts.out) await writeFile(opts.out as string, text);
        else io.stdout(text);
      }),
    );

  program
    .command("validate")
    .argument("<file>", "a SEP-24 record file, evidence file, case file or report")
    .description("Check that a file is readable by AnchorTrace (offline). Detects the kind of file.")
    .action(
      guard(async (path: string) => {
        const f = await readJson(path);
        const v = f.value;
        if (looksLikeCase(v)) {
          const r = caseSchema.safeParse(v);
          if (!r.success) throw new InputError(`${path} is not a valid case file`, r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
          io.stdout(`Case OK: ${r.data.id} (${r.data.synthetic ? "synthetic" : "recorded"} record), ${r.data.records.length} record snapshot(s)\n`);
        } else if (looksLikeEvidence(v)) {
          const r = evidenceFileSchema.safeParse(v);
          if (!r.success) throw new InputError(`${path} is not a valid evidence file`, r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
          io.stdout(`Evidence OK: ${r.data.items.length} transaction(s)\n`);
        } else if (v !== null && typeof v === "object" && "reportVersion" in v) {
          const r = reportSchema.safeParse(v);
          if (!r.success) throw new InputError(`${path} is not a valid report`, r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
          io.stdout(`Report OK: ${r.data.transactions.length} transaction(s)\n`);
        } else {
          const recs = parseSep24Records(v);
          io.stdout(`SEP-24 records OK: ${recs.length} snapshot(s) of ${new Set(recs.map((r) => r.id)).size} transaction(s)\n`);
        }
      }),
    );

  program
    .command("schema")
    .argument("<name>", "report, evidence or case")
    .description("Print a published JSON Schema (draft 2020-12).")
    .action(
      guard(async (name: string) => {
        const t = SCHEMA_TARGETS.find((x) => x.name === name);
        if (!t) throw new InputError(`Unknown schema "${name}" (report, evidence or case)`);
        io.stdout(JSON.stringify(jsonSchemaFor(t.schema, t.title), null, 2) + "\n");
      }),
    );

  try {
    await program.parseAsync(argv, { from: "user" });
  } catch (e) {
    if (e instanceof CommanderError) return e.exitCode === 0 ? 0 : 2;
    io.stderr(`Unexpected error: ${e instanceof Error ? e.message : String(e)}\n`);
    return 3;
  }
  return exit;
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (invokedDirectly) {
  runCli(process.argv.slice(2), {
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
  }).then((code) => process.exit(code));
}
