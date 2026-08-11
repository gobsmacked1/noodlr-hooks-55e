// Test runner.
//
// The source is TypeScript with extensionless relative imports, which Node's own type stripping
// cannot resolve, so each test file is bundled first and `node --test` is pointed at the output.
// esbuild is already a devDependency and this is the whole cost of having tests at all.
//
// Only pure logic is testable this way: anything reading a Foundry global has nothing to read. That
// is a useful constraint rather than a limitation — it keeps module-level code free of globals, which
// is what lets the bundle import at all.

import { build } from "esbuild";
import { readdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const outdir = join(here, "..", ".test-build");

rmSync(outdir, { recursive: true, force: true });

const entryPoints = readdirSync(here)
  .filter((name) => name.endsWith(".test.ts"))
  .map((name) => join(here, name));

if (entryPoints.length === 0) {
  console.log("no test files");
  process.exit(0);
}

await build({
  entryPoints,
  outdir,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  sourcemap: "inline",
  packages: "external",
  logLevel: "warning",
});

// Explicit files, not the directory: Node 26 stopped treating a directory argument as a search root
// and tries to load it as a module instead.
const built = readdirSync(outdir)
  .filter((name) => name.endsWith(".js"))
  .map((name) => join(outdir, name));

const result = spawnSync(process.execPath, ["--test", ...built], { stdio: "inherit" });
process.exit(result.status ?? 1);
