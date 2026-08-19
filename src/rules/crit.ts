// The 2024 auto-crit rule, as arithmetic. No Foundry globals.
//
// Incapacitated itself does not auto-crit. Paralyzed and Unconscious do, and only when the attacker
// is within 5 feet and the attack roll already hit. The damage dialog is a separate object from the
// attack die: dnd5e defaults it to Critical only when the *stored* attack roll's `isCritical` is
// true. A post-hoc mutation of the live die never reaches that card, which is why a new player
// sees Normal suggested after a melee hit on a held target.

const REACH_FT = 5;
const REACH_SLACK = 0.01;

export function shouldForceCrit(input: {
  reason: string | null;
  distance: number;
  isFumble: boolean;
  total: number;
  ac: number | null;
}): boolean {
  if (!input.reason) return false;
  if (!(input.distance <= REACH_FT + REACH_SLACK)) return false;
  if (input.isFumble) return false;
  const ac = input.ac;
  if (ac === null || !Number.isFinite(ac)) return false;
  if (!Number.isFinite(input.total) || input.total < ac) return false;
  return true;
}

/** Only an Attack activity's damage is this rule. A save, a heal, or a standalone Damage is not. */
export function damageActivityMayCrit(type: string | undefined | null): boolean {
  return type === "attack";
}

/**
 * Make `roll.isCritical` true without claiming the die showed a 20.
 *
 * Sets `criticalSuccess` to the die's own total so a 14 that hit a paralyzed creature reads as a
 * crit. Never `1`: chat treats a critical as a non-miss, and a threshold of 1 would make every
 * later read of this roll a hit regardless of AC.
 */
export function markAttackCritical(roll: {
  d20?: { options?: Record<string, unknown>; total?: number };
  dice?: Array<{ options?: Record<string, unknown>; total?: number }>;
  options?: Record<string, unknown>;
  total?: number;
}): boolean {
  const d20 = roll.d20 ?? roll.dice?.[0];
  const threshold = Number(d20?.total ?? roll.total);
  if (!Number.isFinite(threshold)) return false;
  if (d20?.options) d20.options.criticalSuccess = threshold;
  roll.options ??= {};
  roll.options.criticalSuccess = threshold;
  return true;
}

/**
 * What `#rollDamage` does for a natural 20: default the dialog to Critical and stamp every part.
 *
 * Overwrites a stored `isCritical: false` — that is the whole bug. `??=` would leave the Normal
 * default that `#rollDamage` already wrote from the un-updated card.
 */
export function applyDamageCritDefault(
  config: { isCritical?: boolean; rolls?: Array<{ options?: { isCritical?: boolean } }> },
  dialog: { options?: { defaultButton?: string } },
): void {
  config.isCritical = true;
  dialog.options ??= {};
  dialog.options.defaultButton = "critical";
  for (const part of config.rolls ?? []) {
    part.options ??= {};
    part.options.isCritical = true;
  }
}
