// Turning a compiled `Quantity` into a number, here, at the moment the rule fires.
//
// Three shapes, and the reason there are three is the corpus: Tactical Charge mined as
// `distance: "half Speed"` while Watery Rebuke mined as `distance: 30`. A schema that only admits
// numbers forces the compiler to invent one for the first case, and the number it invents belongs to
// whichever creature the book happened to be describing.
//
// Dice are rolled by Foundry, never by the model and never by arithmetic here. That is the oldest
// standing rule in the project and it applies to a compiled descriptor exactly as it applies to a
// `{{roll:}}` macro: a model that supplies its own totals biases towards narrative convenience.

import { warn } from "../constants";
import type { NamedQuantity, Quantity } from "../integration/capability";
import { readLocomotion } from "../core/locomotion";

export interface QuantitySubject {
  actor?: any;
  token?: any;
  /** Spell slot level, when a rule scales with upcasting. */
  spellLevel?: number;
  /** Movement already spent this turn, for `remaining_movement`. */
  movementUsed?: number;
}

/** Speed in scene units, by whichever mode the creature actually travels fastest. */
function speedOf(subject: QuantitySubject): number | null {
  try {
    const locomotion = readLocomotion(subject.actor);
    const speed = Number(locomotion?.speed);
    return Number.isFinite(speed) ? speed : null;
  } catch {
    return null;
  }
}

function namedValue(named: NamedQuantity, subject: QuantitySubject): number | null {
  const actor = subject.actor;
  switch (named) {
    case "speed":
      return speedOf(subject);
    case "half_speed": {
      const speed = speedOf(subject);
      return speed === null ? null : Math.floor(speed / 2);
    }
    case "remaining_movement": {
      const speed = speedOf(subject);
      if (speed === null) return null;
      return Math.max(0, speed - (Number(subject.movementUsed) || 0));
    }
    case "reach": {
      // Not a rules calculation: the sheet states it, and where it does not, one grid step is the
      // same fallback the planner has always used rather than a claim about polearms.
      const stated = Number(actor?.system?.attributes?.reach);
      if (Number.isFinite(stated) && stated > 0) return stated;
      return Number((canvas as any)?.scene?.grid?.distance) || 5;
    }
    case "proficiency_bonus": {
      const bonus = Number(actor?.system?.attributes?.prof);
      return Number.isFinite(bonus) ? bonus : null;
    }
    case "spell_level": {
      const level = Number(subject.spellLevel);
      return Number.isFinite(level) ? level : null;
    }
    case "character_level": {
      const level = Number(actor?.system?.details?.level);
      return Number.isFinite(level) ? level : null;
    }
    case "challenge_rating": {
      const cr = Number(actor?.system?.details?.cr);
      return Number.isFinite(cr) ? cr : null;
    }
    default:
      return null;
  }
}

/**
 * Resolve a quantity to a number, or null when it cannot be resolved.
 *
 * Null rather than zero, everywhere. Zero is a legitimate answer that an executor would act on — heal
 * for 0, push 0 feet — and quietly substituting it for "could not tell" turns an unreadable sheet into
 * a rule that appears to have fired correctly.
 */
export async function resolveQuantity(
  quantity: Quantity | undefined,
  subject: QuantitySubject = {},
): Promise<number | null> {
  if (!quantity || typeof quantity !== "object") return null;

  let total = 0;
  let resolved = false;

  if (typeof quantity.value === "number" && Number.isFinite(quantity.value)) {
    total += quantity.value;
    resolved = true;
  }

  if (typeof quantity.named === "string") {
    const named = namedValue(quantity.named as NamedQuantity, subject);
    if (named === null) return null;
    total += named;
    resolved = true;
  }

  if (typeof quantity.dice === "string" && quantity.dice.trim()) {
    const rolled = await rollDice(quantity.dice, subject);
    if (rolled === null) return null;
    total += rolled;
    resolved = true;
  }

  if (quantity.perLevelAbove && Number.isFinite(Number(subject.spellLevel))) {
    const above = Number(subject.spellLevel) - Number(quantity.perLevelAbove.level ?? 0);
    if (above > 0) {
      if (Number.isFinite(Number(quantity.perLevelAbove.value))) {
        total += Number(quantity.perLevelAbove.value) * above;
      }
      if (quantity.perLevelAbove.dice) {
        for (let i = 0; i < above; i++) {
          const extra = await rollDice(quantity.perLevelAbove.dice, subject);
          if (extra !== null) total += extra;
        }
      }
    }
  }

  return resolved ? total : null;
}

/** A real Foundry roll, evaluated against the actor's own roll data. */
async function rollDice(formula: string, subject: QuantitySubject): Promise<number | null> {
  try {
    const data = subject.actor?.getRollData?.() ?? {};
    const Roll = (globalThis as any).Roll;
    if (!Roll) return null;
    const roll = new Roll(formula, data);
    await roll.evaluate();
    const total = Number(roll.total);
    return Number.isFinite(total) ? total : null;
  } catch (err) {
    warn(`could not roll "${formula}" for a capability:`, err);
    return null;
  }
}

/** The synchronous half, for predicates that must answer during a `pre*` hook. Dice yield null. */
export function resolveQuantitySync(
  quantity: Quantity | undefined,
  subject: QuantitySubject = {},
): number | null {
  if (!quantity || typeof quantity !== "object") return null;
  if (typeof quantity.dice === "string" && quantity.dice.trim()) return null;
  let total = 0;
  let resolved = false;
  if (typeof quantity.value === "number" && Number.isFinite(quantity.value)) {
    total += quantity.value;
    resolved = true;
  }
  if (typeof quantity.named === "string") {
    const named = namedValue(quantity.named as NamedQuantity, subject);
    if (named === null) return null;
    total += named;
    resolved = true;
  }
  return resolved ? total : null;
}

/**
 * A number OR a quantity, which is what a hand-edited descriptor tends to contain.
 *
 * The validator insists on the object form for the keys it polices, but a GM editing a capability on
 * the sheet types `15`, and refusing that would be pedantry rather than safety.
 */
export function asQuantity(value: unknown): Quantity | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return { value };
  if (typeof value === "object" && value !== null) return value as Quantity;
  return undefined;
}
