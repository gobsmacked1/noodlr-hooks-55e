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

/**
 * Loot carried across a linked transform.
 *
 * dnd5e creates a new world Actor for a linked Wild Shape / Polymorph and on revert copies
 * only HP, temp HP and spell slots. Items and coin picked up in the form stay on that Actor
 * and vanish if a GM deletes it. We stamp the form's starting item ids and purse at create,
 * then copy anything new onto the original. The stamp lives in our namespace so a player
 * revert — which strips `flags.dnd5e.isPolymorphed` and leaves the leftover — still knows
 * what to carry when the GM later deletes it.
 */
export const FORM_LOOT_FLAG = "formLoot";

export const COIN_KEYS = ["pp", "gp", "ep", "sp", "cp"] as const;

export type CoinKey = (typeof COIN_KEYS)[number];

export type CurrencyBag = Record<CoinKey, number>;

export type FormLootSnapshot = {
  originalActor: string;
  itemIds: string[];
  currency: CurrencyBag;
  copied?: boolean;
};

export function emptyCurrency(): CurrencyBag {
  return { pp: 0, gp: 0, ep: 0, sp: 0, cp: 0 };
}

export function currencyOf(source: any): CurrencyBag {
  const raw = source?.system?.currency ?? source?.currency ?? {};
  const out = emptyCurrency();
  for (const key of COIN_KEYS) {
    const n = Math.floor(Number(raw?.[key]) || 0);
    out[key] = Number.isFinite(n) && n > 0 ? n : 0;
  }
  return out;
}

export function addCurrency(base: CurrencyBag, extra: CurrencyBag): CurrencyBag {
  const out = emptyCurrency();
  for (const key of COIN_KEYS) out[key] = (base[key] ?? 0) + (extra[key] ?? 0);
  return out;
}

/** Coin acquired after the stamp. A negative denomination is treated as 0 — we never subtract. */
export function currencyDelta(start: CurrencyBag, now: CurrencyBag): CurrencyBag {
  const out = emptyCurrency();
  for (const key of COIN_KEYS) out[key] = Math.max(0, (now[key] ?? 0) - (start[key] ?? 0));
  return out;
}

export function hasCoin(bag: CurrencyBag): boolean {
  return COIN_KEYS.some((key) => (bag[key] ?? 0) > 0);
}

export function itemIdOf(item: any): string {
  return String(item?._id ?? item?.id ?? "");
}

export function itemIdsOf(items: Iterable<any> | null | undefined): string[] {
  const ids: string[] = [];
  if (!items) return ids;
  for (const item of items) {
    const id = itemIdOf(item);
    if (id) ids.push(id);
  }
  return ids;
}

export function newItemsFrom(items: Iterable<any> | null | undefined, stampedIds: string[]): any[] {
  const known = new Set(stampedIds);
  const out: any[] = [];
  if (!items) return out;
  for (const item of items) {
    const id = itemIdOf(item);
    if (id && !known.has(id)) out.push(item);
  }
  return out;
}

export function isFormLootSnapshot(value: unknown): value is FormLootSnapshot {
  if (!value || typeof value !== "object") return false;
  const snap = value as FormLootSnapshot;
  return typeof snap.originalActor === "string" && Array.isArray(snap.itemIds);
}

export function readFormLoot(actor: any): FormLootSnapshot | null {
  const raw = actor?.flags?.[MODULE_ID]?.[FORM_LOOT_FLAG];
  return isFormLootSnapshot(raw) ? raw : null;
}

/**
 * What to copy onto the original. `null` means do not touch this form (no stamp, or already copied).
 * An empty plan still means "mark copied" — nothing new was acquired.
 */
export function planFormLoot(args: {
  items: Iterable<any> | null | undefined;
  currency: CurrencyBag;
  snapshot: FormLootSnapshot | null | undefined;
}): { items: any[]; currency: CurrencyBag } | null {
  const snap = args.snapshot;
  if (!snap || snap.copied) return null;
  return {
    items: newItemsFrom(args.items, snap.itemIds),
    currency: currencyDelta(snap.currency ?? emptyCurrency(), args.currency),
  };
}

/** Payload for `createEmbeddedDocuments`. New id; drop a container link that would point at the form. */
export function itemPayloadForCarry(item: any): Record<string, unknown> {
  const raw =
    typeof item?.toObject === "function" ? item.toObject() : { ...(item && typeof item === "object" ? item : {}) };
  const payload = { ...raw } as Record<string, unknown>;
  delete payload._id;
  delete payload.id;
  delete payload.folder;
  const system = payload.system;
  if (system && typeof system === "object") {
    const next = { ...(system as Record<string, unknown>) };
    delete next.container;
    payload.system = next;
  }
  return payload;
}

/** Write the stamp onto the create payload `d` that `dnd5e.transformActor` hands over. */
export function stampFormLootOnCreateData(d: any, host: any): FormLootSnapshot {
  const originalActor = String(d?.flags?.dnd5e?.originalActor ?? host?.id ?? "");
  const snap: FormLootSnapshot = {
    originalActor,
    itemIds: itemIdsOf(d?.items ?? []),
    currency: currencyOf(d),
    copied: false,
  };
  if (!d.flags) d.flags = {};
  if (!d.flags[MODULE_ID]) d.flags[MODULE_ID] = {};
  d.flags[MODULE_ID][FORM_LOOT_FLAG] = snap;
  return snap;
}
