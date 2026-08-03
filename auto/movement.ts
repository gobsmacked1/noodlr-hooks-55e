// Actually moving the token.
//
// Up to v0.4.23 the planner only ever *announced* movement ("closes 15 ft on Hobocop"), which the GM
// then had to perform by hand — the single loudest complaint from the first play test: "no NPCs moved".
// This module performs it.
//
// Deliberate limits, so the behaviour is predictable rather than clever:
//   - Straight-line steps only. No pathfinding: if a wall blocks the direct line, we shorten the step
//     and try again rather than route around. A creature that cannot get there simply gets closer.
//   - Never moves further than the budget it was given, and never onto an occupied square.
//   - Snapped to the grid where the scene has one, so tokens land in squares like a player's would.
//   - Nothing here touches hit points, resources, or the turn — movement is the only side effect.

import { log } from "../../constants";
import { blocked, centerOf, insideScene, occupied, type Point } from "./positioning";

function gridSize(): number {
  return Number((canvas as any)?.grid?.size) || 100;
}

function unitsPerSquare(): number {
  return Number((canvas as any)?.grid?.distance) || 5;
}

/** Scene units → canvas pixels. */
function toPixels(units: number): number {
  return (units / unitsPerSquare()) * gridSize();
}

/** Canvas pixels → scene units. */
function toUnits(pixels: number): number {
  return (pixels / gridSize()) * unitsPerSquare();
}

/**
 * Top-left document coordinates for a token whose CENTRE should sit at `point`, snapped to the grid.
 *
 * Foundry stores token position as the top-left corner, while every measurement here is centre-based;
 * conflating the two puts large creatures half a square off, which is exactly the sort of error that
 * looks like "the AI moved it somewhere stupid".
 *
 * Reports whether snapping actually happened, because the waypoint's `snapped` field is pure metadata:
 * it records a claim for the ruler and undo history and snaps nothing itself, so setting it on an
 * unaligned coordinate just files a false statement.
 */
function cornerFor(token: any, point: Point): { point: Point; snapped: boolean } {
  const doc = token?.document ?? token;
  const size = gridSize();
  const corner = {
    x: point.x - (size * (Number(doc?.width) || 1)) / 2,
    y: point.y - (size * (Number(doc?.height) || 1)) / 2,
  };

  // The document's own snapper understands the token's footprint; the raw grid snapper does not.
  for (const snap of [
    () => doc?.getSnappedPosition?.(corner),
    () => (canvas as any)?.grid?.getSnappedPoint?.(corner),
  ]) {
    try {
      const snapped = snap();
      if (Number.isFinite(snapped?.x) && Number.isFinite(snapped?.y))
        return { point: { x: snapped.x, y: snapped.y }, snapped: true };
    } catch {
      // gridless scenes and unfamiliar grid APIs keep the unsnapped position
    }
  }
  return { point: corner, snapped: false };
}

/**
 * How this creature travels, as one of the movement actions the core config declares.
 *
 * Matters because each action carries its own wall rule: a flyer told to "walk" is tested against walls
 * it should be crossing. An action the core does not recognise makes `move()` throw, so anything
 * unrecognised is omitted and the core default applies.
 */
function movementAction(token: any): string | undefined {
  const actions: any = (globalThis as any).CONFIG?.Token?.movement?.actions;
  if (!actions) return undefined;

  const doc = token?.document ?? token;
  const modes: any = doc?.actor?.system?.attributes?.movement;
  if (modes) {
    if (Number(modes.walk) > 0) return actions.walk ? "walk" : undefined;
    // No walk speed: whatever it does instead, in the order a creature would prefer it.
    for (const mode of ["fly", "swim", "burrow", "climb"]) {
      if (Number(modes[mode]) > 0 && actions[mode]) return mode;
    }
  }
  return actions.walk ? "walk" : undefined;
}

/**
 * How long to wait for a move before giving up on it.
 *
 * A movement PAUSED by a region behaviour (Terrain Mapper's stairs and elevators do this) never
 * resolves its promise at all — so an unguarded await would hang the creature's turn, and with it the
 * whole automated initiative chain, for the rest of the session.
 */
const MOVE_TIMEOUT_MS = 8000;

/**
 * Move a token so its centre lands at `point`. Returns the distance travelled in scene units.
 *
 * Uses `TokenDocument#move` (Foundry v13+), which walks the token through the intervening grid spaces,
 * constrains the path against walls, and records the move in the token's history — everything a player
 * dragging the token would get. `update({x, y})` is NOT a fallback: since v13 it is routed through the
 * identical pipeline and is just as refusable, while hiding the outcome behind a truthy return.
 *
 * The distance returned is measured from where the token ACTUALLY ended up, not from where it was asked
 * to go, so a creature stopped short by a wall reports the shorter distance — and 0 means it did not
 * move at all, which the caller is expected to act on rather than assume away.
 */
