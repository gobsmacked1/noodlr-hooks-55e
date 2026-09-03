// Everything about Counterspell that is a D&D fact rather than a mechanism.
//
// Quarantined here for the usual reason: `rules/counterspell.ts` holds a cast, asks somebody, and lets the
// answer decide whether the cast proceeds, and none of that is about D&D. A second game system with an
// interrupt-a-cast reaction writes a sibling of this file and changes nothing next door.
//
// WHY THE 2024 REDESIGN IS WHAT MADE THIS BUILDABLE. Under the 2014 rules the counterspeller rolled an
// ability check against a DC derived from the countered spell's level, and the countered caster lost their
// slot. Both halves fought Foundry: there is no contest primitive, and refunding a slot means unpicking a
// consumption that has already happened. 2024 inverts both. The counterspelled creature makes a plain
// Constitution saving throw against the counterspeller's ordinary spell save DC, and on a failure the slot
// "isn't expended" — so the correct implementation is to stop the cast BEFORE dnd5e consumes anything,
// which is exactly what a `dnd5e.preUseActivity` veto does. The rule and the platform agree.
//
// dnd5e already ships the spell in that shape (`packs/_source/spells24/3rd-level/counterspell.yml`): a
// `save` activity, `save.ability: con`, `dc.calculation: spellcasting`, `identifier: counterspell`. So the
// DC is the system's to compute and never ours, and there is no "at higher levels" scaling to model —
// upcasting Counterspell does nothing in 2024, which is one fewer thing to read.

import { log } from "../constants";
import { readFlag } from "../util/flags";
import { slotAvailable, spendsSlot } from "./dnd5e-spells";

/** The spell's own range, in feet. Read from the item where possible; this is the printed fallback. */
export const COUNTERSPELL_RANGE = 60;

/** The lowest slot Counterspell can be cast from. Upcasting buys nothing, so this is also the sane pick. */
export const COUNTERSPELL_LEVEL = 3;

/** Spell component properties. Any one of the three is enough for a spell to be counterable. */
const COMPONENTS = ["vocal", "somatic", "material"];

/** A cast that Counterspell could interrupt. */
export interface CounterableCast {
  /** The spell's name, for the announcement. */
  name: string;
  /** Its level, where the item states one. Recorded for the card, not for any arithmetic. */
  level: number | null;
  /**
   * Verbal components and nothing else — so the only way to notice this cast is to HEAR it.
   *
   * The rule says "when you see a creature casting", and a purely spoken cast has nothing to see, so a
   * Deafened creature cannot notice it. Gambit's Premades reads it the same way, which is worth knowing
   * because it is an interpretation rather than a printed clause. Left false whenever the components
   * cannot be read: refusing a counter on an unreadable property set would be a silent immunity.
   */
  vocalOnly: boolean;
}

/**
 * Is this activity a creature casting a spell with Verbal, Somatic or Material components?
 *
 * Synchronous by necessity — the caller is inside `preUseActivity`, whose return value is the veto — which
 * is what decides how the monster-casting case is handled. Monsters mostly cast through a FEAT carrying a
 * `cast` activity that points at a compendium spell ("1/day each: fireball"), and resolving that pointer
 * needs an await. `fromUuidSync` on an unloaded pack returns an index stub with no `system.properties`, so
 * the components genuinely cannot be read here.
 *
 * UNREADABLE COMPONENTS ARE TREATED AS PRESENT, and the alternative decides it. A spell with no components
 * at all is vanishingly rare — Subtle Spell is a caster's choice rather than a property of any spell — so
 * assuming components costs the occasional pointless offer, while assuming their absence would make every
 * monster in the bestiary uncounterable and leave nothing anywhere saying why.
 */
export function counterableCast(activity: any): CounterableCast | null {
  const item = activity?.item;
  const type = String(activity?.type ?? "");

  // A spell item used directly. The common case for characters.
  if (String(item?.type ?? "") === "spell") {
    if (!hasComponents(item)) return null;
    return { name: String(item?.name ?? ""), level: levelOf(item), vocalOnly: vocalOnly(item) };
  }

  // A feat wrapping a spell, which is how most statblocks cast. The wrapper owns the uses; the spell it
  // points at owns the shape, and may not be loaded.
  if (type === "cast") {
    const spell = referencedSpell(activity);
    if (spell && !hasComponents(spell)) return null;
    return {
      name: String(spell?.name ?? activity?.name ?? item?.name ?? ""),
      level: spell ? levelOf(spell) : null,
      vocalOnly: spell ? vocalOnly(spell) : false,
    };
  }

  return null;
}

