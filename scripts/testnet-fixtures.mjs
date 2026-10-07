// Creates real Stellar TESTNET transactions used as evidence fixtures.
// This is fixture tooling, not part of the product: AnchorTrace itself never signs or submits.
// Requires: stellar CLI with funded testnet identities at-issuer, at-rogue, at-wallet, at-anchor, at-other
// (stellar keys generate <alias> --network testnet --fund). Secrets are read from ~/.config/stellar at run time
// and are never written anywhere. Usage: node scripts/testnet-fixtures.mjs
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Account, Asset, Claimant, Keypair, Memo, Networks, Operation, TransactionBuilder } from "@stellar/stellar-sdk";

const HORIZON = "https://horizon-testnet.stellar.org";
const outDir = "fixtures/testnet/evidence";
mkdirSync(outDir, { recursive: true });

const alias = (a) => ({ kp: Keypair.fromSecret(execFileSync("stellar", ["keys", "secret", a]).toString().trim()) });
const acc = { issuer: alias("at-issuer").kp, rogue: alias("at-rogue").kp, wallet: alias("at-wallet").kp, anchor: alias("at-anchor").kp, other: alias("at-other").kp };
const GOOD = new Asset("TRACEUSD", acc.issuer.publicKey());
const ROGUE = new Asset("TRACEUSD", acc.rogue.publicKey());

async function withRetry(fn) {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= 4) throw e;
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
}

async function getJson(path) {
  return withRetry(async () => {
    const r = await fetch(HORIZON + path);
    return { status: r.status, body: await r.json() };
  });
}

async function submit(kp, ops, memo) {
  const a = await getJson(`/accounts/${kp.publicKey()}`);
  const b = new TransactionBuilder(new Account(kp.publicKey(), a.body.sequence), { fee: "100", networkPassphrase: Networks.TESTNET }).setTimeout(120);
  for (const op of ops) b.addOperation(op);
  if (memo) b.addMemo(memo);
  const tx = b.build();
  tx.sign(kp);
  const r = await fetch(`${HORIZON}/transactions`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ tx: tx.toXDR() }) });
  const body = await r.json();
  // Failed transactions are still in the ledger; hash is known from the envelope.
  return { hash: Buffer.from(tx.hash()).toString("hex"), accepted: r.status === 200, status: r.status, resultCodes: body?.extras?.result_codes ?? null };
}

