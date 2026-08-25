// Legendary-action pool and activation, quarantined from resistance (`dnd5e-legendary.ts`).
//
// dnd5e tracks `resources.legact` itself: `activityActivationTypes.legendary` (and mythic) declare
// `consume.property: "resources.legact"`. We never write the pool. We only read what is left and
// what one option costs, so a use through `activity.use` is what spends it.
//
// RAW VS DND5E REFILL — THIS WILL BE ASKED FOR AS AN OVERRIDE, DO NOT "FIX" IT IN PASSING.
// 2024 MM and dnd5e's own flavour (`DND5E.LegendaryAction.Description`) refill at the START of
// its turn. `NPCData#recoverCombatUses` zeroes `spent` on `encounter` or `turnEnd` and ignores
// `turnStart`. Combat5e#_onEndTurn is the hook. Same number of spends in a round if it cannot
// use a legendary action on its own turn (the printed restriction). The visible disagreement is
// the counter during its own turn: RAW 3/3 unused, dnd5e last-round leftover unused.
// A RAW override means taking the refill away from the system, not adding turnStart on top
// (that double-fills if they ever move the hook). Planned row: `legendaryActionRefill`.
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
