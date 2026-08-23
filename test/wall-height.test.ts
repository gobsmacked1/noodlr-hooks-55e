import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  DEFAULT_WALL_BOTTOM,
  DEFAULT_WALL_TOP,
  canCrossSlab,
  decidePath,
  scenePolicyOf,
  segmentIntersection,
  trimToCut,
  wallBlocksMovement,
  wallBounds,
  type CrossingFacts,
  type ScenePolicy,
  type WallLike,
} from "../src/core/wall-height";

const outdoor: ScenePolicy = {
  enclosure: "outdoor",
  floor: "natural",
  defaultTop: DEFAULT_WALL_TOP,
  defaultBottom: DEFAULT_WALL_BOTTOM,
};

const flyer: CrossingFacts = {
  hasFly: true,
  hasClimb: false,
  hasBurrow: false,
  jumpLong: null,
  jumpHighRunning: 6,
  jumpHighStanding: 3,
  defaultAction: "fly",
};

const maze: WallLike = { c: [50, 0, 50, 200], move: 20 };

test("an untagged wall is 10 ft, not infinite", () => {
  assert.deepEqual(wallBounds({}, outdoor), { top: 10, bottom: 0 });
  assert.deepEqual(wallBounds({ flags: { "wall-height": { top: Infinity, bottom: -Infinity } } }, outdoor), {
    top: 10,
    bottom: 0,
  });
});

test("our flag outranks Wall Height, which outranks the scene default", () => {
  const wall: WallLike = {
    flags: {
      "noodlr-hooks-55e": { top: 30, bottom: 5 },
      "wall-height": { top: 20, bottom: 0 },
    },
  };
  assert.deepEqual(wallBounds(wall, outdoor), { top: 30, bottom: 5 });
  assert.deepEqual(
    wallBounds({ flags: { "wall-height": { top: 20 } } }, outdoor),
    { top: 20, bottom: 0 },
  );
});

test("open doors and move-none walls do not block", () => {
  assert.equal(wallBlocksMovement({ move: 20, door: 1, ds: 1 }), false);
  assert.equal(wallBlocksMovement({ move: 20, door: 1, ds: 0 }), true);
  assert.equal(wallBlocksMovement({ move: 20, door: 1, ds: 2 }), true);
  assert.equal(wallBlocksMovement({ move: 0 }), false);
  assert.equal(wallBlocksMovement({ move: 20 }), true);
});

test("fly crosses at or above the top outdoors; five feet does not clear ten", () => {
  const slab = { top: 10, bottom: 0 };
  assert.equal(
    canCrossSlab({
      action: "fly",
      elevation: 10,
      slab,
      scene: outdoor,
      hasFly: true,
      hasClimb: false,
      hasBurrow: false,
      jumpHigh: null,
      jumpLong: null,
      horizontal: 5,
    }),
    true,
  );
  assert.equal(
    canCrossSlab({
      action: "fly",
      elevation: 5,
      slab,
      scene: outdoor,
      hasFly: true,
      hasClimb: false,
      hasBurrow: false,
      jumpHigh: null,
      jumpLong: null,
      horizontal: 5,
    }),
    false,
  );
  assert.equal(
    canCrossSlab({
      action: "walk",
      elevation: 10,
      slab,
      scene: outdoor,
      hasFly: true,
      hasClimb: false,
      hasBurrow: false,
      jumpHigh: null,
      jumpLong: null,
      horizontal: 5,
    }),
    false,
  );
});

test("indoor scenes refuse fly, climb and jump over; burrow still works on a natural floor", () => {
  const indoor = { ...outdoor, enclosure: "indoor" as const };
  const slab = { top: 10, bottom: 0 };
  assert.equal(
    canCrossSlab({
      action: "fly",
      elevation: 10,
      slab,
      scene: indoor,
      hasFly: true,
      hasClimb: false,
      hasBurrow: false,
      jumpHigh: 20,
      jumpLong: 20,
      horizontal: 5,
    }),
    false,
  );
  assert.equal(
    canCrossSlab({
      action: "burrow",
      elevation: -5,
      slab,
      scene: indoor,
      hasFly: false,
      hasClimb: false,
      hasBurrow: true,
      jumpHigh: null,
      jumpLong: null,
      horizontal: 5,
    }),
    true,
  );
});

