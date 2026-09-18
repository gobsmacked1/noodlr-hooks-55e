// Follow-on damage on a concentration item (Witch Bolt's later 1d12).
//
// The first activity is an Attack that names a creature. The later one is a
// Damage activity whose target override is empty — it does not ask for a new
// token, and auto-damage then reads nobody. That is not a missing target; it
// is the same bolt still on the creature that was hit.

import { templateTypeOf } from "./dnd5e-target";

function activitiesOf(item: any): any[] {
  const collection = item?.system?.activities;
  if (!collection) return [];
  if (Array.isArray(collection.contents)) return collection.contents;
  if (Array.isArray(collection)) return collection;
  return [];
}

/** Later-turn Damage beside an Attack on the same item (Witch Bolt's 1d12). */
export function isFollowOnDamage(activity: any): boolean {
  if (String(activity?.type ?? "").toLowerCase() !== "damage") return false;
  if (templateTypeOf(activity)) return false;
  if (activity?.consumption?.spellSlot === true) return false;
  const item = activity?.item;
  if (!item) return false;
  return activitiesOf(item).some((a) => a && a !== activity && String(a?.type ?? "") === "attack");
}

export function followOnDamageOf(item: any): any | null {
  if (!item) return null;
  for (const activity of activitiesOf(item)) {
    if (isFollowOnDamage({ ...activity, item })) return activity;
  }
  return null;
}

function sameRef(a: any, b: any): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const aId = String(a.id ?? a._id ?? "");
  const bId = String(b.id ?? b._id ?? "");
  if (aId && aId === bId) return true;
  const aUuid = String(a.uuid ?? "");
  const bUuid = String(b.uuid ?? "");
  return Boolean(aUuid) && aUuid === bUuid;
}

/** Concentration started on this initiative slot — the 1d12 waits until a later turn. */
export function startedOnSlot(
  start: { startRound?: number; startTurn?: number; start?: { round?: number; turn?: number } } | null,
  slot: { round: number; turn: number },
): boolean {
  if (!start) return false;
  const round = Number(start.startRound ?? start.start?.round);
  const turn = Number(start.startTurn ?? start.start?.turn);
  return Number.isFinite(round) && round === slot.round && Number.isFinite(turn) && turn === slot.turn;
}

/**
 * Witch Bolt ends when the named creature is gone, dead, or at 0 HP.
 *
 * Printed text names range and cover, not death — but a killed target is how
 * the table (and AA) expect the beam to drop. Missing is "deleted", not
 * "could not resolve".
 */
export function followOnTargetOut(status: {
  missing?: boolean;
  defeated?: boolean;
  dead?: boolean;
  hp?: number | null;
}): boolean {
  if (status.missing) return true;
  if (status.defeated) return true;
  if (status.dead) return true;
  const hp = status.hp;
  return typeof hp === "number" && Number.isFinite(hp) && hp <= 0;
}

/**
 * Printed Witch Bolt: the spell ends if you use your Action to do anything else.
 * The Attack button is an announcement, not the Action. The bolt's own activities
 * are the spell, not something else.
 */
export function otherActionEndsFollowOn(opts: {
  activationType?: unknown;
  declaration?: boolean;
  usedItem?: any;
  heldItem?: any;
}): boolean {
  if (opts.declaration) return false;
  if (String(opts.activationType ?? "").toLowerCase() !== "action") return false;
  if (!opts.heldItem || !followOnDamageOf(opts.heldItem)) return false;
  return !sameRef(opts.usedItem, opts.heldItem);
}

/** Bonus still free, target still up, not the casting turn. */
export function shouldContinueFollowOn(opts: {
  startedThisSlot: boolean;
  targetOut: boolean;
  bonusFree: boolean;
}): boolean {
  if (opts.startedThisSlot) return false;
  if (opts.targetOut) return false;
  return opts.bonusFree;
}

/** Sequencer persistents AA leaves behind when the concentration AE dies (or never did). */
export function killFollowOnAnims(_actor: any, item: any, origin?: string): void {
  const mgr = (globalThis as any).Sequencer?.EffectManager;
  if (!mgr || typeof mgr.endEffects !== "function") return;
  const filters: Array<Record<string, unknown>> = [];
  const name = String(item?.name ?? "");
  const itemOrigin = String(item?.uuid ?? "");
  const extra = String(origin ?? "");
  if (name) filters.push({ name });
  if (itemOrigin) filters.push({ origin: itemOrigin });
  if (extra && extra !== itemOrigin) filters.push({ origin: extra });
  for (const filter of filters) {
    try {
      void mgr.endEffects(filter);
    } catch {
      /* Sequencer is optional; a leftover beam is worse than a throw */
    }
  }
}
