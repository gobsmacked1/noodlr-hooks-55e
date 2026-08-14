// What D&D 5e knows about readying an action.
//
// Quarantined here for the usual reason: `rules/ready.ts` holds the state machine and the trigger
// matching, and nothing in it learns a spell name, an activation key or a concentration rule. A
// `noodlr-hooks-pf2e` writes a sibling of this file and changes nothing next door.
//
// THE THREE RULES THAT SHAPE EVERYTHING ELSE, from the 2024 Ready entry:
//
//   1. **You ready an ACTION or MOVEMENT, never a Bonus Action.** So the readiable set is exactly the
//      activities whose activation is an action, plus the pseudo-option of moving up to your Speed.
//   2. **The response costs your REACTION.** Which means it is subject to everything a reaction is
//      subject to — one per round, and none at all while Incapacitated.
//   3. **A readied Attack is ONE attack.** Extra Attack says "when you take the Attack action on your
//      turn", and a readied swing happens on somebody else's. Nothing in Foundry enforces this because
//      nothing in Foundry knows the swing was readied; we do, so we use one activity once and never
//      loop `attacksPerAction`.
//
// WHAT IS DELIBERATELY DIVERGENT, and it is the one place this feature does not follow the letter.
// RAW, a readied SPELL is cast on your turn and its energy held with Concentration, so a trigger that
// never comes — or a Concentration broken before it does — wastes the slot. Foundry cannot represent a
// cast that has spent its slot and not yet chosen its target or placed its template: `activity.use()`
// resolves the whole thing in one pass, including the area. So the slot is spent when the trigger fires
// rather than when the action is readied, and a readied spell that never goes off costs the Action and
// keeps the slot. That is the generous direction, it is the direction every ambiguity in this module
// errs in, and it is stated in the announcement so nobody discovers it mid-argument.

import { hasFlag } from "../util/flags";
import type { WatchDescriptor } from "../integration/watch";
import { isActionActivity, READY_ACTION } from "./dnd5e-actions";
import { isDnd5e } from "./dnd5e-rewards";

/** Is pressing this the Ready action? */
export function isReadyActivity(item: any, activity: any): boolean {
  return isActionActivity(item, activity, READY_ACTION);
}

/**
 * Activation types that may be readied.
 *
 * Just the one, and the shortness is the rule rather than an omission. `bonus` is forbidden outright,
 * `reaction` is what the response itself costs, and everything longer than an action (`minute`, `hour`)
 * has a casting time that cannot fit inside a reaction.
 *
 * An EMPTY activation is not readiable either, and that is the census's finding rather than a reading of
 * the rules: 109 of 2067 activities in a real world carry no activation because they are the companion
 * half of something else — the save rider on a bite, the extra damage on a sneak attack. Offering one as
 * a readied action would hold a rule that cannot be used on its own.
 */
const READIABLE = new Set(["action"]);

export function readiableActivation(type: unknown): boolean {
  return READIABLE.has(String(type ?? "").toLowerCase());
}

/** Does holding this spell need Concentration? Read for the announcement, not enforced — see the header. */
export function requiresConcentration(item: any, activity: any): boolean {
  try {
    if (activity?.requiresConcentration === true) return true;
    const properties: any = item?.system?.properties;
    if (properties?.has?.("concentration")) return true;
    return Array.isArray(properties) && properties.includes("concentration");
  } catch {
    return false;
  }
}

/** Is the thing being readied a spell? Only affects the wording and the concentration note. */
export function isSpellItem(item: any): boolean {
  return String(item?.type ?? "") === "spell";
}

/**
 * Can this creature ready an action at all?
 *
 * The user's gate, from their own pseudocode: `(INT + WIS) / 2 > 5`. That lands exactly on tier 3 of the
 * cognition ladder — "child-like" — which is the first band that understands other creatures well enough
 * to lie in wait for one. Below it a creature acts on what is in front of it, which is what tiers 1 and
 * 2 model, and a beetle setting an ambush is worse than a beetle biting whatever is nearest.
 *
 * Player characters are never gated. A player who wants to hold a shot has decided to, and a module
 * telling somebody their character is too stupid to wait is not a rule anybody asked for.
 */
