// Which statuses change attack rolls, saves, and critical hits. D&D 5e ONLY.
//
// SYSTEM-SPECIFIC BY NECESSITY, quarantined like the concealment and forced-movement tables. The
// system's own `CONFIG.DND5E.conditionEffects.attackDisadvantage` lists Poisoned and is never read
// anywhere in the module (verified 5.3.3). Target-relative rules — advantage against Paralyzed,
// auto-fail Str/Dex, crit-on-hit within 5 ft — live only as journal prose. Nested statuses DO apply
// Incapacitated for Paralyzed/Stunned/Unconscious/Petrified. `isIncapacitated` names those four as
// well as the status itself, so a sheet that applied Paralyzed without the nest still cannot act —
// and so the planner skip, the activity veto, Dodge expiry, and opportunity attacks cannot disagree.
//
// This file is the rule table. The hook engine that applies it lives in `rules/conditions.ts`.

import { midiConfig, midiOn, moduleActive, moduleSetting } from "../util/modules";
import { isDnd5e } from "./dnd5e-rewards";

/** Statuses that grant advantage on attack rolls against the creature that has them. */
export const ATTACK_ADV_VS: ReadonlySet<string> = new Set([
  "blinded",
  "paralyzed",
  "petrified",
  "restrained",
  "stunned",
  "unconscious",
]);

/** Statuses that grant disadvantage on attack rolls against the creature (melee vs ranged differs). */
export const ATTACK_DISADV_VS_MELEE: ReadonlySet<string> = new Set([
  // none in 2024 for melee; prone is advantage
]);

export const ATTACK_DISADV_VS_RANGED: ReadonlySet<string> = new Set(["prone"]);

/** Target statuses that grant melee attack advantage (in addition to ATTACK_ADV_VS). */
export const ATTACK_ADV_VS_MELEE: ReadonlySet<string> = new Set(["prone"]);

/** Attacker statuses that impose disadvantage on its attack rolls. */
export const ATTACK_DISADV_ATTACKER: ReadonlySet<string> = new Set([
  "poisoned",
  "blinded",
  "frightened",
]);

/** Statuses that auto-fail Strength and Dexterity saving throws. */
export const AUTO_FAIL_STR_DEX: ReadonlySet<string> = new Set([
  "paralyzed",
  "petrified",
  "stunned",
  "unconscious",
]);

/** Statuses for which a hit within 5 feet is a critical hit (2024: not auto-hit). */
export const CRIT_ON_HIT_WITHIN_5: ReadonlySet<string> = new Set(["paralyzed", "unconscious"]);

/** The status dnd5e stamps for the Dodge action, and reads nowhere. */
export const DODGING_STATUS = "dodging";

const SAVE_ABILITIES_AUTO_FAIL = new Set(["str", "dex"]);

/** Set, Collection, array, or a single id — Foundry's bag shape moves between versions. */
function bagHas(bag: any, status: string): boolean {
  if (!bag) return false;
  if (typeof bag.has === "function") return Boolean(bag.has(status));
  if (Array.isArray(bag)) return bag.includes(status);
  return typeof bag === "string" && bag === status;
}

/** Does this actor carry any of the named statuses? Respects condition immunity when readable. */
export function hasStatus(actor: any, status: string): boolean {
  if (!actor) return false;
  try {
    const ci = actor.system?.traits?.ci?.value;
    if (ci instanceof Set && ci.has(status)) return false;
    if (Array.isArray(ci) && ci.includes(status)) return false;
  } catch {
    // ignore unreadable immunity
  }
  try {
    if (bagHas(actor.statuses, status)) return true;
  } catch {
    // fall through
  }
  try {
    for (const effect of actor.effects ?? []) {
      if (effect?.disabled) continue;
      const statuses = effect.statuses ?? effect.flags?.core?.statusId;
      if (bagHas(statuses, status)) return true;
    }
  } catch {
    return false;
  }
  return false;
}

export function hasAnyStatus(actor: any, statuses: ReadonlySet<string>): string | null {
  for (const s of statuses) {
    if (hasStatus(actor, s)) return s;
  }
  return null;
}

/**
 * Statuses that are Incapacitated, or that grant it.
 *
 * dnd5e nests `incapacitated` on the four; a DDB or premade effect sometimes ships Paralyzed
 * without the nest. The printed rule is the same either way. Grappled / Restrained / Prone stay
 * out — those restrict movement, not the turn.
 */
export const INCAPACITATED_BY: ReadonlySet<string> = new Set([
  "incapacitated",
  "paralyzed",
  "petrified",
  "stunned",
  "unconscious",
]);

export function isIncapacitated(actor: any): boolean {
  return hasAnyStatus(actor, INCAPACITATED_BY) !== null;
}

