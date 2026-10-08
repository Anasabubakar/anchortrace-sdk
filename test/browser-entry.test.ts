import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const checker = fileURLToPath(new URL("../scripts/check-browser-entry.mjs", import.meta.url));
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/browser-entry/${name}`, import.meta.url));

function runCheck(entryPoint?: string) {
  return spawnSync(process.execPath, entryPoint === undefined ? [checker] : [checker, entryPoint], { encoding: "utf8" });
}

describe("browser entry point", () => {
  it("bundles the public package export for browsers", () => {
    expect(runCheck().status).toBe(0);
  });

  it.each(["node-builtin.ts", "stellar-sdk.ts"])("rejects %s", (entryPoint) => {
    const result = runCheck(fixture(entryPoint));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Browser entry must not import");
  });
});
