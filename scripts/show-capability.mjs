// Print one capability as the executor will read it, i.e. after the repair.
//
// Usage: node scripts/show-capability.mjs <dir-of-shard-json> <label-substring>
//
// Exists because the two bugs this repair closes were both reported as behaviour ("the troll heals
// through fire", "the limbs come off at full health") and both had to be diagnosed by reading what the
// runtime would do with a stored descriptor. Reading the shard by hand answers the wrong question: it
// shows what was compiled, not what runs.

import { build } from "esbuild";
import { readdirSync, readFileSync, rmSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const [dir, needle] = process.argv.slice(2);
if (!dir || !needle) {
  console.error("usage: node scripts/show-capability.mjs <dir-of-shard-json> <label-substring>");
  process.exit(1);
}

const out = mkdtempSync(join(tmpdir(), "noodlr-show-"));
try {
  await build({
    entryPoints: [resolve("src/integration/capability.ts")],
    outfile: join(out, "capability.mjs"),
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node20",
    logLevel: "warning",
  });
  const { normalizeCapability } = await import(pathToFileURL(join(out, "capability.mjs")).href);

  for (const name of readdirSync(dir).filter((n) => n.endsWith(".json"))) {
    const shard = JSON.parse(readFileSync(join(dir, name), "utf8"));
    for (const cap of shard.capabilities ?? []) {
      if (!String(cap.label ?? "").toLowerCase().includes(needle.toLowerCase())) continue;
      const { capability, notes } = normalizeCapability(cap);
      console.log(`=== ${cap.label}  [${cap.id}]  status: ${cap.status}`);
      for (const note of notes) console.log(`    repaired: ${note}`);
      console.log(JSON.stringify(capability.rules, null, 2));
      console.log("");
    }
  }
} finally {
  rmSync(out, { recursive: true, force: true });
}
