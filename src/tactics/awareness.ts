// What the creature planning its turn actually knows about.
//
// `readBoard` reads the combat tracker, and the tracker is omniscient: every combatant is in it,
// wherever they are standing and whatever they are doing about being found. So a rogue who hid, broke
// line of sight and moved was still the nearest entry in `board.enemies`, and the planner pursued them
// square by square with the confidence of something that could see straight through the wall. Reported
// 2026-08-16, and the giveaway was the pursuit track rather than any error: the behaviour was correct
// for the board it was given, and the board was a lie.
//
// TWO QUESTIONS ARE ASKED AND THEY COST DIFFERENT AMOUNTS, which is the whole shape of this file.
//
//   `evades` is arithmetic — concealment layers, then a banked Stealth DC against passive Perception —
//   and it is asked about EVERY enemy, because it is what catches an invisible one as well as a hidden
//   one. It builds nothing and reads no polygons.
//
//   `sightOf` casts rays, and it is asked ONLY about creatures that are deliberately hiding. Asking it
//   about everybody is the tempting version and it regresses ordinary combat: a creature whose token
//   has vision switched off and whose stat block states no senses falls back to an ASSUMED 60 ft of
//   sight, so on a large map every archer would abruptly be unable to see the thing it had been
//   shooting at all fight. Nobody hiding means no vision source is ever built.
//
// The consequence, stated rather than left to be discovered: a creature that has NOT hidden is still
// tracked through a wall. That is the behaviour this module has always had, and it is not what was
// reported — somebody who never tried to be unfindable has not earned being unfindable, and the fix for
// it is a per-creature sight model whose fallback is trustworthy rather than a filter here.
//
// This READS the sweep's per-watcher `spotted` set — `evades` consults it internally — and deliberately
// never WRITES to it. The set is maintained by `maintainSpotted`, which runs only inside the perception
// sweep, which is gated on auto-engagement being on; so on a table that switched auto-engagement off,
// a watcher recorded here would never be cleared by anything and the spot would be permanent. Reading a
// possibly-stale set costs a monster that keeps tracking; writing to one nobody maintains costs a rogue
// who can never hide again.

import { log, MODULE_ID } from "../constants";
import { readBoard, type Board, type BoardActor, type UnseenEnemy } from "../core/board";
import { centerOf, measureBetween } from "../core/positioning";
import { isStealthEnabled } from "../settings";
import { releaseVision, sightOf, type VisionCache } from "../rules/sight";
import { evades, hidingState } from "../rules/stealth";

/** Where one observer last saw one creature. */
interface Sighting {
  point: { x: number; y: number };
  elevation: number;
  name: string;
}

/**
 * Last-known positions, keyed `observerTokenId:targetTokenId`.
 *
 * In memory and per client, deliberately, for the same reason the per-encounter registry is: a flag on
 * the actor would outlive the fight and follow every future copy of that goblin, and a creature that
 * remembers where it saw somebody three sessions ago is worse than one that remembers nothing.
 */
const seenAt = new Map<string, Sighting>();

/** Forget every sighting. Called when a fight ends. */
export function forgetSightings(): void {
  seenAt.clear();
}

function key(observerId: string, targetId: string): string {
  return `${observerId}:${targetId}`;
}

/**
 * Narrow a board to what its owner can perceive, and record where the rest were last seen.
 *
 * Returns a new board rather than mutating: `readBoard`'s answer is the measurement, this is one
 * creature's reading of it, and keeping them separable is what lets a diagnostic show both.
 *
 * FAILS TOWARD SEEING, at every level — a thrown vision test, an unreadable token, stealth switched off
 * — because the destructive failure here is granting free invisibility to something that never earned
 * it, and a monster that fights normally is merely the status quo. Same asymmetry as `sight.ts`.
 */
