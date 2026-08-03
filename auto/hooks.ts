// Firing automated turns when the tracker advances, and advancing it again when they finish.
//
// One client must own this. Every GM sees the same `updateCombat`, so without a designated owner a
// table with an assistant GM would plan (and later execute) the same creature's turn twice. The
// primary GM is the same tiebreak used everywhere else in the module.
//
// Automation ends the creature's turn too (user's call, 2026-08-03: "automation should include ending
// the NPC's turn and advancing to the next NPC or PC in initiative order"). That makes the tracker
// self-propelling through consecutive automated creatures and stopping dead on a player's turn — a
// horde of skeletons resolves itself while the party keeps its own pacing. A creature the GM is playing
// by hand is untouched in either mode, and the console entry point does NOT advance: a GM asking Noodlr
// to play one creature has not asked it to take over the fight.

import { log } from "../../constants";
import { isPrimaryGM } from "../../util/gm";
import { runTurnFor } from "../npc-turn";
import { shouldAutomate } from "./registry";
import { hasResolved } from "./encounter";

/**
 * Beat between the narration and the tracker moving on.
 *
 * Chat cards render asynchronously; without a pause the tracker jumps before the table has read what
 * just happened, and a chain of automated creatures becomes a wall of text appearing after the fact.
 */
const SETTLE_MS = 900;

/**
 * Consecutive automated turns before automation stops advancing the tracker.
 *
 * The brake exists because self-propulsion has one genuinely unbounded case: a fight in which no
 * combatant ever stops the chain — NPCs against NPCs, or a party that has been wiped — would cycle
 * rounds forever, unattended, each one issuing rolls. Two dozen turns is far more than any real
 * encounter needs between player turns, and hitting it means something is wrong rather than busy.
 */
const RUNAWAY_LIMIT = 24;

let consecutive = 0;

/** Advance past the creature Noodlr just played, if the tracker is still where we left it. */
async function endAutomatedTurn(combat: any, playedId: string): Promise<void> {
  if (!combat?.started) return;
  // The GM may have advanced manually while the turn was resolving, or the encounter may have ended on
  // a surrender. Either way the tracker has moved on without us and must not be nudged again.
  if (String(combat.combatant?.id ?? "") !== playedId) return;

  if (consecutive >= RUNAWAY_LIMIT) {
    log(
      `automation stopped advancing the tracker after ${consecutive} consecutive turns — no player turn reached. Advance manually.`,
    );
    ui.notifications?.warn(game.i18n.localize("NOODLR.Combat.Runaway"));
    return;
  }

  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
  // Re-check: the pause is long enough for the GM to have acted during it.
  if (!combat?.started || String(combat.combatant?.id ?? "") !== playedId) return;

  try {
    await combat.nextTurn();
  } catch (err) {
    log("could not advance the tracker after an automated turn:", err);
  }
}

export function registerAutomationTurnHook(): void {
  Hooks.on("deleteCombat", () => {
    consecutive = 0;
  });

  Hooks.on("updateCombat", (combat: any, changed: any) => {
    // Only when the turn actually moved: unrelated tracker edits (initiative fixes, a token added
    // mid-fight) must not re-run the current creature.
    if (!("turn" in (changed ?? {})) && !("round" in (changed ?? {}))) return;
    if (!combat?.started) return;
    if (!isPrimaryGM()) return;

    const combatant = combat.combatant;
    if (!shouldAutomate(combatant)) {
      // A turn Noodlr does not play — a player's, or a creature the GM kept — is what the runaway
      // brake is counting the absence of.
      consecutive = 0;
      return;
    }
    // A creature that ran, gave up, or stood down does not get played again if the tracker still
    // holds a turn for it. It still needs skipping past, though, or the fight stalls on it.
    const id = String(combatant?.id ?? "");
    if (hasResolved(id)) {
      void endAutomatedTurn(combat, id);
      return;
    }

    log(`automation taking ${combatant?.name ?? "?"}'s turn`);
    consecutive++;
    void runTurnFor(combatant).then(() => endAutomatedTurn(combat, id));
  });
}
