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
import { getTurnPaceSeconds } from "../config";
import { isPrimaryGM } from "../../util/gm";
import { runTurnFor } from "../npc-turn";
import { shouldAutomate } from "./registry";
import { hasResolved } from "./encounter";
import { readHp } from "../tracker";

/**
 * Floor on how long an automated turn occupies the table, in milliseconds.
 *
 * This is a minimum DURATION, not a delay bolted onto the end: the time a creature spent thinking,
 * rolling and moving counts toward it, so a slow turn waits not at all and an instant one waits the
 * full pace. Configurable under Text Generation ("Automated turn pace"); 0 disables it.
 */
function paceFloorMs(): number {
  return getTurnPaceSeconds() * 1000;
}

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

/**
 * Advance past the creature Noodlr just played, if the tracker is still where we left it.
 *
 * `startedAt` is when the turn began, so the configured pace is measured across the whole turn rather
 * than added to it.
 */
async function endAutomatedTurn(
  combat: any,
  playedId: string,
  startedAt: number,
  opts: { pace?: boolean } = {},
): Promise<void> {
  if (!combat?.started) return;
  // The GM may have advanced manually while the turn was resolving, or the encounter may have ended on
  // a surrender. Either way the tracker has moved on without us and must not be nudged again.
  if (String(combat.combatant?.id ?? "") !== playedId) return;

  if (consecutive >= RUNAWAY_LIMIT) {
    log(
      `automation stopped advancing the tracker after ${consecutive} consecutive turns — no player turn reached. Advance manually.`,
    );
    ui.notifications?.warn(game.i18n.localize("NOODLRHOOKS.Combat.Runaway"));
    return;
  }

  // The pace exists so the table can follow a turn. A turn in which nothing happened has nothing to
  // follow, so it is skipped at once (user, 2026-08-05: six-second pauses for dead creatures "become a
  // huge nuisance as combat comes to a close" — a wiped enemy line meant half a minute of empty waiting).
  if (opts.pace !== false) {
    const remaining = paceFloorMs() - (Date.now() - startedAt);
    if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
    // Re-check: the pause is long enough for the GM to have acted during it.
    if (!combat?.started || String(combat.combatant?.id ?? "") !== playedId) return;
  }

  try {
    await combat.nextTurn();
  } catch (err) {
    log("could not advance the tracker after an automated turn:", err);
  }
}

/**
 * Has every combatant still in the fight got an initiative?
 *
 * The hard lesson behind this (user's test, 2026-08-04): automatic engagement starts a combat in which
 * only the monsters have rolled, so the tracker's first turn is a monster and automation cheerfully
 * played the whole round — the player was unconscious before ever rolling. Turn order is not meaningful
 * until everyone has a number, and acting on a provisional order is not a pacing problem, it is cheating.
 * Defeated combatants are excluded so a corpse in the tracker cannot deadlock the fight.
 */
export function initiativeSettled(combat: any): boolean {
  for (const combatant of combat?.combatants ?? []) {
    if (combatant?.isDefeated) continue;
    if (combatant?.initiative === null || combatant?.initiative === undefined) return false;
  }
  return true;
}

/**
 * Is this creature out of the fight?
 *
 * Read from the tracker's own defeated mark AND from hit points, because the two disagree often enough
 * to matter: a creature killed by a module that never set the status is still a corpse, and a GM who
 * ticked the skull on something at full health has still said it is out.
 */
function isDown(combatant: any): boolean {
  if (combatant?.isDefeated) return true;
  const hp = readHp(combatant?.actor);
  return Boolean(hp && hp.value !== null && hp.value <= 0);
}

/** The turn currently being played, as combat:round:combatant, so no route plays it twice. */
let playing: string | null = null;

/** Whether we have already said we are waiting, so the console does not fill up with it. */
let waiting = false;

/**
 * Play the current creature's turn, if it is ours to play and the fight is ready for it.
 *
 * Reached from two directions — the tracker advancing, and the last straggler rolling initiative — so
 * it is guarded against playing the same turn twice.
 */
function takeTurn(combat: any): void {
  if (!combat?.started || !isPrimaryGM()) return;

  if (!initiativeSettled(combat)) {
    if (!waiting) {
      waiting = true;
      log("automation is holding: not every combatant has rolled initiative yet");
    }
    return;
  }
  waiting = false;

  const combatant = combat.combatant;
  if (!shouldAutomate(combatant)) {
    // A turn Noodlr does not play — a player's, or a creature the GM kept — is what the runaway
    // brake is counting the absence of.
    consecutive = 0;
    return;
  }

  const id = String(combatant?.id ?? "");
  const token = `${combat.id}:${combat.round}:${id}`;
  if (playing === token) return;
  playing = token;

  // A creature that ran, gave up, stood down or died does not get played again if the tracker still
  // holds a turn for it. It still needs skipping past, though, or the fight stalls on it — and it is
  // skipped without the pace, because there is nothing to watch.
  const startedAt = Date.now();
  if (hasResolved(id) || isDown(combatant)) {
    void endAutomatedTurn(combat, id, startedAt, { pace: false });
    return;
  }

  log(`automation taking ${combatant?.name ?? "?"}'s turn`);
  consecutive++;
  void runTurnFor(combatant).then(() => endAutomatedTurn(combat, id, startedAt));
}

export function registerAutomationTurnHook(): void {
  Hooks.on("deleteCombat", () => {
    consecutive = 0;
    playing = null;
    waiting = false;
  });

  Hooks.on("updateCombat", (combat: any, changed: any) => {
    // Only when the turn actually moved: unrelated tracker edits (initiative fixes, a token added
    // mid-fight) must not re-run the current creature.
    if (!("turn" in (changed ?? {})) && !("round" in (changed ?? {}))) return;
    takeTurn(combat);
  });

  // The other way in: a fight that was held waiting for initiative becomes playable the moment the last
  // straggler rolls. Without this the tracker sits on turn one until somebody nudges it by hand.
  Hooks.on("updateCombatant", (combatant: any, changed: any) => {
    if (!("initiative" in (changed ?? {}))) return;
    takeTurn(combatant?.parent);
  });
}