export function applyAwareness(board: Board): Board {
  if (!isStealthEnabled()) return board;

  const selfToken = board.self.token;
  const selfId = String(board.self.tokenId);

  const vision: VisionCache = new Map();
  const visible: BoardActor[] = [];
  const unseen: UnseenEnemy[] = [];

  try {
    for (const enemy of board.enemies) {
      let found = true;
      try {
        const hiding = Boolean(hidingState(enemy.token));
        // `useModes: false` says core's detection modes have NOT already run, which is true here and
        // matters: it is what makes plain invisibility our business rather than something we are
        // deferring on. A watcher with see-invisible still pierces it, through `evades`' own table.
        found = !evades(selfToken, enemy.token, enemy.distance, false);
        if (found && hiding) found = sightOf(selfToken, enemy.token, vision).seen;
      } catch (err) {
        log(`awareness: ${board.self.name} could not test its sight of ${enemy.name}:`, err);
        found = true;
      }

      if (found) {
        remember(selfId, enemy);
        visible.push(enemy);
        continue;
      }

      const memory = seenAt.get(key(selfId, enemy.tokenId));
      // No memory at all means this creature never saw them in the first place, so there is nothing
      // to know and nowhere to search. It is dropped from the board entirely rather than added to
      // `unseen`, which is what makes an ambush an ambush.
      if (!memory) continue;

      const here = centerOf(selfToken);
      unseen.push({
        tokenId: enemy.tokenId,
        name: memory.name,
        point: memory.point,
        elevation: memory.elevation,
        distance: here ? measureBetween(here, memory.point) : Number.POSITIVE_INFINITY,
      });
    }
  } finally {
    releaseVision(vision);
  }

  if (unseen.length > 0) {
    log(
      `awareness: ${board.self.name} has lost sight of ${unseen.map((u) => u.name).join(", ")}`,
    );
  }

  unseen.sort((a, b) => a.distance - b.distance);
  return { ...board, enemies: visible, unseen };
}

/**
 * What each selected creature can and cannot see, and where it would go looking.
 *
 * Printed flat, one line per enemy: the finding this exists to show is a NEGATIVE — "the planner still
 * thinks it can see the rogue" — and a nested return value renders in a console as a collapsed
 * `Object { … }`, which is what gets pasted into a report. Same lesson as `surveyCapabilities`.
 */
export function surveyAwareness(): unknown {
  const lines: string[] = [`stealth enforcement: ${isStealthEnabled() ? "on" : "OFF"}`];
  const rows: any[] = [];

  for (const token of (canvas as any)?.tokens?.controlled ?? []) {
    const combatant = token?.combatant ?? token?.document?.combatant;
    if (!combatant) {
      lines.push(`${token?.name}: not in the combat tracker, so it has no board to read`);
      continue;
    }
    const raw = readBoard(combatant);
    if (!raw) {
      lines.push(`${token?.name}: no readable board`);
      continue;
    }
    const aware = applyAwareness(raw);
    const seen = new Set(aware.enemies.map((e) => e.tokenId));

    lines.push(`\n${aware.self.name} — ${raw.enemies.length} hostile(s) in the tracker:`);
    for (const enemy of raw.enemies) {
      const hiding = (() => {
        try {
          const h = hidingState(enemy.token);
          return h ? `hiding at DC ${h.dc}` : "not hiding";
        } catch {
          return "hiding state unreadable";
        }
      })();
      lines.push(
        `  ${seen.has(enemy.tokenId) ? "SEES" : "lost"}  ${enemy.name} — ${Math.round(enemy.distance)} ${aware.units}, ${hiding}`,
      );
    }
    for (const lost of aware.unseen) {
      lines.push(
        `  would search for ${lost.name}, last seen ${Math.round(lost.distance)} ${aware.units} away`,
      );
    }
    if (aware.unseen.length === 0 && aware.enemies.length < raw.enemies.length) {
      lines.push(`  (nothing to search — it never saw the one it cannot see)`);
    }
    rows.push({ self: aware.self.name, sees: aware.enemies.length, unseen: aware.unseen });
  }

  if (rows.length === 0 && lines.length === 1) lines.push("nothing selected");
  console.log(`[${MODULE_ID}] awareness\n${lines.join("\n")}`);
  return rows;
}

/** Note where an enemy is standing, for when it stops being visible. */
function remember(observerId: string, enemy: BoardActor): void {
  const point = centerOf(enemy.token);
  if (!point) return;
  seenAt.set(key(observerId, enemy.tokenId), {
    point,
    elevation: enemy.elevation,
    name: enemy.name,
  });
}
