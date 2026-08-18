// How old a reading is, and against which ruleset it was made.
//
// A cached descriptor is an interpretation of one wording, and the wording is not the only thing that
// can move. The vocabulary the compiler answers in has a schema; the game system whose numbers the
// rules describe has a version; Foundry itself has a version. A descriptor read against dnd5e 5.3.3
// says nothing about 6.0, and the cache had no way to say which it was read against — `compiledBy`
// carried the model, the timestamp and a schema number that NOTHING EVER LOOKED AT.
//
// WHAT THIS DOES NOT DO IS SPEND MONEY (user's decision, 2026-08-17, choosing this over automatic
// eviction on a version bump). The obvious design is to evict on a mismatch, and it is wrong twice
// over:
//
//   * IT IS A BILL NOBODY AGREED TO. The reference world holds 1,022 wordings that cost 87 minutes and
//     real credit. A dnd5e patch release is a routine event; a patch release that silently starts an
//     87-minute unattended spend at the next scene load is not something a GM can consent to after the
//     fact. `recompileWorld` is deliberately called by no hook for exactly this reason.
//   * IT WOULD MOSTLY BE WRONG. The overwhelming majority of these readings are of prose that did not
//     change and whose meaning did not change. Version equality is a proxy for staleness so coarse that
//     it would re-buy a thousand identical answers to catch the handful that genuinely moved.
//
// So drift is REPORTED — one line per capability on the sheet, a census at the console — and the GM
// decides. Two responses are available and both are already built: Recompile spends one call and buys a
// fresh reading, and Lock says "I have looked at this and it is still right", which restamps it for
// free. That is the same shape as every other judgement in this module: state the position, name who
// owns it, and let the human act.
//
// SCHEMA IS THE ONE AXIS THAT COULD JUSTIFY A REFUSAL, AND IT STILL DOES NOT GET ONE. A schema bump
// means the descriptor's SHAPE may be unreadable, which sounds like grounds for failing closed — but a
// blanket refusal on a bump would switch every rule in the world off at once, silently, which is the
// exact failure this repo documents at length under "a silent stand-aside is a bug report waiting to
// happen". The existing machinery already covers it per rule and with a reason: `normalizeCapability`
// repairs known shape drift on the way in, `validateCapability` reports an unrecognised key, and
// `isExecutable` refuses anything it cannot read and says so on the sheet. Enforcing the schema here
// means READING it — it had never been read at all — and counting it, not vetoing on it.

import { MODULE_ID, log } from "../constants";
import { worldStamp, type WorldStamp } from "../util/provenance";
import * as cache from "./cache";
import { CAPABILITY_SCHEMA, type Capability } from "../integration/capability";

/** What a reading was made against: the world's two versions plus the vocabulary it answered in. */
export interface Provenance extends WorldStamp {
  schema: number;
}

/** This world and this build, as a reading made now would be stamped. */
export function currentProvenance(): Provenance {
  return { ...worldStamp(), schema: CAPABILITY_SCHEMA };
}

export type DriftReason =
  /** Compiled to a vocabulary older than the one the executor reads. */
  | "schema"
  /** Compiled under a different game system, or a different version of one. */
  | "system"
  /** Compiled under a different Foundry. */
  | "foundry"
  /** Compiled before this stamp existed, so there is nothing to compare. */
  | "unstamped";

export interface Drift {
  id: string;
  label: string;
  status: string;
  reasons: DriftReason[];
  /** What it was read against, for a human to read. Empty when unstamped. */
  was: string;
}

export interface AgeReport {
  now: Provenance;
  cached: number;
  /** Entries whose stamp matches this world on every axis. */
  current: number;
  drift: Drift[];
  counts: Record<DriftReason, number>;
}

/**
 * Which axes moved, if any.
 *
 * Pure, and exported for the test, because the two judgements worth pinning are both easy to get
 * backwards: an UNSTAMPED entry must not be reported as a version mismatch (there is no version to
 * mismatch, and calling it one invents a fact), and a stamp NEWER than the current schema is not
 * drift — a cache written by a later build and read by an older one is a downgrade, and the older
 * build's normaliser is the thing that would have to cope, not a report.
 */
