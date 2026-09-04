// 2014 DMG optional flanking — the geometry, with no Foundry and no D&D names.
//
// Square (DMG 251): draw a line between the centres of the two attackers' spaces. They flank if
// that line passes through opposite sides or opposite corners of the enemy's space. A Large or
// larger creature flanks when at least one square of its space qualifies.
//
// Adjacent is a shared edge or corner of occupied squares — Chebyshev 1 — never movement cost.
// Foundry's EXACT diagonal rule makes a corner 7.07 ft; that must still count or opposite-corner
// flanking is impossible on the worlds that use it.
//
// Hex (same page): count around the enemy on the adjacent ring. Medium or smaller: 2 hexes
// between the allies. Large 4, Huge 5, Gargantuan 6. BFS on that ring is the shorter arc.
//
// Fail toward no: an unreadable rectangle or a pair that is not on the ring is not a flank.

export interface Pt {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Cube {
  q: number;
  r: number;
  s: number;
}

const EPS = 1e-6;

/** Cube directions, pointy or flat — the six neighbors are the same set. */
export const HEX_DIRS: readonly Cube[] = Object.freeze([
  { q: 1, r: -1, s: 0 },
  { q: 1, r: 0, s: -1 },
  { q: 0, r: 1, s: -1 },
  { q: -1, r: 1, s: 0 },
  { q: -1, r: 0, s: 1 },
  { q: 0, r: -1, s: 1 },
]);

/** Hexes that must sit between the two allies on the shorter arc around the target. */
export function hexBetweenNeeded(sizeSquares: number): number {
  const n = Math.max(1, Math.round(Number(sizeSquares) || 1));
  if (n <= 1) return 2;
  if (n === 2) return 4;
  if (n === 3) return 5;
  return 6;
}

function nearly(a: number, b: number, eps = EPS): boolean {
  return Math.abs(a - b) <= eps;
}

function edgeEps(r: Rect): number {
  return Math.max(EPS, 1e-3 * Math.min(r.w, r.h));
}

function lerp(a: Pt, b: Pt, t: number): Pt {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function strictlyInside(p: Pt, r: Rect, eps: number): boolean {
  return p.x > r.x + eps && p.x < r.x + r.w - eps && p.y > r.y + eps && p.y < r.y + r.h - eps;
}

type Edge = "L" | "R" | "T" | "B";

function edgesAt(p: Pt, r: Rect, eps: number): Edge[] {
  const out: Edge[] = [];
  if (nearly(p.x, r.x, eps)) out.push("L");
  if (nearly(p.x, r.x + r.w, eps)) out.push("R");
  if (nearly(p.y, r.y, eps)) out.push("T");
  if (nearly(p.y, r.y + r.h, eps)) out.push("B");
  return out;
}

/**
 * Clip the segment A→B to the AABB. Null when the segment misses the closed rectangle.
 * Standard Liang–Barsky; `t` is on the original segment.
 */
export function clipSegmentToAabb(a: Pt, b: Pt, r: Rect): { t0: number; t1: number } | null {
  if (!(r.w > 0 && r.h > 0)) return null;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  let t0 = 0;
  let t1 = 1;
  const p = [-dx, dx, -dy, dy];
  const q = [a.x - r.x, r.x + r.w - a.x, a.y - r.y, r.y + r.h - a.y];
  for (let i = 0; i < 4; i++) {
    if (Math.abs(p[i]) <= EPS) {
      if (q[i] < -EPS) return null;
      continue;
    }
    const t = q[i] / p[i];
    if (p[i] < 0) {
      if (t - t1 > EPS) return null;
      if (t > t0) t0 = t;
    } else {
      if (t0 - t > EPS) return null;
      if (t < t1) t1 = t;
    }
  }
  if (t0 - t1 > EPS) return null;
  return { t0, t1 };
}

/**
 * Does the line between A and B pass through opposite sides or opposite corners of `r`?
 *
 * A graze along one edge hits both left and right of that edge and is not a flank — the midpoint
 * of a true crossing sits strictly inside the rectangle. Adjacent-side crossings through a Large
 * interior (west to north) are also refused: RAW wants opposite, not a clip through a corner.
 */
export function lineFlanksAabb(a: Pt, b: Pt, r: Rect): boolean {
  const clip = clipSegmentToAabb(a, b, r);
  if (!clip) return false;
  const p0 = lerp(a, b, clip.t0);
  const p1 = lerp(a, b, clip.t1);
  const mid = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 };
  const eps = edgeEps(r);
  if (!strictlyInside(mid, r, eps)) return false;
  const e0 = edgesAt(p0, r, eps);
  const e1 = edgesAt(p1, r, eps);
  if (!e0.length || !e1.length) return false;
  return (
    (e0.includes("L") && e1.includes("R")) ||
    (e0.includes("R") && e1.includes("L")) ||
    (e0.includes("T") && e1.includes("B")) ||
    (e0.includes("B") && e1.includes("T"))
  );
}

/** Occupied-square neighbours, including diagonals. Same cell is not adjacent. */
export function chebyshevAdjacent(a: Pt, b: Pt, gridSize: number): boolean {
  const size = Number(gridSize);
  if (!(size > 0) || !Number.isFinite(size)) return false;
  const di = Math.round((b.x - a.x) / size);
  const dj = Math.round((b.y - a.y) / size);
  return Math.max(Math.abs(di), Math.abs(dj)) === 1;
}

export function anyCellAdjacent(cells: readonly Pt[], against: readonly Pt[], gridSize: number): boolean {
  for (const p of cells) {
    for (const q of against) {
      if (chebyshevAdjacent(p, q, gridSize)) return true;
    }
  }
  return false;
}

/**
 * Square-grid flanking: any occupied cell of the attacker with any occupied cell of the ally,
 * each adjacent to the target, whose centres draw a flanking line through the target's space.
 */
export function squareFlanks(
  attackerCells: readonly Pt[],
  allyCells: readonly Pt[],
  targetCells: readonly Pt[],
  targetRect: Rect,
  gridSize: number,
): boolean {
  if (!attackerCells.length || !allyCells.length || !targetCells.length) return false;
  const aAdj = attackerCells.filter((p) => anyCellAdjacent([p], targetCells, gridSize));
  const bAdj = allyCells.filter((p) => anyCellAdjacent([p], targetCells, gridSize));
  if (!aAdj.length || !bAdj.length) return false;
  for (const a of aAdj) {
    for (const b of bAdj) {
      if (lineFlanksAabb(a, b, targetRect)) return true;
    }
  }
  return false;
}

export function cubeKey(c: Cube): string {
  return `${c.q},${c.r},${c.s}`;
}

export function cubeNeighbors(c: Cube): Cube[] {
  return HEX_DIRS.map((d) => ({ q: c.q + d.q, r: c.r + d.r, s: c.s + d.s }));
}

/**
 * Hexes between `from` and `to` on the shorter path around the target's adjacent ring.
 * Null when either cell is not on that ring (not adjacent, or standing on the target).
 */
export function hexesBetweenOnRing(from: Cube, to: Cube, target: readonly Cube[]): number | null {
  const targetSet = new Set(target.map(cubeKey));
  const ring = new Set<string>();
  for (const t of target) {
    for (const n of cubeNeighbors(t)) {
      const k = cubeKey(n);
      if (!targetSet.has(k)) ring.add(k);
    }
  }
  const start = cubeKey(from);
  const goal = cubeKey(to);
  if (!ring.has(start) || !ring.has(goal)) return null;
  if (start === goal) return null;

  const queue: Array<{ c: Cube; d: number }> = [{ c: from, d: 0 }];
  const seen = new Set<string>([start]);
  while (queue.length) {
    const { c, d } = queue.shift()!;
    for (const n of cubeNeighbors(c)) {
      const k = cubeKey(n);
      if (!ring.has(k) || seen.has(k)) continue;
      const nd = d + 1;
      if (k === goal) return nd - 1;
      seen.add(k);
      queue.push({ c: n, d: nd });
    }
  }
  return null;
}

export function hexFlanks(
  attacker: readonly Cube[],
  ally: readonly Cube[],
  target: readonly Cube[],
  sizeSquares: number,
): boolean {
  if (!attacker.length || !ally.length || !target.length) return false;
  const need = hexBetweenNeeded(sizeSquares);
  for (const a of attacker) {
    for (const b of ally) {
      const between = hexesBetweenOnRing(a, b, target);
      if (between !== null && between >= need) return true;
    }
  }
  return false;
}

/**
 * Foundry `GridOffset` `{i, j}` → cube. `i` is row, `j` is column (v12+ GridOffset).
 * Types match `CONST.GRID_TYPES`: HEXEVENQ 2, HEXODDQ 3, HEXEVENR 4, HEXODDR 5.
 */
export function offsetToCube(offset: { i: number; j: number }, gridType: number): Cube | null {
  const row = Number(offset?.i);
  const col = Number(offset?.j);
  if (!Number.isFinite(row) || !Number.isFinite(col)) return null;
  let q: number;
  let r: number;
  switch (gridType) {
    case 2: // HEXEVENQ
      q = col;
      r = row - (col + (col & 1)) / 2;
      break;
    case 3: // HEXODDQ
      q = col;
      r = row - (col - (col & 1)) / 2;
      break;
    case 4: // HEXEVENR
      q = col - (row + (row & 1)) / 2;
      r = row;
      break;
    case 5: // HEXODDR
      q = col - (row - (row & 1)) / 2;
      r = row;
      break;
    default:
      return null;
  }
  // `-0` is falsy and would fail a deepEqual against `0`; cube keys stringify it as "0" either way.
  return { q, r, s: -q - r || 0 };
}
