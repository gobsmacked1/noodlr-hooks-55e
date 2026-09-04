import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  chebyshevAdjacent,
  hexBetweenNeeded,
  hexFlanks,
  hexesBetweenOnRing,
  lineFlanksAabb,
  offsetToCube,
  squareFlanks,
  type Cube,
  type Pt,
  type Rect,
} from "../src/core/flank";

const G = 100;

/** Medium target occupying the square whose top-left is (100, 100). */
const MEDIUM: Rect = { x: 100, y: 100, w: G, h: G };
const MEDIUM_CELLS: Pt[] = [{ x: 150, y: 150 }];

const N: Pt = { x: 150, y: 50 };
const S: Pt = { x: 150, y: 250 };
const E: Pt = { x: 250, y: 150 };
const W: Pt = { x: 50, y: 150 };
const NW: Pt = { x: 50, y: 50 };
const NE: Pt = { x: 250, y: 50 };
const SE: Pt = { x: 250, y: 250 };
const SW: Pt = { x: 50, y: 250 };

function flanks(a: Pt, b: Pt, rect = MEDIUM, cells = MEDIUM_CELLS): boolean {
  return squareFlanks([a], [b], cells, rect, G);
}

test("opposite sides grant a flank", () => {
  assert.equal(lineFlanksAabb(N, S, MEDIUM), true);
  assert.equal(lineFlanksAabb(E, W, MEDIUM), true);
  assert.equal(flanks(N, S), true);
  assert.equal(flanks(W, E), true);
});

test("opposite corners grant a flank", () => {
  assert.equal(lineFlanksAabb(NW, SE, MEDIUM), true);
  assert.equal(lineFlanksAabb(NE, SW, MEDIUM), true);
  assert.equal(flanks(NW, SE), true);
  assert.equal(flanks(NE, SW), true);
});

test("the same side, or an L around a Medium target, does not", () => {
  assert.equal(lineFlanksAabb(N, E, MEDIUM), false);
  assert.equal(lineFlanksAabb(NW, NE, MEDIUM), false);
  assert.equal(lineFlanksAabb(N, NE, MEDIUM), false);
  assert.equal(flanks(N, E), false);
  assert.equal(flanks(NW, NE), false);
});

test("a line that only grazes one edge is not a flank", () => {
  // Both north of the target, the segment runs along the top edge.
  const left = { x: 50, y: 100 };
  const right = { x: 250, y: 100 };
  assert.equal(lineFlanksAabb(left, right, MEDIUM), false);
});

test("adjacency is Chebyshev 1, so a corner still counts on an EXACT diagonal world", () => {
  assert.equal(chebyshevAdjacent(MEDIUM_CELLS[0], N, G), true);
  assert.equal(chebyshevAdjacent(MEDIUM_CELLS[0], NW, G), true);
  assert.equal(chebyshevAdjacent(MEDIUM_CELLS[0], { x: 150, y: 350 }, G), false);
  assert.equal(chebyshevAdjacent(MEDIUM_CELLS[0], MEDIUM_CELLS[0], G), false);
});

test("a creature that is not adjacent cannot flank, even if the line would look opposite", () => {
  const farNorth = { x: 150, y: -50 };
  assert.equal(flanks(farNorth, S), false);
});

test("a Large target is flanked when the line crosses opposite sides of its space", () => {
  const large: Rect = { x: 100, y: 100, w: 2 * G, h: 2 * G };
  const cells: Pt[] = [
    { x: 150, y: 150 },
    { x: 250, y: 150 },
    { x: 150, y: 250 },
    { x: 250, y: 250 },
  ];
  // West of the northern row, east of the southern row.
  const westNorth = { x: 50, y: 150 };
  const eastSouth = { x: 350, y: 250 };
  assert.equal(squareFlanks([westNorth], [eastSouth], cells, large, G), true);
  // Both on the north side.
  const northWest = { x: 150, y: 50 };
  const northEast = { x: 250, y: 50 };
  assert.equal(squareFlanks([northWest], [northEast], cells, large, G), false);
  // West to north — adjacent sides through the interior, not opposite.
  const west = { x: 50, y: 150 };
  const north = { x: 150, y: 50 };
  assert.equal(squareFlanks([west], [north], cells, large, G), false);
});

test("a Large flanker qualifies from any occupied square", () => {
  // Two-square creature standing west of the target; only the southern cell is due west.
  const attacker = [
    { x: 50, y: 50 },
    { x: 50, y: 150 },
  ];
  assert.equal(squareFlanks(attacker, [E], MEDIUM_CELLS, MEDIUM, G), true);
  // Neither cell is opposite a neighbour on the same side.
  assert.equal(squareFlanks(attacker, [NW], MEDIUM_CELLS, MEDIUM, G), false);
});

test("hex Medium opposite neighbors have two hexes between them", () => {
  const target: Cube[] = [{ q: 0, r: 0, s: 0 }];
  const north: Cube = { q: 0, r: -1, s: 1 };
  const south: Cube = { q: 0, r: 1, s: -1 };
  const east: Cube = { q: 1, r: -1, s: 0 };
  assert.equal(hexesBetweenOnRing(north, south, target), 2);
  assert.equal(hexFlanks([north], [south], target, 1), true);
  assert.equal(hexFlanks([north], [east], target, 1), false);
  assert.equal(hexBetweenNeeded(1), 2);
  assert.equal(hexBetweenNeeded(2), 4);
  assert.equal(hexBetweenNeeded(3), 5);
  assert.equal(hexBetweenNeeded(4), 6);
});

test("a hex that is not on the ring cannot flank", () => {
  const target: Cube[] = [{ q: 0, r: 0, s: 0 }];
  const far: Cube = { q: 0, r: -2, s: 2 };
  const south: Cube = { q: 0, r: 1, s: -1 };
  assert.equal(hexesBetweenOnRing(far, south, target), null);
  assert.equal(hexFlanks([far], [south], target, 1), false);
});

test("offsetToCube refuses a square grid and accepts even-q", () => {
  assert.equal(offsetToCube({ i: 0, j: 0 }, 1), null);
  const origin = offsetToCube({ i: 0, j: 0 }, 2);
  assert.deepEqual(origin, { q: 0, r: 0, s: 0 });
  const nextCol = offsetToCube({ i: 0, j: 1 }, 2);
  assert.ok(nextCol);
  assert.equal(nextCol!.q + nextCol!.r + nextCol!.s, 0);
});
