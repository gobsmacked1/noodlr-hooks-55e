// Can one creature perceive another? The engine, with no policy on top of it.
//
// Extracted from `perception.ts` on 2026-08-16, which had grown two jobs: this question, and the
// separate policy of starting a fight when the answer is yes. The split was forced by a third caller —
// the PLANNER needs the same answer and lives in `tactics/`, which `perception.ts` already imports
// from, so asking it there would have closed an import cycle. It is the right shape regardless: this
// is the one implementation of "can X see Y", and every consumer has to reach the same answer.
//
// THE THREE TRAPS, all verified against core source and all silent when got wrong:
//
//   1. `token.isVisible` and `canvas.visibility.testVisibility` answer a DIFFERENT question — whether
//      the CURRENT USER can see it. Core's method iterates the vision sources initialized on this
//      client and short-circuits to `game.user.isGM` when there are none, so on an automation client
//      it is a very confident "yes" to everything. Neither can be scoped to an arbitrary token.
//   2. An uncontrolled NPC has no vision source on a GM's client at all: `Token#_isVisionSource()`
//      refuses for a GM unless the token is controlled. So one has to be built by hand — initialized
//      but deliberately never `add()`ed, because adding it would change what the GM's own screen
//      shows. `DetectionMode#testVisibility(visionSource, mode, config)` takes the source as a
//      PARAMETER, which is the only reason per-creature perception is possible at all.
//   3. dnd5e never maps a stat block's senses onto Foundry detection modes, and NPC tokens ship with
//      `sight.enabled` false (its character template sets it; its NPC template has no prototype token
//      block). A monster with "Darkvision 60 ft." therefore has NO detection modes whatsoever, and a
//      pure vision test silently returns false for the entire bestiary. This is the single most likely
//      way for any of this to look broken, so a creature with no usable modes falls back to its stated
//      senses plus a wall check, and one with no way to perceive anything says so in the console.
//
// Both the throwaway-source technique and the detection-mode loop are what Patrol and vision-5e do in
// production against Foundry 14. Behaviour was the reference; the code is ours.
//
// EVERY PUBLIC ANSWER HERE FAILS TOWARD "THE OBSERVER SEES", and the symmetry is deliberate rather than
// incidental: for the Hide prerequisite that refuses a hide nobody has earned, and for the planner it
// keeps a monster fighting normally. In both cases the destructive failure is the other one — granting
// free invisibility, or blinding the entire bestiary — so a thrown exception must never produce it.

import { log } from "../constants";
import { isStealthEnabled } from "../settings";
import { measureBetween } from "../core/positioning";
import { evades } from "./stealth";

/** Sight range assumed for a creature whose token has vision switched off and no stated senses. */
const ASSUMED_SIGHT = 60;

/** Senses that let a creature notice someone, whatever the light is doing. */
const SENSES = ["darkvision", "blindsight", "truesight", "tremorsense"];

/** Creatures already warned about having no way to perceive anything, so the log stays readable. */
const warnedBlind = new Set<string>();

/** Pairings already reported as "would have been spotted, but they are hidden". */
const announced = new Set<string>();

/**
 * Vision sources built for a run of questions, keyed by observer token id.
 *
 * Building the source runs a full wall sweep, which is the entire cost of any of this; testing an extra
 * target against an existing one is arithmetic. NEVER build one inside an inner loop.
 */
export type VisionCache = Map<string, any>;

/** Discard the sources in a cache. They were never `add()`ed, so nobody else will tidy them up. */
export function releaseVision(cache: VisionCache): void {
  for (const source of cache.values()) {
    try {
      source?.destroy?.();
    } catch {
      /* a source that will not tidy up is not worth failing the question over */
    }
  }
  cache.clear();
}

/** Distance between two tokens in scene units, through the one shared measurement. */
export function separation(a: any, b: any): number {
  const p1 = a?.center;
  const p2 = b?.center;
  if (!p1 || !p2) return Number.POSITIVE_INFINITY;
  return measureBetween(p1, p2);
}

/**
 * Can `spotter` see `target`, before anything either of them is doing about it?
 *
 * The vision half of `perceives`, split out because two callers want the question stopped at different
 * points. The sweep wants the whole thing: eyes first, then the dice. The Hide prerequisite wants ONLY
 * this half, and the reason is circularity — `evades` reads what the target is doing to hide, so a
 * creature that is already hiding would be invisible to the very test deciding whether it may hide
 * again, and every re-hide would pass unconditionally.
 *
 * Reports `useModes` alongside the answer because the caller cannot otherwise tell whether it got the
 * real detection-mode verdict or the stat-block fallback, and `evades` needs to know which.
 */
