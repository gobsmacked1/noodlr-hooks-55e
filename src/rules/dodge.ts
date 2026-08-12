// Taking the Dodge action, and stopping dodging when the round comes back round.
//
// dnd5e ships a `dodging` status and reads it NOWHERE — verified 5.3.3: the id appears in
// `CONFIG.statusEffects` and in no rule. So the button applies an icon and changes nothing, which is the
// same shape as Hide and Disengage: an action the sheet knows the name of and nobody enforces.
//
// The rules the status should impose live in `rules/conditions.ts`, beside the rest of the
// condition-to-roll matrix, because that is where the attack and save hooks already are. What lives here
// is the LIFECYCLE — making sure the status is actually on when the action was taken, and off again when
// it should be.
//
// EXPIRY IS THE HALF THAT MATTERS, and it is why this file exists at all. "Until the start of your next
// turn" is enforced by nothing in the stack: dnd5e never reads the status, AC5e reads it and never writes
// it, and the PHB item carries no duration. A Dodge taken in round one is therefore still lit in round
// nine, which is worse than the rule not being automated at all — an icon that lies is read by the GM as
// state. So the expiry runs whenever the condition layer is on, INDEPENDENTLY of who owns the Dodge
// rules: clearing a stale marker is bookkeeping rather than a rules opinion, and if AC5e is the one
// reading the status then it benefits from the status being honest just as much as we do.
//
// APPLICATION IS BELT AND BRACES. Argon offers Dodge two different ways — through the sheet's own item,
// and by toggling the status directly when Convenient Effects is installed — and only the first fires an
// activity hook. Re-applying an already-present status is a no-op, so asking for it after the item
// resolves costs nothing and covers the case where the item turns out to carry no effect of its own.

import { log } from "../constants";
import { isDodgeActivity } from "../system/dnd5e-actions";
import { DODGING_STATUS } from "../system/dnd5e-conditions";
import { isDnd5e } from "../system/dnd5e-rewards";
import { isConditionAutomationEnabled } from "../settings";
import { isPrimaryGM } from "../util/gm";

// Deliberately NOT `ac5eOwnsDodging()`. That gate decides who reads the status; this file decides
// whether the status is true, and nobody else does that at all.
function enabled(): boolean {
  return isDnd5e() && isConditionAutomationEnabled();
}

/** Put the status on, or leave it exactly as it is. */
async function markDodging(actor: any): Promise<void> {
  try {
    if ((actor?.statuses as Set<string> | undefined)?.has(DODGING_STATUS)) return;
    await actor?.toggleStatusEffect?.(DODGING_STATUS, { active: true });
    log(`conditions: ${String(actor?.name)} is Dodging`);
  } catch (err) {
    // A player pressing Dodge on their own character always may; anything else is somebody else's
    // sheet, and a missing icon is better than an error dialog mid-turn.
    log(`conditions: could not mark ${String(actor?.name)} as Dodging:`, err);
  }
}

/**
 * Take it off again — whoever put it on.
 *
 * `toggleStatusEffect(id, {active: false})` is NOT enough, and the reason is subtle. Core resolves the
 * effect to remove by the status's static `_id` when it has one (`client/documents/actor.mjs:496`), and
 * dnd5e's conditions all have one — so it deletes the system's own marker and walks straight past an
 * identically-statused effect created by anything else. Convenient Effects is exactly that case: its
 * "Dodge" carries `statuses: ["dodging"]` under its own id, and Argon toggles CE's effect in preference
 * to the sheet's item whenever CE is installed. Clearing only the native one would leave the icon lit.
 *
 * So the status is read off the effects that actually carry it. Single-status effects only: an effect
 * that grants dodging alongside something else is not this action, and deleting it would take the
 * something else with it.
 */
async function clearDodging(actor: any): Promise<void> {
  try {
    const stale: string[] = [];
    for (const effect of (actor?.effects ?? []) as any[]) {
      const statuses: Set<string> = effect?.statuses ?? new Set();
      if (statuses.size === 1 && statuses.has(DODGING_STATUS)) stale.push(String(effect.id));
    }
    if (!stale.length) return;
    await actor?.deleteEmbeddedDocuments?.("ActiveEffect", stale);
    log(`conditions: ${String(actor?.name)}'s Dodge ends as its turn begins`);
  } catch (err) {
    log(`conditions: could not clear ${String(actor?.name)}'s Dodge:`, err);
  }
}

/**
 * Watch the button, and expire what it applied.
 *
 * The application half runs on every client, because the client that pressed is the one that owns the
 * sheet. The expiry half is primary-GM only, for the ordinary reason: a turn change fires `updateCombat`
 * on every connected client at once, and four of them racing to remove one effect is three errors.
 */
export function registerDodgeHooks(): void {
  Hooks.on("dnd5e.postUseActivity", (activity: any) => {
    try {
      if (!enabled() || !isDodgeActivity(activity?.item, activity)) return;
      void markDodging(activity?.actor);
    } catch (err) {
      log("conditions: the Dodge watch failed:", err);
    }
  });

  Hooks.on("updateCombat", (combat: any, changed: any) => {
    try {
      if (!enabled() || !isPrimaryGM()) return;
      // Only a turn or round change ends a Dodge. Initiative edits and flag writes also update the
      // combat document, and expiring on those would take the action away before it was ever used.
      if (!("turn" in (changed ?? {})) && !("round" in (changed ?? {}))) return;
      const actor = combat?.combatant?.actor;
      if (actor) void clearDodging(actor);
    } catch (err) {
      log("conditions: expiring Dodge failed:", err);
    }
  });
}
