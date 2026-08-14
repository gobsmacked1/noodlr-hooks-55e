// Everything about Silvery Barbs that is a D&D fact rather than a mechanism.
//
// Same quarantine as Counterspell's, and for the same reason: `rules/barbs.ts` holds a verdict open, asks
// somebody, and rerolls a die. None of that is about D&D, and a second game system with a
// spoil-their-success reaction writes a sibling of this file and changes nothing next door.
//
// THE SPELL IS NOT IN ANY dnd5e COMPENDIUM. It is Strixhaven content rather than SRD or PHB, so unlike
// Counterspell there is no authored `system.identifier` to trust — a table's copy came from DDB Importer, a
// premade library, or somebody typing it out. That is why the recogniser tries three routes and why the
// flag is documented: a hand-built copy is the normal case here, not the exception.
//
// WHAT IS AUTOMATED AND WHAT IS NOT. The reroll is; the second half of the spell — "then one creature you
// can see gains Advantage on its next attack roll, ability check, or saving throw" — is not, because it is
// a promise about a roll that has not happened, which is the same thing that keeps the Help action unbuilt.
// Where the table's copy of the spell carries an Active Effect for it, using the item applies it exactly as
// the sheet says, because the reaction is used through the ordinary activity pipeline.

import { hasFlag } from "../util/flags";
import { moduleActive } from "../util/modules";
import { slotAvailable, spendsSlot } from "./dnd5e-spells";

/** The spell's own range, in feet. Read from the item where possible; this is the printed fallback. */
export const BARBS_RANGE = 60;

/** The lowest slot it can be cast from, and the only one worth using: it does not scale. */
export const BARBS_LEVEL = 1;

/**
 * Is this the Silvery Barbs spell?
 *
 * Identifier first, then our own flag, then the name — and the name is ANCHORED, because "barbs" on its own
 * is a plausible substring of a homebrew weapon or a monster trait, and matching one of those would offer a
 * creature a reroll it does not have.
 */
export function isSilveryBarbs(item: any): boolean {
  if (!item) return false;
  if (String(item?.type ?? "") !== "spell") return false;
  if (hasFlag(item, "silveryBarbs")) return true;
  const identifier = String(item?.system?.identifier ?? "").toLowerCase();
  if (identifier) return identifier === "silvery-barbs" || identifier === "silverybarbs";
  return /^\s*silvery\s+barbs\s*$/i.test(String(item?.name ?? ""));
}

/** What a creature would spoil a success with, or null when it cannot. */
export interface BarbsReady {
  item: any;
  /** Range in feet, off the item where it states one. */
  range: number;
}

/**
 * Can this creature cast Silvery Barbs right now?
 *
 * No DC to read and no contest to run, which makes this a much shorter check than Counterspell's: the spell
 * simply happens, and the dice decide. So the only requirements are the spell itself and something to pay
 * for it.
 */
export function barbsReady(actor: any): BarbsReady | null {
  try {
    const items: any[] = Array.from(actor?.items ?? []);
    for (const item of items) {
      if (!isSilveryBarbs(item)) continue;
      if (spendsSlot(item) && !slotAvailable(actor, BARBS_LEVEL) && !forcedBarber(actor)) continue;
      const stated = Number(item?.system?.range?.value);
      return { item, range: Number.isFinite(stated) && stated > 0 ? stated : BARBS_RANGE };
    }
  } catch {
    /* an unreadable item list is not a creature that can cast */
  }
  return null;
}

/**
 * Has an effect or a GM declared that this creature can spoil a roll without meeting the usual requirements?
 *
 * The escape hatch every rule here carries, under the documented `flags.<ns>.*` contract. Set it on a
 * statblock whose prose says it twists somebody's luck without listing a spell.
 */
export function forcedBarber(actor: any): boolean {
  return hasFlag(actor, "d20Reaction");
}

/**
 * Does Gambit's Premades own this rule at this table?
 *
 * `silveryBarbs.js` is a complete implementation of both halves — the reroll for attacks and for saves, the
 * ally who gains Advantage, the timed dialog — so where it runs, ours must not. Two windows on one success
 * would ask twice and could reroll twice.
 *
 * MIDI IS PART OF THE TEST, exactly as with Counterspell: their first line is
 * `MidiQOL.Workflow.getWorkflow()` and every step routes through `MidiQOL.socket()`, so with midi absent
 * their automation cannot fire at all — and standing aside for an installed-but-inert module would leave
 * the spell unimplemented while a settings row claimed somebody had it.
 *
 * Worth recording what their approach confirms about ours: they reroll `1d20 + (total - dice[0].total)` and
 * keep it only when the new total is lower. That is the same arithmetic as ours, derived independently,
 * which is reassuring about the one piece of this that has to be exactly right.
 */
export function gambitsOwnsBarbs(): boolean {
  return moduleActive("gambits-premades") && moduleActive("midi-qol");
}