export function sightOf(
  spotter: any,
  target: any,
  cache: VisionCache,
): { seen: boolean; useModes: boolean } {
  const id = String(spotter?.id ?? "");
  if (!cache.has(id)) cache.set(id, buildVision(spotter));
  const source = cache.get(id);

  const modes = source ? enabledModes(spotter) : [];
  const useModes = Boolean(source) && modes.length > 0;
  let seen = false;

  if (useModes) {
    const config = testConfig(target);
    for (const [modeId, mode] of modes) {
      const detector: any = (globalThis as any).CONFIG?.Canvas?.detectionModes?.[modeId];
      if (typeof detector?.testVisibility !== "function") continue;
      try {
        if (detector.testVisibility(source, mode, config)) {
          seen = true;
          break;
        }
      } catch (err) {
        log(`detection mode ${modeId} threw for ${spotter?.name}:`, err);
      }
    }
    // Its senses are properly configured and none of them found the target. That is an answer, not a
    // gap — falling through to the stat block here would quietly undo darkness and invisibility.
  } else {
    seen = withinSenses(spotter, target) && hasLineOfSight(spotter, target);
  }
  return { seen, useModes };
}

/**
 * Can `spotter` perceive `target` right now — eyes AND the stealth contest?
 *
 * Runs the creature's own detection modes, which is what gets darkness, darkvision, blindsight,
 * tremorsense and invisibility right without us reimplementing any of them, and then asks the dice.
 *
 * Elevation is not considered beyond what core's own modes do: Foundry's vision is largely planar, and
 * modelling a creature's vertical arc of sight would be inventing precision we do not have.
 */
export function perceives(spotter: any, target: any, cache: VisionCache): boolean {
  const { seen, useModes } = sightOf(spotter, target, cache);

  if (!seen) return false;
  if (!isStealthEnabled()) return true;

  // A clear line of sight is Foundry's answer, not 5e's. Ask the dice too.
  const evaded = evades(spotter, target, separation(spotter, target), useModes);
  if (evaded) {
    announceEvasion(spotter, target, evaded);
    return false;
  }

  // Being found used to lift the hide outright, here, for everybody. It does not any more:
  // `maintainSpotted` records that THIS watcher has them and leaves the hide standing against everyone
  // else. The universal reveal is still right for the things that deserve it — attacking, casting
  // aloud, invisibility ending — and those all call `reveal` from `stealth.ts`. This function stays
  // pure, which is what both the diagnostic survey and the planner need it to be.
  return true;
}

/**
 * Which of `observers` can currently see `target`, by token id.
 *
 * Exists so the Hide prerequisite in `hide.ts` answers "out of any enemy's line of sight" with the SAME
 * machinery that decides whether a fight starts. Before v0.4.1 those were two unrelated tests: the
 * sweep ran detection modes, ranges, light and darkness, while Hide counted wall-blocked corner rays
 * and nothing else — so nine hostiles a hundred feet away in the dark, whom no sweep would ever let
 * notice anybody, were reported as having the rogue "in plain view". Two answers to one question is a
 * bug whichever of them is right, and this is the one that is right.
 *
 * Sight only, deliberately: see the circularity note on `sightOf`.
 */
export function observersWhoSee(observers: any[], target: any): Set<string> {
  const seen = new Set<string>();
  const vision: VisionCache = new Map();
  try {
    for (const observer of observers) {
      const id = String(observer?.id ?? "");
      try {
        if (sightOf(observer, target, vision).seen) seen.add(id);
      } catch (err) {
        log(`could not work out whether ${observer?.name} can see ${target?.name}:`, err);
        seen.add(id);
      }
    }
  } finally {
    releaseVision(vision);
  }
  return seen;
}

/**
 * Which of `targets` can `observer` perceive right now, by token id. The transpose of the above.
 *
 * One observer against many targets rather than many observers against one, which is what the PLANNER
 * needs: a creature deciding its turn asks about everybody at once, and that costs exactly one vision
 * build. Cheap enough to run every turn, which the other direction would not be.
 *
 * The FULL question, unlike `observersWhoSee` — eyes and then the contest — because a creature deciding
 * who to attack must not be able to target somebody who has successfully hidden from it. `evades`
 * already returns null for an observer sitting in the hider's `spotted` set, so a watcher that has
 * already found them keeps them.
 */
export function perceivedBy(observer: any, targets: any[]): Set<string> {
  const seen = new Set<string>();
  const vision: VisionCache = new Map();
  try {
    for (const target of targets) {
      const id = String(target?.id ?? "");
      try {
        if (perceives(observer, target, vision)) seen.add(id);
      } catch (err) {
        log(`could not work out whether ${observer?.name} can perceive ${target?.name}:`, err);
        seen.add(id);
      }
    }
  } finally {
    releaseVision(vision);
  }
  return seen;
}

/**
 * Say once, per pair, that somebody went unnoticed because they were hidden.
 *
 * The failure this guards against is silence: a stale hidden state suppressing every encounter forever
 * while the GM wonders why automatic engagement stopped working. Repeating it every six seconds would
 * be its own kind of useless, so each pairing is announced once and reset when a fight ends.
 */
