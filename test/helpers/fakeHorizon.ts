import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { evidence } from "./cases.ts";

export type Behaviour = "ok" | "404" | "500" | "hang" | "garbage" | "huge" | "wrong_hash" | "ops_500";

export interface FakeHorizon {
  url: string;
  requests: string[];
  methods: Set<string>;
  behave: Record<string, Behaviour>;
  close: () => Promise<void>;
}

/** Serves the RECORDED testnet bodies as a stand-in for Horizon. Keys of `fixtures` are fixture names. */
export async function startFakeHorizon(fixtures: string[], passphrase = "Test SDF Network ; September 2015"): Promise<FakeHorizon> {
  const byHash = new Map<string, { tx: unknown; ops: unknown }>();
  for (const name of fixtures) {
    const item = evidence(name).items[0];
    byHash.set(item.transaction.hash, { tx: item.transaction, ops: item.operations });
  }
  const state: FakeHorizon = { url: "", requests: [], methods: new Set(), behave: {}, close: async () => {} };
  const server: Server = createServer((req, res) => {
    state.requests.push(req.url ?? "");
    state.methods.add(req.method ?? "");
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ network_passphrase: passphrase, horizon_version: "fake" }));
      return;
    }
    const m = /^\/transactions\/([0-9a-f]{64})(\/operations)?$/.exec(url.pathname);
    if (!m) {
      res.statusCode = 404;
      res.end("{}");
      return;
    }
    const hash = m[1] as string;
    const isOps = m[2] !== undefined;
    const how = state.behave[hash] ?? "ok";
    const rec = byHash.get(hash);
    if (how === "hang") return; // never respond
    if (how === "500" || (how === "ops_500" && isOps)) {
      res.statusCode = 500;
      res.end("{}");
      return;
    }
    if (how === "garbage") {
      res.end("<html>not json</html>");
      return;
    }
    if (how === "huge") {
      res.end(JSON.stringify({ pad: "x".repeat(300_000) }));
      return;
    }
    if (how === "404" || rec === undefined) {
      res.statusCode = 404;
      res.end(JSON.stringify({ status: 404, title: "Resource Missing" }));
      return;
    }
    res.setHeader("content-type", "application/json");
    if (how === "wrong_hash" && !isOps) {
      res.end(JSON.stringify({ ...(rec.tx as object), hash: "f".repeat(64) }));
      return;
    }
    res.end(JSON.stringify(isOps ? rec.ops : rec.tx));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  state.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  state.close = () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); });
  return state;
}
