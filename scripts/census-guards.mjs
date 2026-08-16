// What the repair recovers, measured against a real cache rather than against a fixture.
//
// The finding this exists to prove: a compiler filed guards under `conditions`, plural, and the
// executor reads `condition`, singular, so a majority of the guards an operator had already paid for
// were being discarded silently. A fixture can show the normaliser works; only the live cache can say
// how much of it was broken, and that number is the go/no-go on whether the repair was worth shipping
// without a recompile.
//
// Usage: node scripts/census-guards.mjs <dir-of-shard-json>
//
// It bundles the REAL `normalizeCapability` rather than reimplementing it, for the same reason the
// prose census bundles the real scrubber: a census with its own copy of the predicate is a census of
// the copy. esbuild is already a devDependency.

import { build } from "esbuild";
import { readdirSync, readFileSync, rmSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: node scripts/census-guards.mjs <dir-of-shard-json>");
  process.exit(1);
}

const out = mkdtempSync(join(tmpdir(), "noodlr-census-"));
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
  const { normalizeCapability, normalizeDamageWindow, validateCapability } = await import(
    pathToFileURL(join(out, "capability.mjs")).href
  );

  const caps = [];
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".json"))) {
    const shard = JSON.parse(readFileSync(join(dir, name), "utf8"));
    caps.push(...(shard.capabilities ?? []));
  }

  const tally = {
    capabilities: caps.length,
    rules: 0,
    guardsRead: 0,
    guardsRecovered: 0,
    rulesRecovered: 0,
    windowsCanonical: 0,
    windowsRepaired: 0,
    windowsUnreadable: 0,
    unknownKeys: new Map(),
  };
  const spellings = new Map();
  const recovered = [];

  for (const cap of caps) {
    const before = (cap.rules ?? []).reduce((n, r) => n + (r.condition?.length ?? 0), 0);
    const { capability: after, notes } = normalizeCapability(cap);
    const now = (after.rules ?? []).reduce((n, r) => n + (r.condition?.length ?? 0), 0);

    tally.rules += after.rules?.length ?? 0;
    tally.guardsRead += before;
    if (now > before) {
      tally.guardsRecovered += now - before;
      tally.rulesRecovered++;
      recovered.push(`${cap.label} (+${now - before})`);
    }

    for (const rule of after.rules ?? []) {
      for (const guard of rule.condition ?? []) {
        if (guard?.kind !== "damage_taken") continue;
        const raw = String(guard.window ?? "");
        spellings.set(raw, (spellings.get(raw) ?? 0) + 1);
      }
    }
    for (const note of notes) {
      const unknown = /unrecognised key "([^"]+)"/.exec(note);
      if (unknown) tally.unknownKeys.set(unknown[1], (tally.unknownKeys.get(unknown[1]) ?? 0) + 1);
    }
    // A repaired capability must validate, or the repair has produced something unrunnable.
    const check = validateCapability(cap);
    if (!check.ok) console.log(`INVALID after repair: ${cap.label}: ${check.errors.join("; ")}`);
  }

  for (const [raw, count] of spellings) {
    const canonical = normalizeDamageWindow(raw);
    if (canonical === null) tally.windowsUnreadable += count;
    else if (canonical === raw) tally.windowsCanonical += count;
    else tally.windowsRepaired += count;
  }

  console.log(`capabilities  ${tally.capabilities}`);
  console.log(`rules         ${tally.rules}`);
  console.log("");
  console.log(`guards the executor read BEFORE the repair   ${tally.guardsRead}`);
  console.log(`guards recovered by the repair               ${tally.guardsRecovered}`);
  console.log(`rules that gained at least one guard         ${tally.rulesRecovered}`);
  console.log("");
  console.log("damage_taken windows, after the repair:");
  console.log(`  already canonical  ${tally.windowsCanonical}`);
  console.log(`  read from prose    ${tally.windowsRepaired}`);
  console.log(`  UNREADABLE         ${tally.windowsUnreadable}`);
  for (const [raw, count] of [...spellings].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(normalizeDamageWindow(raw) ?? "??").padEnd(17)} x${count}  "${raw}"`);
  }
  if (tally.unknownKeys.size) {
    console.log("");
    console.log("unrecognised rule keys (warned, never fatal):");
    for (const [key, count] of [...tally.unknownKeys].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${key} x${count}`);
    }
  }
  if (recovered.length) {
    console.log("");
    console.log(`capabilities repaired (${recovered.length}):`);
    for (const line of recovered.sort()) console.log(`  ${line}`);
  }
} finally {
  rmSync(out, { recursive: true, force: true });
}
