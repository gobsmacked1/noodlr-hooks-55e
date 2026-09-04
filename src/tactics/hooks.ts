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
//
// After the tracker flips, nobody else acts until combatants are at rest (`core/settle.ts`). A player
// Dash at sheet pace is still sliding when Argon / Hurry Up / a click calls nextTurn; legendary
// actions and takeTurn used to fire in that window. We never end a player-owned turn ourselves.

import { log } from "../constants";
import { waitForCombatantsToRest } from "../core/settle";
import { getTurnPaceSeconds } from "../settings";
import { isPrimaryGM } from "../util/gm";
import { runTurnFor } from "./npc-turn";
import { shouldAutomate } from "./registry";
import { hasResolved } from "./encounter";
import { isFleeingCombatant } from "./flee";
import { fireLegendaryActions, noteLegendaryAdvance, resetLegendaryAdvance } from "./legendary-act";
import { isUnableToAct, skipReason } from "./skip";
import {
  waitForOwedRolls,
  owedOutstanding,
  OWED_CLEARED,
} from "../rules/owed-roll";

/** Why we have not yet advanced or played: an Eye Ray save (or similar) is still open. */
let owedHold: { action: "take" | "next"; combatantId: string } | null = null;

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

  const clear = await waitForOwedRolls();
  if (!clear) {
    owedHold = { action: "next", combatantId: playedId };
    const names = owedOutstanding().map((o) => o.name).join(", ");
    log(`automation holding nextTurn — ${names || "a demanded roll"} still outstanding`);
    return;
  }

  await settleCombatants(combat, "nextTurn");
  if (!combat?.started || String(combat.combatant?.id ?? "") !== playedId) return;

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

  // A creature that ran, gave up, stood down, died, or cannot act (Incapacitated and everything that
  // grants it) does not get played if the tracker still holds a turn for it. It still needs skipping
  // past, or the fight stalls on it — and it is skipped without the pace, because there is nothing
  // to watch. Hold Person on the Assassin was the specimen: paralyzed landed, then the planner walked.
  const startedAt = Date.now();
  if (hasResolved(id) || (isUnableToAct(combatant) && !isFleeingCombatant(combatant))) {
    const why = hasResolved(id) ? "already resolved" : (skipReason(combatant) ?? "unable to act");
    log(`automation skipping ${combatant?.name ?? "?"}'s turn: ${why}`);
    void endAutomatedTurn(combat, id, startedAt, { pace: false });
    return;
  }

  log(`automation taking ${combatant?.name ?? "?"}'s turn`);
  consecutive++;
  void runTurnFor(combatant).then(() => endAutomatedTurn(combat, id, startedAt));
}

async function settleCombatants(combat: any, why: string): Promise<void> {
  const settled = await waitForCombatantsToRest(combat);
  if (settled === "rest") return;
  log(
    `automation proceeding (${why}) after combatants ${
      settled === "stale" ? "stopped moving (stale animation)" : "hit the rest-wait deadline"
    }`,
  );
}

async function onAdvance(combat: any): Promise<void> {
  // The tracker can flip while a player Dash is still in flight — document commit
  // lags nextTurn by a few hundred ms, and the sprite lags the document by seconds
  // at sheet pace. Legendary actions and the next takeTurn wait here.
  await settleCombatants(combat, "onAdvance");
  const ended = noteLegendaryAdvance(combat);
  // Eye Rays at the end of the turn that just finished, before the next creature acts.
  // Awaited so a Beholder that is also next in order rays first, then takes its turn.
  await fireLegendaryActions(combat, ended);
  // Legendary rays post AFTER the tracker has already moved. Waiting only in `nextTurn`
  // lets the new current combatant act (or be played) before a petrify save exists.
  const clear = await waitForOwedRolls();
  if (!clear) {
    owedHold = { action: "take", combatantId: String(combat.combatant?.id ?? "") };
    const names = owedOutstanding().map((o) => o.name).join(", ");
    log(`automation holding takeTurn — ${names || "a demanded roll"} still outstanding`);
    return;
  }
  takeTurn(combat);
}

function resumeOwedHold(): void {
  const what = owedHold;
  owedHold = null;
  const combat = (globalThis as any).game?.combat;
  if (!combat?.started || !what) return;
  const current = String(combat.combatant?.id ?? "");
  if (what.action === "next") {
    if (current !== what.combatantId) {
      log(
        `automation dropped a held nextTurn — tracker is now ${combat.combatant?.name ?? current}, not the combatant we were holding`,
      );
      return;
    }
    void combat.nextTurn?.();
    return;
  }
  takeTurn(combat);
}

export function registerAutomationTurnHook(): void {
  Hooks.on("deleteCombat", () => {
    consecutive = 0;
    playing = null;
    waiting = false;
    owedHold = null;
    resetLegendaryAdvance();
  });

  Hooks.on(OWED_CLEARED, () => {
    if (!owedHold) return;
    resumeOwedHold();
  });

  Hooks.on("updateCombat", (combat: any, changed: any, _options: unknown, userId?: string) => {
    // Only when the turn actually moved: unrelated tracker edits (initiative fixes, a token added
    // mid-fight) must not re-run the current creature.
    if (!("turn" in (changed ?? {})) && !("round" in (changed ?? {}))) return;
    const user = (globalThis as any).game?.users?.get?.(userId);
    log(
      `tracker advanced to ${combat?.combatant?.name ?? "?"} (round ${combat?.round ?? "?"}) by ${user?.name ?? userId ?? "?"}`,
    );
    void onAdvance(combat);
  });

  // The other way in: a fight that was held waiting for initiative becomes playable the moment the last
  // straggler rolls. Without this the tracker sits on turn one until somebody nudges it by hand.
  Hooks.on("updateCombatant", (combatant: any, changed: any) => {
    if (!("initiative" in (changed ?? {}))) return;
    takeTurn(combatant?.parent);
  });
}
