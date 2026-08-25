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

import { log } from "../constants";

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
  // globalThis: a bare `canvas` is a ReferenceError in the test bundle (ESM, no Foundry).
  const grid = Number((globalThis as any).canvas?.grid?.size) || 100;
  return {
    x: x + (grid * (Number(doc?.width) || 1)) / 2,
    y: y + (grid * (Number(doc?.height) || 1)) / 2,
  };
}

/**
 * Distance between two points in scene units, the way the scene itself measures it.
 *
 * THE ONE ANSWER to "how far apart are these", and it has to stay that way. `board.ts` asked Foundry
 * (which honours the grid type and the diagonal rule) while `movement.ts` did its own `Math.hypot`, so
 * on a square grid the two disagreed about every diagonal — by 41% at the EQUIDISTANT default, where
 * core calls a diagonal step 5 ft and Pythagoras calls it 7.07. The planner would judge a creature in
 * reach and the mover would still try to close a two-foot gap that has no square to land in, which at
 * the table looked like a creature standing next to its target refusing to attack (reported 2026-08-15).
 * Same lesson as the two answers to "can X see Y": one question, one implementation.
 *
 * Falls back to straight-line pixels when the grid API is unreadable, which is also the honest answer
 * on a gridless scene — there `measurePath` returns the Euclidean distance anyway.
 */
export function measureBetween(a: Point, b: Point): number {
  // globalThis: a bare `canvas` is a ReferenceError in the test bundle (same as `centerOf`).
  const grid: any = (globalThis as any).canvas?.grid;
  try {
    if (typeof grid?.measurePath === "function") {
      const result = grid.measurePath([a, b]);
      const d = Number(result?.distance ?? result);
      if (Number.isFinite(d)) return d;
    }
  } catch {
    // fall through to the geometric estimate
  }
  const size = Number(grid?.size) || 100;
  const perSquare = Number(grid?.distance) || 5;
  return (Math.hypot(b.x - a.x, b.y - a.y) / size) * perSquare;
}

/**
 * Token space as the grid counts it: top-left in pixels, width/height in squares.
 *
 * Melee reach is a question about SPACES, not centres. A Large Beholder adjacent to a Medium
 * monk is 5 ft away in 5e (closest squares touch) and ~8 ft centre-to-centre — and using the
 * second as "in reach?" is why a 5 ft Quarterstaff never saw the Beholder leave.
 */
export interface Footprint {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Centre of each occupied grid square. Empty when `gridSize` cannot place a cell. */
export function cellCenters(fp: Footprint, gridSize: number): Point[] {
  const size = Number(gridSize);
  if (!Number.isFinite(size) || size <= 0) return [];
  const w = Math.max(1, Math.round(Number(fp.width) || 1));
  const h = Math.max(1, Math.round(Number(fp.height) || 1));
  const x0 = Number(fp.x);
  const y0 = Number(fp.y);
  if (!Number.isFinite(x0) || !Number.isFinite(y0)) return [];
  const out: Point[] = [];
  for (let i = 0; i < w; i++) {
    for (let j = 0; j < h; j++) {
      out.push({ x: x0 + size * i + size / 2, y: y0 + size * j + size / 2 });
    }
  }
  return out;
}

/**
 * 5e melee range between two token footprints: the closest pair of occupied squares.
 *
 * Adjacent creatures of any size measure one square (usually 5 ft). Centre-to-centre
 * does not — a Medium next to a Large is a square and a half. Callers that already
 * treat coordinates as scene units (tests) pass the same `measure` they always did.
 */
export function reachBetween(
  a: Footprint,
  b: Footprint,
  gridSize: number,
  measure: (p: Point, q: Point) => number = measureBetween,
): number {
  const cellsA = cellCenters(a, gridSize);
  const cellsB = cellCenters(b, gridSize);
  if (!cellsA.length || !cellsB.length) return measure({ x: a.x, y: a.y }, { x: b.x, y: b.y });
  let best = Number.POSITIVE_INFINITY;
  for (const p of cellsA) {
    for (const q of cellsB) {
      const d = measure(p, q);
      if (d < best) best = d;
    }
  }
  return best;
}

/** Top-left and size in squares, from a Token, TokenDocument, or a bare `{x,y,width,height}`. */
export function footprintOf(token: any): Footprint | null {
  const doc = token?.document ?? token;
  const x = Number(doc?.x);
  const y = Number(doc?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return {
    x,
    y,
    width: Math.max(1, Number(doc?.width) || 1),
    height: Math.max(1, Number(doc?.height) || 1),
  };
}

/**
 * How far apart two tokens are for 5e spaces: closest occupied squares, then the scene's
 * diagonal rule. THE one answer the planner, the closer, and the melee swing gate share.
 *
 * Centre-to-centre is the wrong question for reach. A Large Beholder adjacent to a Medium
 * monk is 5 ft (spaces touch) and ~8 ft between centres — the 17:17 smoke test after
 * v0.7.36: "must close 3 ft", then "close only 2.5 — less than one square", then no Bite.
 * `sight.ts` `separation` stays centre-based: vision and Hide ask about eyes, not spaces.
 */
export function tokenDistance(a: any, b: any): number {
  const fa = footprintOf(a);
  const fb = footprintOf(b);
  if (!fa || !fb) {
    const p1 = centerOf(a);
    const p2 = centerOf(b);
    if (!p1 || !p2) return Number.POSITIVE_INFINITY;
    return measureBetween(p1, p2);
  }
  const size = Number((globalThis as any).canvas?.grid?.size) || 100;
  return reachBetween(fa, fb, size);
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
  // Compare identity by document id, not object identity. `self` arrives as a TokenDocument from the
  // board while this list holds Token placeables, so `token === self` never matched and a creature
  // counted ITSELF as an obstacle — quietly vetoing every short step it tried to take.
  const selfId = String((self?.document ?? self)?.id ?? "");
  for (const token of (canvas as any)?.tokens?.placeables ?? []) {
    const id = String((token?.document ?? token)?.id ?? "");
    if (id && id === selfId) continue;
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