export function driftOf(capability: Capability, now: Provenance): DriftReason[] {
  const stamp = capability.compiledIn;
  const schema = Number(capability.compiledBy?.schema ?? 0);
  const reasons: DriftReason[] = [];
  // A schema is comparable on its own even with no environment stamp, so it is tested first and
  // independently: an entry from before `compiledIn` existed can still be behind the vocabulary.
  if (schema > 0 && schema < now.schema) reasons.push("schema");
  if (!stamp?.system && !stamp?.foundry) {
    reasons.push("unstamped");
    return reasons;
  }
  if (now.system && String(stamp.system ?? "") !== now.system) reasons.push("system");
  if (now.foundry && String(stamp.foundry ?? "") !== now.foundry) reasons.push("foundry");
  return reasons;
}

/** What a reading was made against, for a human to read. Empty when nothing was ever stamped. */
export function describeStamp(capability: Capability): string {
  const stamp = capability.compiledIn;
  if (!stamp) return "";
  const parts = [stamp.system, stamp.foundry ? `Foundry ${stamp.foundry}` : ""].filter(Boolean);
  const schema = Number(capability.compiledBy?.schema ?? 0);
  if (schema) parts.push(`vocabulary ${schema}`);
  return parts.join(", ");
}

/**
 * Every cached reading, sorted by whether it still matches this world.
 *
 * Warms the cache first for the reason {@link import("./hygiene").findOrphans} does: an unwarmed cache
 * is an empty `Map`, and a census over one reports that everything is current — the reassuring answer,
 * from a measurement never taken.
 */
export async function findDrift(): Promise<AgeReport> {
  await cache.warm();
  const now = currentProvenance();
  const drift: Drift[] = [];
  const counts: Record<DriftReason, number> = { schema: 0, system: 0, foundry: 0, unstamped: 0 };
  let current = 0;
  for (const capability of cache.all()) {
    const reasons = driftOf(capability, now);
    if (reasons.length === 0) {
      current++;
      continue;
    }
    for (const reason of reasons) counts[reason]++;
    drift.push({
      id: capability.id,
      label: capability.label,
      status: String(capability.status ?? "compiled"),
      reasons,
      was: describeStamp(capability),
    });
  }
  return { now, cached: cache.size(), current, drift, counts };
}

/**
 * Diagnostics: what the cache was read against.
 *
 * Printed flat, one line per group rather than per capability — a thousand-line block is not a report,
 * and the interesting number here is how many share a stamp rather than which ones they are. The
 * per-capability answer is on the capability sheet, beside the buttons that act on it.
 */
export async function surveyCacheAge(): Promise<AgeReport> {
  const report = await findDrift();
  const lines: string[] = [
    `${MODULE_ID} cache provenance`,
    `  world is ${report.now.system || "?"}, Foundry ${report.now.foundry || "?"}, ` +
      `vocabulary ${report.now.schema}`,
    `  cached ${report.cached}; matching this world ${report.current}; drifted ${report.drift.length}`,
  ];
  if (report.drift.length === 0) {
    lines.push("  nothing to review");
  } else {
    // Grouped by the stamp they carry, so "everything was read under 5.3.2" is one line.
    const groups = new Map<string, number>();
    for (const row of report.drift) {
      const key = `[${row.reasons.join("+")}] ${row.was || "no stamp (compiled before v0.7.4)"}`;
      groups.set(key, (groups.get(key) ?? 0) + 1);
    }
    for (const [key, count] of [...groups].sort((a, b) => b[1] - a[1])) {
      lines.push(`  ${count} × ${key}`);
    }
    lines.push(
      "  nothing is spent on this. Recompile a row on the capability sheet to buy a fresh reading,",
      "  or Lock it to record that you have checked it — either one clears the drift for that row.",
    );
  }
  log(lines.join("\n"));
  return report;
}
