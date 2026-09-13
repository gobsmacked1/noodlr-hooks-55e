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
 * DDB / imported sheets often store an equipped thrown weapon as quantity 0.
 * dnd5e still rolls, but `rollAttack` warns the moment quantity is 0 — that
 * check is the first line, before any hook. Treat an untouched 0 as one in
 * hand. After that uuid has been thrown empty this combat, 0 means gone.
 */
export function inHandQuantity(qty: number, alreadyEmptied: boolean): number {
  if (alreadyEmptied) return Number.isFinite(qty) && qty > 0 ? qty : 0;
  if (!Number.isFinite(qty) || qty <= 0) return 1;
  return qty;
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

/** How close the vacuuming player must be, in scene units. Stock grid: one square. */
export const VACUUM_REACH_FT = 5;

function occupiedCenters(
  token: { x: number; y: number; width: number; height: number },
  gridSize: number,
): Array<{ x: number; y: number }> {
  const size = Number.isFinite(gridSize) && gridSize > 0 ? gridSize : 100;
  const w = Math.max(1, Math.round(Number(token.width) || 1));
  const h = Math.max(1, Math.round(Number(token.height) || 1));
  const x0 = Number(token.x);
  const y0 = Number(token.y);
  if (!Number.isFinite(x0) || !Number.isFinite(y0)) return [];
  const out: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < w; i++) {
    for (let j = 0; j < h; j++) {
      out.push({ x: x0 + size * i + size / 2, y: y0 + size * j + size / 2 });
    }
  }
  return out;
}

/**
 * Token to pin in scene units. Token `width`/`height` are squares; tile
 * `width`/`height` are pixels. Closest occupied square to the pin centre,
 * Euclidean — a diagonal adjacent under EXACT (7.07 ft) is not 5 ft.
 */
export function withinVacuumReach(
  token: { x: number; y: number; width: number; height: number },
  tile: { x: number; y: number; width: number; height: number },
  gridSize: number,
  gridDistance = 5,
): boolean {
  const size = Number.isFinite(gridSize) && gridSize > 0 ? gridSize : 100;
  const per = Number.isFinite(gridDistance) && gridDistance > 0 ? gridDistance : 5;
  const gx = Number(tile.x) + Number(tile.width) / 2;
  const gy = Number(tile.y) + Number(tile.height) / 2;
  if (!Number.isFinite(gx) || !Number.isFinite(gy)) return false;
  let best = Number.POSITIVE_INFINITY;
  for (const c of occupiedCenters(token, size)) {
    const feet = (Math.hypot(gx - c.x, gy - c.y) / size) * per;
    if (feet < best) best = feet;
  }
  return best <= VACUUM_REACH_FT + 1e-6;
}

/** HUD and leftover pickup use the same 5 ft as the vacuum. */
export function withinPickupReach(
  token: { x: number; y: number; width: number; height: number },
  tile: { x: number; y: number; width: number; height: number },
  gridSize: number,
  gridDistance = 5,
): boolean {
  return withinVacuumReach(token, tile, gridSize, gridDistance);
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

/** Player-owned thrown gear, not a goblin's spear. Sheet type, never `hasPlayerOwner`. */
export function isPlayerThrower(actor: { type?: unknown } | null | undefined): boolean {
  return String(actor?.type ?? "") === "character";
}

/** A pin the owner may vacuum from 5 ft. Unstamped leftovers stay — we will not guess an owner. */
export function pinIsPlayerOwned(
  flags: { playerOwned?: unknown; ownerType?: unknown } | null | undefined,
): boolean {
  if (!flags) return false;
  if (flags.playerOwned === true) return true;
  return String(flags.ownerType ?? "") === "character";
}

/** Same remaining stack, or a fresh copy of the one we deleted at quantity 0. */
export function thrownStacksMatch(live: any, payload: any): boolean {
  const liveId = String(live?.system?.identifier ?? "");
  const payId = String(payload?.system?.identifier ?? "");
  if (liveId && payId) return liveId === payId;
  const liveName = String(live?.name ?? "");
  const payName = String(payload?.name ?? "");
  if (!liveName || liveName !== payName) return false;
  const liveType = String(live?.type ?? "");
  const payType = String(payload?.type ?? "");
  return !liveType || !payType || liveType === payType;
}

/** One vacuum card, not one line per pin. `2 × Dagger` — never invent a plural. */
export function vacuumItemsLabel(entries: Array<{ name: string; count: number }>): string {
  return entries
    .filter((e) => e.count > 0 && e.name)
    .map((e) => `${e.count} × ${e.name}`)
    .join(", ");
}