export async function moveTo(token: any, point: Point): Promise<number> {
  const origin = centerOf(token);
  const doc = token?.document ?? token;
  if (!origin) {
    log("movement: no position for the token; cannot move it");
    return 0;
  }
  if (typeof doc?.move !== "function") {
    log("movement: this token document has no move(); Foundry v13 or newer is required");
    return 0;
  }

  const { point: corner, snapped } = cornerFor(token, point);
  const before = sourcePosition(doc);

  const waypoint: Record<string, unknown> = {
    // Top-left pixel coordinates, as integers. Not centres, not grid offsets.
    x: Math.round(corner.x),
    y: Math.round(corner.y),
    snapped,
    explicit: true,
    checkpoint: true,
  };
  const action = movementAction(token);
  if (action) waypoint.action = action;

  let completed: unknown;
  try {
    // `ignoreCost` because the planner already budgeted this creature's movement in scene units;
    // letting terrain cost truncate the path as well would silently halve every move across rough
    // ground. Walls are deliberately NOT ignored — a creature should no more walk through a wall than a
    // player's token should.
    completed = await withTimeout(
      doc.move(waypoint, {
        method: "api",
        constrainOptions: { ignoreCost: true },
        autoRotate: false,
        showRuler: false,
      }),
    );
  } catch (err) {
    log("movement: move() threw:", err);
    return 0;
  }

  if (completed === TIMED_OUT) {
    // Almost certainly paused by a region behaviour. Stop it, so the creature's turn — and the whole
    // automated initiative chain behind it — is not left awaiting a promise that will never settle.
    log(`movement: ${describe(doc)} stalled mid-move (state: ${state(doc)}); abandoning it`);
    try {
      doc.stopMovement?.();
    } catch {
      // nothing more to do; the turn continues either way
    }
  }

  const after = sourcePosition(doc);
  // A pixel of drift is rounding, not movement.
  if (Math.hypot(after.x - before.x, after.y - before.y) > 1) {
    const landed = centerOf(token) ?? point;
    return Math.round(toUnits(Math.hypot(landed.x - origin.x, landed.y - origin.y)));
  }

  reportRefusal(doc, completed, waypoint);
  return 0;
}

const TIMED_OUT = Symbol("timed-out");

function withTimeout<T>(promise: Promise<T>): Promise<T | typeof TIMED_OUT> {
  return Promise.race([
    promise,
    new Promise<typeof TIMED_OUT>((resolve) =>
      setTimeout(() => resolve(TIMED_OUT), MOVE_TIMEOUT_MS),
    ),
  ]);
}

/**
 * The token's stored position, not its animated one.
 *
 * `_source` is the only honest reading: the prepared `x`/`y` are interpolated during the move animation,
 * so comparing them can report movement that is only a frame of tweening — or none at all, because the
 * animation has not started yet. This is why v0.4.24's "verify it moved" check could not be trusted.
 */
function sourcePosition(doc: any): { x: number; y: number } {
  const source = doc?._source ?? doc;
  return { x: Number(source?.x) || 0, y: Number(source?.y) || 0 };
}

function describe(doc: any): string {
  return String(doc?.name ?? "token");
}

function state(doc: any): string {
  return String(doc?.movement?.state ?? "unknown");
}

/**
 * Explain a move that did not happen, in the terms its cause actually has.
 *
 * `move()` returning false and `move()` returning true are two DIFFERENT failures, and conflating them
 * is what kept this invisible for two releases:
 *
 *  - `false` means core refused: the path was constrained to nothing (a wall, or a destination inside
 *    one), or a `preMoveToken` handler vetoed it. Note that the GM's "Unconstrained Movement" toggle does
 *    not apply to programmatic moves — core reads it only in the drag workflow — so "I can drag the token
 *    there myself" proves nothing about this call.
 *  - `true` with the token still in place means something removed the position from the update after core
 *    had already approved it, which is a `preUpdateToken` handler: a grappled or mounted creature
 *    (Rideable), or one on a teleport cooldown (Monk's Active Tiles).
 */
function reportRefusal(doc: any, completed: unknown, waypoint: Record<string, unknown>): void {
  const movement: any = doc?.movement;
  const detail = {
    completed,
    constrained: movement?.constrained,
    state: movement?.state,
    destination: `${waypoint.x},${waypoint.y}`,
    action: waypoint.action ?? "(core default)",
  };

  if (completed === true) {
    log(
      `movement: core allowed ${describe(doc)}'s move but its position was stripped before saving — is ` +
        `it grappled, mounted, or on a teleport cooldown?`,
      detail,
    );
    return;
  }
  if (movement?.constrained) {
    log(
      `movement: ${describe(doc)}'s path hit walls or terrain and was shortened to nothing`,
      detail,
    );
    return;
  }
  log(
    `movement: ${describe(doc)} was refused — either a preMoveToken handler vetoed it (NotYourTurn and ` +
      `Token Warp both do this) or the destination is unreachable`,
    detail,
  );
}

