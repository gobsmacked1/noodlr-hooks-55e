// Turning a compiled `duration` Quantity into the Active Effect fields Foundry expires.
//
// Phase 4's first job, and the reason it is a file rather than four lines in the executor: two
// schemas and a source-versus-target distinction all have to agree, and a second copy of any of
// them is how a Ray of Frost ends on the target's turn instead of the caster's.
//
// WHAT CORE ACTUALLY EXPIRES. v14 Active Effects carry `duration.{value, units, expiry, expired}`
// and `start.{time, round, turn, combat, combatant}`. `CONST.ACTIVE_EFFECT_EXPIRY_EVENTS` is
// combatStart / roundStart / turnStart / combatEnd / roundEnd / turnEnd. Source-turn versus
// target-turn is `start.combatant`, not a different event name — DAE's `sourceStart` is
// `turnStart` plus the caster's combatant id, and that is the translation this file owns.
//
// TWO WRITES THAT LOOKED CORRECT AND EXPIRED ON THE NEXT WOLF (Ray of Frost, 2026-08-19).
// `start.combat` is a ForeignDocumentField. Core does `combat === start.combat` to decide whether
// `start.combatant` is the expiry combatant; an id string fails that, and the fallback is
// `getCombatantsByActor(this.actor)` — the creature wearing the Slow, not the caster. And
// `units: "turns"` remaining counts initiative slots, so value:1 dies the moment anyone else
// acts. Write the Combat document, and count remaining in rounds.
//
// v13 still uses `duration.{rounds, turns, seconds, startTime, startRound, startTurn}`. The live
// host is v14; the module's compatibility floor is 13. Both shapes are written so a downgrade
// does not silently become a permanent Slow.
//
// A QUANTITY WITHOUT A TIME UNIT IS NOT A DURATION. `{value: 10, units: "ft"}` is a distance that
// happened to be filed under `duration`. Returning a 10-round effect for that would invent a
// number the descriptor never stated. Null, and the caller refuses.

import type { Quantity, Unit } from "../integration/capability";

/** Who's-turn expiry, named the way DAE and dnd5e 6.0 name them so an import translation can reuse the list. */
export const UNTIL = [
  "sourceStart",
  "sourceEnd",
  "targetStart",
  "targetEnd",
  "combatEnd",
] as const;

export type Until = (typeof UNTIL)[number];

const TIME_UNITS = new Set<Unit>(["rounds", "turns", "minutes", "hours", "days"]);

const SECONDS: Record<string, number> = {
  minutes: 60,
  hours: 3600,
  days: 86400,
};

/** Core expiry events. Source/target are not among them — those become `start.combatant`. */
export type CoreExpiry =
  | "combatStart"
  | "roundStart"
  | "turnStart"
  | "combatEnd"
  | "roundEnd"
  | "turnEnd";

export interface DurationWorld {
  /** `game.release.generation`. 14 writes the new schema; anything else writes the old one. */
  generation: number;
  worldTime: number;
  combat?: {
    id?: string | null;
    /**
     * The Combat document itself. `start.combat` is a ForeignDocumentField compared by
     * identity (`combat === start.combat`) in both remaining-math and `isExpiryEvent`.
     * An id string makes every comparison fail: Foundry then treats the afflicted
     * creature as the expiry combatant, so Ray of Frost dies on the wolf's turn.
     */
    document?: { id?: string } | null;
    round?: number | null;
    turn?: number | null;
    sourceCombatantId?: string | null;
    targetCombatantId?: string | null;
  } | null;
}

export interface EffectDurationPayload {
  duration: Record<string, unknown>;
  start?: Record<string, unknown>;
}

export function isUntil(value: unknown): value is Until {
  return typeof value === "string" && (UNTIL as readonly string[]).includes(value);
}

/**
 * Resolve a compiled duration (and optional `until`) into fields an Active Effect will accept.
 *
 * Null when there is nothing to write — no quantity, no `until`, or a quantity that is not time.
 * A caller that needs a duration to be honest about the rule must treat null as a refusal, not as
 * "permanent". `apply_status` is the exception: a Hold Person with no duration lasts until the
 * repeat save or a human clears it, which is what the book says.
 */
export function durationPayload(
  quantity: Quantity | undefined,
  until: unknown,
  world: DurationWorld,
): EffectDurationPayload | null {
  const namedUntil = isUntil(until) ? until : undefined;
  const units = quantity?.units;
  const value = typeof quantity?.value === "number" && Number.isFinite(quantity.value) ? quantity.value : null;

  if (units && !TIME_UNITS.has(units)) return null;

  if (value === null && !namedUntil) return null;
  if (value !== null && value <= 0 && !namedUntil) return null;

  const amount = value !== null && value > 0 ? value : namedUntil ? 1 : null;
  if (amount === null && namedUntil !== "combatEnd") return null;

  const unit: Unit | undefined = units ?? (namedUntil && namedUntil !== "combatEnd" ? "turns" : undefined);
  const resolvedUntil = namedUntil ?? defaultUntil(unit);

  if (world.generation >= 14) return v14(amount, unit, resolvedUntil, world);
  return v13(amount, unit, world);
}

