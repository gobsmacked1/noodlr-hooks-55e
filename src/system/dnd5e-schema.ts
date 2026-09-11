// dnd5e 5.3.3 vs 6.0.0 schema facts that more than one file has to agree on.
//
// Dual-read, never 6.0-only: a world still on 5.3.3 must keep working. Detect the live
// shape first (an actor that already has `movement.speeds`, a sense stored as `{value}`),
// then fall back to the system major version, then to the 5.3.3 key. Writing BOTH the
// shimmed key and the nested key on 6.0 would double-apply if the shim copies.

import { isDnd5e } from "./dnd5e-rewards";

/** Major version of the active dnd5e system, or 0 when it cannot be read. */
export function dnd5eMajor(): number {
  if (!isDnd5e()) return 0;
  const raw = String((globalThis as any).game?.system?.version ?? "");
  const match = /^(\d+)/.exec(raw);
  return match ? Number(match[1]) : 0;
}

/**
 * Does this actor (or this world) store Speed under `movement.speeds.*`?
 *
 * 6.0 moved `movement.walk` there and shims the old path until 7.0. Prefer the nested
 * key when the live object already has it, so a test world that set the version but
 * not the field still writes what 6.0 will persist.
 */
export function usesNestedMovementSpeeds(actor?: any): boolean {
  const speeds = actor?.system?.attributes?.movement?.speeds;
  if (speeds && typeof speeds === "object") return true;
  return dnd5eMajor() >= 6;
}

/** Active Effect change key for one movement mode. */
export function movementSpeedKey(type: string, actor?: any): string {
  const mode = String(type || "walk").trim() || "walk";
  return usesNestedMovementSpeeds(actor)
    ? `system.attributes.movement.speeds.${mode}`
    : `system.attributes.movement.${mode}`;
}

/**
 * A sense range as a finite number.
 *
 * 5.3.3 / 6.0 `senses.ranges.<id>` is a NumberField. Importers and Vision 5e sometimes
 * wrap it as `{value}` or `{range}`. `Number({value: 60})` is NaN — that is the hole.
 */
export function senseRangeOf(raw: unknown): number | null {
  if (raw == null || raw === "") return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw === "string") {
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof raw === "object") {
    const inner = (raw as { value?: unknown; range?: unknown }).value ?? (raw as { range?: unknown }).range;
    return senseRangeOf(inner);
  }
  return null;
}

/**
 * 6.0 form-mode Wild Shape / Polymorph applies an Active Effect. No new Actor, no
 * `dnd5e.transformActor` hook, nothing for `formLoot` to stamp. Actor-copy
 * `transformInto` is unchanged.
 */
export function isFormModeTransform(activity?: any, settings?: any): boolean {
  if (String(activity?.transform?.mode ?? "") === "form") return true;
  if (String(settings?.mode ?? "") === "form") return true;
  if (String(settings?.transform?.mode ?? "") === "form") return true;
  return false;
}