/**
 * Step toward a target, stopping once within `desired` scene units of it.
 *
 * Tries the full step first and then progressively shorter ones, so a wall or a crowded square costs
 * distance rather than the whole move. Returns the distance actually travelled.
 */
export async function moveToward(
  token: any,
  target: any,
  budget: number,
  desired: number,
): Promise<number> {
  const origin = centerOf(token);
  const goal = centerOf(target);
  if (!origin || !goal || !(budget > 0)) return 0;

  const separation = Math.hypot(goal.x - origin.x, goal.y - origin.y);
  const stopShort = toPixels(Math.max(desired, 0));
  // How far along the line we would LIKE to travel: enough to be in range, no further.
  const wanted = Math.min(toPixels(budget), Math.max(0, separation - stopShort));
  if (wanted < gridSize() * 0.25) return 0;

  const ux = (goal.x - origin.x) / separation;
  const uy = (goal.y - origin.y) / separation;

  for (const fraction of [1, 0.75, 0.5, 0.25]) {
    const distance = wanted * fraction;
    const point = { x: origin.x + ux * distance, y: origin.y + uy * distance };
    if (!insideScene(point) || occupied(point, token)) continue;
    // `false` means "definitely not blocked"; null means the collision API was unreadable, in which
    // case we move anyway — refusing to move on an unknown API would disable movement wholesale.
    if (blocked(origin, point, "move") === true) continue;
    // Keep trying shorter steps when the move is refused. Returning here regardless is what made the
    // whole shorten-and-retry design decorative: the first candidate consumed the loop even when the
    // token never budged, so a destination core disliked ended the attempt outright.
    const travelled = await moveTo(token, point);
    if (travelled > 0) return travelled;
  }
  return 0;
}

/**
 * Back away from a target until at least `desired` units separate them.
 *
 * Used for withdrawing out of reach. Retreat is fanned across nearby bearings, because the direct
 * line away is frequently the one thing a wall is standing on.
 */
export async function moveAwayFrom(
  token: any,
  target: any,
  budget: number,
  desired: number,
): Promise<number> {
  const origin = centerOf(token);
  const threat = centerOf(target);
  if (!origin || !threat || !(budget > 0)) return 0;

  const separation = Math.hypot(origin.x - threat.x, origin.y - threat.y) || 1;
  const needed = Math.max(0, toPixels(desired) - separation);
  const distance = Math.min(toPixels(budget), needed || toPixels(budget));
  if (distance < gridSize() * 0.25) return 0;

  const base = Math.atan2(origin.y - threat.y, origin.x - threat.x);
  // Straight back first, then fan out to either side.
  const offsets = [0, Math.PI / 6, -Math.PI / 6, Math.PI / 3, -Math.PI / 3];
  for (const offset of offsets) {
    const angle = base + offset;
    const point = {
      x: origin.x + Math.cos(angle) * distance,
      y: origin.y + Math.sin(angle) * distance,
    };
    if (!insideScene(point) || occupied(point, token)) continue;
    if (blocked(origin, point, "move") === true) continue;
    const travelled = await moveTo(token, point);
    if (travelled > 0) return travelled;
  }
  return 0;
}

/**
 * Leave the field. A creature that flees walks to the nearest scene edge under its own speed; it is
 * removed from play by the encounter layer, not here.
 */
export async function moveOffField(token: any, budget: number): Promise<number> {
  const origin = centerOf(token);
  const rect: any = (canvas as any)?.dimensions?.sceneRect;
  if (!origin || !rect || !(budget > 0)) return 0;

  const exits: Point[] = [
    { x: rect.x, y: origin.y },
    { x: rect.x + rect.width, y: origin.y },
    { x: origin.x, y: rect.y },
    { x: origin.x, y: rect.y + rect.height },
  ];
  exits.sort(
    (a, b) =>
      Math.hypot(a.x - origin.x, a.y - origin.y) - Math.hypot(b.x - origin.x, b.y - origin.y),
  );

  const distance = toPixels(budget);
  for (const exit of exits) {
    const span = Math.hypot(exit.x - origin.x, exit.y - origin.y) || 1;
    const step = Math.min(distance, span);
    const point = {
      x: origin.x + ((exit.x - origin.x) / span) * step,
      y: origin.y + ((exit.y - origin.y) / span) * step,
    };
    if (occupied(point, token)) continue;
    if (blocked(origin, point, "move") === true) continue;
    const travelled = await moveTo(token, point);
    if (travelled > 0) return travelled;
  }
  return 0;
}
