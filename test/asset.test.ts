import { describe, expect, it } from "vitest";
import { assetFromHorizon, assetKey, assetsEqual, parseAsset, parseStellarAsset } from "../src/asset.ts";

const ISSUER = "GC7Q2WPYYUISJ2FL26UVAEDSYJG2OBIFIGZSW2NYQCMOUKPM4LI3JRJD";
const ROGUE = "GAZ3S5TXIUUSAW7UC2RPQXNYWUJZSTSH5CPHG5RYNMOUBMJL45ER6ZII";

describe("assets", () => {
  it("parses native, CODE:ISSUER and SEP-38 stellar identifiers to the same asset", () => {
    expect(parseAsset("native")).toEqual({ kind: "native" });
    expect(parseAsset("stellar:native")).toEqual({ kind: "native" });
    const a = parseAsset(`TRACEUSD:${ISSUER}`);
    const b = parseAsset(`stellar:TRACEUSD:${ISSUER}`);
    expect(a).toEqual({ kind: "issued", code: "TRACEUSD", issuer: ISSUER });
    expect(b).toEqual(a);
  });

  it("treats the same code with a different issuer as a different asset", () => {
    const a = parseStellarAsset(`TRACEUSD:${ISSUER}`);
    const b = parseStellarAsset(`TRACEUSD:${ROGUE}`);
    if ("error" in a || "error" in b) throw new Error("setup");
    expect(assetsEqual(a, b)).toBe(false);
    expect(assetKey(a)).not.toBe(assetKey(b));
    expect(assetsEqual({ kind: "native" }, { kind: "native" })).toBe(true);
  });

  it("returns SEP-38 off-chain identifiers as offchain, never as Stellar assets", () => {
    expect(parseAsset("iso4217:USD")).toEqual({ kind: "offchain", raw: "iso4217:USD" });
    expect(parseStellarAsset("iso4217:USD")).toHaveProperty("error");
  });

  it("rejects missing issuers, bad checksums, XLM-as-issued and over-long codes", () => {
    for (const bad of ["USD", "USD:", `USD:${ISSUER.slice(0, 55)}A`, `XLM:${ISSUER}`, `ABCDEFGHIJKLM:${ISSUER}`, "stellar:USD", "", ":G"]) {
      expect("error" in (parseAsset(bad) as object), bad).toBe(true);
    }
  });

  it("maps Horizon asset fields", () => {
    expect(assetFromHorizon({ asset_type: "native" })).toEqual({ kind: "native" });
    expect(assetFromHorizon({ asset_type: "credit_alphanum12", asset_code: "TRACEUSD", asset_issuer: ISSUER })).toEqual({ kind: "issued", code: "TRACEUSD", issuer: ISSUER });
    expect(assetFromHorizon({ asset_type: "liquidity_pool_shares" })).toHaveProperty("error");
  });
});
