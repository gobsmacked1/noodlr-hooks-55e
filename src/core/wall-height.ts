// Per-wall height for special movement.
//
// Foundry walls are infinite vertical slabs. Token elevation is real; wall height is not.
// Wall Height (theripper93) 7.0.8 solves this by wrapping the sweep so a token whose
// *head* is already above the wall walks through it (Vaulting). That is the wrong test
// for RAW, and it requires libWrapper. The audit is
// `C:\Project\_research\_audit\wall-height-2026-08-23.md`.
//
// Ours: a wall blocks when the token's FEET overlap the slab
// (`elevation >= bottom && elevation < top`). Fly / climb / jump go over when the
// feet are at or above `top` and the scene has no ceiling. Burrow goes under when
// the feet are below `bottom` and the floor is not man-made. Walk and swim never.
//
// Untagged walls are 10 ft tall, not infinite. Wall Height's unset is Infinity —
// `Number.isFinite` is what makes their untagged walls fall through to our default
// when we read their flags.
//
// `ignoreWalls` on a whole path is the wrong primitive the moment two walls have
// different tops. The path is tested wall by wall; a later blocker becomes a cut.

import { MODULE_ID } from "../constants";
import type { TraverseFacts, TraverseWaypoint } from "./traverse";

export const DEFAULT_WALL_TOP = 10;
export const DEFAULT_WALL_BOTTOM = 0;
export const WALL_HEIGHT_FOREIGN = "wall-height";

const EPS = 1e-6;

export type Enclosure = "outdoor" | "indoor";
export type FloorKind = "natural" | "manmade";

export interface ScenePolicy {
  enclosure: Enclosure;
  floor: FloorKind;
  defaultTop: number;
  defaultBottom: number;
}

export interface WallLike {
  c?: number[] | null;
  move?: number | null;
  door?: number | null;
  ds?: number | null;
  flags?: Record<string, any> | null;
}

export interface CrossingFacts extends TraverseFacts {
  jumpHighRunning: number | null;
  jumpHighStanding: number | null;
}

export interface PathCut {
  x: number;
  y: number;
  elevation: number;
  /** Index of the `to` waypoint of the segment that hit the blocker. */
  segmentIndex: number;
  /** Crossable walls passed before this blocker on the same path. */
  skipped: number;
}

export type PathDecision =
  | { kind: "ignore-all" }
  | { kind: "core" }
  | { kind: "cut"; cut: PathCut };

export function scenePolicyOf(scene: any): ScenePolicy {
  const flags = scene?.flags?.[MODULE_ID] ?? {};
  return {
    enclosure: flags.enclosure === "indoor" ? "indoor" : "outdoor",
    floor: flags.floor === "manmade" ? "manmade" : "natural",
    defaultTop: finiteOr(flags.defaultWallTop, DEFAULT_WALL_TOP),
    defaultBottom: finiteOr(flags.defaultWallBottom, DEFAULT_WALL_BOTTOM),
  };
}

export function wallBounds(wall: WallLike, scene: ScenePolicy): { top: number; bottom: number } {
  const ours = wall.flags?.[MODULE_ID];
  const theirs = wall.flags?.[WALL_HEIGHT_FOREIGN];
  let top = firstFinite(ours?.top, theirs?.top, scene.defaultTop);
  let bottom = firstFinite(ours?.bottom, theirs?.bottom, scene.defaultBottom);
  if (top < bottom) {
    const swap = top;
    top = bottom;
    bottom = swap;
  }
  return { top, bottom };
}

/** Movement-blocking closed walls only. Open doors and `move === 0` are scenery. */
export function wallBlocksMovement(wall: WallLike): boolean {
  if (Number(wall.move) === 0) return false;
  const door = Number(wall.door ?? 0);
  const ds = Number(wall.ds ?? 0);
  if (door > 0 && ds === 1) return false;
  return true;
}

export function canCrossSlab(input: {
  action: string;
  elevation: number;
  slab: { top: number; bottom: number };
  scene: ScenePolicy;
  hasFly: boolean;
  hasClimb: boolean;
  hasBurrow: boolean;
  jumpHigh: number | null;
  jumpLong: number | null;
  horizontal: number;
}): boolean {
  const action = String(input.action || "walk").toLowerCase();
  const elev = Number(input.elevation);
  const { top, bottom } = input.slab;
  const indoor = input.scene.enclosure === "indoor";
  const paved = input.scene.floor === "manmade";

  if (action === "burrow") {
    if (!input.hasBurrow || paved) return false;
    return Number.isFinite(elev) && elev < bottom;
  }

  if (indoor) return false;
  if (!Number.isFinite(elev)) return false;

  if (action === "fly" && input.hasFly) return elev >= top;
  if (action === "climb" && input.hasClimb) return elev >= top;
  if (action === "jump") {
    if (elev >= top) return true;
    const high = input.jumpHigh;
    if (high != null && high >= top - elev) return true;
    const long = input.jumpLong;
    const horiz = input.horizontal;
    if (top <= elev && long != null && horiz != null && long >= horiz && horiz > 0) return true;
  }
  return false;
}