async function capture(name, hash) {
  // Horizon ingests asynchronously; retry briefly.
  for (let i = 0; i < 20; i++) {
    const tx = await getJson(`/transactions/${hash}`);
    if (tx.status === 200) {
      const ops = await getJson(`/transactions/${hash}/operations?limit=200&order=asc`);
      const file = {
        evidenceVersion: "1",
        capture: { network: "testnet", horizon: HORIZON, capturedAt: new Date().toISOString(), note: "Raw Horizon responses recorded by scripts/testnet-fixtures.mjs" },
        items: [{ transaction: tx.body, operations: ops.body }],
      };
      writeFileSync(`${outDir}/${name}.json`, JSON.stringify(file, null, 2) + "\n");
      return;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`transaction ${hash} not visible on Horizon`);
}

const pay = (kp, dest, asset, amount) => Operation.payment({ destination: dest, asset, amount, source: kp.publicKey() });
const manifest = { network: "testnet", horizon: HORIZON, asset: { code: "TRACEUSD", issuer: acc.issuer.publicKey(), rogueIssuer: acc.rogue.publicKey() }, accounts: Object.fromEntries(Object.entries(acc).map(([k, v]) => [k, v.publicKey()])), scenarios: {} };

// Setup: trustlines and funding of the wallet with both assets.
const setup = [];
setup.push(await submit(acc.wallet, [Operation.changeTrust({ asset: GOOD }), Operation.changeTrust({ asset: ROGUE })]));
setup.push(await submit(acc.anchor, [Operation.changeTrust({ asset: GOOD }), Operation.changeTrust({ asset: ROGUE })]));
setup.push(await submit(acc.other, [Operation.changeTrust({ asset: GOOD })]));
setup.push(await submit(acc.issuer, [pay(acc.issuer, acc.wallet.publicKey(), GOOD, "1000"), pay(acc.issuer, acc.anchor.publicKey(), GOOD, "500")]));
setup.push(await submit(acc.rogue, [pay(acc.rogue, acc.wallet.publicKey(), ROGUE, "1000")]));
manifest.setupTransactions = setup.map((s) => s.hash);
for (const s of setup) if (!s.accepted) throw new Error("setup failed " + JSON.stringify(s));

const W = acc.wallet, A = acc.anchor.publicKey();
const scenarios = [
  ["w01-correct-withdrawal-payment", () => submit(W, [pay(W, A, GOOD, "100")], Memo.id("1001")), "100.0000000 TRACEUSD (issuer) to anchor, memo id 1001"],
  ["w02-wrong-destination", () => submit(W, [pay(W, acc.other.publicKey(), GOOD, "100")], Memo.id("1002")), "100 TRACEUSD to the 'other' account instead of the anchor, memo id 1002"],
  ["w03-wrong-issuer", () => submit(W, [pay(W, A, ROGUE, "100")], Memo.id("1003")), "100 TRACEUSD issued by the rogue issuer to anchor, memo id 1003"],
  ["w04-wrong-amount", () => submit(W, [pay(W, A, GOOD, "99.5")], Memo.id("1004")), "99.5 TRACEUSD (issuer) to anchor, memo id 1004"],
  ["w05-multi-operation", () => submit(W, [pay(W, A, GOOD, "60"), pay(W, A, GOOD, "40")], Memo.id("1005")), "one tx, two payments (60 + 40) to anchor, memo id 1005"],
  ["w06-path-payment", () => submit(W, [Operation.pathPaymentStrictSend({ sendAsset: Asset.native(), sendAmount: "5", destination: A, destAsset: Asset.native(), destMin: "5", path: [] })], Memo.id("1006")), "path payment strict send XLM->XLM 5 to anchor, memo id 1006"],
  ["w07-claimable-balance", () => submit(W, [Operation.createClaimableBalance({ asset: Asset.native(), amount: "5", claimants: [new Claimant(A)] })], Memo.id("1007")), "create_claimable_balance 5 XLM claimable by anchor, memo id 1007"],
  ["w08-wrong-memo", () => submit(W, [pay(W, A, GOOD, "100")], Memo.id("9999")), "100 TRACEUSD to anchor with memo id 9999 (record will say 1008)"],
  ["w09-failed-transaction", () => submit(W, [pay(W, A, GOOD, "5000000")], Memo.id("1009")), "payment larger than balance: transaction fails on apply (op_underfunded)"],
  ["d01-correct-deposit-payment", () => submit(acc.anchor, [pay(acc.anchor, W.publicKey(), GOOD, "50")], Memo.text("dep-2001")), "anchor pays 50 TRACEUSD to wallet, memo text dep-2001"],
];
for (const [name, run, note] of scenarios) {
  if (existsSync(`${outDir}/${name}.json`)) {
    // Resume after an interrupted run: keep what is already recorded instead of submitting again.
    const prior = JSON.parse(readFileSync(`${outDir}/${name}.json`, "utf8")).items[0].transaction;
    manifest.scenarios[name] = { hash: prior.hash, horizonAccepted: prior.successful, resultCodes: null, note };
    continue;
  }
  const r = await run();
  console.log(name, r.hash, r.status, JSON.stringify(r.resultCodes));
  await capture(name, r.hash);
  manifest.scenarios[name] = { hash: r.hash, horizonAccepted: r.accepted, resultCodes: r.resultCodes, note };
}

// Soroban: transfer of the native asset's Stellar Asset Contract (invoke_host_function), via the stellar CLI.
const sac = execFileSync("stellar", ["contract", "id", "asset", "--asset", "native", "--network", "testnet"]).toString().trim();
const out = execFileSync("stellar", ["contract", "invoke", "--id", sac, "--source", "at-wallet", "--network", "testnet", "--send=yes", "--", "transfer", "--from", acc.wallet.publicKey(), "--to", A, "--amount", "50000000"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
void out;
console.log("soroban invoke done; locate its hash with the account's transactions listing");
const recent = await getJson(`/accounts/${acc.wallet.publicKey()}/transactions?order=desc&limit=1`);
const sorobanHash = recent.body._embedded.records[0].hash;
await capture("w10-soroban-sac-transfer", sorobanHash);
manifest.scenarios["w10-soroban-sac-transfer"] = { hash: sorobanHash, horizonAccepted: true, resultCodes: null, note: `invoke_host_function: transfer 5 XLM on the native Stellar Asset Contract ${sac} from wallet to anchor` };

writeFileSync("fixtures/testnet/manifest.json", JSON.stringify(manifest, null, 2) + "\n");
console.log("done");
