import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  OOC_TTL_MS,
  SETTLE_MS,
  combatClockOf,
  durationExpired,
  isDue,
  leftoverAfterCombat,
  stampFor,
  type LifetimeNow,
  type LifetimeStamp,
} from "../src/rules/template-lifetime";
import {
  classifySource,
  clocksFromDuration,
  durationOf,
  kindFromUnits,
} from "../src/system/dnd5e-templates";

function now(partial: Partial<LifetimeNow> & { now: number }): LifetimeNow {
  return { live: new Set(), ...partial };
}

function stamp(partial: Partial<LifetimeStamp> & Pick<LifetimeStamp, "kind" | "at">): LifetimeStamp {
  return partial as LifetimeStamp;
}

test("duration units close the three kinds", () => {
  assert.equal(kindFromUnits("inst"), "instant");
  assert.equal(kindFromUnits(""), "instant");
  assert.equal(kindFromUnits("round"), "lasting");
  assert.equal(kindFromUnits("minute"), "lasting");
  assert.equal(kindFromUnits("hour"), "lasting");
  assert.equal(kindFromUnits("perm"), "keep");
  assert.equal(kindFromUnits("spec"), "keep");
  assert.equal(kindFromUnits("until"), "keep");
  assert.equal(kindFromUnits("disp"), "keep");
});

test("Fireball: activity inst + override false + item inst is instant", () => {
  const fireball = {
    duration: { units: "inst", override: false },
    item: { system: { duration: { value: "", units: "inst" } } },
  };
  assert.equal(classifySource(fireball).kind, "instant");
});

test("Wall of Fire: activity inst + override false + item minute is the item, not a Fireball", () => {
  const wall = {
    duration: { units: "inst", override: false },
    item: {
      system: {
        duration: { value: "1", units: "minute" },
        properties: ["concentration"],
      },
    },
  };
  const read = durationOf(wall);
  assert.equal(read.kind, "lasting");
  assert.equal(read.value, 1);
  assert.equal(read.units, "minute");
  assert.equal(read.concentrating, true);
});

test("empty activity duration falls through to the item", () => {
  const override = { duration: { units: "" }, item: { system: { duration: { units: "minute" } } } };
  assert.equal(classifySource(override).kind, "lasting");
});

test("a duration rider on the activity is taken even when override is still false", () => {
  const extended = {
    duration: { units: "inst", override: false, value: 2 },
    item: { system: { duration: { value: 1, units: "minute" }, properties: ["concentration"] } },
  };
  const read = durationOf(extended);
  assert.equal(read.kind, "lasting");
  assert.equal(read.value, 2);
  assert.equal(read.units, "minute");
});

test("concentration is a property, not a duration unit", () => {
  const wall = {
    duration: { units: "minute", concentration: true },
    item: { system: { properties: new Set(["concentration"]) } },
  };
  assert.deepEqual(classifySource(wall), { kind: "lasting", concentrating: true });
  const fog = { system: { duration: { units: "hour" }, properties: ["concentration"] } };
  assert.equal(classifySource(fog).concentrating, true);
});

test("clocks: 1 minute is 60 s and 10 rounds; Extend to 2 is double", () => {
  const one = clocksFromDuration("minute", 1, 0, { round: 1 }, 100);
  assert.equal(one.durationMs, 60_000);
  assert.equal(one.durationRounds, 10);
  assert.equal(one.untilMs, 60_000);
  assert.equal(one.untilRound, 11);
  assert.equal(one.untilWorld, 160);
  const two = clocksFromDuration("minute", 2, 0, { round: 1 });
  assert.equal(two.durationMs, 120_000);
  assert.equal(two.durationRounds, 20);
  assert.equal(two.untilRound, 21);
});

test("a lasting stamp without a value is not given an invented 1", () => {
  const empty = clocksFromDuration("minute", null, 0, { round: 1 });
  assert.deepEqual(empty, {});
});

test("a hand-drawn ruler (no origin, no item, no source) is not stamped", () => {
  assert.equal(stampFor({}, null, {}, 1), null);
});

test("an ability template whose source cannot be read is kept, never guessed as instant", () => {
  const doc = { flags: { dnd5e: { origin: "Activity.abc", item: "Item.wall" } } };
  const s = stampFor(doc, null, { combatId: "c1", round: 1, turn: 0 }, 100);
  assert.ok(s);
  assert.equal(s.kind, "keep");
  assert.equal(s.origin, "Activity.abc");
});

test("stampFor on Wall of Fire writes the minute clocks from the item", () => {
  const doc = { flags: { dnd5e: { origin: "Activity.wall", item: "Item.wall" } } };
  const source = {
    duration: { units: "inst", override: false },
    item: {
      uuid: "Item.wall",
      system: { duration: { value: "1", units: "minute" }, properties: ["concentration"] },
    },
  };
  const s = stampFor(doc, source, { combatId: "c1", round: 1, turn: 0 }, 1_000, 50);
  assert.ok(s);
  assert.equal(s.kind, "lasting");
  assert.equal(s.untilMs, 61_000);
  assert.equal(s.untilRound, 11);
  assert.equal(s.untilWorld, 110);
  assert.equal(s.concentrating, true);
});

test("an instant in combat is not due on the placing slot, even after settle", () => {
  const placed = stamp({
    kind: "instant",
    at: 0,
    combatId: "c1",
    round: 2,
    turn: 3,
  });
  const sameSlot = now({
    now: SETTLE_MS + 1,
    combatId: "c1",
    round: 2,
    turn: 3,
  });
  assert.equal(isDue(placed, sameSlot), false);
});

