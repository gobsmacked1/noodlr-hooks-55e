// Firing automated turns when the tracker advances.
//
// One client must own this. Every GM sees the same `updateCombat`, so without a designated owner a
// table with an assistant GM would plan (and later execute) the same creature's turn twice. The
// primary GM is the same tiebreak used everywhere else in the module.

import { log } from "../../constants";
import { isPrimaryGM } from "../../util/gm";
import { runTurnFor } from "../npc-turn";
import { shouldAutomate } from "./registry";

export function registerAutomationTurnHook(): void {
  Hooks.on("updateCombat", (combat: any, changed: any) => {
    // Only when the turn actually moved: unrelated tracker edits (initiative fixes, a token added
    // mid-fight) must not re-run the current creature.
    if (!("turn" in (changed ?? {})) && !("round" in (changed ?? {}))) return;
    if (!combat?.started) return;
    if (!isPrimaryGM()) return;

    const combatant = combat.combatant;
    if (!shouldAutomate(combatant)) return;

    log(`automation taking ${combatant?.name ?? "?"}'s turn`);
    void runTurnFor(combatant);
  });
}
