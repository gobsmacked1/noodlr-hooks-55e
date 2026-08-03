// Finding a square where one specific pair of eyes cannot see you.
//
// Cover and hiding are the same geometric question asked about different observers (user's call,
// 2026-08-02): break line of sight from the FURTHEST opponent to take cover from shooters, and from
// the NEAREST opponent to hide. Testing against every opponent from every candidate square is what
// made this look unaffordable; testing against one chosen opponent is a few dozen ray casts, which
// Foundry does in well under a millisecond.
//
// The compromise is real and worth stating: cover found against the furthest shooter may still leave
// the creature visible to someone closer. That is the price of the cheap version, and it is the right
// trade for a per-turn planner — the alternative is not "better cover", it is no cover at all.
//
// Candidates are scanned nearest-first and the search returns the first square that works, so a
// creature spends the least movement that achieves the goal and the average cost is far below the
// worst case.

import { log } from "../../constants";

/** Ray types Foundry restricts by wall: we need sight (can it see me) and move (can I get there). */
type Restriction = "sight" | "move";

export interface Point {
  x: number;
  y: number;
}

export interface Spot {
  /** Token centre of the destination, in canvas pixels. */
  x: number;
  y: number;
  /** How far the creature travels to reach it, in scene units. */
  travel: number;
  /** Eight-point compass bearing from where it stands now, for the announcement. */
  bearing: string;
}

/**
 * Does a wall block a straight line between two points?
 *
 * Verified against the v13 API (foundry.canvas.geometry.ClockwiseSweepPolygon.testCollision with a
 * compulsory restriction type). The older global and the pre-v12 `canvas.walls.checkCollision` are
 * tried in turn, and an unrecognised API returns null — "we could not tell" — which callers treat as
 * "do not claim cover", never as "cover found".
 */
export function blocked(origin: Point, destination: Point, type: Restriction): boolean | null {
  const config = { type, mode: "any" };
  // Lazy on purpose. Building this as an array of values reads every entry, and merely TOUCHING the
  // legacy global emits a deprecation warning even when the modern namespace answered — which is
  // exactly the console noise this module was adding in v0.4.22. Each candidate is only evaluated if
  // the ones before it were unusable.
  const candidates: Array<() => any> = [
    () => (foundry as any)?.canvas?.geometry?.ClockwiseSweepPolygon,
    () => (globalThis as any).CONFIG?.Canvas?.polygonBackends?.[type],
    () => (globalThis as any).ClockwiseSweepPolygon,
  ];
  for (const resolve of candidates) {
    let backend: any;
    try {
      backend = resolve();
    } catch {
      continue;
    }
    if (typeof backend?.testCollision === "function") {
      try {
        return Boolean(backend.testCollision(origin, destination, config));
      } catch {
        // try the next shape
      }
    }
  }
  try {
    const walls: any = (canvas as any)?.walls;
    if (typeof walls?.checkCollision === "function") {
      return Boolean(walls.checkCollision({ A: origin, B: destination }, config));
    }
  } catch {
    // fall through
  }
  return null;
}

const BEARINGS = [
  "east",
  "south-east",
  "south",
  "south-west",
  "west",
  "north-west",
  "north",
  "north-east",
];

function bearingOf(dx: number, dy: number): string {
  const angle = Math.atan2(dy, dx);
  const index = Math.round((angle < 0 ? angle + Math.PI * 2 : angle) / (Math.PI / 4)) % 8;
  return BEARINGS[index];
}

export function centerOf(token: any): Point | null {
  const doc = token?.document ?? token;
  const x = Number(doc?.x);
  const y = Number(doc?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const grid = Number((canvas as any)?.grid?.size) || 100;
  return {
    x: x + (grid * (Number(doc?.width) || 1)) / 2,
    y: y + (grid * (Number(doc?.height) || 1)) / 2,
  };
}

export function insideScene(point: Point): boolean {
  const rect: any = (canvas as any)?.dimensions?.sceneRect;
  if (!rect) return true;
  return (
    point.x >= rect.x &&
    point.y >= rect.y &&
    point.x <= rect.x + rect.width &&
    point.y <= rect.y + rect.height
  );
}

/** Somebody is already standing there. Crude on purpose: exact footprints are not worth the cost. */
export function occupied(point: Point, self: any): boolean {
  const grid = Number((canvas as any)?.grid?.size) || 100;
  for (const token of (canvas as any)?.tokens?.placeables ?? []) {
    if (token === self) continue;
    const c = centerOf(token);
    if (c && Math.hypot(c.x - point.x, c.y - point.y) < grid * 0.75) return true;
  }
  return false;
}

/**
 * Search for a reachable spot within `budget` scene units from which `observer` cannot see the
 * creature. Returns null when the geometry says no such spot is reachable, or when the collision API
 * could not be read at all.
 *
 * `rand` seeds the angular offset so two identical creatures do not both break left, while keeping
 * the whole turn reproducible.
 */
export function findConcealment(
  selfToken: any,
  observerToken: any,
  budget: number,
  rand: () => number,
): Spot | null {
  const origin = centerOf(selfToken);
  const eyes = centerOf(observerToken);
  if (!origin || !eyes || !(budget > 0)) return null;

  const gridSize = Number((canvas as any)?.grid?.size) || 100;
  const gridDistance = Number((canvas as any)?.grid?.distance) || 5;
  const pixelBudget = (budget / gridDistance) * gridSize;

  // 12 bearings x 3 distances. Enough resolution to find the near side of a pillar without turning
  // the turn into a pathfinding problem.
  const spin = rand() * (Math.PI / 6);
  const rings = [0.4, 0.7, 1].map((f) => f * pixelBudget);

  for (const radius of rings) {
    for (let i = 0; i < 12; i++) {
      const angle = spin + (i * Math.PI) / 6;
      const point = {
        x: origin.x + Math.cos(angle) * radius,
        y: origin.y + Math.sin(angle) * radius,
      };
      if (!insideScene(point) || occupied(point, selfToken)) continue;

      // Straight-line reachability, not pathfinding: a spot around a corner that requires going the
      // long way is rejected rather than under-costed. Conservative in the safe direction.
      if (blocked(origin, point, "move") !== false) continue;

      const hidden = blocked(eyes, point, "sight");
      if (hidden !== true) continue;

      return {
        x: point.x,
        y: point.y,
        travel: Math.round((radius / gridSize) * gridDistance),
        bearing: bearingOf(point.x - origin.x, point.y - origin.y),
      };
    }
  }

  log("no concealed spot within reach");
  return null;
}
