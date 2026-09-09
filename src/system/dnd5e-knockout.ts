// When a killing blow may knock an ordinary NPC Unconscious instead of killing them.
//
// 2024 PHB (Damage and Healing, "Knocking Out a Creature"): when a melee attack would
// reduce a creature to 0 HP, you may instead reduce it to 1 HP and give it Unconscious.
// It starts a Short Rest; Unconscious ends when that rest finishes, or earlier if it
// regains any Hit Points or someone administers first aid (DC 10 Medicine). Instant
// death (leftover ≥ max HP) is still death. They are never Stable and never make death
// saves — those are the 0 HP track.
//
// THE PROMPT IS THE KILLING BLOW, NOT EVERY SWING. A club that leaves the troll standing
// is ordinary damage. Mixed types (piercing + bludgeoning) are not "only Bludgeoning".
// An empty type list is not a guess. Unknown melee is not melee.
//
// Pure. `rules/knockout.ts` reads the card; `rules/dying.ts` applies the outcome.

/** 2024 Short Rest length — the Unconscious clock. */
export const KNOCKOUT_HOURS = 1;

/** Actor flag while a 2024 knockout is in effect. Written only to this module's namespace. */
export const KNOCKOUT_FLAG = "knockout";

/**
 * Health Estimate replaces the token name with a health phrase. At 0 HP an unowned NPC
 * is labelled Dead when `NPCsJustDie` is on. A 2024 knockout is at 1 HP, so that
 * branch should not fire; `dontMarkDead` is still written as a belt. We do not depend
 * on that module.
 */
export const ESTIMATE_NS = "healthEstimate";
export const ESTIMATE_NOT_DEAD = "dontMarkDead";

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

/**
 * What Administer First Aid does to this creature.
 *
 * A 2024 knockout wakes rather than applying Stable, even at 1 HP. Dying at 0
 * is still stabilize. Dead, already-Stable, or standing (no knockout) is none.
 */
export function firstAidKind(input: {
  hp: number;
  knockout: boolean;
  unconscious: boolean;
  dead: boolean;
  stable: boolean;
}): "wake" | "stabilize" | "none" {
  if (input.dead) return "none";
  if (input.knockout) return "wake";
  if (!(input.hp <= 0)) return "none";
  if (input.stable) return "none";
  return "stabilize";
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
