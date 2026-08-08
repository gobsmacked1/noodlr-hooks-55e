// What a creature's sheet says about whether it talks, and about whom.
//
// The banter LIBRARY — the line file, the tagging, the picking and the voice — lives in `noodlr`,
// because it is flavour and it needs that module's TTS. What stayed here is the half that reads a
// character sheet, which is the half that has to know where dnd5e keeps its numbers. This module
// emits a profile with every automated turn; `noodlr` turns it into a line, or into silence.
//
// Frequency formula (user, 2026-08-03), applied to the creature's own modifiers:
//
//     chatter = INT + 2·CHA − 2·WIS,  clamped to 0…20,  then 5% per point
//
// The signs are intentional (user, confirmed 2026-08-03) and must not be "corrected": a clever
// creature is often too pleased with its own commentary, a charismatic one is a show-off (hence the
// doubled weight), and wisdom is largely knowing when to shut up — so it is SUBTRACTED, doubled.
//
// The subtraction is doing double duty, which is the elegant part. A wise creature stays quiet and
// fights; an UNWISE one has a negative modifier, so the minus flips it positive and the fool becomes
// the loudest thing on the battlefield. Both halves of the behaviour fall out of the same term.
//
// Hard gate before any of that: a creature with no language cannot speak. A dire wolf gets no lines
// however charismatic the sheet says it is. Everything that CAN talk is floored at one point (5%),
// because the raw arithmetic otherwise mutes almost every published low-CR humanoid — a goblin's
// −1 WIS contributes +2 and its −1 CHA takes the same amount straight back, landing it on exactly
// zero. The floor sits outside the formula, after the language gate, so the arithmetic stays as
// specified.

import { pick, pickNumber, pickString, systemPaths, type SystemPaths } from "../system/profiles";
import { turnRandom } from "../core/random";

/** Everything a taunt needs to know about the creature receiving it. */
export interface TargetProfile {
  name: string;
  race?: string;
  klass?: string;
  style?: string;
  gender?: string;
}

/** The whole banter question, answered from sheets, for `noodlr` to act on or ignore. */
export interface BanterProfile {
  /** Chance this creature says anything at all, 0…1. Zero means it has no language. */
  chance: number;
  /** Creature type of the speaker, lowercased — a curse suits something already dead. */
  creatureType: string;
  /** Who is being taunted. */
  target: TargetProfile;
  /**
   * Two draws from this turn's banter stream, 0…1: whether to speak, and which line.
   *
   * Handed over rather than left to the listener so banter stays reproducible across the module
   * boundary — the listener has no access to the fight's seed, and a `Math.random()` on its side
   * would make every taunt unreplayable and untestable. The stream is `"banter"`, separate from the
   * tactical one on purpose: a decision made here must never shift a number the planner sees.
   */
  roll: number;
  pick: number;
}

/** Percentage points contributed by each score point. */
const CHATTER_STEP = 0.05;

const CASTER_CLASSES = new Set(["wizard", "sorcerer", "warlock", "cleric", "druid", "bard"]);
const MARTIAL_CLASSES = new Set([
  "fighter",
  "barbarian",
  "monk",
  "rogue",
  "paladin",
  "ranger",
  "artificer",
]);

/** Ability modifier, read directly when the sheet states one and derived only as a fallback. */
function modifier(actor: any, mods: string[], scores: string[]): number {
  const stated = pickNumber(actor, mods);
  if (stated !== null) return stated;
  const score = pickNumber(actor, scores);
  return score === null ? 0 : Math.floor((score - 10) / 2);
}

/** Does this creature have any language at all? Sets, arrays, and plain strings all appear. */
export function hasLanguage(actor: any, P: SystemPaths = systemPaths()): boolean {
  const raw: any = pick(actor, P.languages);
  if (!raw) return false;
  if (typeof raw === "string") return raw.trim().length > 0;
  if (Array.isArray(raw)) return raw.length > 0;
  if (raw instanceof Set) return raw.size > 0;
  // dnd5e keeps `{ value: Set, custom: string }`; either half counts.
  const value = raw.value;
  if (value instanceof Set) return value.size > 0;
  if (Array.isArray(value)) return value.length > 0;
  return typeof raw.custom === "string" && raw.custom.trim().length > 0;
}

/** How likely this creature is to run its mouth, as a count of 5% steps (0–20). */
export function chatterScore(actor: any): number {
  const P = systemPaths();
  const int = modifier(actor, P.intelligenceMod, P.intelligence);
  const wis = modifier(actor, P.wisdomMod, P.wisdom);
  const cha = modifier(actor, P.charismaMod, ["system.abilities.cha.value"]);
  return Math.max(0, Math.min(20, int + 2 * cha - 2 * wis));
}

function classOf(actor: any): string | undefined {
  // The class item with the most levels is the character people would name first.
  let best: { name: string; levels: number } | undefined;
  for (const item of actor?.items ?? []) {
    if (item?.type !== "class") continue;
    const levels = Number(item?.system?.levels ?? 1);
    if (!best || levels > best.levels) best = { name: String(item.name ?? ""), levels };
  }
  if (best?.name) return best.name.toLowerCase();
  const stated = pickString(actor, ["system.details.originalClass", "system.details.class"]);
  return stated ? stated.toLowerCase() : undefined;
}

export function readTarget(actor: any, name: string): TargetProfile {
  const P = systemPaths();
  // dnd5e 4.x keeps ancestry as an item; earlier versions as a plain string.
  const raceItem = (actor?.items ?? []).find?.((i: any) => i?.type === "race");
  const race = (raceItem?.name ?? pickString(actor, P.race)).toString().toLowerCase();
  const klass = classOf(actor);
  const gender = pickString(actor, P.gender).toLowerCase();

  return {
    name,
    race: race || undefined,
    klass,
    style: klass
      ? CASTER_CLASSES.has(klass)
        ? "spellcaster"
        : MARTIAL_CLASSES.has(klass)
          ? "martial"
          : undefined
      : undefined,
    gender: gender.startsWith("f") ? "female" : gender.startsWith("m") ? "male" : undefined,
  };
}

/**
 * The banter question for one creature taunting another, or null when there is nobody to taunt.
 *
 * A zero `chance` is returned rather than a null profile when the speaker simply has no language, so
 * a caller can tell "nothing to say" apart from "nothing to say it to".
 */
export function banterProfile(actor: any, target: any, combatantId: string): BanterProfile | null {
  if (!actor || !target?.actor) return null;
  const P = systemPaths();
  const rand = turnRandom(combatantId, "banter");
  return {
    // The floor of one point sits outside the formula and after the language gate, so the arithmetic
    // stays as specified while anything that can talk still gets a one-in-twenty chance to jeer.
    chance: hasLanguage(actor, P) ? Math.max(1, chatterScore(actor)) * CHATTER_STEP : 0,
    creatureType: pickString(actor, P.creatureType).toLowerCase(),
    target: readTarget(target.actor, String(target.name ?? "")),
    roll: rand(),
    pick: rand(),
  };
}
