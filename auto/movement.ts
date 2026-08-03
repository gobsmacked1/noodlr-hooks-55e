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
 */
function cornerFor(token: any, point: Point): Point {
  const doc = token?.document ?? token;
  const size = gridSize();
  const corner = {
    x: point.x - (size * (Number(doc?.width) || 1)) / 2,
    y: point.y - (size * (Number(doc?.height) || 1)) / 2,
  };

  const grid: any = (canvas as any)?.grid;
  try {
    if (typeof grid?.getSnappedPoint === "function") {
      const snapped = grid.getSnappedPoint(corner, { mode: 0xff0 });
      if (Number.isFinite(snapped?.x) && Number.isFinite(snapped?.y)) return snapped;
    }
  } catch {
    // gridless scenes and unfamiliar grid APIs keep the unsnapped position
  }
  return corner;
}

/**
 * Move a token so its centre lands at `point`. Returns the distance travelled in scene units.
 *
 * Prefers `TokenDocument#move` (Foundry v13+), which walks the token through the intervening grid
 * spaces, measures the cost, constrains the path against walls and impassable terrain, and records the
 * move in the token's movement history — everything a player dragging the token would get. A raw
 * position update, by contrast, teleports: it is the fallback for older cores only.
 *
 * The distance returned is measured from where the token ACTUALLY ended up, not from where it was
 * asked to go, so a creature stopped short by a wall reports the shorter distance.
 */
export async function moveTo(token: any, point: Point): Promise<number> {
  const origin = centerOf(token);
  const doc = token?.document ?? token;
  if (!origin) return 0;

  const corner = cornerFor(token, point);
  try {
    if (typeof doc?.move === "function") {
      await doc.move({ x: corner.x, y: corner.y, snapped: true }, { autoRotate: true });
    } else if (typeof doc?.update === "function") {
      await doc.update({ x: corner.x, y: corner.y }, { animate: true });
    } else {
      return 0;
    }
  } catch (err) {
    log("movement: the token would not move:", err);
    return 0;
  }
  const landed = centerOf(token) ?? point;
  return Math.round(toUnits(Math.hypot(landed.x - origin.x, landed.y - origin.y)));
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
    return moveTo(token, point);
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
    return moveTo(token, point);
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
    return moveTo(token, point);
  }
  return 0;
}
