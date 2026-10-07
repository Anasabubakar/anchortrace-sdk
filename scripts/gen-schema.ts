// Run with: node --experimental-strip-types scripts/gen-schema.ts [--check]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { SCHEMA_TARGETS, jsonSchemaFor } from "../src/schemas.ts";

const check = process.argv.includes("--check");
mkdirSync("schema", { recursive: true });
let stale = false;
for (const t of SCHEMA_TARGETS) {
  const text = JSON.stringify(jsonSchemaFor(t.schema, t.title), null, 2) + "\n";
  if (check) {
    let current = "";
    try {
      current = readFileSync(t.path, "utf8");
    } catch {
      /* missing counts as stale */
    }
    if (current !== text) {
      console.error(`${t.path} is out of date; run pnpm schema`);
      stale = true;
    }
  } else {
    writeFileSync(t.path, text);
    console.log(`wrote ${t.path}`);
  }
}
if (stale) process.exit(1);
