// Where compiled capabilities live between sessions.
//
// Compiling costs a model call, so it must happen once per DISTINCT WORDING and never again. The
// corpus measured how much that is worth: across 436 SRD actors, 4,661 features reduced to 1,387
// distinct wordings, and one trait's text was shared by 270 creatures. Traits are templated with
// `[[lookup @name lowercase]]` rather than naming their owner, so the same Pack Tactics is
// byte-identical everywhere it appears. Hence the cache key is the prose, not the creature.
//
// FILE-BACKED, NOT A WORLD SETTING. Foundry ships every world setting to every connected client, and
// this payload is of interest to exactly one of them. It follows RAG Lite's proven path in `noodlr`
// (`FilePicker.upload` to write, a plain routed fetch to read), with two deliberate differences:
//
//   * SHARDED by the first hex digit of the key. One file rewritten on every store makes a scene load
//     that compiles forty features an O(n) upload forty times over.
//   * FLUSHED, not written through per store. Same reason. `put` marks a shard dirty and `flush`
//     settles them; the collector awaits one flush at the end of a batch, so nothing is lost and the
//     upload count is bounded by the number of shards touched rather than the number of compiles.

import { MODULE_ID, debug, log, warn } from "../constants";
import { isPrimaryGM } from "../util/gm";
import { worldStamp } from "../util/provenance";
import type { Capability } from "../integration/capability";
import { exportable, normalizeCapability } from "../integration/capability";

/**
 * Where THIS world's compiled capabilities live. WORLD-SCOPED SINCE v0.7.4.
 *
 * Before that it was `assets/<module>/capabilities`, and `assets/` is a sibling of `worlds/` rather
 * than a child of any one of them — so every world on a host shared one cache. That reads as an
 * economy, since templated trait prose is byte-identical across creatures AND across worlds, and it
 * carries three faults that outweigh it:
 *
 *   * TWO OPEN WORLDS CLOBBER EACH OTHER, silently. `writeShard` serialises a whole shard from this
 *     client's `memory`, so world B flushing shard 3 overwrites everything world A had added to it.
 *     Nothing guarded that, and the loss shows up as a descriptor simply not being there next warm.
 *   * `pruneOrphans({includeAbsent: true})` in one world would delete another's wordings, because "no
 *     sheet here produces this" is answered per world. Guarded only by there being no caller.
 *   * A world backup does not carry it, so restoring a world restores an empty cache.
 *
 * NOTHING IS INHERITED FROM THE OLD SHARED TREE, and that was a deliberate call (user, 2026-08-17)
 * against the obvious migration. A one-time read of a cache belonging to some other campaign — a
 * different ruleset, different modules, different creatures — is a plausible route to a descriptor
 * nobody in this world asked for, and the failure would surface as a rule behaving oddly weeks later
 * rather than as anything traceable to an adoption. Re-buying a wording costs a model call once;
 * chasing a poisoned cache costs days. `exportAll`/`importAll` remain the way to share on purpose.
 *
 * Not a setting: there is no scenario where a GM needs it somewhere else, and a movable path that
 * silently recreates itself when moved would be worse than none. `worlds/<id>/assets/` is core's own
 * home for a world's media — it exists before we touch it — and a named file under it is fetchable
 * over the routed URL exactly like one under `assets/`, both verified against a live server.
 *
 * `null` when the world id cannot be read. There is no fallback on purpose: the only path available
 * would be the old shared tree, which is the thing being retired, and a path built from `undefined`
 * would scatter shards into a folder literally named "undefined". With no world there is also nothing
 * to cache FOR, so the honest answer is to do nothing and say so.
 */
function folder(): string | null {
  const world = (game as any)?.world?.id;
  return world ? `worlds/${world}/assets/${MODULE_ID}/capabilities` : null;
}

/** 16 shards, so the SRD bestiary's 1,387 wordings land ~87 to a file. */
const SHARDS = 16;

const CACHE_FORMAT = 1;

