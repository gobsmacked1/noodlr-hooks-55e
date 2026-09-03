// Pause a walk that would provoke, so Halt can stop the rest of the path.
//
// Core's `moveToken` is not awaited and fires per waypoint. Remaining waypoints keep
// committing while the six-second OA dialog is up. `pauseMovement` / `stopMovement`
// belong to the User that *initiated* the move — a GM cannot stop a player's drag.
// Pause must therefore be synchronous, on the initiator, in `moveToken`.
//
// Leaf: pause / stop / resume / rewind only. `reactions.ts` decides whether a leave
// would provoke. Do not revert the whole drag — that returns them to the start.
// The Halt square is the first out-of-reach waypoint (`leaveSquareAt`).

import { log } from "../constants";
import { rollerForActor } from "../util/gm";
import { askUser, registerQuery } from "../util/queries";
import { FORCE_ACTION } from "./shove";

export const HOLD_KEY = "noodlr-oa";

interface Hold {
  movementId: string;
  leave: { x: number; y: number; elevation?: number } | null;
  userId?: string;
  tokenUuid: string;
  stopped?: boolean;
}

const holds = new Map<string, Hold>();

export function pendingRemainder(movement: any): number {
  return Number(movement?.pending?.waypoints?.length ?? 0);
}

export function shouldHoldMove(wouldProvoke: boolean, pending: number): boolean {
  return Boolean(wouldProvoke) && pending > 0;
}

/** The square they occupy after the leave at `index`. `route[0]` is the origin. */
export function leaveSquareAt(
  route: Array<{ x: number; y: number; elevation?: number }>,
  index: number,
): { x: number; y: number; elevation?: number } | null {
  const point = route[index + 1];
  if (!point) return null;
  const x = Number(point.x);
  const y = Number(point.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const elevation = Number(point.elevation);
  return Number.isFinite(elevation) ? { x, y, elevation } : { x, y };
}

export function rememberHold(
  doc: any,
  movement: any,
  leave: { x: number; y: number; elevation?: number } | null,
): void {
  const id = String(doc?.id ?? "");
  if (!id) return;
  const movementId = String(movement?.id ?? movement?._id ?? "");
  if (!movementId) return;
  const existing = holds.get(id);
  holds.set(id, {
    movementId,
    leave,
    userId: existing?.userId,
    tokenUuid: String(doc?.uuid ?? existing?.tokenUuid ?? ""),
    stopped: existing?.stopped,
  });
}

export function peekHold(doc: any): Hold | undefined {
  return holds.get(String(doc?.id ?? ""));
}

export function isHeld(doc: any): boolean {
  return holds.has(String(doc?.id ?? ""));
}

/** Pause if we initiated this move. False when `pauseMovement` returns null (not us). */
export function pauseHeld(
  doc: any,
  movement: any,
  leave: { x: number; y: number; elevation?: number } | null,
): boolean {
  rememberHold(doc, movement, leave);
  const paused = doc?.pauseMovement?.(HOLD_KEY);
  if (!paused) return false;
  const hold = holds.get(String(doc?.id ?? ""));
  if (hold) hold.userId = String((globalThis as any).game?.user?.id ?? "");
  return true;
}

export async function resumeHeld(doc: any): Promise<void> {
  const id = String(doc?.id ?? "");
  const hold = holds.get(id);
  if (!hold || hold.stopped) {
    holds.delete(id);
    return;
  }
  try {
    doc?.resumeMovement?.(hold.movementId, HOLD_KEY);
  } catch (err) {
    log(`move-hold: could not resume ${String(doc?.name ?? id)}:`, err);
  }
  holds.delete(id);
}

export async function stopHeld(doc: any): Promise<void> {
  const id = String(doc?.id ?? "");
  const hold = holds.get(id);
  if (hold) hold.stopped = true;

  const stopped = doc?.stopMovement?.();
  if (stopped) {
    holds.delete(id);
    return;
  }

  const game = (globalThis as any).game;
  const owner =
    hold?.userId || rollerForActor(doc?.actor) || String(game?.users?.activeGM?.id ?? "");
  if (owner && owner !== String(game?.user?.id ?? "")) {
    await askUser(String(owner), "stopHeldMove", {
      tokenUuid: String(hold?.tokenUuid ?? doc?.uuid ?? ""),
    });
  }
  holds.delete(id);
}

function atSquare(doc: any, leave: { x: number; y: number }): boolean {
  const x = Number(doc?._source?.x ?? doc?.x);
  const y = Number(doc?._source?.y ?? doc?.y);
  return Math.round(x) === Math.round(leave.x) && Math.round(y) === Math.round(leave.y);
}

async function forceTo(
  doc: any,
  leave: { x: number; y: number; elevation?: number },
): Promise<boolean> {
  try {
    const waypoint: Record<string, unknown> = {
      x: leave.x,
      y: leave.y,
      action: FORCE_ACTION,
      snapped: true,
    };
    if (Number.isFinite(leave.elevation)) waypoint.elevation = leave.elevation;
    await doc.move?.([waypoint], {
      method: "api",
      noodlrForced: true,
      constrainOptions: { ignoreCost: true },
    });
    return true;
  } catch (err) {
    log(`move-hold: could not rewind ${String(doc?.name ?? "?")}:`, err);
    return false;
  }
}

/** Stop remaining waypoints, then snap back to the leave square if pause never held. */
export async function haltMovement(doc: any): Promise<void> {
  const leave = peekHold(doc)?.leave ?? null;
  await stopHeld(doc);
  if (leave && !atSquare(doc, leave)) await forceTo(doc, leave);
}

export function clearHolds(): void {
  holds.clear();
}

export function registerMoveHoldQueries(): void {
  registerQuery("stopHeldMove", async (data) => {
    const uuid = String(data?.tokenUuid ?? "");
    const fromUuid = (globalThis as any).fromUuid;
    const doc = uuid && typeof fromUuid === "function" ? await fromUuid(uuid) : null;
    if (!doc) return false;
    const stopped = Boolean(doc.stopMovement?.());
    holds.delete(String(doc.id ?? ""));
    return stopped;
  });
}
