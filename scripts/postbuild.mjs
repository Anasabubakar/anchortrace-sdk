import { chmodSync, existsSync } from "node:fs";
const cli = "dist/cli.js";
if (existsSync(cli)) chmodSync(cli, 0o755);
