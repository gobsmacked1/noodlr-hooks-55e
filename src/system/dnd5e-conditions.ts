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