function announceEvasion(spotter: any, target: any, why: string): void {
  const key = `${spotter?.id}:${target?.id}`;
  if (announced.has(key)) return;
  announced.add(key);
  log(`perception: ${spotter?.name} would have spotted ${target?.name}, but they are ${why}`);
}

/** Let every pairing be reported again. Called when a fight ends. */
export function forgetEvasionNotices(): void {
  announced.clear();
}

/**
 * The spotter's enabled detection modes as [id, mode] pairs.
 *
 * v14 keeps `detectionModes` as a Record keyed by id; v13 and earlier keep an Array of objects carrying
 * their own `id`. Both shapes are handled because the difference is silent — the wrong one yields an
 * empty list rather than an error, and an empty list looks exactly like a blind monster.
 */
export function enabledModes(spotter: any): Array<[string, any]> {
  const raw: any = spotter?.document?.detectionModes;
  const pairs: Array<[string, any]> = Array.isArray(raw)
    ? raw.map((m: any) => [String(m?.id ?? ""), m])
    : Object.entries(raw ?? {});
  return pairs.filter(([id, mode]) => id && mode?.enabled);
}

/**
 * The visibility test config a detection mode expects: a set of points, each with its own LOS memo.
 *
 * Core builds this in `_createVisibilityTestConfig`, which is internal, so it is used when present and
 * hand-rolled when not — the shape is small and stable enough that a fallback is cheaper than a hard
 * dependency on a protected method. v14 takes an array of points and offers the token's own test
 * points; earlier versions take one point and jitter it by a tolerance.
 */
function testConfig(target: any): any {
  const v14 = Number((game as any)?.release?.generation ?? 13) >= 14;
  const doc = target?.document;
  const points =
    v14 && typeof doc?.getVisibilityTestPoints === "function"
      ? doc.getVisibilityTestPoints()
      : target.center;

  const visibility: any = (canvas as any)?.visibility;
  if (typeof visibility?._createVisibilityTestConfig === "function") {
    try {
      return visibility._createVisibilityTestConfig(points, {
        object: target,
        tolerance: v14 ? 0 : 2,
      });
    } catch (err) {
      log("core's visibility test config threw; using our own:", err);
    }
  }

  const elevation = Number(doc?.elevation ?? 0) || 0;
  const list = Array.isArray(points) ? points : [points];
  return {
    object: target,
    tests: list.map((p: any) => ({
      point: { x: p.x, y: p.y, elevation: Number(p.elevation ?? elevation) || 0 },
      los: new Map(),
    })),
  };
}

/**
 * A vision source for a token nobody is controlling.
 *
 * `initialize()` computes the polygons; `add()` would register the source with the canvas and change
 * what the GM actually sees on screen, so it is never called. Built even when `sight.enabled` is false,
 * because the detection-mode loop is what decides whether it is useful.
 */
function buildVision(token: any): any {
  try {
    const cls: any = (globalThis as any).CONFIG?.Canvas?.visionSourceClass;
    if (!cls || typeof token?.document?._getVisionSourceData !== "function") return null;
    const source = new cls({ sourceId: token.sourceId, object: token });
    source.initialize(token.document._getVisionSourceData());
    return source;
  } catch (err) {
    log("could not build a vision source:", err);
    return null;
  }
}

/**
 * Fallback for creatures with no detection modes: the senses their stat block claims.
 *
 * dnd5e 5.3 moved these under `senses.ranges`; the flat path still resolves through a deprecation shim,
 * so both are read. A creature with neither modes nor stated senses is assumed to have ordinary sight,
 * and is named in the console once — an empty capability read is a misconfiguration until proven
 * otherwise, and silence here is what would make the whole feature look dead.
 */
function withinSenses(spotter: any, target: any): boolean {
  const attributes: any = spotter?.actor?.system?.attributes?.senses ?? {};
  const ranges: any = attributes?.ranges ?? attributes;
  let radius = Number(spotter?.document?.sight?.range) || 0;
  for (const sense of SENSES) radius = Math.max(radius, Number(ranges?.[sense]) || 0);

  if (radius <= 0) {
    radius = ASSUMED_SIGHT;
    const id = String(spotter?.id ?? "");
    if (!warnedBlind.has(id)) {
      warnedBlind.add(id);
      log(
        `perception: ${spotter?.name} has no detection modes and no stated senses — assuming ${ASSUMED_SIGHT} ft of ordinary sight. Enable vision on the token, or install a senses module, for anything better.`,
      );
    }
  }
  return separation(spotter, target) <= radius;
}

function hasLineOfSight(spotter: any, target: any): boolean {
  try {
    if (typeof spotter?.checkCollision === "function") {
      return !spotter.checkCollision(target.center, { type: "sight", mode: "any" });
    }
  } catch (err) {
    log("line-of-sight test threw; assuming the view is clear:", err);
  }
  return true;
}
