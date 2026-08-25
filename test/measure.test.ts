import { strict as assert } from "node:assert";
import { afterEach, test } from "node:test";

import { centerOf, measureBetween, tokenDistance } from "../src/core/positioning";

const GRID = 100;
const PER_SQUARE = 5;

/** A square grid whose diagonal rule is the 5-5-5 default: every adjacent square is one step away. */
function equidistant(): void {
  (globalThis as any).canvas = {
    grid: {
      type: 1,
      size: GRID,
      distance: PER_SQUARE,
      measurePath: ([a, b]: Array<{ x: number; y: number }>) => {
        const dx = Math.abs(b.x - a.x) / GRID;
        const dy = Math.abs(b.y - a.y) / GRID;
        return { distance: Math.max(dx, dy) * PER_SQUARE };
      },
    },
  };
}

afterEach(() => {
  delete (globalThis as any).canvas;
});

test("a diagonal step is one square, not Pythagoras", () => {
  equidistant();
  // THE BUG, in one assertion. The planner asked Foundry and got 5; the mover asked Pythagoras and got
  // 7.07, so a creature the planner had judged to be in reach was sent to close a two-foot gap that has
  // no square in it. Both sides ask this function now.
  assert.equal(measureBetween({ x: 0, y: 0 }, { x: GRID, y: GRID }), PER_SQUARE);
  // And the answer the mover used to reach on its own, so the gap is on the record rather than implied.
  const pythagoras = (Math.hypot(GRID, GRID) / GRID) * PER_SQUARE;
  assert.ok(Math.abs(pythagoras - 7.07) < 0.01);
});

test("an orthogonal step is unaffected, which is why this went unnoticed", () => {
  equidistant();
  assert.equal(measureBetween({ x: 0, y: 0 }, { x: GRID * 3, y: 0 }), PER_SQUARE * 3);
});

test("the scene's own rule wins, whatever it is", () => {
  // Foundry's EXACT setting really does make a diagonal neighbour 7.07 ft away. We do not second-guess
  // it — we report what the scene says and let the sub-square guard explain why nothing can close it.
  (globalThis as any).canvas = {
    grid: {
      type: 1,
      size: GRID,
      distance: PER_SQUARE,
      measurePath: ([a, b]: Array<{ x: number; y: number }>) => ({
        distance: (Math.hypot(b.x - a.x, b.y - a.y) / GRID) * PER_SQUARE,
      }),
    },
  };
  assert.ok(Math.abs(measureBetween({ x: 0, y: 0 }, { x: GRID, y: GRID }) - 7.07) < 0.01);
});

test("an unreadable grid API falls back to straight-line pixels rather than throwing", () => {
  (globalThis as any).canvas = {
    grid: {
      type: 1,
      size: GRID,
      distance: PER_SQUARE,
      measurePath: () => {
        throw new Error("shape changed between versions");
      },
    },
  };
  assert.equal(measureBetween({ x: 0, y: 0 }, { x: GRID * 2, y: 0 }), PER_SQUARE * 2);
});

test("a Large token adjacent to a Medium one is 5 ft, not ~8", () => {
  equidistant();
  // THE BUG after v0.7.36, in one assertion. Beholder 2×2 at (100,0), Monk 1×1 at (0,0):
  // spaces touch, so melee is one square. Centres are 150×50 px → 7.5 ft, and the planner
  // then tried to close 2.5 ft into a gap with no square in it.
  const monk = { x: 0, y: 0, width: 1, height: 1 };
  const beholder = { x: GRID, y: 0, width: 2, height: 2 };
  assert.equal(tokenDistance(monk, beholder), PER_SQUARE);
  const centres = measureBetween(centerOf(monk)!, centerOf(beholder)!);
  assert.ok(centres > 7 && centres < 8);
});

test("two Mediums in adjacent squares are still one square apart", () => {
  equidistant();
  assert.equal(
    tokenDistance({ x: 0, y: 0, width: 1, height: 1 }, { x: GRID, y: 0, width: 1, height: 1 }),
    PER_SQUARE,
  );
});

// Deliberately NOT tested: `measureBetween` with no `canvas` global at all throws a ReferenceError,
// because `(canvas as any)?.grid` compiles to a bare identifier read rather than a property lookup.
// Every geometry function in this module has that same exposure and none of them is reachable before
// the canvas exists, so guarding this one alone would be an inconsistency rather than a fix.