interface Shard {
  format: number;
  capabilities: Capability[];
}

const memory = new Map<string, Capability>();
const dirty = new Set<string>();
let warmed = false;
let warming: Promise<void> | null = null;

/**
 * THE ONE DOOR INTO `memory`, and the reason it exists rather than each caller normalising.
 *
 * `normalizeCapability` folds a compiler's aliases and free text into the shape the executor reads. Doing
 * that here — on a shard read, a fresh compile, a GM edit and an import alike — means no consumer
 * downstream ever has to know a repair happened, and there is exactly one answer to "what shape is a
 * cached rule in". It is idempotent, so the compile path validating a normalised copy and then storing
 * through here costs nothing.
 *
 * `stamp` records what the world was when a reading was MADE HERE, and the two callers that pass it are
 * exactly the two where somebody just decided something: a fresh compile and a GM's own save. Reading a
 * shard must not restamp, or every warm would claim the whole cache was read today and `capability/age.ts`
 * could never report anything. An import must not either — an imported descriptor was compiled on
 * somebody else's world, and its own stamp is the honest account of that, drift and all.
 *
 * Notes are returned rather than logged: a warm read of a cache written before the repair existed
 * produces hundreds of them, and a line each would bury the summary that is the actually useful message.
 */
function admit(capability: Capability, notes: string[], stamp = false): Capability {
  const { capability: fixed, notes: found } = normalizeCapability(capability);
  for (const note of found) notes.push(`${capability.id} ${note}`);
  memory.set(fixed.id, stamp ? { ...fixed, compiledIn: worldStamp() } : fixed);
  return fixed;
}

/** Say what was repaired: the count out loud, the detail behind the debug flag. */
function reportRepairs(what: string, notes: string[]): void {
  if (notes.length === 0) return;
  log(`capability cache: repaired ${notes.length} field(s) while ${what} (debug logging lists them)`);
  for (const note of notes) debug(`capability repair: ${note}`);
}

// ---- Keying ---------------------------------------------------------------------------------

/**
 * Normalise prose before hashing, so a rule that differs only in markup or spacing compiles once.
 *
 * This is where the 70% dedup rate comes from, and it has to be conservative: fold whitespace and
 * strip tags, but never touch words or numbers. "15 or more Slashing damage" and "5 or more Slashing
 * damage" are different rules and must stay different keys.
 */
