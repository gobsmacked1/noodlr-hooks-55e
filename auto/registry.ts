// Which creatures Noodlr is currently playing, and for how long.
//
// Automation is a property of THIS FIGHT, never of the actor or the token. A goblin the GM handed to
// the module in one ambush should not still be automated when its twin shows up three sessions later
// — that would be a persistent flag on a shared actor, quietly changing how every copy behaves. So
// the opt-in list is in-memory, keyed by combatant id, and dies with the encounter.
//
// In "full" mode the list is irrelevant: every non-player combatant is played. In "partial" the GM
// toggles creatures in and out with the Act-as-NPC tool, including mid-fight to take one back.

import { log } from "../../constants";
import { getCombatAutomation } from "../config";

const optedIn = new Set<string>();

export function registerAutomationCleanup(): void {
  Hooks.on("deleteCombat", () => {
    if (optedIn.size > 0) log(`combat ended; releasing ${optedIn.size} automated combatant(s)`);
    optedIn.clear();
  });
}

export function isOptedIn(combatantId: string): boolean {
  return optedIn.has(combatantId);
}

/** Flip one combatant in or out of automation. Returns the state it ended up in. */
export function toggleOptIn(combatantId: string): boolean {
  if (optedIn.has(combatantId)) {
    optedIn.delete(combatantId);
    return false;
  }
  optedIn.add(combatantId);
  return true;
}

export function releaseCombatant(combatantId: string): void {
  optedIn.delete(combatantId);
}

/** Player characters are never automated, whatever the mode says. */
function isPlayerCombatant(combatant: any): boolean {
  return Boolean(combatant?.hasPlayerOwner ?? combatant?.actor?.hasPlayerOwner);
}

/** Should Noodlr play this combatant's turn? */
export function shouldAutomate(combatant: any): boolean {
  if (!combatant || isPlayerCombatant(combatant)) return false;
  const mode = getCombatAutomation();
  if (mode === "off") return false;
  if (mode === "full") return true;
  return isOptedIn(String(combatant.id ?? ""));
}