/**
 * Why a reaction is illegal, or null if it is legal.
 *
 * Same walk as `isIncapacitated` — effects, not only `actor.statuses`. A Stunned Beholder whose
 * Active Effect landed but whose prepared Set has not caught up must not take an Opportunity Attack.
 * `dead` is extra: Incapacitated does not name it, and a corpse still has a reaction slot on paper.
 */
export function cannotReactReason(actor: any): string | null {
  if (!actor) return "no actor";
  const incap = hasAnyStatus(actor, INCAPACITATED_BY);
  if (incap) return incap;
  if (hasStatus(actor, "dead")) return "dead";
  return null;
}

export function canReact(actor: any): boolean {
  return cannotReactReason(actor) === null;
}

export function autoFailsSave(actor: any, ability: string): string | null {
  const ab = String(ability ?? "").toLowerCase();
  if (!SAVE_ABILITIES_AUTO_FAIL.has(ab)) return null;
  return hasAnyStatus(actor, AUTO_FAIL_STR_DEX);
}

export function attackIsMelee(activity: any): boolean {
  const value = String(
    activity?.attack?.type?.value ?? activity?.item?.system?.actionType ?? "",
  ).toLowerCase();
  if (value.includes("ranged") || value === "rwak" || value === "rsak") return false;
  if (value.includes("melee") || value === "mwak" || value === "msak") return true;
  // Empty attack type on a prepared dnd5e weapon means melee/weapon (system fills it later).
  const range = activity?.range?.units ?? activity?.item?.system?.range?.units;
  if (range === "ft" || range === "mi") {
    const dist = Number(activity?.range?.value ?? activity?.item?.system?.range?.value);
    if (Number.isFinite(dist) && dist > 10) return false;
  }
  return true;
}

export interface AttackModifiers {
  advantage: string[];
  disadvantage: string[];
}

/** Pure: which advantage/disadvantage sources apply for this attacker vs this target. */
export function attackModifiers(
  attacker: any,
  target: any,
  melee: boolean,
  opts?: { fearSourceVisible?: boolean | null },
): AttackModifiers {
  const advantage: string[] = [];
  const disadvantage: string[] = [];
  if (!isDnd5e()) return { advantage, disadvantage };

  for (const s of ATTACK_DISADV_ATTACKER) {
    if (!hasStatus(attacker, s)) continue;
    if (s === "frightened") {
      // No readable fear source → apply and log upstream; visible source → only if still in sight.
      if (opts?.fearSourceVisible === false) continue;
    }
    disadvantage.push(s);
  }

  if (target) {
    for (const s of ATTACK_ADV_VS) {
      if (hasStatus(target, s)) advantage.push(`vs:${s}`);
    }
    if (melee) {
      for (const s of ATTACK_ADV_VS_MELEE) {
        if (hasStatus(target, s)) advantage.push(`vs:${s}`);
      }
      for (const s of ATTACK_DISADV_VS_MELEE) {
        if (hasStatus(target, s)) disadvantage.push(`vs:${s}`);
      }
    } else {
      for (const s of ATTACK_DISADV_VS_RANGED) {
        if (hasStatus(target, s)) disadvantage.push(`vs:${s}`);
      }
    }
  }

  return { advantage, disadvantage };
}

export function critOnHitWithin5(target: any): string | null {
  return hasAnyStatus(target, CRIT_ON_HIT_WITHIN_5);
}

/** The creature's best movement speed in scene units, or 0 when it cannot move at all. */
function bestSpeed(actor: any): number {
  const movement = actor?.system?.attributes?.movement ?? {};
  let best = 0;
  for (const key of ["walk", "fly", "swim", "climb", "burrow"]) {
    const value = Number((movement as any)[key]);
    if (Number.isFinite(value) && value > best) best = value;
  }
  return best;
}

/**
 * Is this creature getting the benefit of the Dodge action right now?
 *
 * The status is only half the answer: 2024 ends the benefits "if you have the Incapacitated condition or
 * your Speed is 0", and both of those can arrive after the button was pressed. Reading the two live is
 * why nothing has to watch for a grapple or a stun in order to take Dodge away — a creature that is
 * paralysed mid-round simply stops qualifying.
 */
export function isDodging(actor: any): boolean {
  if (!isDnd5e() || !hasStatus(actor, DODGING_STATUS)) return false;
  if (isIncapacitated(actor)) return false;
  return bestSpeed(actor) > 0;
}

const AC5E = "automated-conditions-5e";

function ac5eSetting(key: string): unknown {
  return moduleActive(AC5E) ? moduleSetting(AC5E, key) : undefined;
}

