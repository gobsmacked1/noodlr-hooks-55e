// Opening a door from across the room is not reach.
//
// Arm's Reach is installed on this table and its door integration is on, but its default
// `globalInteractionDistanceForGMOnDoors` is false — and that setting means every GM click is
// unrestricted, including a GM who is playing a character. The Archmage fight (2026-08-21) is how
// that read: a distance-click opened a door from well outside melee. We do not stand aside for a
// module whose default is the bug. Dual-refuse is fine; a door that stays shut is recoverable.
//
// The veto is `preUpdateWall` when `ds` changes, on every client, because the presser's own hook is
// the one that can cancel. A GM with no token on the scene is staging and is left alone. A GM who
// HAS a token selected is the distant-click case. A player with no token cannot reach a door.

import { log } from "../constants";
import { isInteractReachEnabled } from "../settings";
import { centerOf, measureBetween, type Point } from "../core/positioning";

const CLOSED = 0;

export function doorCenter(wall: any): Point | null {
  const c = wall?.c ?? wall?.document?.c;
  if (!Array.isArray(c) || c.length < 4) return null;
  const x1 = Number(c[0]);
  const y1 = Number(c[1]);
  const x2 = Number(c[2]);
  const y2 = Number(c[3]);
  if (![x1, y1, x2, y2].every(Number.isFinite)) return null;
  return { x: (x1 + x2) / 2, y: (y1 + y2) / 2 };
}

/** One grid square, in scene units. That is melee reach on a 5-foot grid. */
export function interactReach(): number {
  const grid = (canvas as any)?.grid ?? (canvas as any)?.scene?.grid;
  const distance = Number(grid?.distance);
  return distance > 0 ? distance : 5;
}

export function withinInteractReach(
  token: any,
  door: Point,
  reach: number,
  measure: (a: Point, b: Point) => number = measureBetween,
): boolean {
  const from = centerOf(token);
  if (!from) return false;
  return measure(from, door) <= reach;
}

function actingTokens(): any[] {
  const controlled = [...((canvas as any)?.tokens?.controlled ?? [])].filter(Boolean);
  if (controlled.length) return controlled;
  const character = (game as any)?.user?.character;
  if (!character) return [];
  try {
    const tokens = character.getActiveTokens?.(true) ?? [];
    return tokens.filter(Boolean);
  } catch {
    return [];
  }
}

function nearest(
  tokens: any[],
  door: Point,
  measure: (a: Point, b: Point) => number = measureBetween,
): any | null {
  let best: any = null;
  let bestGap = Infinity;
  for (const token of tokens) {
    const from = centerOf(token);
    if (!from) continue;
    const gap = measure(from, door);
    if (gap < bestGap) {
      bestGap = gap;
      best = token;
    }
  }
  return best;
}

function notify(key: string): void {
  try {
    ui.notifications?.warn(game.i18n.localize(key));
  } catch {
    /* a toast is courtesy */
  }
}

/**
 * May this client change this door's state right now?
 *
 * Exported so a test can pin the GM-with-token / GM-without-token split without a wall document.
 */
export function mayReachDoor(opts: {
  isGM: boolean;
  tokens: any[];
  door: Point;
  reach: number;
  measure?: (a: Point, b: Point) => number;
}): { ok: boolean; reason?: string } {
  const { isGM, tokens, door, reach, measure = measureBetween } = opts;
  if (!tokens.length) {
    return isGM ? { ok: true } : { ok: false, reason: "no-token" };
  }
  const token = nearest(tokens, door, measure);
  if (!token) return isGM ? { ok: true } : { ok: false, reason: "no-token" };
  if (withinInteractReach(token, door, reach, measure)) return { ok: true };
  return { ok: false, reason: "too-far" };
}

export function registerInteractReach(): void {
  Hooks.on("preUpdateWall", (document: any, changed: any, _options: any, userId: string) => {
    if (!isInteractReachEnabled()) return;
    if (userId && (game as any).userId && userId !== (game as any).userId) return;
    if (!document?.door) return;
    if (!("ds" in (changed ?? {}))) return;
    const next = Number(changed.ds);
    const prev = Number(document.ds ?? CLOSED);
    if (!Number.isFinite(next) || next === prev) return;

    const door = doorCenter(document);
    if (!door) return;

    const tokens = actingTokens();
    const reach = interactReach();
    const verdict = mayReachDoor({
      isGM: Boolean(game.user?.isGM),
      tokens,
      door,
      reach,
    });
    if (verdict.ok) return;

    const who = String(tokens[0]?.name ?? game.user?.name ?? "?");
    log(
      `interact: ${who} cannot change that door from here (${verdict.reason}, reach ${reach})`,
    );
    notify(
      verdict.reason === "no-token"
        ? "NOODLRHOOKS.General.InteractReach.NoToken"
        : "NOODLRHOOKS.General.InteractReach.TooFar",
    );
    return false;
  });
}

export function surveyInteract(): Record<string, unknown> {
  const tokens = actingTokens();
  const reach = interactReach();
  return {
    enabled: isInteractReachEnabled(),
    reach,
    tokens: tokens.map((t) => String(t?.name ?? "?")),
    isGM: Boolean(game.user?.isGM),
  };
}
