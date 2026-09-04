// Where the sprite is, as opposed to where the document has already committed.
//
// Foundry writes TokenDocument `_source` (and fires `moveToken`) at the start of a
// walk, then animates the placeable there. A reach reaction that reads the planned
// destination therefore fires while the creature is still across the map — the Monk
// vs Beholder case: six seconds expire, then the sprite arrives and flies away.
//
// Halt still uses the planned route (it has to pause remaining waypoints before they
// play). Offers walk this file's samples instead.

import { REST_DEADLINE_MS, REST_GRACE_MS, tokenIsMoving } from "./settle";

export const VISIBLE_POLL_MS = 250;

export type VisiblePoint = { x: number; y: number; elevation: number };

export function elevationOf(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export function sameVisible(a: VisiblePoint, b: VisiblePoint): boolean {
  return a.x === b.x && a.y === b.y && a.elevation === b.elevation;
}

/**
 * Top-left of the sprite. Never `_source` — that is the committed destination.
 *
 * Placeable `x`/`y` is the animated token. Prepared document `x`/`y` interpolate
 * during a slide (see `movement.ts` `sourcePosition`). `_source` is only the
 * fallback when nothing else is readable, which is an instant / unrendered move.
 */
export function visualTopLeft(doc: any): VisiblePoint | null {
  if (!doc) return null;
  const placeable = doc.object ?? doc;
  const x = Number(placeable?.position?.x ?? placeable?.x ?? doc.x);
  const y = Number(placeable?.position?.y ?? placeable?.y ?? doc.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    const src = doc._source ?? doc;
    const sx = Number(src?.x);
    const sy = Number(src?.y);
    if (!Number.isFinite(sx) || !Number.isFinite(sy)) return null;
    return { x: sx, y: sy, elevation: elevationOf(src?.elevation) };
  }
  const elevation = elevationOf(
    placeable?.elevation ?? doc.elevation ?? doc._source?.elevation,
  );
  return { x, y, elevation };
}

/**
 * Where a watch should start. If the first readable position is already the
 * committed destination, Foundry has written `_source` and the sprite has not
 * moved — start from the planned origin instead.
 */
export function watchOrigin(doc: any, planned: VisiblePoint): VisiblePoint {
  const visual = visualTopLeft(doc);
  const committed = committedTopLeft(doc);
  if (
    visual &&
    committed &&
    sameVisible(visual, committed) &&
    !sameVisible(visual, planned)
  ) {
    return planned;
  }
  return visual ?? planned;
}

/** Committed top-left. Used only after the sprite has stopped, to catch a last snap. */
export function committedTopLeft(doc: any): VisiblePoint | null {
  const src = doc?._source ?? doc;
  const x = Number(src?.x);
  const y = Number(src?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y, elevation: elevationOf(src?.elevation) };
}

export interface WatchVisibleMoveOpts {
  pollMs?: number;
  startGraceMs?: number;
  idleGraceMs?: number;
  budgetMs?: number;
  stillMoving?: (doc: any) => boolean;
  read?: (doc: any) => VisiblePoint | null;
  committed?: (doc: any) => VisiblePoint | null;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  shouldStop?: () => boolean;
  onStep: (from: VisiblePoint, to: VisiblePoint) => Promise<void> | void;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Follow the sprite from `origin` and call `onStep` each time it actually moves.
 *
 * A planned destination that has not been walked is never a step. An instant move
 * (no animation after a short grace) still steps origin → committed square.
 */
export async function watchVisibleMove(
  doc: any,
  origin: VisiblePoint,
  opts: WatchVisibleMoveOpts,
): Promise<void> {
  const poll = opts.pollMs ?? VISIBLE_POLL_MS;
  const startGrace = opts.startGraceMs ?? REST_GRACE_MS;
  const idleGrace = opts.idleGraceMs ?? REST_GRACE_MS;
  const budget = opts.budgetMs ?? REST_DEADLINE_MS;
  const stillMoving = opts.stillMoving ?? tokenIsMoving;
  const read = opts.read ?? visualTopLeft;
  const committedOf = opts.committed ?? committedTopLeft;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  const started = now();

  const step = async (from: VisiblePoint, to: VisiblePoint): Promise<void> => {
    if (sameVisible(from, to)) return;
    await opts.onStep(from, to);
  };

  // `moveToken` can fire before animationContexts exists. Wait a beat for the slide
  // to start; looking only at "is it sliding right now" misses the whole walk.
  const begin = now();
  while (!stillMoving(doc) && now() - begin < startGrace) {
    if (opts.shouldStop?.()) return;
    await sleep(poll);
  }

  let last = origin;
  if (!stillMoving(doc)) {
    const landed = read(doc) ?? committedOf(doc);
    if (landed) await step(last, landed);
    return;
  }

  let idleFor = 0;
  while (now() - started < budget) {
    if (opts.shouldStop?.()) return;
    const here = read(doc) ?? last;
    const dest = committedOf(doc);
    // A read that already matches `_source` while the sprite is still sliding is
    // the document, not the placeable — stepping it would offer at the planned
    // destination. Wait until idle (or a real interpolated sample) instead.
    const unreadCommit =
      Boolean(dest) &&
      stillMoving(doc) &&
      sameVisible(here, dest as VisiblePoint) &&
      !sameVisible(last, here);
    if (!unreadCommit && !sameVisible(here, last)) {
      await step(last, here);
      last = here;
      idleFor = 0;
    }
    if (stillMoving(doc)) idleFor = 0;
    else {
      idleFor += poll;
      if (idleFor >= idleGrace) break;
    }
    await sleep(poll);
  }

  const landed = read(doc) ?? committedOf(doc);
  if (landed) await step(last, landed);
}