function defaultUntil(units: Unit | undefined): Until | undefined {
  // One turn with no `until` is "until the start of the caster's next turn" — Ray of Frost,
  // Reckless Attack, Zephyr Strike. Guessing the target's turn ends the slow before they walk.
  if (units === "turns") return "sourceStart";
  return undefined;
}

function v14(
  amount: number | null,
  units: Unit | undefined,
  until: Until | undefined,
  world: DurationWorld,
): EffectDurationPayload {
  const duration: Record<string, unknown> = { expired: false };
  const start: Record<string, unknown> = { time: world.worldTime };

  if (world.combat) {
    if (world.combat.document) start.combat = world.combat.document;
    else if (world.combat.id) start.combat = world.combat.id;
    if (Number.isFinite(Number(world.combat.round))) start.round = Number(world.combat.round);
    if (Number.isFinite(Number(world.combat.turn))) start.turn = Number(world.combat.turn);
  }

  if (until === "combatEnd") {
    duration.expiry = "combatEnd";
    if (amount !== null) {
      duration.value = amount;
      duration.units = units ?? "rounds";
    }
    return { duration, start };
  }

  if (units && SECONDS[units] && amount !== null) {
    duration.value = amount;
    duration.units = units;
    return { duration, start };
  }

  if (units === "rounds" && amount !== null) {
    duration.value = amount;
    duration.units = "rounds";
    duration.expiry = "roundStart";
    return { duration, start };
  }

  if (units === "turns" && amount !== null) {
    const mapped = mapUntil(until, world);
    duration.expiry = mapped.expiry;
    if (mapped.combatant) start.combatant = mapped.combatant;
    // Foundry's units:"turns" remaining counts every initiative SLOT. "Until the start
    // of your next turn" is one of the caster's turns, which is a ROUND of remaining
    // plus a turnStart event on that combatant. Writing value:1 / units:turns made
    // Ray of Frost's remaining hit 0 the moment the next wolf acted — the sheet never
    // showed 40 ft even when the expiry event was aimed at the right creature.
    duration.value = amount;
    duration.units = "rounds";
    return { duration, start };
  }

  if (until) {
    const mapped = mapUntil(until, world);
    duration.expiry = mapped.expiry;
    if (mapped.combatant) start.combatant = mapped.combatant;
    if (amount !== null) {
      duration.value = amount;
      duration.units = units ?? "turns";
    }
    return { duration, start };
  }

  return { duration, start };
}

function v13(
  amount: number | null,
  units: Unit | undefined,
  world: DurationWorld,
): EffectDurationPayload {
  const duration: Record<string, unknown> = { startTime: world.worldTime };
  if (world.combat) {
    if (Number.isFinite(Number(world.combat.round))) duration.startRound = Number(world.combat.round);
    if (Number.isFinite(Number(world.combat.turn))) duration.startTurn = Number(world.combat.turn);
  }
  if (amount === null) return { duration };
  if (units && SECONDS[units]) {
    duration.seconds = amount * SECONDS[units];
    return { duration };
  }
  if (units === "turns") duration.turns = amount;
  else if (units === "rounds") duration.rounds = amount;
  return { duration };
}

function mapUntil(
  until: Until | undefined,
  world: DurationWorld,
): { expiry: CoreExpiry; combatant?: string } {
  const source = world.combat?.sourceCombatantId || undefined;
  const target = world.combat?.targetCombatantId || undefined;
  switch (until) {
    case "sourceEnd":
      return { expiry: "turnEnd", combatant: source };
    case "targetStart":
      return { expiry: "turnStart", combatant: target };
    case "targetEnd":
      return { expiry: "turnEnd", combatant: target };
    case "combatEnd":
      return { expiry: "combatEnd" };
    case "sourceStart":
    default:
      return { expiry: "turnStart", combatant: source };
  }
}

/** Snapshot the live world into the shape `durationPayload` reads. Foundry-only. */
export function worldOf(ctx: {
  self?: { actor?: any };
  target?: { actor?: any };
}): DurationWorld {
  const combat = (globalThis as any).game?.combat ?? null;
  return {
    generation: Number((globalThis as any).game?.release?.generation) || 13,
    worldTime: Number((globalThis as any).game?.time?.worldTime) || 0,
    combat: combat
      ? {
          id: combat.id ?? null,
          document: combat,
          round: combat.round ?? null,
          turn: combat.turn ?? null,
          sourceCombatantId: combatantIdOf(ctx.self?.actor, combat),
          targetCombatantId: combatantIdOf(ctx.target?.actor, combat),
        }
      : null,
  };
}

export function combatantIdOf(actor: any, combat: any): string | null {
  const uuid = String(actor?.uuid ?? "");
  if (!uuid || !combat?.combatants) return null;
  const found = combat.combatants.find?.((c: any) => String(c?.actor?.uuid ?? "") === uuid);
  return found?.id ? String(found.id) : null;
}
