// Thrown weapons: reach vs range, spend, and the pin size.
//
// dnd5e decrements `system.quantity` on an attack whose `attackMode` starts
// with `"thrown"`, and it skips that when the item has `ret` (`attack.mjs`).
// It never asks, never leaves a pin, and never treats a dual-mode weapon
// without a mode as melee — so a Dagger (reach 5, thrown 20/60) used from
// 35 feet was a legal stab. The ask, the spend-if-needed, the scene Tile,
// and the name-only Returning match live in `rules/thrown.ts`.
// This file is the sheet reading, with no Foundry.
//
// Do not create an Actor for a dropped weapon. `"loot"` is an Item type in
// dnd5e, not an Actor type. Dropping as `npc` made a Huge dagger token, a
// creature sheet, and a "add randomized loot" prompt — and a Token on the
// target is what a flee would carry away.

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

/** Stock 2024 weapons with `thr` — all share the Dagger pin path, not just Dagger. */
export const THROWN_STOCK = [
  "Dagger",
  "Handaxe",
  "Javelin",
  "Light Hammer",
  "Spear",
  "Trident",
  "Dart",
] as const;

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

/**
 * Quantity after one throw. dnd5e may already have decremented; we must not
 * spend a second time. If the live count is still the snapshot, we spend.
 */
export function quantityAfterThrow(before: number, afterSystem: number): {
  next: number;
  alreadySpent: boolean;
} {
  if (!Number.isFinite(before) || before < 0) {
    const fallback = Number.isFinite(afterSystem) ? afterSystem : 0;
    return { next: Math.max(0, fallback), alreadySpent: false };
  }
  if (Number.isFinite(afterSystem) && afterSystem < before) {
    return { next: Math.max(0, afterSystem), alreadySpent: true };
  }
  return { next: Math.max(0, before - 1), alreadySpent: false };
}

/** Pixel size of the scene pin. A fraction of one square, never a creature footprint. */
export function pinSizePx(gridSize: number): number {
  const size = Number.isFinite(gridSize) && gridSize > 0 ? gridSize : 100;
  return Math.min(64, Math.max(32, Math.round(size * 0.35)));
}

/**
 * Whether a token can reach a pin. Token `width`/`height` are grid squares;
 * tile `width`/`height` are pixels. Adjacent includes a diagonal.
 */
export function withinPickupReach(
  token: { x: number; y: number; width: number; height: number },
  tile: { x: number; y: number; width: number; height: number },
  gridSize: number,
): boolean {
  const size = Number.isFinite(gridSize) && gridSize > 0 ? gridSize : 100;
  const tw = Number(token.width) > 0 ? Number(token.width) : 1;
  const th = Number(token.height) > 0 ? Number(token.height) : 1;
  const tx = Number(token.x) + (tw * size) / 2;
  const ty = Number(token.y) + (th * size) / 2;
  const gx = Number(tile.x) + Number(tile.width) / 2;
  const gy = Number(tile.y) + Number(tile.height) / 2;
  if (![tx, ty, gx, gy].every(Number.isFinite)) return false;
  return Math.hypot(tx - gx, ty - gy) <= size * 1.5;
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
