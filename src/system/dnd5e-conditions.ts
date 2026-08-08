// Which statuses change attack rolls, saves, and critical hits. D&D 5e ONLY.
//
// SYSTEM-SPECIFIC BY NECESSITY, quarantined like the concealment and forced-movement tables. The
// system's own `CONFIG.DND5E.conditionEffects.attackDisadvantage` lists Poisoned and is never read
// anywhere in the module (verified 5.3.3). Target-relative rules — advantage against Paralyzed,
// auto-fail Str/Dex, crit-on-hit within 5 ft — live only as journal prose. Nested statuses DO apply
// Incapacitated for Paralyzed/Stunned/Unconscious/Petrified; nothing consults that either.
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

const SAVE_ABILITIES_AUTO_FAIL = new Set(["str", "dex"]);

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
    if (actor.statuses?.has?.(status)) return true;
  } catch {
    // fall through
  }
  try {
    for (const effect of actor.effects ?? []) {
      if (effect?.disabled) continue;
      const statuses = effect.statuses ?? effect.flags?.core?.statusId;
      if (statuses instanceof Set && statuses.has(status)) return true;
      if (Array.isArray(statuses) && statuses.includes(status)) return true;
      if (typeof statuses === "string" && statuses === status) return true;
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

export function isIncapacitated(actor: any): boolean {
  return hasStatus(actor, "incapacitated");
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

const AC5E = "automated-conditions-5e";

function ac5eSetting(key: string): unknown {
  try {
    if (!(game as any).modules?.get?.(AC5E)?.active) return undefined;
    return game.settings.get(AC5E, key);
  } catch {
    return undefined;
  }
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
export function ac5eOwnsIncapacitatedUse(): boolean {
  if (!isDnd5e()) return false;
  const mode = ac5eSetting("autoArmorSpellUse");
  return Boolean(mode && mode !== "off");
}
