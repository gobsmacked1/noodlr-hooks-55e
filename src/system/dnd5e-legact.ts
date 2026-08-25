// Legendary-action pool and activation, quarantined from resistance (`dnd5e-legendary.ts`).
//
// dnd5e tracks `resources.legact` itself: `activityActivationTypes.legendary` (and mythic) declare
// `consume.property: "resources.legact"`, and `NPCData#recoverCombatUses` zeroes `spent` at the end
// of that creature's own turn. We never write the pool. We only read what is left and what one
// option costs, so a use through `activity.use` is what spends it.
//
// Lair is a different trigger (initiative 20) and is not this.

const LEGENDARY = new Set(["legendary", "mythic"]);

/** End-of-another-turn options. Not lair. */
export function isLegendaryActivation(raw: unknown): boolean {
  return LEGENDARY.has(
    String(raw ?? "")
      .trim()
      .toLowerCase(),
  );
}

/** How many legendary actions this sheet still has. Null when the pool cannot be read. */
export function legendaryRemaining(actor: any): number | null {
  const value = Number(actor?.system?.resources?.legact?.value);
  if (!Number.isFinite(value)) return null;
  return Math.max(0, value);
}

export function legendaryMax(actor: any): number | null {
  const max = Number(actor?.system?.resources?.legact?.max);
  if (!Number.isFinite(max)) return null;
  return Math.max(0, max);
}

/**
 * What this option costs from the pool.
 *
 * Scalar activations default to 1 in dnd5e. A missing or unreadable value is 1 rather than 0:
 * treating "unset" as free would dump the whole pool on the first other turn.
 */
export function legendaryCost(activity: any): number {
  const n = Number(activity?.activation?.value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
}
