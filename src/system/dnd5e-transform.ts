// Wild Shape / Polymorph / Shapechange — identification only.
//
// We do not draw a restore badge. dnd5e already restores from the sheet header and the sidebar.
// `isPolymorphed` is what riding uses to dump riders on revert. The leftover-badge helpers exist
// so an upgraded world can delete the old `noodlr-transformed` Active Effect instead of leaving
// a dead icon on the token beside Paladin auras.

import { MODULE_ID } from "../constants";

/** Status the withdrawn restore badge used to stamp. Kept so leftovers can be recognised and deleted. */
export const TRANSFORM_STATUS_ID = "noodlr-transformed";

export const TRANSFORM_BADGE_FLAG = "transformBadge";

/** Fixed 16-char id the withdrawn badge used (`keepId`). Leftovers still carry it. */
export const TRANSFORM_BADGE_ID = "noodlrTransform0";

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

/** Ours, or any AE still carrying the withdrawn restore status. */
export function isTransformBadge(effect: any): boolean {
  return isOurTransformBadge(effect) || hasTransformStatus(effect);
}