export function normalizeProse(prose: string): string {
  return String(prose ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * A 64-bit key, built from two independent 32-bit hashes.
 *
 * One 32-bit hash was the obvious choice and is not good enough here: at ten thousand cached wordings
 * the birthday bound gives better than a one-in-a-hundred chance of a collision, and a collision here
 * does not lose data — it hands one creature another creature's rules, which would surface as a
 * monster with somebody else's abilities and no error anywhere. Sixty-four bits puts that at one in
 * 10^11 and costs a second pass over a short string.
 */
export function proseHash(prose: string): string {
  const text = normalizeProse(prose);
  let djb2 = 5381;
  let fnv = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    djb2 = ((djb2 << 5) + djb2 + code) | 0;
    fnv ^= code;
    fnv = (fnv + ((fnv << 1) + (fnv << 4) + (fnv << 7) + (fnv << 8) + (fnv << 24))) | 0;
  }
  const a = (djb2 >>> 0).toString(16).padStart(8, "0");
  const b = (fnv >>> 0).toString(16).padStart(8, "0");
  return `${a}${b}`;
}

/**
 * XOR every nibble of the key rather than reading its first digit.
 *
 * The first digit was the obvious choice and it does not work: djb2's high bits barely move across
 * short, similar inputs, so 400 trait wordings landed in 3 of the 16 buckets. Folding the whole key
 * uses both hashes and spreads them evenly.
 */
function shardOf(id: string): string {
  let acc = 0;
  for (let i = 0; i < id.length; i++) {
    const digit = parseInt(id.charAt(i), 16);
    if (Number.isFinite(digit)) acc ^= digit;
  }
  return (acc % SHARDS).toString(16);
}

// ---- Foundry plumbing -----------------------------------------------------------------------

function filePicker(): any {
  const ns = (foundry as any)?.applications?.apps?.FilePicker;
  return ns ?? (globalThis as any).FilePicker;
}

function routeUrl(path: string): string {
  const getRoute = (foundry as any)?.utils?.getRoute;
  return typeof getRoute === "function" ? getRoute(path) : `/${path}`;
}

async function ensureFolder(dir: string): Promise<void> {
  const fp = filePicker();
  if (!fp?.createDirectory) return;
  // Each segment separately: createDirectory does not create intermediates, and it throws a benign
  // "EEXIST" for one that is already there.
  const parts = dir.split("/");
  let path = "";
  for (const part of parts) {
    path = path ? `${path}/${part}` : part;
    try {
      await fp.createDirectory("data", path, {});
    } catch {
      // Already present, or no permission — the upload below reports the real problem.
    }
  }
}

/** A shard that has never been written is the normal case, not an error worth a console line. */
async function readShard(dir: string, shard: string): Promise<Capability[]> {
  try {
    const resp = await fetch(routeUrl(`${dir}/${shard}.json`), { cache: "no-store" });
    if (!resp.ok) return [];
    const data = JSON.parse(await resp.text()) as Shard;
    return Array.isArray(data?.capabilities) ? data.capabilities : [];
  } catch {
    return [];
  }
}

async function writeShard(dir: string, shard: string): Promise<void> {
  const fp = filePicker();
  if (!fp?.upload)
    throw new Error("FilePicker.upload unavailable (GM upload permission required).");
  const capabilities = [...memory.values()].filter((cap) => shardOf(cap.id) === shard);
  const body: Shard = { format: CACHE_FORMAT, capabilities };
  const file = new File([JSON.stringify(body)], `${shard}.json`, { type: "application/json" });
  await fp.upload("data", dir, file, {}, { notify: false });
}

// ---- The cache ------------------------------------------------------------------------------

/**
 * Load every shard into memory. Idempotent, and safe to await from several places at once — the
 * collector and the capability sheet both want it and neither should trigger a second read.
 */
export async function warm(): Promise<void> {
  if (warmed) return;
  if (warming) return warming;
  warming = (async () => {
    const dir = folder();
    warmed = true;
    if (!dir) {
      log("capability cache: no world id, so nothing is stored or read this session");
      return;
    }
    const shards = Array.from({ length: SHARDS }, (_, i) => i.toString(16));
    const notes: string[] = [];
    const stored = await Promise.all(shards.map((shard) => readShard(dir, shard)));
    for (const capabilities of stored) {
      for (const cap of capabilities) admit(cap, notes);
    }
    log(`capability cache: ${memory.size} compiled`);
    reportRepairs("reading the cache", notes);
  })();
  try {
    await warming;
  } finally {
    warming = null;
  }
}

export function get(id: string): Capability | undefined {
  return memory.get(id);
}

export function has(id: string): boolean {
  return memory.has(id);
}

export function all(): Capability[] {
  return [...memory.values()];
}

export function size(): number {
  return memory.size;
}

/**
 * Store a capability, unless a human has already had the last word on it.
 *
 * `locked` is the load-bearing status: once a GM has corrected a bad compile, a model upgrade, a
 * cache miss or a re-scan must never silently undo that work. `rejected` is treated the same way for
 * the same reason — a GM who threw a hallucinated rule away should not have it come back next session.
 */
export function put(capability: Capability): boolean {
  const existing = memory.get(capability.id);
  if (existing && (existing.status === "locked" || existing.status === "rejected")) return false;
  const notes: string[] = [];
  admit(capability, notes, true);
  reportRepairs(`storing "${capability.label}"`, notes);
  dirty.add(shardOf(capability.id));
  return true;
}

/**
 * A GM edit. Always wins, including over a lock, because this IS the human having the last word.
 *
 * Restamped, which is what makes Lock a free answer to version drift: a GM who has read a rule and
 * frozen it has certified it against the ruleset in front of them, and that is worth exactly as much as
 * a fresh compile without costing a call. See `capability/age.ts`.
 */
export function putOverride(capability: Capability): void {
  const notes: string[] = [];
  admit(capability, notes, true);
  reportRepairs(`saving "${capability.label}"`, notes);
  dirty.add(shardOf(capability.id));
}

export function remove(id: string): boolean {
  if (!memory.delete(id)) return false;
  dirty.add(shardOf(id));
  return true;
}

/** Persist every shard touched since the last flush. Returns how many files were written. */
export async function flush(): Promise<number> {
  if (dirty.size === 0) return 0;
  if (!isPrimaryGM()) {
    // Several GMs may be connected and all of them run the same hooks. One writer, or they overwrite
    // each other's shards with their own view of memory.
    dirty.clear();
    return 0;
  }
  const dir = folder();
  if (!dir) {
    // No world, no folder. Cleared rather than left pending: retrying every flush for a path that
    // cannot be built would warn for ever, and the descriptors still serve this session from memory.
    dirty.clear();
    return 0;
  }
  const shards = [...dirty];
  dirty.clear();
  await ensureFolder(dir);
  let written = 0;
  for (const shard of shards) {
    try {
      await writeShard(dir, shard);
      written++;
    } catch (err) {
      // Put it back, so the next flush retries rather than losing the compile silently.
      dirty.add(shard);
      warn(`could not persist capability shard ${shard}:`, err);
    }
  }
  return written;
}

/** Drop everything, on disk as well as in memory. The GM's "recompile the world" button. */
export async function clear(): Promise<void> {
  const shards = new Set([...memory.values()].map((cap) => shardOf(cap.id)));
  memory.clear();
  for (const shard of shards) dirty.add(shard);
  await flush();
}

// ---- Sharing --------------------------------------------------------------------------------

export interface CacheExport {
  format: number;
  exportedAt: number;
  capabilities: Capability[];
}

/**
 * A shareable cache.
 *
 * Descriptors are mechanics and mechanics are not copyrightable; the prose they were compiled from is
 * a different matter entirely. Stripping it here is the same boundary `assertNoQuotes` enforces at the
 * other end of the corpus pipeline, and it is what lets one GM publish a compiled bestiary that
 * everyone else can drop in without owning the book it came from.
 */
export function exportAll(): CacheExport {
  return {
    format: CACHE_FORMAT,
    exportedAt: Date.now(),
    capabilities: all()
      .filter((cap) => cap.status !== "rejected")
      .map(exportable),
  };
}

export interface ImportReport {
  added: number;
  updated: number;
  skipped: number;
}

/**
 * Merge someone else's compiled cache in.
 *
 * Imported entries never beat local ones a human has touched, and they never carry prose even if the
 * file offers some — an import is not a route around the export boundary.
 */
export function importAll(payload: unknown): ImportReport {
  const report: ImportReport = { added: 0, updated: 0, skipped: 0 };
  const incoming = (payload as CacheExport)?.capabilities;
  if (!Array.isArray(incoming)) return report;

  const notes: string[] = [];
  for (const raw of incoming) {
    if (!raw?.id || !Array.isArray(raw.rules)) {
      report.skipped++;
      continue;
    }
    const existing = memory.get(raw.id);
    if (existing && existing.status !== "compiled") {
      report.skipped++;
      continue;
    }
    const { prose: _prose, ...rest } = raw;
    admit({ ...rest, status: "compiled" }, notes);
    dirty.add(shardOf(raw.id));
    if (existing) report.updated++;
    else report.added++;
  }
  reportRepairs("importing a shared cache", notes);
  return report;
}

/** Test seam. Never called in Foundry. */
export function __reset(): void {
  memory.clear();
  dirty.clear();
  warmed = false;
  warming = null;
}