test("a man-made floor refuses burrow even outdoors", () => {
  const paved = { ...outdoor, floor: "manmade" as const };
  assert.equal(
    canCrossSlab({
      action: "burrow",
      elevation: -5,
      slab: { top: 10, bottom: 0 },
      scene: paved,
      hasFly: false,
      hasClimb: false,
      hasBurrow: true,
      jumpHigh: null,
      jumpLong: null,
      horizontal: 5,
    }),
    false,
  );
});

test("a long jump clears a lip, not a 10 ft maze wall", () => {
  const jump = {
    action: "jump",
    elevation: 0,
    scene: outdoor,
    hasFly: false,
    hasClimb: false,
    hasBurrow: false,
    jumpHigh: 4,
    jumpLong: 16,
    horizontal: 5,
  };
  assert.equal(canCrossSlab({ ...jump, slab: { top: 10, bottom: 0 } }), false);
  assert.equal(canCrossSlab({ ...jump, slab: { top: 0, bottom: -50 } }), true);
  assert.equal(canCrossSlab({ ...jump, jumpHigh: 10, slab: { top: 10, bottom: 0 } }), true);
});

test("segment intersection ignores the starting point so a token on a wall is not immediately cut", () => {
  const hit = segmentIntersection(50, 50, 150, 50, 50, 0, 50, 200);
  assert.equal(hit, null);
  const mid = segmentIntersection(0, 50, 100, 50, 50, 0, 50, 200);
  assert.ok(mid);
  assert.ok(Math.abs(mid.x - 50) < 1e-6);
  assert.ok(Math.abs(mid.t - 0.5) < 1e-6);
});

test("a flyer at 10 ft ignores a default maze wall; at 5 ft it does not", () => {
  const path = [
    { x: 0, y: 50, elevation: 10, action: "fly" },
    { x: 100, y: 50, elevation: 10, action: "fly" },
  ];
  const measure = () => 5;
  assert.equal(decidePath(path, [maze], flyer, outdoor, measure).kind, "ignore-all");

  const low = [
    { x: 0, y: 50, elevation: 5, action: "fly" },
    { x: 100, y: 50, elevation: 5, action: "fly" },
  ];
  const blocked = decidePath(low, [maze], flyer, outdoor, measure);
  assert.equal(blocked.kind, "cut");
  if (blocked.kind === "cut") assert.equal(blocked.cut.skipped, 0);
});

test("a 10 ft hedge then a 100 ft keep stops at the keep after skipping the hedge", () => {
  const hedge: WallLike = { c: [40, 0, 40, 200], move: 20, flags: { "noodlr-hooks-55e": { top: 10 } } };
  const keep: WallLike = { c: [80, 0, 80, 200], move: 20, flags: { "noodlr-hooks-55e": { top: 100 } } };
  const path = [
    { x: 0, y: 50, elevation: 10, action: "fly" },
    { x: 120, y: 50, elevation: 10, action: "fly" },
  ];
  const decision = decidePath(path, [hedge, keep], flyer, outdoor, () => 6);
  assert.equal(decision.kind, "cut");
  if (decision.kind !== "cut") return;
  assert.equal(decision.cut.skipped, 1);
  assert.ok(Math.abs(decision.cut.x - 80) < 1e-6);
  const trimmed = trimToCut(path, decision.cut);
  assert.equal(trimmed.length, 2);
  assert.equal(trimmed[1]?.x, decision.cut.x);
});

test("scene flags default to outdoor and natural", () => {
  assert.deepEqual(scenePolicyOf(null), outdoor);
  assert.equal(scenePolicyOf({ flags: { "noodlr-hooks-55e": { enclosure: "indoor", floor: "manmade" } } }).enclosure, "indoor");
  assert.equal(scenePolicyOf({ flags: { "noodlr-hooks-55e": { enclosure: "indoor", floor: "manmade" } } }).floor, "manmade");
  assert.equal(
    scenePolicyOf({ flags: { "noodlr-hooks-55e": { defaultWallTop: "" } } }).defaultTop,
    DEFAULT_WALL_TOP,
    "an emptied number field is not a 0-foot wall",
  );
});