/** Is this the Counterspell spell itself? Identifier first, then the name, as every table here does. */
export function isCounterspell(item: any): boolean {
  if (!item) return false;
  if (String(item?.type ?? "") !== "spell") return false;
  const identifier = String(item?.system?.identifier ?? "").toLowerCase();
  if (identifier) return identifier === "counterspell";
  return /^\s*counterspell\s*$/i.test(String(item?.name ?? ""));
}

/**
 * Is this action a Counterspell, including a feat that casts it?
 *
 * `isCounterspell` is the spell item. 2024 monsters wrap it as Protective Magic (`type: feat`,
 * `cast` → Counterspell). The hurt-reaction picker reads actions, not items, and spent that
 * wrapper on a barbarian's melee hit — illegal, and it threw.
 */
export function isCounterspellAction(action: {
  item?: unknown;
  spellKey?: string;
  activity?: unknown;
}): boolean {
  if (isCounterspell(action.item)) return true;
  if (String(action.spellKey ?? "").toLowerCase() === "counterspell") return true;
  return isCounterspell(referencedSpell(action.activity));
}

/** What a creature needs to counter with, or null when it cannot. */
export interface CounterspellReady {
  item: any;
  activity: any;
  /** The spell save DC the countered creature rolls against. */
  dc: number;
  /** Range in feet, off the item where it states one. */
  range: number;
}

/**
 * Can this creature counter right now — spell known, slot free, DC readable?
 *
 * THE DC IS A HARD REQUIREMENT, not a best guess. Without it there is no honest contest to run, and the
 * failure we must avoid is spending somebody's third-level slot on a save nobody can adjudicate. dnd5e
 * resolves `save.dc.value` during data preparation from `dc.calculation: "spellcasting"`, so reading it
 * rather than recomputing it also means a table's own homebrew DC is respected.
 */
export function counterspellReady(actor: any): CounterspellReady | null {
  try {
    const items: any[] = Array.from(actor?.items ?? []);
    for (const item of items) {
      if (!isCounterspell(item)) continue;
      const activity = saveActivityOf(item);
      const dc = Number(activity?.save?.dc?.value);
      if (!Number.isFinite(dc)) {
        log(
          `counterspell: ${actor?.name} has Counterspell but no readable save DC, so it is not offered`,
        );
        continue;
      }
      if (spendsSlot(item) && !slotAvailable(actor, COUNTERSPELL_LEVEL)) {
        if (!forcedCounterspeller(actor)) continue;
      }
      const stated = Number(item?.system?.range?.value);
      return {
        item,
        activity,
        dc,
        range: Number.isFinite(stated) && stated > 0 ? stated : COUNTERSPELL_RANGE,
      };
    }
  } catch (err) {
    log(`counterspell: could not read ${actor?.name}'s spells:`, err);
  }
  return null;
}

/**
 * Has an effect or a GM declared that this creature can counter without meeting the usual requirements?
 *
 * The escape hatch every rule here carries, under the documented `flags.<ns>.*` contract. Set it on a
 * statblock whose prose says it counters spells without listing one as a known spell.
 */
export function forcedCounterspeller(actor: any): boolean {
  return Boolean(readFlag(actor, "counterspell"));
}

/** Verbal but neither somatic nor material: nothing to see, so only a creature that can hear notices. */
function vocalOnly(item: any): boolean {
  return has(item, "vocal") && !has(item, "somatic") && !has(item, "material");
}

function has(item: any, key: string): boolean {
  try {
    const properties: any = item?.system?.properties;
    if (!properties) return false;
    if (properties?.has?.(key)) return true;
    return Array.isArray(properties) && properties.includes(key);
  } catch {
    return false;
  }
}

function hasComponents(item: any): boolean {
  try {
    const properties: any = item?.system?.properties;
    if (!properties) return true;
    if (COMPONENTS.some((key) => has(item, key))) return true;
    // A readable property set that names none of the three: genuinely uncounterable.
    return false;
  } catch {
    return true;
  }
}

function levelOf(item: any): number | null {
  const level = Number(item?.system?.level);
  return Number.isFinite(level) ? level : null;
}

/** The spell a `cast` activity points at, when it happens to be resolvable without awaiting. */
function referencedSpell(activity: any): any {
  const uuid = String(activity?.spell?.uuid ?? activity?.spell ?? "");
  if (!uuid) return null;
  try {
    const doc: any = (globalThis as any).fromUuidSync?.(uuid);
    // An index stub has a name and no system data. Reported as unresolvable rather than as componentless.
    return doc?.system ? doc : null;
  } catch {
    return null;
  }
}

/** Counterspell's one activity. Taken by type rather than by index, which a homebrew copy may reorder. */
function saveActivityOf(item: any): any {
  const activities: any = item?.system?.activities;
  const all: any[] = Array.from(activities?.contents ?? activities ?? []);
  return all.find((activity: any) => String(activity?.type ?? "") === "save") ?? all[0] ?? null;
}
