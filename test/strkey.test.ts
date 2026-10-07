import { Keypair, MuxedAccount, Account, StrKey } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { baseAccountOf, isAccountId, isMuxedAccount, isStellarAddress } from "../src/strkey.ts";

// Real testnet account recorded in fixtures/testnet/manifest.json.
const REAL = "GBC4Y6VLSLAMPSRSHPRF4WQ7UVUYCG3RYUZMDZX6UUE6AHBVNCVIJ7VI";

describe("strkey", () => {
  it("accepts a real account and agrees with the Stellar SDK on random keys", () => {
    expect(isAccountId(REAL)).toBe(true);
    for (let i = 0; i < 25; i++) {
      const g = Keypair.random().publicKey();
      expect(isAccountId(g)).toBe(StrKey.isValidEd25519PublicKey(g));
      expect(isAccountId(g)).toBe(true);
    }
  });

  it("rejects corrupted checksums, wrong lengths, lowercase and other key kinds", () => {
    const swapped = REAL.slice(0, 55) + (REAL.endsWith("A") ? "B" : "A");
    expect(isAccountId(swapped)).toBe(false);
    expect(isAccountId(REAL.slice(0, 55))).toBe(false);
    expect(isAccountId(REAL.toLowerCase())).toBe(false);
    expect(isAccountId("")).toBe(false);
    expect(isAccountId(Keypair.random().secret())).toBe(false);
    expect(isStellarAddress(StrKey.encodeContract(Buffer.alloc(32, 1)))).toBe(false);
  });

  it("decodes muxed accounts to their base account, matching the Stellar SDK", () => {
    const g = Keypair.random().publicKey();
    const m = new MuxedAccount(new Account(g, "1"), "12345").accountId();
    expect(m.startsWith("M")).toBe(true);
    expect(isMuxedAccount(m)).toBe(true);
    expect(isAccountId(m)).toBe(false);
    expect(baseAccountOf(m)).toBe(g);
    expect(baseAccountOf(g)).toBe(g);
    expect(baseAccountOf("nope")).toBeNull();
    expect(isStellarAddress(m)).toBe(true);
  });
});