test("an instant is due once the placing turn is over and settle has passed", () => {
  const placed = stamp({
    kind: "instant",
    at: 0,
    combatId: "c1",
    round: 2,
    turn: 3,
  });
  assert.equal(
    isDue(placed, now({ now: SETTLE_MS - 1, combatId: "c1", round: 2, turn: 4 })),
    false,
    "settle first — a Fireball that vanishes before its saves is worse than a leftover",
  );
  assert.equal(isDue(placed, now({ now: SETTLE_MS, combatId: "c1", round: 2, turn: 4 })), true);
  assert.equal(isDue(placed, now({ now: SETTLE_MS, combatId: "c1", round: 3, turn: 0 })), true);
});

test("combat ending (no combatId now) makes a combat-stamped instant due after settle", () => {
  const placed = stamp({ kind: "instant", at: 0, combatId: "c1", round: 1, turn: 0 });
  assert.equal(isDue(placed, now({ now: SETTLE_MS })), true);
});

test("an out-of-combat instant uses the real-time TTL, not the combat clock", () => {
  const ooc = stamp({ kind: "instant", at: 0 });
  assert.equal(isDue(ooc, now({ now: OOC_TTL_MS - 1 })), false);
  assert.equal(isDue(ooc, now({ now: OOC_TTL_MS })), true);
});

test("lasting + concentration is not due from an empty live set — we never saw the AE", () => {
  const wall = stamp({
    kind: "lasting",
    at: 0,
    concentrating: true,
    item: "Item.wall",
    origin: "Activity.wall",
    untilMs: 60_000,
  });
  assert.equal(isDue(wall, now({ now: SETTLE_MS, live: new Set() })), false);
  assert.equal(isDue(wall, now({ now: SETTLE_MS, live: new Set(["Item.wall"]) })), false);
});

test("lasting + concentration is due when we saw the AE and it is gone, after settle", () => {
  const wall = stamp({
    kind: "lasting",
    at: 0,
    concentrating: true,
    heldSeen: true,
    item: "Item.wall",
    origin: "Activity.wall",
    untilMs: 60_000,
  });
  assert.equal(isDue(wall, now({ now: SETTLE_MS, live: new Set(["Item.wall"]) })), false);
  assert.equal(isDue(wall, now({ now: SETTLE_MS - 1, live: new Set() })), false);
  assert.equal(isDue(wall, now({ now: SETTLE_MS, live: new Set() })), true);
});

test("an out-of-combat Wall of Fire lasts the stamped minute, not four seconds", () => {
  const wall = stamp({
    kind: "lasting",
    at: 0,
    concentrating: true,
    item: "Item.wall",
    untilMs: 60_000,
  });
  assert.equal(isDue(wall, now({ now: SETTLE_MS, live: new Set() })), false);
  assert.equal(isDue(wall, now({ now: 59_999, live: new Set() })), false);
  assert.equal(isDue(wall, now({ now: 60_000, live: new Set() })), true);
});

test("in the placing combat a wall lasts 10 rounds, even if wall-clock seconds have passed", () => {
  const wall = stamp({
    kind: "lasting",
    at: 0,
    combatId: "c1",
    round: 1,
    untilMs: 60_000,
    untilRound: 11,
  });
  assert.equal(durationExpired(wall, now({ now: 60_000, combatId: "c1", round: 10 })), false);
  assert.equal(isDue(wall, now({ now: 60_000, combatId: "c1", round: 10 })), false);
  assert.equal(isDue(wall, now({ now: 1_000, combatId: "c1", round: 11 })), true);
});

test("lasting without concentration still expires on its stamped clock (Fog Cloud)", () => {
  const fog = stamp({ kind: "lasting", at: 0, item: "Item.fog", untilMs: 3_600_000 });
  assert.equal(isDue(fog, now({ now: 3_599_999 })), false);
  assert.equal(isDue(fog, now({ now: 3_600_000 })), true);
});

test("keep + concentration still dies when we saw the AE and it ended", () => {
  const until = stamp({
    kind: "keep",
    at: 0,
    concentrating: true,
    heldSeen: true,
    item: "Item.until",
  });
  assert.equal(isDue(until, now({ now: SETTLE_MS, live: new Set(["Item.until"]) })), false);
  assert.equal(isDue(until, now({ now: SETTLE_MS, live: new Set() })), true);
});

test("keep + concentration without heldSeen is not due from an empty live set", () => {
  const until = stamp({
    kind: "keep",
    at: 0,
    concentrating: true,
    item: "Item.until",
  });
  assert.equal(isDue(until, now({ now: SETTLE_MS, live: new Set() })), false);
});

test("keep without concentration is never due", () => {
  const hand = stamp({ kind: "keep", at: 0 });
  assert.equal(isDue(hand, now({ now: 999_999 })), false);
});

test("leftover after combat converts remaining rounds to real time", () => {
  const wall = stamp({ kind: "lasting", at: 0, untilRound: 11 });
  assert.equal(leftoverAfterCombat(wall, 4, 10_000), 10_000 + 7 * 6_000);
  assert.equal(leftoverAfterCombat(wall, 11, 10_000), 10_000);
});

test("combatClockOf ignores a combat that has not started", () => {
  assert.deepEqual(combatClockOf({ id: "c1", started: false, round: 1, turn: 0 }), {});
  assert.equal(combatClockOf({ id: "c1", started: true, round: 2, turn: 1 }).round, 2);
});