export function segmentIntersection(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
): { t: number; x: number; y: number } | null {
  const rx = bx - ax;
  const ry = by - ay;
  const sx = dx - cx;
  const sy = dy - cy;
  const denom = rx * sy - ry * sx;
  if (Math.abs(denom) < EPS) return null;
  const t = ((cx - ax) * sy - (cy - ay) * sx) / denom;
  const u = ((cx - ax) * ry - (cy - ay) * rx) / denom;
  if (t <= EPS || t > 1 + EPS) return null;
  if (u < -EPS || u > 1 + EPS) return null;
  return { t: Math.min(1, t), x: ax + rx * t, y: ay + ry * t };
}

export function decidePath(
  waypoints: TraverseWaypoint[],
  walls: WallLike[],
  facts: CrossingFacts,
  scene: ScenePolicy,
  measure: (from: TraverseWaypoint, to: TraverseWaypoint) => number,
  runUp = 10,
): PathDecision {
  const blockers = walls.filter((wall) => wallBlocksMovement(wall) && Array.isArray(wall.c) && wall.c.length >= 4);
  let skipped = 0;
  let anyMove = false;

  for (let i = 1; i < waypoints.length; i++) {
    const from = waypoints[i - 1];
    const to = waypoints[i];
    const horiz = measure(from, to);
    if (!(horiz > 0)) continue;
    anyMove = true;

    const action = String(to.action ?? facts.defaultAction ?? "walk");
    const elev0 = Number(from.elevation ?? 0);
    const elev1 = Number(to.elevation ?? from.elevation ?? 0);
    const jumpHigh = horiz >= runUp ? facts.jumpHighRunning : facts.jumpHighStanding;
    const ax = Number(from.x ?? 0);
    const ay = Number(from.y ?? 0);
    const bx = Number(to.x ?? 0);
    const by = Number(to.y ?? 0);
    if (![ax, ay, bx, by].every(Number.isFinite)) continue;

    const hits: { t: number; x: number; y: number; elevation: number; wall: WallLike }[] = [];
    for (const wall of blockers) {
      const c = wall.c as number[];
      const hit = segmentIntersection(ax, ay, bx, by, c[0], c[1], c[2], c[3]);
      if (!hit) continue;
      const elevation = elev0 + (elev1 - elev0) * hit.t;
      hits.push({ ...hit, elevation, wall });
    }
    hits.sort((a, b) => a.t - b.t);

    for (const hit of hits) {
      const clear = canCrossSlab({
        action,
        elevation: hit.elevation,
        slab: wallBounds(hit.wall, scene),
        scene,
        hasFly: facts.hasFly,
        hasClimb: facts.hasClimb,
        hasBurrow: facts.hasBurrow,
        jumpHigh,
        jumpLong: action.toLowerCase() === "jump" ? facts.jumpLong : null,
        horizontal: horiz,
      });
      if (clear) {
        skipped += 1;
        continue;
      }
      return {
        kind: "cut",
        cut: {
          x: hit.x,
          y: hit.y,
          elevation: hit.elevation,
          segmentIndex: i,
          skipped,
        },
      };
    }
  }

  if (!anyMove) return { kind: "core" };
  return { kind: "ignore-all" };
}

/** Keep waypoints up to the blocking segment and land on the cut. */
export function trimToCut(waypoints: TraverseWaypoint[], cut: PathCut): TraverseWaypoint[] {
  const from = waypoints[Math.max(0, cut.segmentIndex - 1)];
  const to = waypoints[cut.segmentIndex] ?? from;
  const kept = waypoints.slice(0, cut.segmentIndex);
  kept.push({
    ...to,
    x: cut.x,
    y: cut.y,
    elevation: cut.elevation,
  });
  return kept;
}

function finiteOr(value: unknown, fallback: number): number {
  if (value === "" || value == null) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function firstFinite(...values: unknown[]): number {
  for (const value of values) {
    if (value === "" || value == null) continue;
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return DEFAULT_WALL_TOP;
}
