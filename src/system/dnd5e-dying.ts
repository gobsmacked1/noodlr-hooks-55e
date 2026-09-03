// Who dies, who makes death saves, and when excess damage kills outright. D&D 5e ONLY.
//
// Stock dnd5e floors HP at 0 and never applies Unconscious, Dead, or death-save failures from damage
// (verified 5.3.3: `applyDamage` clamps; `onUpdateHP` only bloodies + concentration). Instant death
// and damage-at-0 failures live only as journal prose. This file is the rule table; the engine is
// `rules/dying.ts`.


/** Characters, player-owned creatures, and (when opted in) NPCs flagged `traits.important`. */
export function usesDeathSaves(actor: any, honorImportantNpc: boolean): boolean {
  if (!actor) return false;
  if (actor.type === "character") return true;
  if (actor.hasPlayerOwner) return true;
  if (!honorImportantNpc) return false;
  try {
    return Boolean(actor.system?.traits?.important);
  } catch {
    return false;
  }
}

export function hpSnapshot(actor: any): {
  value: number;
  temp: number;
  max: number;
  failures: number;
  successes: number;
} {
  const hp = actor?.system?.attributes?.hp;
  const death = actor?.system?.attributes?.death;
  const max = Number(hp?.effectiveMax ?? hp?.max ?? 0) || 0;
  return {
    value: Number(hp?.value ?? 0) || 0,
    temp: Number(hp?.temp ?? 0) || 0,
    max,
    failures: Number(death?.failure ?? 0) || 0,
    successes: Number(death?.success ?? 0) || 0,
  };
}

/**
 * Excess damage past 0 HP that would kill outright.
 * Formula: damage that reaches real HP, minus current HP; instant death when that leftover ≥ max HP.
 * Temp HP is absorbed first (same order as `Actor5e.applyDamage`).
 */
export function leftoverPastZero(oldHp: number, oldTemp: number, amount: number): number {
  if (!(amount > 0)) return 0;
  const afterTemp = amount - Math.min(Math.max(oldTemp, 0), amount);
  return Math.max(0, afterTemp - Math.max(oldHp, 0));
}

export function isInstantDeath(
  oldHp: number,
  oldTemp: number,
  maxHp: number,
  amount: number,
): boolean {
  if (!(maxHp > 0) || !(amount > 0)) return false;
  // Already dead territory: damage ≥ max while at 0 also kills.
  return leftoverPastZero(oldHp, oldTemp, amount) >= maxHp;
}

/** Failures to add for damage while dying. Critical hits count as two (2024). */
export function deathFailuresFromDamage(critical: boolean): number {
  return critical ? 2 : 1;
}

