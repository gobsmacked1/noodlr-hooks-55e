// dnd5e 6.0.1 schema facts that more than one file has to agree on.
//
// Floor is 6.0.1. Do not add a 5.3.3 fallback. Writing BOTH the shimmed Speed key and
// the nested key would double-apply: 6.0 still copies `movement.speeds.walk` onto
// `movement.walk` until 7.0.

import { isDnd5e } from "./dnd5e-rewards";

/** Major version of the active dnd5e system, or 0 when it cannot be read. */
export function dnd5eMajor(): number {
  if (!isDnd5e()) return 0;
  const raw = String((globalThis as any).game?.system?.version ?? "");
  const match = /^(\d+)/.exec(raw);
  return match ? Number(match[1]) : 0;
}

/** 6.0.1 stores Speed under `movement.speeds.*`. */
export function usesNestedMovementSpeeds(_actor?: any): boolean {
  return true;
}

/** Active Effect change key for one movement mode. */
export function movementSpeedKey(type: string, _actor?: any): string {
  const mode = String(type || "walk").trim() || "walk";
  return `system.attributes.movement.speeds.${mode}`;
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
