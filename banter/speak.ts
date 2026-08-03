// Who mouths off, how often, and at whom.
//
// Frequency formula (user, 2026-08-03), applied to the creature's own modifiers:
//
//     chatter = INT + 2·CHA − 2·WIS,  clamped to 0…10,  then 10% per point
//
// The reasoning behind it is worth keeping, because the signs look wrong at a glance: a clever
// creature is often too pleased with its own commentary, a charismatic one is a show-off (hence the
// doubled weight), and wisdom is largely knowing when to shut up (hence subtracting it, doubled). So
// a hag with a high WIS says almost nothing while a preening warlord will not stop.
//
// Hard gate before any of that: a creature with no language cannot speak. A dire wolf gets no lines
// however charismatic the sheet says it is.
//
// Reactions can also carry a line ("at the beginning of their turn, or during a reaction"), but the
// off-turn reaction layer does not exist yet — see the gaps note in AGENTS.md. Turn-start only, today.

import { log } from "../../constants";
import { getTtsEnabled } from "../../media/config";
import { speakShared } from "../../media/tts";
import { pick, pickNumber, pickString, systemPaths, type SystemPaths } from "../system-profiles";
import { turnRandom } from "../auto/random";
import { banterLines, type BanterLine } from "./library";

/** Everything a taunt needs to know about the creature receiving it. */
interface TargetProfile {
  name: string;
  race?: string;
  klass?: string;
  style?: string;
  gender?: string;
}

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
function hasLanguage(actor: any, P: SystemPaths): boolean {
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

/** 0–10: how many tens of percent chance this creature has of running its mouth. */
export function chatterScore(actor: any): number {
  const P = systemPaths();
  const int = modifier(actor, P.intelligenceMod, P.intelligence);
  const wis = modifier(actor, P.wisdomMod, P.wisdom);
  const cha = modifier(actor, P.charismaMod, ["system.abilities.cha.value"]);
  return Math.max(0, Math.min(10, int + 2 * cha - 2 * wis));
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

function readTarget(actor: any, name: string): TargetProfile {
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
 * How well a line suits this target. Zero means never say it — a taunt that names the wrong ancestry
 * or addresses a woman as "boy" is worse than no taunt at all, so those are excluded rather than
 * merely disfavoured.
 */
function weigh(line: BanterLine, target: TargetProfile, creatureType: string): number {
  if (line.race && line.race !== target.race) return 0;
  if (line.gender && line.gender !== target.gender) return 0;

  let weight = 1;
  if (line.race && line.race === target.race) weight += 6;
  if (line.klass) weight += line.klass === target.klass ? 6 : -0.9;
  if (line.style) weight += line.style === target.style ? 3 : -0.7;
  // A curse in the mouth of something dead already sounds right.
  if (line.flavor === "curse" && /undead|fiend|fey/.test(creatureType)) weight += 2;
  if (line.bark) weight += 0.5;
  return Math.max(0.05, weight);
}

function choose(lines: BanterLine[], weights: number[], rand: () => number): BanterLine {
  const total = weights.reduce((a, b) => a + b, 0);
  let roll = rand() * total;
  for (let i = 0; i < lines.length; i++) {
    roll -= weights[i];
    if (roll <= 0) return lines[i];
  }
  return lines[lines.length - 1];
}

/**
 * Say something, maybe. Returns the line spoken, or null when the creature stayed quiet — which is
 * the common case and not a failure.
 */
export async function maybeTaunt(combatant: any, target: any): Promise<string | null> {
  const actor = combatant?.actor;
  const lines = banterLines();
  if (!actor || lines.length === 0 || !target?.actor) return null;

  const P = systemPaths();
  if (!hasLanguage(actor, P)) return null;

  const score = chatterScore(actor);
  if (score <= 0) return null;

  // Its own stream, so switching banter off cannot change a single tactical decision.
  const rand = turnRandom(String(combatant.id ?? ""), "banter");
  if (rand() >= score / 10) return null;

  const profile = readTarget(target.actor, String(target.name ?? ""));
  const creatureType = pickString(actor, P.creatureType).toLowerCase();

  const weights = lines.map((l) => weigh(l, profile, creatureType));
  const usable = lines.filter((_, i) => weights[i] > 0);
  const usableWeights = weights.filter((w) => w > 0);
  if (usable.length === 0) return null;

  const line = choose(usable, usableWeights, rand);
  log(`banter: ${combatant.name} -> ${profile.name} (${score}0% chatter): ${line.text}`);

  const ChatMessage = (globalThis as any).ChatMessage;
  await ChatMessage.create({
    content: `<p class="noodlr-banter">"${foundry.utils.escapeHTML(line.text)}"</p>`,
    speaker: { alias: String(combatant.name ?? "") },
  });

  // Spoken only if the table already has voice switched on; banter never turns it on by itself.
  if (getTtsEnabled()) {
    try {
      await speakShared(line.text);
    } catch (err) {
      log("banter: could not speak the line:", err);
    }
  }

  return line.text;
}
