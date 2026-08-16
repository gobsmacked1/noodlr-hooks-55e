// Cached descriptors that nothing can use any more.
//
// The cache is keyed on prose and nothing has ever removed an entry whose prose stopped arriving. Two
// things make that a problem rather than harmless clutter, and only one of them is about disk space.
//
// A descriptor that can never bind is INVISIBLE ROT. v0.6.3 taught `featuresOf` to decline the 2024
// glossary items — `Hide`, `Dash`, `Influence`, `Unarmed Strike` — which is correct and which means the
// entries compiled from them before that release sit in the cache forever, badged `active` on the
// capability sheet, counted in every survey, and reachable by nothing. Two audit documents read exactly
// those specimens as evidence that the glossary skip was not working. It was working; the cache was not
// swept. **An unswept cache does not merely lie about itself, it makes every measurement taken against
// it lie**, which is why this ships before the yield baseline rather than after.
//
// THE TWO REASONS ARE NOT EQUALLY CERTAIN, and separating them is the whole design. A wording the
// collector now DECLINES can never bind on any sheet in any world — that is a property of our own code,
// and pruning it is safe. A wording that merely does not appear on any sheet we can see is a guess: the
// creature may live in a compendium this sweep does not walk, or be one scene away from being dragged
// back in. So the first is offered for pruning and the second is reported and left alone.
//
// NOTHING HERE RUNS ON ITS OWN. A sweep that deleted on scene load would eventually delete a
// compendium creature's descriptor the GM had paid for, and it would do it quietly. The GM presses the
// button, having read what it would take.

import { MODULE_ID, log, warn } from "../constants";
import { isPrimaryGM } from "../util/gm";
import * as cache from "./cache";
import { featuresOf, type Declined } from "./collect";
import { readableActors } from "./sheets";

/** Why a cached descriptor is unreachable, and how sure we are. */
export type OrphanReason =
  /** The collector declines this wording wherever it appears. Certain, and safe to prune. */
  | "declined"
  /** No sheet this sweep can see produces it. Probable, and deliberately not pruned. */
  | "absent";

export interface Orphan {
  id: string;
  label: string;
  reason: OrphanReason;
  /** For `declined`, the collector's own sentence. Empty for `absent`. */
  why: string;
  status: string;
}

export interface HygieneReport {
  /** Every actor whose sheet was read: world actors plus each scene's unlinked tokens. */
  actors: number;
  cached: number;
  /** Distinct wordings some readable sheet still produces. */
  live: number;
  orphans: Orphan[];
  /** `declined` orphans only — what a prune would remove. */
  prunable: number;
}

/**
 * Sort cached entries into reachable and not, given what the sheets produced.
 *
 * Split out from {@link findOrphans} so it can be pinned by a test: the rest of this file needs a
 * populated `game` and the ONE judgement here that can be got backwards destructively is which of
 * `live` and `declined` wins.
 */
export function classifyCache(
  cached: readonly { id: string; label: string; status?: string }[],
  live: ReadonlySet<string>,
  declined: ReadonlyMap<string, Declined>,
): Orphan[] {
  const orphans: Orphan[] = [];
  for (const capability of cached) {
    // LIVE WINS OVER DECLINED, and the order is the whole safety property. One wording can be declined
    // on a character sheet (where it is the PHB glossary item) and be a real ability on a monster:
    // "Unarmed Strike" is exactly that. Binding anywhere is enough to keep it, so a descriptor is only
    // an orphan when NOTHING produced it. Reading `declined` first deletes a working descriptor in
    // order to tidy up its duplicate.
    if (live.has(capability.id)) continue;
    const refused = declined.get(capability.id);
    orphans.push({
      id: capability.id,
      label: capability.label,
      reason: refused ? "declined" : "absent",
      why: refused?.why ?? "",
      status: String(capability.status ?? "compiled"),
    });
  }
  return orphans;
}