export const READY_TIER = 3;

/**
 * The number in the user's pseudocode: `(INT + WIS) / 2 > 5`.
 *
 * Kept as its own constant rather than derived from `READY_TIER`, because the two are different things
 * that happen to line up — the tier ladder's band boundaries are its own, and deriving one from the other
 * would silently move this gate the next time somebody retunes the ladder.
 */
export const READY_MENTAL_MIN = 5;

/**
 * A canned trigger, for NPCs and for any table with no AI module installed.
 *
 * These are the finite list the user asked for on the NPC side, and they double as the fallback picker,
 * which is why they are worth having even where the compiler is available: a player who does not want to
 * type a sentence gets the six common cases in one click, and every one of them is `judge: false`, so it
 * fires instantly and costs nothing.
 *
 * Reach is passed in rather than baked in because "moves out of my reach" is a different distance for a
 * kobold and a giant, and a hardcoded 5 would make the most-wanted trigger wrong for half the bestiary.
 */
export interface CannedTrigger {
  id: string;
  /** i18n key for the label shown in the picker. */
  label: string;
  descriptor: WatchDescriptor;
}

export function cannedTriggers(reach: number): CannedTrigger[] {
  const key = (id: string) => `NOODLRHOOKS.Ready.Trigger.${id}`;
  return [
    {
      id: "reach",
      label: key("Reach"),
      descriptor: {
        events: ["creature_moves"],
        subject: { side: "enemy", sense: "sight" },
        where: { inReach: true },
        judge: false,
        summary: "an enemy comes within reach",
      },
    },
    {
      id: "near",
      label: key("Near"),
      descriptor: {
        events: ["creature_moves", "creature_appears"],
        subject: { side: "enemy", sense: "sight" },
        where: { ofSelf: 30 },
        judge: false,
        summary: "an enemy comes within 30 feet",
      },
    },
    {
      id: "leaves",
      label: key("Leaves"),
      descriptor: {
        events: ["creature_moves"],
        subject: { side: "enemy", sense: "sight" },
        where: { beyondSelf: reach },
        judge: false,
        summary: "an enemy backs out of reach",
      },
    },
    {
      id: "casts",
      label: key("Casts"),
      descriptor: {
        events: ["creature_casts"],
        subject: { side: "enemy", sense: "sight" },
        judge: false,
        summary: "an enemy starts casting a spell",
      },
    },
    {
      id: "appears",
      label: key("Appears"),
      descriptor: {
        events: ["creature_appears"],
        subject: { side: "enemy", sense: "sight" },
        judge: false,
        summary: "an enemy comes into view",
      },
    },
    {
      id: "ally-hurt",
      label: key("AllyHurt"),
      descriptor: {
        events: ["creature_damaged", "creature_drops"],
        subject: { side: "ally" },
        judge: false,
        summary: "an ally is hurt",
      },
    },
    {
      id: "door",
      label: key("Door"),
      descriptor: {
        events: ["door_changes"],
        judge: false,
        summary: "a door opens or closes",
      },
    },
  ];
}

/**
 * Ability scores for the tier gate, or null when the sheet does not report them.
 *
 * Null rather than zero, and the caller defaults to ALLOWING: an unreadable sheet turning a lich into a
 * beetle is the worse failure, which is the same call `tactics/dossier.ts` makes for the planner.
 */
export function mentalScores(actor: any): { int: number | null; wis: number | null } {
  if (!isDnd5e()) return { int: null, wis: null };
  const read = (key: string): number | null => {
    const value = Number(actor?.system?.abilities?.[key]?.value);
    return Number.isFinite(value) ? value : null;
  };
  return { int: read("int"), wis: read("wis") };
}

/** `flags.<ns>.ready` on an actor forces readying regardless of the tier gate. */
export function forcedReady(actor: any): boolean {
  return hasFlag(actor, "ready");
}
