// What on a sheet would be charged an action slot, and whether we think it should be.
//
// Kept apart from both surveys that use it so they cannot form two opinions. The Sneak Attack report
// (2026-08-07) was undiagnosable from the tally alone: the count was right and the thing being counted was
// wrong, so what a diagnostic has to show is not how much was spent but what is capable of spending.
//
// Deliberately no dependency on settings or config. This answers a question about a sheet, and it must be
// askable from a census that runs with every automation switched off.

import { isActionSurge } from "../../system/dnd5e-action-surge";
import { actionDeclarationOf } from "../../system/dnd5e-declarations";
import { damageRiderOf } from "../../system/dnd5e-riders";
import { slotFor, type Slot } from "./ledger";

export interface SlotClaim {
  item: string;
  /** dnd5e authors stable identifiers on its own features; imported content often carries none. */
  identifier: string | null;
  /** `weapon`, `spell`, `feat`, ... — a feature claiming an Action is far more suspect than a weapon. */
  itemType: string;
  activity: string;
  activityType: string;
  claims: Slot;
  /**
   * The rule that exempts it, or null if it will really be charged.
   *
   * Was `treatedAsRider` until declarations became a second reason to exempt something. A field that
   * said "rider" about the Attack button would be a diagnostic telling a lie, which is worse than a
   * field name somebody has to re-learn.
   */
  exemptedAs: string | null;
}

/** Every activity on this actor that the ledger would charge a slot for. */
export function slotClaims(actor: any): SlotClaim[] {
  const out: SlotClaim[] = [];
  for (const item of actor?.items ?? []) {
    const activities: any[] = item?.system?.activities?.contents ?? [];
    for (const activity of activities) {
      const slot = slotFor(activity?.activation?.type);
      if (!slot) continue;
      out.push({
        item: String(item?.name ?? "?"),
        identifier: String(item?.system?.identifier ?? "") || null,
        itemType: String(item?.type ?? "?"),
        activity: String(activity?.name ?? "") || String(activity?.type ?? ""),
        activityType: String(activity?.type ?? "?"),
        claims: slot,
        exemptedAs:
          damageRiderOf(item, activity) ??
          actionDeclarationOf(item, activity) ??
          (isActionSurge(item, activity) ? "Action Surge" : null),
      });
    }
  }
  return out;
}

/** Item types whose activities are expected to cost something. A sword claiming an Action is not news. */
const ORDINARY = new Set(["weapon", "spell", "consumable", "equipment", "tool", "container"]);

/**
 * Is this claim worth a human's attention?
 *
 * Two populations. Anything already exempted, so a fix can be confirmed rather than assumed; and any
 * *feature* that claims a slot, which is where a mis-authored ability hides. Filtering on the activity
 * being damage-typed would have been narrower and would have missed the Sneak Attack that started this,
 * because there is no guarantee the importer typed it as damage.
 */
export function notable(claim: SlotClaim): boolean {
  return claim.exemptedAs !== null || !ORDINARY.has(claim.itemType);
}
