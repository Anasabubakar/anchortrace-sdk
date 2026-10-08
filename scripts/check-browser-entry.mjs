import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const forbiddenImport = /^(node:|@stellar\/stellar-sdk(?:\/|$))/;

/**
 * Bundles an entry point as browser code and rejects imports that would make
 * the package root unavailable to browser consumers.
 *
 * @param {string} entryPoint
 */
export async function checkBrowserEntry(entryPoint) {
  await build({
    entryPoints: [entryPoint],
    bundle: true,
    format: "esm",
    platform: "browser",
    write: false,
    logLevel: "silent",
    plugins: [
      {
        name: "forbid-node-only-imports",
        setup(build) {
          build.onResolve({ filter: forbiddenImport }, (args) => ({
            errors: [{ text: `Browser entry must not import ${args.path} (imported by ${args.importer || "the entry point"})` }],
          }));
        },
      },
    ],
  });
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const entryPoint = process.argv[2] ?? fileURLToPath(new URL("../src/index.ts", import.meta.url));
  checkBrowserEntry(entryPoint).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
