// When a killing blow may knock an ordinary NPC Unconscious instead of killing them.
//
// 2024 PHB: when you reduce a creature to 0 HP with a melee attack, you can knock it out.
// The creature is Unconscious and Stable. We add one house clock: one hour, so the party
// can leave before it wakes. Instant death (leftover ≥ max HP) is still death.
//
// THE PROMPT IS THE KILLING BLOW, NOT EVERY SWING. A club that leaves the troll standing
// is ordinary damage. Mixed types (piercing + bludgeoning) are not "only Bludgeoning".
// An empty type list is not a guess. Unknown melee is not melee.
//
// Pure. `rules/knockout.ts` reads the card; `rules/dying.ts` applies the outcome.

/** How long a knockout lasts. House rule, not RAW — RAW is until they heal or someone wakes them. */
export const KNOCKOUT_HOURS = 1;

export function isBludgeoningOnly(types: readonly string[]): boolean {
  const live = types
    .map((t) => String(t ?? "").toLowerCase().trim())
    .filter((t) => t.length > 0);
  if (!live.length) return false;
  return live.every((t) => t === "bludgeoning");
}

/**
 * Is this a melee attack, from the parts a chat card can name?
 *
 * Fail closed on unknown. Thrown and ranged are not melee. A save-for-damage (Fireball)
 * is not an attack. Empty `attack.type` on a real Attack activity is melee — that is how
 * dnd5e stores a claw or Unarmed Strike.
 */
export function meleeFromParts(input: {
  attackMode?: string;
  activityType?: string;
  attackType?: string;
  actionType?: string;
  rollType?: string;
}): boolean | null {
  const mode = String(input.attackMode ?? "").toLowerCase();
  if (mode === "thrown" || mode === "ranged") return false;

  const roll = String(input.rollType ?? "").toLowerCase();
  if (roll === "save" || roll === "check") return false;

  const attackType = String(input.attackType ?? "").toLowerCase();
  if (attackType === "ranged") return false;
  if (attackType === "melee") return true;

  const actionType = String(input.actionType ?? "").toLowerCase();
  if (actionType === "rwak" || actionType === "rsak") return false;
  if (actionType === "mwak" || actionType === "msak") return true;

  if (String(input.activityType ?? "").toLowerCase() === "attack") return true;

  return null;
}

export function knockoutQualifies(input: {
  types: readonly string[];
  melee: boolean | null;
  leftover: number;
  maxHp: number;
  usesDeathSaves: boolean;
}): { ok: boolean; reason: string } {
  if (input.usesDeathSaves) return { ok: false, reason: "death-saves" };
  if (!(input.maxHp > 0)) return { ok: false, reason: "no-max" };
  if (input.leftover >= input.maxHp) return { ok: false, reason: "massive" };
  if (input.melee !== true) {
    return { ok: false, reason: input.melee === false ? "not-melee" : "unknown-melee" };
  }
  if (!isBludgeoningOnly(input.types)) return { ok: false, reason: "not-bludgeoning-only" };
  return { ok: true, reason: "" };
}
