// What stops a departure from provoking an Opportunity Attack. D&D 5e ONLY.
//
// SYSTEM-SPECIFIC BY NECESSITY, quarantined like the rider, declaration, Dash, jump and concealment
// tables. `rules/reactions.ts` is allowed to know that some movement does not provoke; it is never
// allowed to know that a peryton has Flyby.
//
// WHY THIS EXISTS. `provoke()` asked exactly one question — had the creature taken the Disengage action
// — and swung at everything else. The corpus says that is wrong twenty-seven times over (2026-08-13,
// 27 documents across nine books), and the misses split cleanly in two:
//
//   STANDING TRAITS. Flyby and Agile: "doesn't provoke an Opportunity Attack when it moves out of an
//   enemy's reach", always, with nothing to press. Flyby is by far the most common trait of its kind
//   in the Monster Manual, and its whole point is that the creature can dive in, bite, and leave.
//   Automated watchers were snapping at every one of them, every round.
//
//   GRANTED MOVEMENT. Cunning Strike's Withdraw, Remarkable Athlete, Tactical Shift, Brutal Strike,
//   Bait and Switch, and a dozen monster actions: "you can move up to half your Speed without
//   provoking Opportunity Attacks", handed out by using something. Same shape as Disengage — a mark
//   that lasts a while and then stops mattering — so it is recorded through the same turn-stamped
//   mark rather than through a second mechanism.
//
// THE DELIBERATE OVER-PERMISSION. A granted exemption is nearly always bounded ("up to half your
// Speed") and the mark is not: it covers the rest of the turn. That is the safe direction and it is
// chosen rather than tolerated. An opportunity attack that should not have happened is a real hit on
// a real character, rolled and applied before anyone can object; one that is skipped is a swing the GM
// can still call for. Bounding it properly would mean tracking distance-since-the-mark against a
// per-feature allowance, for a rule most tables do not police by hand either.
//
// WHY A TABLE OF NAMES. Foundry stores nothing machine-readable that says "this movement does not
// provoke": there is no flag, no status, no activity field, and dnd5e ships `effects: []` on every one
// of these. The identifier IS the only signal that exists — which is the same finding as the
// concealment table, arrived at from the reaction side.
//
// FAILS SAFE IN BOTH HALVES. An unrecognised trait behaves exactly as it did before this file existed,
// and `flags.<ns>.noOpportunity` on the actor is the escape hatch for anything the list has never
// heard of.

import { readFlag } from "../util/flags";
import { midiConfig, midiOn } from "../util/modules";
import { isDnd5e } from "./dnd5e-rewards";

export interface OpportunityExemption {
  label: string;
  /** True when the exemption applies only to a move made by flying. */
  requiresFlight?: boolean;
}

interface StandingTrait extends OpportunityExemption {
  identifiers: string[];
  pattern: RegExp;
}

/**
 * Traits a creature simply has, which exempt some or all of its movement.
 *
 * Both entries state the rule in the same words and differ only in whether the movement has to be
 * flight, which is why `requiresFlight` is a field rather than two code paths.
 */
const STANDING: StandingTrait[] = [
  {
    label: "Flyby",
    identifiers: ["flyby"],
    pattern: /^\s*flyby\s*$/i,
    // "when it FLIES out of an enemy's reach". A peryton that lands and walks away provokes normally,
    // and honouring that costs one field — while ignoring it would hand every winged creature a
    // permanent Disengage, including on the ground.
    requiresFlight: true,
  },
  {
    label: "Agile",
    identifiers: ["agile"],
    pattern: /^\s*agile\s*$/i,
  },
];

/**
 * Things that, once used, let the creature move without provoking.
 *
 * Identifiers only — no name patterns. These are ordinary English words on a busy sheet ("Withdraw",
 * "Prowl", "Move"), and matching one by name would exempt a homebrew item that merely shares a name
 * with a barbarian feature. The escape hatch covers whatever this list misses.
 *
 * The corpus's full set, so a reader can check it against the books rather than wonder what was left
 * out. Several are monster actions that move the creature themselves, where the exemption is part of
 * the action rather than a licence for the rest of the turn — recorded the same way, on the same
 * reasoning as the over-permission note above.
 */
