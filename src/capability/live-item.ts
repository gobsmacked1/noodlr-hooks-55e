// A compiled rule on a known-but-uncast spell is not a live effect.
//
// `bindingAppliesToActivity` answers "is this rider about the item that just resolved?"
// Hold Person vs Otto is that question, and it only runs when a used item exists.
// `on_damage_taken`, standing grants and the pre-roll grant reader have no used item, so
// that function returned true for every spell on the sheet. Feast of Flesh then granted
// Advantage to the caster on any damage, and Beast of Ragnarok / Investiture of Wind
// imposed Disadvantage on every attack, while none of those spells were up.
//
// Feats stay always-on (Reckless, Pack Tactics, Regeneration). Weapons need to be
// equipped. Spells and consumables are in play only while the creature is concentrating
// on that item or wearing a non-timed AE that originated from it.
//
// Our own timed AEs must not count as "in play" — that is circular: a grant writes the
// AE, the AE keeps the grant alive. The leftover Feast AE on Drew was that loop, and
// its origin is a capability id rather than the item uuid anyway.

import { MODULE_ID } from "../constants";

export type LiveItemKind = "feat" | "weapon" | "spell" | "consumable" | "other";

const FEAT_TYPES = new Set(["feat", "class", "subclass", "background", "race", "species"]);

export function itemKindOf(item: any): LiveItemKind {
  const type = String(item?.type ?? "");
  if (FEAT_TYPES.has(type)) return "feat";
  if (type === "weapon") return "weapon";
  if (type === "spell") return "spell";
  if (type === "consumable") return "consumable";
  return "other";
}

function sameRef(a: any, b: any): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const aId = String(a.id ?? "");
  const bId = String(b.id ?? "");
  if (aId && aId === bId) return true;
  const aUuid = String(a.uuid ?? "");
  const bUuid = String(b.uuid ?? "");
  return Boolean(aUuid) && aUuid === bUuid;
}

function originMatchesItem(effect: any, item: any): boolean {
  const uuid = String(item?.uuid ?? "");
  const origin = String(effect?.origin ?? "");
  if (uuid && (origin === uuid || origin.startsWith(`${uuid}.`))) return true;
  const flagged = effect?.flags?.dnd5e?.item;
  const flagUuid = typeof flagged === "string" ? flagged : String(flagged?.uuid ?? "");
  if (uuid && flagUuid === uuid) return true;
  return sameRef(flagged, item);
}

function isOurTimed(effect: any): boolean {
  return Boolean(effect?.flags?.[MODULE_ID]?.timed);
}

export function concentratingOn(actor: any, item: any): boolean {
  if (!actor || !item) return false;
  const items = actor.concentration?.items;
  const held = items instanceof Set ? [...items] : [...(items ?? [])];
  for (const it of held) {
    if (sameRef(it, item)) return true;
  }
  const effects = actor.concentration?.effects;
  const list = effects instanceof Set ? [...effects] : [...(effects ?? [])];
  for (const effect of list) {
    if (originMatchesItem(effect, item)) return true;
  }
  return false;
}

/** A real affliction from this item — not a timed grant we wrote ourselves. */
export function afflictedBy(actor: any, item: any): boolean {
  if (!actor || !item) return false;
  for (const effect of actor.effects ?? []) {
    if (effect?.disabled || effect?.duration?.expired) continue;
    if (isOurTimed(effect)) continue;
    if (originMatchesItem(effect, item)) return true;
  }
  return false;
}

/**
 * Whether this binding's item is currently doing something.
 *
 * No item (a creature-level trait) is in play. Unreadable `equipped` fails toward
 * in play — inventing "stowed" would hide a real weapon.
 */
export function itemIsInPlay(item: any, actor: any): boolean {
  if (!item) return true;
  const kind = itemKindOf(item);
  if (kind === "feat") return true;
  if (kind === "weapon") return item.system?.equipped !== false;
  if (kind === "spell" || kind === "consumable") {
    return concentratingOn(actor, item) || afflictedBy(actor, item);
  }
  if (item.system && Object.prototype.hasOwnProperty.call(item.system, "equipped")) {
    return item.system.equipped !== false;
  }
  return true;
}

/**
 * Used-item riders still go through `bindingAppliesToActivity` (Hold Person vs Otto).
 * Events with no used item ask whether the item is in play at all.
 */
export function bindingShouldFire(
  binding: { item?: any },
  actor: any,
  usedItem: any,
  appliesToActivity: (binding: { item?: any }, usedItem: any) => boolean,
): boolean {
  if (usedItem) return appliesToActivity(binding, usedItem);
  return itemIsInPlay(binding.item, actor);
}

/**
 * A concentrating caster is not the afflicted creature.
 *
 * Feast of Flesh compiled `on_damage_taken → grant_advantage` on the spell. Once she
 * is concentrating, `itemIsInPlay` becomes true, and damage to HER would still fire
 * the rider. Armor of Agathys is the contrasting specimen: that rider is `damage`,
 * and it is supposed to burn whoever hit the caster. Only grant/impose are refused
 * unless she is actually wearing the spell's AE.
 */
export function damageTakenGrantAllowed(
  binding: { item?: any },
  actor: any,
  event: string,
  kind: string,
): boolean {
  if (event !== "on_damage_taken") return true;
  if (kind !== "grant_advantage" && kind !== "impose_disadvantage") return true;
  if (itemKindOf(binding.item) !== "spell") return true;
  return afflictedBy(actor, binding.item);
}
