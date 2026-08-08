// GM-facing control of combat automation: hand a creature to Noodlr, or take it back.
//
// The gesture is "select the token, press the button" rather than a checkbox in a window, because
// during a fight the GM's hands are already on the canvas and the combatant they mean is the one
// they just clicked. Pressing it again returns the creature to manual control, mid-fight, with no
// confirmation — taking back the reins should never require a dialog.

import { log } from "../constants";
import { isOptedIn, toggleOptIn } from "./registry";

/** Find the combatant for a selected token, if that token is in the current fight. */
function selectedCombatants(): any[] {
  const combat = game.combat;
  if (!combat) return [];
  const selected: any[] = (canvas as any)?.tokens?.controlled ?? [];
  const out: any[] = [];
  for (const token of selected) {
    const id = token?.document?.id ?? token?.id;
    const combatant = (combat.combatants as any)?.find?.(
      (c: any) => c.tokenId === id || c.token?.id === id,
    );
    if (combatant) out.push(combatant);
  }
  return out;
}

/**
 * Toggle automation for whatever the GM has selected. Multi-select is honored — marking a whole
 * skeleton crew at once is the common case, and doing them one at a time would be tedious.
 */
export async function toggleSelectedCombatantAutomation(): Promise<void> {
  const combat = game.combat;
  if (!combat?.started) {
    ui.notifications?.warn(game.i18n.localize("NOODLRHOOKS.Combat.NoCombat"));
    return;
  }

  const combatants = selectedCombatants();
  if (combatants.length === 0) {
    ui.notifications?.warn(game.i18n.localize("NOODLRHOOKS.Combat.SelectToken"));
    return;
  }

  const enabled: string[] = [];
  const released: string[] = [];
  for (const combatant of combatants) {
    const isPC = Boolean(combatant?.hasPlayerOwner ?? combatant?.actor?.hasPlayerOwner);
    if (isPC) {
      ui.notifications?.warn(
        game.i18n.format("NOODLRHOOKS.Combat.IsPCNamed", { name: combatant.name ?? "?" }),
      );
      continue;
    }
    const now = toggleOptIn(String(combatant.id ?? ""));
    (now ? enabled : released).push(String(combatant.name ?? "?"));
  }

  if (enabled.length > 0) {
    ui.notifications?.info(
      game.i18n.format("NOODLRHOOKS.Combat.AutomationOn", { names: enabled.join(", ") }),
    );
  }
  if (released.length > 0) {
    ui.notifications?.info(
      game.i18n.format("NOODLRHOOKS.Combat.AutomationOff", { names: released.join(", ") }),
    );
  }
  log(`automation toggled — on: [${enabled.join(", ")}] off: [${released.join(", ")}]`);
}

/** Whether the currently selected token is already automated (for future button styling). */
export function selectionIsAutomated(): boolean {
  const combatants = selectedCombatants();
  return combatants.length > 0 && combatants.every((c) => isOptedIn(String(c.id ?? "")));
}