const GRANTED: string[] = [
  // Player-side
  "cunning-strike", // Withdraw
  "remarkable-athlete",
  "tactical-shift",
  "brutal-strike",
  "heightened-focus",
  "mantle-of-inspiration",
  "bait-and-switch",
  "maneuvering-attack",
  "inspiring-rally",
  "air-essence-shard",
  // Monster actions
  "bubble-dash",
  "charging-horn",
  "watery-rush",
  "prowl",
  "engulf",
  "frenzied-rush",
  "berserk-lashing",
  "bloodthirsty-slash",
  "unraveling-flesh",
  "mauling-charge",
];

/**
 * A reaction that raises AC against an attack that has already been rolled.
 *
 * NEW IN v0.4.2, and only possible because of the damage layer. dnd5e never compares an attack roll to an
 * AC — a person eyeballs it — so before this module started recomputing hits there was no "the attack has
 * been rolled and has not yet landed" moment for Shield to occupy, which is exactly what the reaction
 * layer's own header said was missing and would need midi's `preCheckHits`. It does not: we own the
 * comparison, so we own the window.
 *
 * The bonus is a NUMBER we add to the recorded AC rather than an effect we wait for. Casting Shield does
 * create an Active Effect worth +5, but the verdict is computed against the AC dnd5e wrote on the card at
 * roll time, so waiting for the sheet to catch up would read the old value and decide the wrong way. The
 * effect still lands — it has to, because it lasts a round — it is simply not what settles THIS attack.
 */
export interface AcReaction {
  label: string;
  bonus: number;
}

interface AcTrait {
  identifiers: string[];
  pattern: RegExp;
  /** Flat bonus, or read from the sheet when the rule states one. */
  bonus: number | ((actor: any) => number);
}

const AC_BOOSTS: AcTrait[] = [
  {
    // The spell, and the reason this exists. Cast as a reaction "when you are hit by an attack", +5 until
    // the start of your next turn.
    identifiers: ["shield"],
    // Anchored, because "Shield" is also every suit of armour's shield. Matching loosely here would offer
    // a fighter their buckler as a spell.
    pattern: /^\s*shield\s*$/i,
    bonus: 5,
  },
  {
    // Defensive Duelist: +proficiency bonus, and the sheet states the number, so there is no table of
    // levels to keep. An unreadable proficiency falls back to 2, the lowest it can ever be — under-
    // promising, which is the safe direction for a bonus that decides a hit.
    identifiers: ["defensive-duelist"],
    pattern: /^\s*defensive duelist\s*$/i,
    bonus: (actor: any) => {
      const prof = Number(actor?.system?.attributes?.prof);
      return Number.isFinite(prof) && prof > 0 ? prof : 2;
    },
  },
];

/**
 * Does this item raise AC as a reaction? Returns the bonus, or null.
 *
 * `flags.<ns>.acReaction` is the escape hatch, holding the number: a homebrew Parry worth 3 needs no
 * change here. Same shape and the same reasoning as `noOpportunity` above.
 */
export function acBoostOf(item: any, actor: any): AcReaction | null {
  if (!isDnd5e() || !item) return null;

  const hatch = readFlag(item, "acReaction");
  if (typeof hatch === "number" && hatch > 0) {
    return { label: String(item?.name ?? "a reaction"), bonus: hatch };
  }

  const identifier = identifierOf(item);
  const name = String(item?.name ?? "");
  for (const trait of AC_BOOSTS) {
    const matched = identifier ? trait.identifiers.includes(identifier) : trait.pattern.test(name);
    if (!matched) continue;
    const bonus = typeof trait.bonus === "function" ? trait.bonus(actor) : trait.bonus;
    return bonus > 0 ? { label: name || "a reaction", bonus } : null;
  }
  return null;
}

/**
 * Is midi already putting a reaction prompt in front of somebody?
 *
 * `doReactions` and `gmDoReactions` both default to `"all"`, so unlike almost every other midi mechanic
 * this one IS live on a stock install — which makes it the one place a second offer of ours would be an
 * actual double prompt rather than a theoretical one.
 *
 * Covers the two triggers midi dispatches, "I was hit" and "I was damaged", and NOT the departure. Midi
 * declares a `reactionmoved` / `isMoved` trigger type and dispatches it from none of its eleven
 * `doReactions` call sites, so an opportunity attack has never been offered by it and standing aside from
 * that half would leave the trigger unoffered by anybody. `rules/offer.ts` applies this per trigger for
 * exactly that reason.
 */
