// Thrown weapons: reach vs range, and whether the weapon comes back.
//
// dnd5e already decrements `system.quantity` on an attack whose `attackMode`
// starts with `"thrown"`, and it skips that decrement when the item has the
// `ret` (Returning) property (`attack.mjs`). It never asks, never drops a
// placeable, and never treats a dual-mode weapon without a mode as melee — so
// a Dagger (reach 5, thrown 20/60) used from 35 feet was a legal stab. The
// ask, the ground token, and the name-only Returning match live in `rules/thrown.ts`.
// This file is the sheet reading, with no Foundry.

export type ThrowAsk = "none" | "melee" | "ask" | "too-far" | "already";

function hasProp(item: any, key: string): boolean {
  const props = item?.system?.properties;
  if (!props) return false;
  if (typeof props.has === "function") return Boolean(props.has(key));
  if (Array.isArray(props)) return props.includes(key);
  return false;
}

export function hasThrownProperty(item: any): boolean {
  return hasProp(item, "thr");
}

export function hasReturningProperty(item: any): boolean {
  return hasProp(item, "ret");
}

/** Magical Returning, or the word in the item name for a sheet that never set `ret`. */
export function isReturningWeapon(item: any): boolean {
  if (hasReturningProperty(item)) return true;
  return /\breturning\b/i.test(String(item?.name ?? ""));
}

export function attackModeIsThrown(mode: unknown): boolean {
  return String(mode ?? "")
    .toLowerCase()
    .startsWith("thrown");
}

/**
 * What to do when a dual-mode weapon is used at this distance.
 *
 * `meleeTooFar` / `thrownInRange` are measured by the caller (cylinder vs 3D
 * hypot) so this file never reimplements `isTooFar`.
 */
export function throwAskNeeded(
  item: any,
  attackMode: unknown,
  meleeTooFar: boolean,
  thrownInRange: boolean,
): ThrowAsk {
  if (!hasThrownProperty(item)) return "none";
  if (attackModeIsThrown(attackMode) || String(attackMode ?? "").toLowerCase() === "ranged") {
    return "already";
  }
  if (!meleeTooFar) return "melee";
  if (thrownInRange) return "ask";
  return "too-far";
}

/** One copy of the weapon as it should land on the ground — new id, quantity 1, unequipped. */
export function thrownLootPayload(item: any): Record<string, unknown> | null {
  if (!item) return null;
  let raw: any;
  try {
    raw = typeof item.toObject === "function" ? item.toObject() : { ...item };
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  delete raw._id;
  delete raw.id;
  delete raw.folder;
  delete raw.sort;
  if (raw.system && typeof raw.system === "object") {
    raw.system = { ...raw.system, quantity: 1, equipped: false };
  }
  return raw;
}
