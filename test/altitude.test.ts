import test from "node:test";
import assert from "node:assert/strict";

import { readLocomotion, type Mode } from "../src/core/locomotion.js";
import {
  canReachVertical,
  emergeOptions,
  flybyOptions,
  hoverHeight,
  hoverOptions,
  strikeElevation,
  worksFrom,
} from "../src/tactics/altitude.js";
import type { CreatureAction } from "../src/tactics/actions.js";

function kit(over: Partial<CreatureAction> = {}): CreatureAction {
  return {
    item: { name: over.name ?? "Bite" },
    name: "Bite",
    kind: "attack",
    economy: "action",
    melee: true,
    ranged: false,
    range: 5,
    available: true,
    depleting: false,
    ...over,
  };
}

function loco(modes: Partial<Record<Mode, number>>, primary: Mode = "walk") {
  return { modes, primary, speed: modes[primary] ?? modes.walk ?? 0, hover: false };
}

function board(over: Record<string, unknown> = {}): any {
  return {
    self: {
      name: "Adult Red Dragon",
      elevation: 0,
      hpFraction: 1,
      actor: { system: { traits: { size: "huge" } } },
    },
    enemies: [{ name: "Fighter", distance: 5, elevation: 0 }],
    allies: [],
    unseen: [],
    units: "ft",
    speed: 80,
    locomotion: loco({ walk: 40, fly: 80 }, "fly"),
    ...over,
  };
}

const NO_GAME = { speed: [] } as any;

test("fly equal to walk is the primary mode", () => {
  const read = readLocomotion(
    { system: { attributes: { movement: { walk: 80, fly: 80 } } } },
    NO_GAME,
  );
  assert.equal(read.primary, "fly");
  assert.equal(read.speed, 80);
});

test("walk still wins when it is strictly faster", () => {
  const read = readLocomotion(
    { system: { attributes: { movement: { walk: 40, fly: 20 } } } },
    NO_GAME,
  );
  assert.equal(read.primary, "walk");
});

test("hover height is one reach plus one square — tax is not a destination", () => {
  assert.equal(hoverHeight(10, 5), 15);
  assert.equal(hoverHeight(5, 5), 10);
});

test("a 5 ft Bite cannot be used from hover height", () => {
  assert.equal(worksFrom(kit({ range: 5 }), 5, 10, 0), false);
});

test("a 30 ft breath can be used from hover height", () => {
  assert.equal(worksFrom(kit({ name: "Fire Breath", range: 30, melee: true }), 20, 10, 0), true);
});

test("no hover without a fly speed", () => {
  const options = hoverOptions(
    board({ locomotion: loco({ walk: 40 }), speed: 40 }),
    [kit({ name: "Fire Breath", range: 30 })],
    () => 5,
  );
  assert.equal(options.length, 0);
});

test("no hover when already at the safe height", () => {
  const options = hoverOptions(
    board({ self: { ...board().self, elevation: 15 } }),
    [kit({ name: "Fire Breath", range: 30 })],
    () => 10,
  );
  assert.equal(options.length, 0);
});

test("no hover with only a 5 ft melee attack", () => {
  const options = hoverOptions(board(), [kit()], () => 5);
  assert.equal(options.length, 0);
});

test("hover is offered in melee when a breath still reaches", () => {
  const options = hoverOptions(
    board(),
    [kit({ name: "Fire Breath", range: 30 })],
    () => 5,
  );
  assert.equal(options[0]?.kind, "hover");
  assert.equal(options[0]?.elevation, 10);
  assert.equal(options[0]?.moveAction, "fly");
  assert.ok(Number(options[0]?.score) > 1.4);
});

test("a Huge takeoff is affordable at 80 ft — the tax is 30, the dest is still +10", () => {
  const options = hoverOptions(
    board({ speed: 30 }),
    [kit({ name: "Fire Breath", range: 30 })],
    () => 5,
  );
  assert.equal(options[0]?.elevation, 10, "paid 30 to sit at +10, not +30");
});

test("cannot hover when the tax exceeds the leftover Speed", () => {
  const options = hoverOptions(
    board({ speed: 20 }),
    [kit({ name: "Fire Breath", range: 30 })],
    () => 5,
  );
  assert.equal(options.length, 0);
});

test("fly-by stays high when the melee still reaches after closing", () => {
  assert.equal(strikeElevation(10, 0, 5, 15), 10, "5 ft away, 15 ft tail from +10");
  assert.equal(strikeElevation(10, 0, 15, 15), 0, "15 ft away is 18 in 3D — must dive");
});

test("fly-by at height scores above a dive", () => {
  const high = board({
    self: { ...board().self, elevation: 10 },
    enemies: [{ name: "Fighter", distance: 5, elevation: 0 }],
  });
  const stay = flybyOptions(high, [kit({ name: "Tail", range: 15 })], () => 5);
  const dive = flybyOptions(
    board({
      self: { ...board().self, elevation: 20 },
      enemies: [{ name: "Fighter", distance: 10, elevation: 0 }],
    }),
    [kit({ name: "Bite", range: 10 })],
    () => 5,
  );
  assert.ok(stay[0], "stay-high fly-by exists");
  assert.equal(stay[0]?.elevation, 10);
  assert.ok(dive[0], "dive fly-by exists");
  assert.equal(dive[0]?.elevation, 0);
  assert.ok(Number(stay[0]?.score) > Number(dive[0]?.score));
});

test("no fly-by without a fly speed", () => {
  const options = flybyOptions(
    board({ locomotion: loco({ walk: 40 }), speed: 40 }),
    [kit({ name: "Bite", range: 10 })],
    () => 5,
  );
  assert.equal(options.length, 0);
});

test("dive is offered to an engaged burrower, emerge is not the same plan", () => {
  const bulette = board({
    self: {
      name: "Bulette",
      elevation: 0,
      hpFraction: 1,
      actor: { system: { traits: { size: "large" } } },
    },
    speed: 40,
    locomotion: loco({ walk: 40, burrow: 40 }, "walk"),
  });
  const down = emergeOptions(bulette, [kit({ name: "Bite", range: 5 })], () => 5);
  assert.equal(down[0]?.kind, "emerge");
  assert.ok((down[0]?.elevation ?? 0) < 0);
  assert.equal(down[0]?.moveAction, "burrow");
  assert.equal(down[0]?.itemName, undefined, "diving is the whole turn — no same-turn emerge");
});

test("a buried burrower emerges and attacks", () => {
  const buried = board({
    self: {
      name: "Bulette",
      elevation: -10,
      hpFraction: 1,
      actor: { system: { traits: { size: "large" } } },
    },
    enemies: [{ name: "Fighter", distance: 10, elevation: 0 }],
    speed: 40,
    locomotion: loco({ walk: 40, burrow: 40 }, "burrow"),
  });
  const up = emergeOptions(buried, [kit({ name: "Bite", range: 5 })], () => 5);
  assert.equal(up[0]?.elevation, 0);
  assert.equal(up[0]?.itemName, "Bite");
});

test("rising needs fly or climb; going down also accepts burrow and swim", () => {
  const burrow = loco({ burrow: 40, walk: 40 });
  assert.equal(canReachVertical(burrow, 10), false);
  assert.equal(canReachVertical(burrow, -10), true);
  const fly = loco({ fly: 80, walk: 40 });
  assert.equal(canReachVertical(fly, 10), true);
  const swim = loco({ swim: 40 });
  assert.equal(canReachVertical(swim, 10), false);
  assert.equal(canReachVertical(swim, -5), true);
});
