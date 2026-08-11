// Reading a creature's hit points.
//
// This file is what is left of Noodlr's combat tracker after the split: the ⚔️ ground-truth prompt
// block it used to build is a language-model concern and stayed behind in `noodlr`. What every rules
// layer here actually needed from it was the HP probe.
//
// Best-effort across data shapes rather than hardcoded to one path. dnd5e keeps hit points at
// `system.attributes.hp`, but this module is loaded alongside importers and homebrew that do not
// always agree, and a null answer is handled everywhere it is read — a wrong answer would not be.

export interface Hp {
  value: number;
  max: number;
  temp: number;
}

/** Best-effort HP extraction across common system data shapes. Null when nothing readable. */
export function readHp(actor: any): Hp | null {
  const sys = actor?.system;
  const candidates = [sys?.attributes?.hp, sys?.hp, sys?.health, sys?.attributes?.health];
  for (const hp of candidates) {
    if (
      hp &&
      typeof hp === "object" &&
      (typeof hp.value === "number" || typeof hp.max === "number")
    ) {
      return {
        value: Number(hp.value ?? 0),
        max: Number(hp.max ?? hp.value ?? 0),
        temp: Number(hp.temp ?? 0),
      };
    }
  }
  return null;
}

/** Descriptive HP tier, for cards that should not hand players an enemy's exact numbers. */
export function hpTier(hp: Hp | null): string {
  if (!hp || hp.max <= 0) return "unknown condition";
  const ratio = hp.value / hp.max;
  if (hp.value <= 0) return "down";
  if (ratio > 0.99) return "fresh";
  if (ratio > 0.5) return "wounded";
  if (ratio > 0.25) return "bloodied";
  return "near death";
}

/** Whether a fight is running. */
export function isCombatActive(): boolean {
  return Boolean(game.combat?.started);
}
