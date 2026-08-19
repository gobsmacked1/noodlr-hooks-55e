// Writing a compiled duration onto an Active Effect, and creating one when the rule is not a status.
//
// `setCondition` goes through `toggleStatusEffect` so every other module sees the condition the way
// it sees a hand-applied one. That call does not take a duration. The stamp happens afterwards, on
// the effect that call just created (or the one that was already there — refreshing a Slow that
// still has a turn left is the rule, not a stack).
//
// grant_advantage / impose_disadvantage / modify_speed have no status to toggle, so they create an
// effect of our own, flagged so the pre-roll reader and a later refresh can find it. Origin is the
// capability label, never a UUID we might not hold — a missing origin is an untitled effect, not a
// throw.

import { MODULE_ID, warn } from "../constants";
import type { EffectDurationPayload } from "./duration";

export interface TimedEffectSpec {
  actor: any;
  name: string;
  img?: string;
  statuses?: string[];
  changes?: Array<{ key: string; mode: number; value: string }>;
  /** Stable identity for refresh. Same kind + capability + rule index replaces rather than stacks. */
  key: { kind: string; capability: string; ruleIndex: number };
  /** Effect parameters the pre-roll reader needs (rollType, ability, skill). */
  params?: Record<string, unknown>;
  duration: EffectDurationPayload | null;
  origin?: string;
}

export function effectForStatus(actor: any, status: string): any | null {
  const wanted = String(status ?? "").toLowerCase();
  if (!actor || !wanted) return null;
  for (const effect of actor.effects ?? []) {
    if (effect?.disabled) continue;
    const statuses = effect.statuses;
    if (statuses instanceof Set && statuses.has(wanted)) return effect;
    if (Array.isArray(statuses) && statuses.includes(wanted)) return effect;
    if (String(effect.flags?.core?.statusId ?? "").toLowerCase() === wanted) return effect;
  }
  return null;
}

export function ourTimedEffect(actor: any, key: TimedEffectSpec["key"]): any | null {
  for (const effect of actor?.effects ?? []) {
    const flag = effect?.flags?.[MODULE_ID]?.timed;
    if (!flag) continue;
    if (flag.kind === key.kind && flag.capability === key.capability && flag.ruleIndex === key.ruleIndex) {
      return effect;
    }
  }
  return null;
}

export async function stampDuration(effect: any, payload: EffectDurationPayload | null): Promise<boolean> {
  if (!effect || !payload) return false;
  try {
    const update: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(payload.duration)) update[`duration.${k}`] = v;
    if (payload.start) {
      for (const [k, v] of Object.entries(payload.start)) update[`start.${k}`] = v;
    }
    await effect.update(update);
    return true;
  } catch (err) {
    warn(`could not stamp duration on ${String(effect?.name ?? "an effect")}:`, err);
    return false;
  }
}

/**
 * Create or refresh a timed effect that is not a status — a Slow, an advantage grant, a Speed cut.
 *
 * Refreshing rather than stacking is the whole point: Ray of Frost landing twice in one round is
 * one Slow with a reset clock, not two that the sheet cannot tell apart.
 */
export async function writeTimedEffect(spec: TimedEffectSpec): Promise<any | null> {
  const actor = spec.actor;
  if (!actor) return null;

  const existing = ourTimedEffect(actor, spec.key);
  if (existing) {
    try {
      const update: Record<string, unknown> = { disabled: false };
      if (spec.changes) update.changes = spec.changes;
      if (spec.duration) {
        for (const [k, v] of Object.entries(spec.duration.duration)) update[`duration.${k}`] = v;
        if (spec.duration.start) {
          for (const [k, v] of Object.entries(spec.duration.start)) update[`start.${k}`] = v;
        }
      }
      await existing.update(update);
      return existing;
    } catch (err) {
      warn(`could not refresh timed effect "${spec.name}":`, err);
      return null;
    }
  }

  const data: Record<string, unknown> = {
    name: spec.name,
    img: spec.img ?? "icons/svg/aura.svg",
    origin: spec.origin,
    statuses: spec.statuses ?? [],
    changes: spec.changes ?? [],
    flags: {
      [MODULE_ID]: {
        timed: { ...spec.key, params: spec.params ?? {} },
      },
    },
  };
  if (spec.duration) {
    data.duration = spec.duration.duration;
    if (spec.duration.start) data.start = spec.duration.start;
  }

  try {
    const created = await actor.createEmbeddedDocuments("ActiveEffect", [data]);
    return created?.[0] ?? null;
  } catch (err) {
    warn(`could not create timed effect "${spec.name}" on ${String(actor?.name)}:`, err);
    return null;
  }
}

export function effectModes(): { add: number; multiply: number; override: number } {
  const modes = (globalThis as any).CONST?.ACTIVE_EFFECT_MODES;
  return {
    add: Number(modes?.ADD) || 2,
    multiply: Number(modes?.MULTIPLY) || 1,
    override: Number(modes?.OVERRIDE) || 5,
  };
}
