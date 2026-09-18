// Follow-on damage on a concentration item (Witch Bolt's later 1d12).
//
// The first activity is an Attack that names a creature. The later one is a
// Damage activity whose target override is empty — it does not ask for a new
// token, and auto-damage then reads nobody. That is not a missing target; it
// is the same bolt still on the creature that was hit.

import { templateTypeOf } from "./dnd5e-target";

function activitiesOf(item: any): any[] {
  const collection = item?.system?.activities;
  if (!collection) return [];
  if (Array.isArray(collection.contents)) return collection.contents;
  if (Array.isArray(collection)) return collection;
  return [];
}

/** Later-turn Damage beside an Attack on the same item (Witch Bolt's 1d12). */
export function isFollowOnDamage(activity: any): boolean {
  if (String(activity?.type ?? "").toLowerCase() !== "damage") return false;
  if (templateTypeOf(activity)) return false;
  if (activity?.consumption?.spellSlot === true) return false;
  const item = activity?.item;
  if (!item) return false;
  return activitiesOf(item).some((a) => a && a !== activity && String(a?.type ?? "") === "attack");
}

export function followOnDamageOf(item: any): any | null {
  if (!item) return null;
  for (const activity of activitiesOf(item)) {
    if (isFollowOnDamage({ ...activity, item })) return activity;
  }
  return null;
}
