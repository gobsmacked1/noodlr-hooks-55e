// Cut two capability caches down to the wordings BOTH of them actually answered, so a before/after
// census compares like with like.
//
//   npm run census:subset -- --before <dir> --after <dir> --out <dir> [--fresh-hours 3]
//
// It writes `<out>/before/` and `<out>/after/`, each holding the same id set, ready for
// `census:yield` to be run over both.
//
// WHY THIS EXISTS RATHER THAN A FLAG ON `census:yield`. Two independent things make the raw
// aggregates incomparable, and both were live on the first real run:
//
// 1. THE POPULATION GREW. A full-world recompile does not re-read a fixed set — this world went from
//    223 cached wordings to 1,038, because the compiler is cache-first and had only ever run on
//    scenes somebody opened. Comparing aggregates would report a change in the CORPUS as a change in
//    the COMPILER: `other` at 21.6% of 631 rules and at 21.6% of three thousand are the same finding
//    and different numbers.
// 2. SOME ENTRIES WERE NOT RE-READ AT ALL, AND THEY DO NOT SAY SO. `recompileWorld` asks, validates,
//    and only THEN stands the old descriptor down — which is the right order, because clear-then-ask
//    trades a working cache for a provider outage. The consequence is that a failed request leaves the
//    PREVIOUS answer in place, indistinguishable from a fresh one except by its timestamp. On the
//    v0.7.2 run 62 wordings died on an HTTP 403 and a further 16 were never asked about (the collector
//    declines them now, or their prose is no longer on a readable sheet). All 78 would have been
//    counted as new answers. **That is the failure this script exists to prevent: it would have
//    reported a third of the old doctrine as the new one, in the reassuring direction.**
//
// So freshness is a hard filter, not a nicety, and the id set is the INTERSECTION rather than the
// before-set: an id is kept only when the after-cache holds an entry compiled inside `--fresh-hours`.
//
// It is a separate script deliberately. `census-yield.mjs` is the instrument, and editing an instrument
// in the middle of the measurement it is taking is the fault its own header records twice (a census
// carrying its own copy of a predicate measures its own copy). This touches the INPUT and leaves the
// counting alone, so both runs are demonstrably the same code over different populations.
//
// The key is the capability id, which is the normalized prose hash — so an id present in both caches is
// the SAME WORDING read twice, which is exactly the comparison wanted. A wording whose prose changed
// between the runs hashes differently and is correctly excluded rather than silently compared.

import { readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
function opt(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
}

const beforeDir = opt("before");
const afterDir = opt("after");
const outDir = opt("out");
const freshHours = Number(opt("fresh-hours", "3"));

if (!beforeDir || !afterDir || !outDir) {
  console.error(
    "usage: node scripts/subset-cache.mjs --before <dir> --after <dir> --out <dir> [--fresh-hours 3]",
  );
  process.exit(1);
}

/** Every shard in a cache directory, with its capabilities indexed by id. */
function read(dir) {
  const shards = new Map();
  const byId = new Map();
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const shard = JSON.parse(readFileSync(join(dir, file), "utf8"));
    const caps = shard.capabilities ?? [];
    shards.set(file, { shard, caps });
    for (const cap of caps) byId.set(cap.id, cap);
  }
  return { shards, byId };
}

/** Write a cache directory holding only `keep`, preserving the source's sharding. */
function writeSubset(dir, { shards }, keep) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  let written = 0;
  for (const [file, { shard, caps }] of shards) {
    const kept = caps.filter((cap) => keep.has(cap.id));
    written += kept.length;
    writeFileSync(join(dir, file), JSON.stringify({ ...shard, capabilities: kept }, null, 2), "utf8");
  }
  return written;
}

const before = read(beforeDir);
const after = read(afterDir);

const cutoff = Date.now() - freshHours * 3_600_000;
// A missing timestamp counts as stale. Conservative in the one direction that matters: excluding a
// fresh answer costs sample size, including a stale one costs the measurement.
const fresh = (cap) => Number(cap?.compiledBy?.at ?? 0) >= cutoff;

const keep = new Set();
const stale = [];
const absent = [];
for (const [id, cap] of before.byId) {
  const now = after.byId.get(id);
  if (!now) absent.push(cap);
  else if (!fresh(now)) stale.push(now);
  else keep.add(id);
}

const b = writeSubset(join(outDir, "before"), before, keep);
const a = writeSubset(join(outDir, "after"), after, keep);

console.log(`before: ${before.byId.size} in ${beforeDir}`);
console.log(`after:  ${after.byId.size} in ${afterDir}`);
console.log(`\ncomparable: ${keep.size} wording(s) present in both and re-read in the last ${freshHours}h`);
console.log(`  wrote ${b} to ${join(outDir, "before")}`);
console.log(`  wrote ${a} to ${join(outDir, "after")}`);

// Named rather than counted. "Not re-read" and "gone" are different things with different causes, and
// a run where the stale list is large is a run whose recompile did not finish.
if (stale.length) {
  console.log(`\nEXCLUDED - STILL THE OLD DESCRIPTOR (${stale.length}). The recompile did not answer for`);
  console.log("these: the request failed, or the collector no longer asks about the wording.");
  for (const cap of stale) console.log(`  ${cap.id}  ${cap.label ?? ""}`);
}
if (absent.length) {
  console.log(`\nEXCLUDED - IN THE BEFORE-CACHE AND NOT THE AFTER (${absent.length}): prose edited,`);
  console.log("item deleted, or pruned since.");
  for (const cap of absent) console.log(`  ${cap.id}  ${cap.label ?? ""}`);
}
