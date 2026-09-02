// Three rules that turn on who can see whom. D&D 5e leaves all three as prose.
//
//   UNSEEN TARGET      "You have Disadvantage on an attack roll against a target you can't see."
//   UNSEEN ATTACKER    "You have Advantage on an attack roll against a target that can't see you."
//   RANGED IN MELEE    "You have Disadvantage on a ranged attack roll if you are within 5 feet of an
//                       enemy who can see you and who isn't Incapacitated."
//
// WHY THEY ARE HERE AND NOT IN `dnd5e-conditions.ts`. That file is a status matrix: it answers "what
// does Blinded do to a roll" from two actors and nothing else, which is what lets the planner and the
// survey call it with nothing placed on a canvas. These three need TOKENS — a position, a wall, a
// distance — so folding them in would drag the canvas into a pure function and quietly break it
// wherever there is no scene.
//
// WHY VISIBILITY IS ASKED OF `rules/stealth.ts` RATHER THAN COMPUTED HERE. `evades()` is the module's
// one answer to "can this creature perceive that one": it reads invisibility, magical darkness, fog,
// the concealment table's whole capability vocabulary, and a declared hide contested against passive
// Perception. A second, simpler test written here would disagree with it — and the disagreement would
// surface as a rogue who is unseen enough to avoid starting a fight but not unseen enough to get
// Advantage, which reads as the module being broken rather than as two implementations drifting.
//
// WHAT IS APPROXIMATE, STATED PLAINLY. Line of sight walks occupied-square centres (`sightOccluded`),
// not a single ray between token centres and not the per-creature detection-mode sweep
// `rules/perception.ts` runs. That sweep is the right answer and cannot be afforded inside a
// synchronous pre-roll hook that fires on every attack in the fight. A centre-to-centre ray on a
// Large token next to a Medium one is the melee-reach bug arriving as Disadvantage: the centres are
// ~8 ft apart and the ray often clips a wall the shared edge does not. Any clear pair means they
// can see. Consequences: total cover is caught, partial cover is not, and a creature whose only
// sense is blindsight through a wall is handled by the sense check rather than by the ray.
//
// EVERY FAILURE FALLS TOWARD "CAN SEE". An unreadable canvas, a missing token, a null from `blocked` —
// all of them mean the attack rolls straight. That is deliberate: a spurious Advantage is a hit that
// should have missed and is already applied by the time anyone objects, while a missed Advantage is a
// swing the table can still argue about.

import { log } from "../constants";
import { sightOccluded } from "../core/positioning";
import { hasStatus, isIncapacitated } from "../system/dnd5e-conditions";
import { separation } from "./sight";
import { evades } from "./stealth";

export interface SightModifiers {
  advantage: string[];
  disadvantage: string[];
}

// Scene-unit distance between two tokens, elevation included. Re-exported rather than implemented:
// this file used to carry a second copy under the same name, which measured the same pair differently
// from `sight.ts` on any scene with a diagonal rule. One question, one implementation.
export { separation };

/**
 * Can `spotter` see `subject`? Returns the reason it cannot, or null when it can.
 *
 * Blinded is answered first and on its own, because it is the one case where the creature's senses are
 * irrelevant: `evades` asks what the target is doing to hide, and a Blinded watcher fails to see a
 * target that is doing nothing at all.
 */
export function unseenBy(spotter: any, subject: any): string | null {
  const spotterActor = spotter?.actor;
  if (spotterActor && hasStatus(spotterActor, "blinded")) return "blinded";

  const distance = separation(spotter, subject);
  // `useModes: false` — there is no detection-mode sweep on this path, so invisibility is ours to
  // judge here rather than something core has already applied to the screen.
  const veiled = evades(spotter, subject, distance, false);
  if (veiled) return veiled;

  if (sightOccluded(spotter, subject)) return "no line of sight";
  return null;
}

/** Enemies of `token` standing within `feet` of it, awake and able to see it. */
function threateningWitnesses(token: any, feet: number): any[] {
  const HOSTILE = (globalThis as any).CONST?.TOKEN_DISPOSITIONS?.HOSTILE ?? -1;
  const FRIENDLY = (globalThis as any).CONST?.TOKEN_DISPOSITIONS?.FRIENDLY ?? 1;
  const mine = Number((token?.document ?? token)?.disposition ?? 0);
  const theirs = mine === HOSTILE ? [FRIENDLY] : [HOSTILE];
  const defeated = (globalThis as any).CONFIG?.specialStatusEffects?.DEFEATED ?? "dead";

  const out: any[] = [];
  for (const other of (canvas as any)?.tokens?.placeables ?? []) {
    if (!other?.actor || other.document?.hidden) continue;
    if (String(other.id) === String(token?.id)) continue;
    if (!theirs.includes(Number(other.document?.disposition))) continue;
    try {
      if (other.document?.hasStatusEffect?.(defeated)) continue;
    } catch {
      /* an unreadable status is not a reason to ignore a witness */
    }
    // Both clauses of the rule, and they are load-bearing: a sleeping guard next to an archer does
    // not spoil the shot, and neither does one who cannot see them.
    if (isIncapacitated(other.actor)) continue;
    if (separation(token, other) > feet + 0.01) continue;
    if (unseenBy(other, token)) continue;
    out.push(other);
  }
  return out;
}

/**
 * What the geometry does to this attack roll.
 *
 * Called from `rules/conditions.ts` alongside the status matrix, so the two sets of reasons merge into
 * one advantage/disadvantage decision — which is right, because 5e does not stack either one.
 */
export function sightModifiers(input: {
  attackerToken: any;
  targetToken: any;
  melee: boolean;
  /** Another module is already applying the unseen-attacker and unseen-target rules. */
  skipVisibility?: boolean;
  /** Another module is already applying Disadvantage for shooting beside an enemy. */
  skipCrowding?: boolean;
}): SightModifiers {
  const mods: SightModifiers = { advantage: [], disadvantage: [] };
  const { attackerToken, targetToken, melee } = input;
  if (!attackerToken) return mods;

  if (targetToken && !input.skipVisibility) {
    const cannotSeeTarget = unseenBy(attackerToken, targetToken);
    if (cannotSeeTarget) mods.disadvantage.push(`unseen target (${cannotSeeTarget})`);

    const cannotBeSeen = unseenBy(targetToken, attackerToken);
    if (cannotBeSeen) mods.advantage.push(`unseen attacker (${cannotBeSeen})`);
  }

  if (!melee && !input.skipCrowding) {
    const crowding = threateningWitnesses(attackerToken, 5);
    if (crowding.length > 0) {
      mods.disadvantage.push(
        `ranged within 5 ft of ${crowding.map((t) => String(t.name ?? "an enemy")).join(", ")}`,
      );
    }
  }

  if (mods.advantage.length || mods.disadvantage.length) {
    log(
      `unseen: ${String(attackerToken?.name)} ->` +
        (mods.advantage.length ? ` ADV[${mods.advantage.join("; ")}]` : "") +
        (mods.disadvantage.length ? ` DIS[${mods.disadvantage.join("; ")}]` : ""),
    );
  }
  return mods;
}