/**
 * Is Automated Conditions 5e handling the condition-to-roll rules, so that we must not?
 *
 * Read from AC5e's source rather than its README, which is out of date. Its `automateStatuses`
 * setting (default ON) drives a status table covering everything this file does and a good deal
 * more — attacker Prone and Restrained disadvantage, Invisible, Grappled, visibility-aware Blinded,
 * legacy Exhaustion — through the same `preRollAttack` and `preRollSavingThrow` hooks we use.
 *
 * Standing down whole rather than merging is deliberate, and it is what AC5e itself does when
 * midi owns range. The two implementations disagree on mechanism even where they agree on the
 * rule: we cancel an auto-failed save outright, AC5e rolls it against DC 999 with the critical
 * threshold pushed to 21; we force a critical after a hit is confirmed, AC5e marks the damage roll
 * critical up front. Whichever module's hook registers first silently wins, which is not a rule to
 * build on — and since AC5e is a superset here, deferring costs the table nothing.
 *
 * AC5e offers an override API (`ac5e.statusEffectsOverrides.register`) that could suppress its
 * rules one status at a time. Not used: it would make us the module that reaches into another's
 * internals to win a fight neither of us needs to have.
 */
export function ac5eOwnsConditions(): boolean {
  if (!isDnd5e()) return false;
  return ac5eSetting("automateStatuses") === true;
}

/**
 * Is AC5e also refusing activity use by Incapacitated creatures?
 *
 * Narrower than the above, because AC5e's veto is gated behind `autoArmorSpellUse`, which ships
 * `"off"`. At stock settings it warns about nothing and blocks nothing, so our refusal is the only
 * one and must stay. A GM who has set that to warn or enforce has asked AC5e to own it.
 */
/**
 * Is AC5e also enforcing the Dodge action?
 *
 * Narrower than `ac5eOwnsConditions`, and the gap between the two is a real hole rather than a nicety.
 * AC5e's `dodging` entry (`ac5e-setpieces.mjs:967`) is a superset of ours — it tests whether the dodger
 * can see the attacker with its own visibility machinery, checks Incapacitated and checks Speed — but
 * every branch of it is gated on `expandedConditions`, which ships **false**. `automateStatuses` ships
 * **true**. So at stock AC5e settings the whole of our condition layer stands down while AC5e's Dodge
 * does nothing, and the rule is enforced by nobody at all.
 *
 * Hence a separate predicate and a separate gate: the Dodge rules keep running when AC5e is present but
 * has not been asked to expand, and step aside the moment it has.
 */
export function ac5eOwnsDodging(): boolean {
  return ac5eOwnsConditions() && ac5eSetting("expandedConditions") === true;
}

export function ac5eOwnsIncapacitatedUse(): boolean {
  if (!isDnd5e()) return false;
  const mode = ac5eSetting("autoArmorSpellUse");
  return Boolean(mode && mode !== "off");
}

/**
 * Is somebody else already applying the unseen-attacker and unseen-target rules?
 *
 * Both of AC5e's gates ship ON, so on a world that has AC5e at all the answer is normally yes.
 * `addSyntheticVisibilityAttackOptins` (`ac5e-setpieces.mjs:813`) runs whenever `automateStatuses`
 * and `visibilityChecks` are both set — the latter registers `default: true` at
 * `ac5e-settings.mjs:184-189` — and pushes a Disadvantage entry for "cannot see target" and an
 * Advantage entry for "target cannot see attacker", each passed to `addDefaultOptinSelection(…,
 * true)`, i.e. ticked rather than merely offered.
 *
 * The midi arm is not an extra safety net but the same rule arriving from AC5e's own stand-aside:
 * `midiHandlesInvisibilityAttackRules` (`:783`) makes AC5e withdraw when midi's `invisAdvantage`
 * optional rule is live, and in that case midi is applying it, so we still must not.
 */
export function visibilityAttackRulesOwned(): boolean {
  if (!isDnd5e()) return false;
  if (ac5eOwnsConditions() && ac5eSetting("visibilityChecks") === true) return true;
  const midi = midiConfig();
  if (!midi?.optionalRulesEnabled) return false;
  return midiOn(midi?.optionalRules?.invisAdvantage);
}

/**
 * Is somebody else applying Disadvantage to a ranged attack made beside an enemy?
 *
 * Almost always no, and that is the finding. AC5e has the rule — `rangedNearbyFoes` inside
 * `autoRangeChecks` — but that setting is a SetField registering `default: []`
 * (`ac5e-settings.mjs:213-229`), so every one of its range checks is off until a GM ticks it. midi's
 * `nearbyFoe` sits under `optionalRules`, which `optionalRulesEnabled` gates and which ships false.
 * At stock settings for both modules this rule is enforced by nobody, which is why we enforce it.
 */
export function rangedNearbyFoeOwned(): boolean {
  if (!isDnd5e()) return false;
  const checks = ac5eSetting("autoRangeChecks") as any;
  try {
    if (checks && typeof checks.has === "function" && checks.has("rangedNearbyFoes")) return true;
    if (Array.isArray(checks) && checks.includes("rangedNearbyFoes")) return true;
  } catch {
    /* an unreadable setting is not evidence that somebody else owns the rule */
  }
  const midi = midiConfig();
  if (!midi?.optionalRulesEnabled) return false;
  return Boolean(midi?.optionalRules?.nearbyFoe);
}
