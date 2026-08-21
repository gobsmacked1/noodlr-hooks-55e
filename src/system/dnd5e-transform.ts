// Wild Shape / Polymorph / Shapechange — the token badge, not the form.
//
// dnd5e already restores via `Actor#revertOriginalForm` (sheet header and sidebar). Argon's Wild
// Shape button is a *use*, so intercepting it as revert would either block beast-to-beast or spend
// a use on the way back. This file only names the badge that points at the system's restore.

import { MODULE_ID } from "../constants";

/** Unique status. Token HUD skips `hud: false`, so this cannot be click-toggled off as a condition. */
export const TRANSFORM_STATUS_ID = "noodlr-transformed";

/** Stock Wild Shape item art — recognisable as the Druid feature, not a canned condition. */
export const TRANSFORM_STATUS_IMG = "icons/creatures/mammals/bull-horns-eyes-glowin-orange.webp";

export const TRANSFORM_BADGE_FLAG = "transformBadge";

/**
 * Fixed 16-char id so two clients (or four hooks on one) cannot stamp two badges.
 * Creating an embedded AE does not fire `updateActor`, so a check-then-create race
 * never reaches the "delete extras" path. `keepId: true` makes the second create a
 * no-op against the same document. Same shape as dnd5e's bloodied / exhaustion ids.
 */
export const TRANSFORM_BADGE_ID = "noodlrTransform0";

/** v14 `CONST.ACTIVE_EFFECT_SHOW_ICON.ALWAYS`. Same reason as the Paladin host badge. */
export const TRANSFORM_SHOW_ICON_ALWAYS = 2;

export const TRANSFORM_AA_FLAGS = { killAnim: true, isEnabled: false, version: 99 } as const;

export function transformStatusEntry(): { id: string; name: string; img: string; hud: false } {
  return {
    id: TRANSFORM_STATUS_ID,
    name: "Restore Transformation",
    img: TRANSFORM_STATUS_IMG,
    hud: false,
  };
}

export function registerTransformStatus(): void {
  const list = (globalThis as any).CONFIG?.statusEffects;
  if (!Array.isArray(list)) return;
  if (list.some((s: any) => s?.id === TRANSFORM_STATUS_ID)) return;
  list.push(transformStatusEntry());
}

export function isPolymorphed(actor: any): boolean {
  if (!actor) return false;
  if (actor.isPolymorphed === true) return true;
  try {
    if (actor.getFlag?.("dnd5e", "isPolymorphed")) return true;
  } catch {
    // unreadable flag
  }
  return Boolean(actor.flags?.dnd5e?.isPolymorphed);
}

export function isOurTransformBadge(effect: any): boolean {
  if (effect?.id === TRANSFORM_BADGE_ID || effect?._id === TRANSFORM_BADGE_ID) return true;
  const flag = effect?.flags?.[MODULE_ID]?.[TRANSFORM_BADGE_FLAG];
  return flag === true || Boolean(flag && typeof flag === "object");
}

export function hasTransformStatus(effect: any): boolean {
  const statuses = effect?.statuses;
  if (statuses instanceof Set) return statuses.has(TRANSFORM_STATUS_ID);
  if (Array.isArray(statuses)) return statuses.includes(TRANSFORM_STATUS_ID);
  return false;
}

/** Ours, or any AE carrying the restore status — both draw the same token icon. */
export function isTransformBadge(effect: any): boolean {
  return isOurTransformBadge(effect) || hasTransformStatus(effect);
}

/** Keep one badge; prefer the keepId document so a leftover random-id twin is the extra. */
export function extrasToDrop(effects: readonly any[]): any[] {
  const ours = effects.filter(isTransformBadge);
  if (ours.length <= 1) return [];
  const keep =
    ours.find((e) => e?.id === TRANSFORM_BADGE_ID || e?._id === TRANSFORM_BADGE_ID) ??
    ours.find(isOurTransformBadge) ??
    ours[0];
  return ours.filter((e) => e !== keep);
}

export function transformBadgePayload(actor: any): Record<string, unknown> {
  return {
    _id: TRANSFORM_BADGE_ID,
    name: "Restore Transformation",
    img: TRANSFORM_STATUS_IMG,
    origin: String(actor?.uuid ?? ""),
    transfer: false,
    disabled: false,
    showIcon: TRANSFORM_SHOW_ICON_ALWAYS,
    statuses: [TRANSFORM_STATUS_ID],
    changes: [],
    flags: {
      [MODULE_ID]: { [TRANSFORM_BADGE_FLAG]: true },
      autoanimations: { ...TRANSFORM_AA_FLAGS },
    },
  };
}