export function midiPromptsReactions(): boolean {
  if (!isDnd5e()) return false;
  const settings = midiConfig();
  if (!settings) return false;
  return midiOn(settings.doReactions) || midiOn(settings.gmDoReactions);
}

function identifierOf(doc: any): string {
  return String(doc?.system?.identifier ?? "")
    .trim()
    .toLowerCase();
}

/**
 * Does this creature carry a standing exemption? Returns it, or null.
 *
 * Read off items rather than effects: both traits are permanent features of the creature, and a
 * duplicate as an effect would say nothing new.
 */
export function standingExemption(actor: any): OpportunityExemption | null {
  if (!isDnd5e() || !actor) return null;

  const hatch = readFlag(actor, "noOpportunity");
  if (hatch) return { label: typeof hatch === "string" ? hatch : "a feature" };

  for (const item of actor?.items ?? []) {
    const identifier = identifierOf(item);
    for (const trait of STANDING) {
      if (
        identifier
          ? trait.identifiers.includes(identifier)
          : trait.pattern.test(String(item?.name ?? ""))
      ) {
        return { label: trait.label, requiresFlight: trait.requiresFlight };
      }
    }
  }
  return null;
}

/**
 * Is pressing this one of the things that grants exempt movement?
 *
 * Matched on the ITEM's identifier rather than the activity's name, because these are single-purpose
 * features whose activities midi renames — the same reason `dnd5e-actions.ts` keeps the identifier
 * route. Cunning Strike is the one that holds several branches (Withdraw, Trip, Poison) and only
 * Withdraw grants this, which is deliberately not distinguished: over-permission again, and the
 * alternative is matching a localised activity name.
 */
export function grantsExemptMovement(item: any, activity: any): boolean {
  if (!isDnd5e()) return false;
  const owner = item ?? activity?.item ?? null;
  if (!owner) return false;
  return GRANTED.includes(identifierOf(owner));
}

/**
 * 2024 Polearm Master (and the 2014 wording that is the same trigger): a Reaction when
 * a creature ENTERS your reach, not when it leaves. The leave is an ordinary Opportunity
 * Attack. The sheet's Reactive Strike activity is `type: utility`, so `readActions`
 * never sees it — the feat itself is the signal, and the swing is a held Quarterstaff,
 * Spear, or Heavy+Reach weapon.
 *
 * `flags.<ns>.enterReach` is the hatch for a homebrew that uses the same trigger.
 */
const POLEARM_IDS = ["quarterstaff", "spear", "glaive", "halberd", "pike"];
const POLEARM_NAME = /^\s*(quarterstaff|spear|glaive|halberd|pike)\s*$/i;
const POLEARM_MASTER = /^\s*polearm\s+master\s*$/i;
const REACTIVE_STRIKE = /^\s*reactive\s+strike\s*$/i;

export function isPolearmWeapon(item: any): boolean {
  if (!item || String(item.type ?? "") !== "weapon") return false;
  const identifier = identifierOf(item);
  if (POLEARM_IDS.includes(identifier)) return true;
  const raw = item?.system?.properties;
  const props = raw instanceof Set ? raw : new Set(Array.isArray(raw) ? raw : []);
  if (props.has("rch") && props.has("hvy")) return true;
  return !identifier && POLEARM_NAME.test(String(item?.name ?? ""));
}

export function isPolearmMaster(item: any): boolean {
  if (!item) return false;
  const identifier = identifierOf(item);
  if (identifier === "polearm-master") return true;
  if (REACTIVE_STRIKE.test(String(item?.name ?? ""))) return true;
  if (!identifier && POLEARM_MASTER.test(String(item?.name ?? ""))) return true;
  for (const activity of item?.system?.activities?.contents ??
    Object.values(item?.system?.activities ?? {})) {
    if (REACTIVE_STRIKE.test(String((activity as any)?.name ?? ""))) return true;
  }
  return false;
}

export function canTakeEnterReach(actor: any): boolean {
  if (!isDnd5e() || !actor) return false;
  if (readFlag(actor, "enterReach")) return true;
  for (const item of actor?.items ?? []) if (isPolearmMaster(item)) return true;
  return false;
}