/**
 * What the cache holds that nothing can reach.
 *
 * Reads sheets and the cache and writes neither, so it is safe to call from a console at any time —
 * which is the point, because its answer is what a GM decides a prune on.
 */
export function findOrphans(): HygieneReport {
  const live = new Set<string>();
  const declinedIds = new Map<string, Declined>();
  const actors = readableActors();
  for (const actor of actors) {
    const declined: Declined[] = [];
    for (const feature of featuresOf(actor, declined)) live.add(feature.id);
    for (const row of declined) {
      if (row.id && !declinedIds.has(row.id)) declinedIds.set(row.id, row);
    }
  }

  const orphans = classifyCache(cache.all(), live, declinedIds);
  return {
    actors: actors.length,
    cached: cache.size(),
    live: live.size,
    orphans,
    prunable: orphans.filter((o) => o.reason === "declined").length,
  };
}

export interface PruneReport {
  removed: number;
  /** Locked or rejected entries left alone, even where they are certainly unreachable. */
  kept: number;
  written: number;
}

/**
 * Remove the certainly-unreachable entries.
 *
 * `declined` only unless `includeAbsent` is passed, and that default is the safety property: an
 * `absent` wording may belong to a compendium creature nobody has placed yet, and deleting it costs a
 * model call to get back. `declined` costs nothing to be wrong about, because the collector refuses the
 * item either way.
 *
 * A `locked` or `rejected` entry is kept whatever its reason. Those two statuses mean a human has had
 * the last word, and a sweep that deletes a GM's correction because the monster is off-scene is the
 * one failure worse than the clutter this exists to remove.
 */
export async function pruneOrphans(options?: { includeAbsent?: boolean }): Promise<PruneReport> {
  const report: PruneReport = { removed: 0, kept: 0, written: 0 };
  if (!isPrimaryGM()) {
    warn("only the primary GM may prune the capability cache.");
    return report;
  }
  const { orphans } = findOrphans();
  for (const orphan of orphans) {
    if (orphan.reason === "absent" && !options?.includeAbsent) continue;
    if (orphan.status === "locked" || orphan.status === "rejected") {
      report.kept++;
      continue;
    }
    if (cache.remove(orphan.id)) report.removed++;
  }
  if (report.removed) report.written = await cache.flush();
  log(
    `capability cache: pruned ${report.removed} unreachable descriptor(s)` +
      (report.kept ? `, kept ${report.kept} a human had edited` : ""),
  );
  return report;
}

/**
 * Diagnostics: what the cache holds that nothing can use.
 *
 * Printed flat, one line per orphan, for the reason recorded in AGENTS.md — a console renders a nested
 * return value as a collapsed `Object { … }`, and the collapsed line is what gets pasted into a report.
 */
export function surveyOrphans(): HygieneReport {
  const report = findOrphans();
  const lines: string[] = [
    `${MODULE_ID} cache hygiene`,
    `  read ${report.actors} sheet(s); ${report.live} wording(s) still produced`,
    `  cached ${report.cached}; unreachable ${report.orphans.length} ` +
      `(${report.prunable} certainly, the rest probably)`,
  ];
  if (report.orphans.length === 0) {
    lines.push("  nothing to prune");
  } else {
    for (const orphan of [...report.orphans].sort((a, b) => a.reason.localeCompare(b.reason))) {
      const note =
        orphan.reason === "declined"
          ? orphan.why
          : "no readable sheet produces it (a compendium creature would look like this too)";
      lines.push(`  [${orphan.reason}] ${orphan.label} — ${note}`);
    }
    lines.push(
      // Spelled `noodlrHooks.` and not `api.`, because this line is read at a browser console where
      // `api` is a ReferenceError. Same trap the standing note in AGENTS.md records.
      `  noodlrHooks.pruneOrphans() removes the ${report.prunable} certain one(s); ` +
        `noodlrHooks.pruneOrphans({includeAbsent: true}) removes all ${report.orphans.length}`,
    );
  }
  log(lines.join("\n"));
  return report;
}
