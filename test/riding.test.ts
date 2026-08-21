import { strict as assert } from "node:assert";
import { test } from "node:test";

import { MODULE_ID } from "../src/constants";
import {
  DISP,
  RIDING_SHOW_ICON_ALWAYS,
  RIDING_STATUS_ID,
  RIDING_STATUS_IMG,
  canAffordMount,
  carryingAllowsMount,
  defaultControlled,
  defaultFootprintSquares,
  dispositionAllowsMount,
  footprintSquares,
  isOurRidingBadge,
  judgeMount,
  mountCostFeet,
  mountCostFromStamp,
  ridingBadgePayload,
  ridingStatusEntry,
  seatCapacityFromSquares,
  seatCellCenter,
  seatCostFromSquares,
  seatPlan,
  seatsAllowMount,
  sizeAllowsMount,
  wouldLoop,
} from "../src/system/dnd5e-riding";

const legal = {
  rideableActive: false,
  riderId: "rider",
  mountId: "horse",
  ridingOf: {},
  riderRank: 2,
  mountRank: 3,
  riderDisposition: DISP.FRIENDLY,
  mountDisposition: DISP.FRIENDLY,
  riderIsPlayer: true,
  inReach: true,
};

test("riding status id is never a canned condition and HUD cannot toggle it", () => {
  assert.equal(RIDING_STATUS_ID, "noodlr-mounted");
  assert.notEqual(RIDING_STATUS_ID, "prone");
  assert.notEqual(RIDING_STATUS_ID, "dead");
  const entry = ridingStatusEntry();
  assert.equal(entry.hud, false);
  assert.equal(entry.img, RIDING_STATUS_IMG);
  assert.notEqual(entry.img, "icons/svg/aura.svg");
});

test("riding badge is empty changes, ALWAYS icon, module flag", () => {
  const payload = ridingBadgePayload({ uuid: "Actor.r" });
  assert.equal(payload.showIcon, RIDING_SHOW_ICON_ALWAYS);
  assert.deepEqual(payload.changes, []);
  assert.deepEqual(payload.statuses, [RIDING_STATUS_ID]);
  const flags = payload.flags as Record<string, any>;
  assert.equal(flags[MODULE_ID].ridingBadge, true);
  assert.equal(isOurRidingBadge({ flags: { [MODULE_ID]: { ridingBadge: true } } }), true);
  assert.equal(isOurRidingBadge({ flags: { [MODULE_ID]: { transformBadge: true } } }), false);
});

test("mount must be at least one size larger; unreadable size refuses", () => {
  assert.equal(sizeAllowsMount(2, 3), true);
  assert.equal(sizeAllowsMount(2, 2), false);
  assert.equal(sizeAllowsMount(4, 5), true);
  assert.equal(sizeAllowsMount(null, 3), false);
  assert.equal(sizeAllowsMount(2, null), false);
});

test("same disposition or Neutral; players also mount Friendly", () => {
  assert.equal(
    dispositionAllowsMount({
      riderDisposition: DISP.HOSTILE,
      mountDisposition: DISP.HOSTILE,
      riderIsPlayer: false,
    }),
    true,
  );
  assert.equal(
    dispositionAllowsMount({
      riderDisposition: DISP.HOSTILE,
      mountDisposition: DISP.NEUTRAL,
      riderIsPlayer: false,
    }),
    true,
  );
  assert.equal(
    dispositionAllowsMount({
      riderDisposition: DISP.HOSTILE,
      mountDisposition: DISP.FRIENDLY,
      riderIsPlayer: false,
    }),
    false,
  );
  assert.equal(
    dispositionAllowsMount({
      riderDisposition: DISP.NEUTRAL,
      mountDisposition: DISP.FRIENDLY,
      riderIsPlayer: true,
    }),
    true,
  );
  assert.equal(
    dispositionAllowsMount({
      riderDisposition: DISP.SECRET,
      mountDisposition: DISP.SECRET,
      riderIsPlayer: false,
    }),
    true,
  );
});

test("half Speed rounds down; Speed 0 cannot mount", () => {
  assert.equal(mountCostFeet(30), 15);
  assert.equal(mountCostFeet(25), 12);
  assert.equal(mountCostFeet(1), 0);
  assert.equal(mountCostFeet(0), 0);
  assert.equal(canAffordMount(30), true);
  assert.equal(canAffordMount(0), false);
  assert.equal(canAffordMount(Number.NaN), false);
});

test("unreadable carrying allows; a known overload refuses", () => {
  assert.equal(carryingAllowsMount(null, 80), true);
  assert.equal(carryingAllowsMount(240, null), true);
  assert.equal(carryingAllowsMount(240, 80), true);
  assert.equal(carryingAllowsMount(50, 80), false);
  assert.equal(carryingAllowsMount(240, 80, 100), true);
  assert.equal(carryingAllowsMount(240, 80, 200), false);
});

test("seats are half the mount footprint; a horse holds two, a brontosaurus a party", () => {
  assert.equal(footprintSquares(2, 2), 4);
  assert.equal(footprintSquares(4, 4), 16);
  assert.equal(footprintSquares(0, 2), null);
  assert.equal(defaultFootprintSquares(2), 1);
  assert.equal(defaultFootprintSquares(3), 4);
  assert.equal(defaultFootprintSquares(5), 16);
  assert.equal(seatCapacityFromSquares(4), 2);
  assert.equal(seatCapacityFromSquares(9), 4);
  assert.equal(seatCapacityFromSquares(16), 8);
  assert.equal(seatCostFromSquares(1), 1);
  assert.equal(seatCostFromSquares(0.25), 1);
  assert.equal(seatCostFromSquares(4), 4);
  assert.equal(seatsAllowMount(seatPlan({ mountRank: 3, riderRank: 2, seatsUsed: 0 })), true);
  assert.equal(seatsAllowMount(seatPlan({ mountRank: 3, riderRank: 2, seatsUsed: 1 })), true);
  assert.equal(seatsAllowMount(seatPlan({ mountRank: 3, riderRank: 2, seatsUsed: 2 })), false);
  assert.equal(
    seatsAllowMount(seatPlan({ mountSquares: 16, riderSquares: 1, mountRank: 5, riderRank: 2, seatsUsed: 5 })),
    true,
  );
  assert.deepEqual(seatCellCenter(0, 1), { fx: 0.5, fy: 0.5 });
});

test("a riding loop or self-mount is refused", () => {
  assert.equal(wouldLoop("a", "a", {}), true);
  assert.equal(wouldLoop("a", "b", { b: "a" }), true);
  assert.equal(wouldLoop("a", "b", { b: "c" }), false);
});

test("Neutral and Friendly mounts default to controlled; Hostile does not", () => {
  assert.equal(defaultControlled(DISP.NEUTRAL), true);
  assert.equal(defaultControlled(DISP.FRIENDLY), true);
  assert.equal(defaultControlled(DISP.HOSTILE), false);
});

test("mount cost stamp is turn-keyed and stale is zero", () => {
  const stamp = { combat: "c1", combatant: "cb", round: 3, cost: 15 };
  assert.equal(mountCostFromStamp(stamp, "c1", "cb", 3), 15);
  assert.equal(mountCostFromStamp(stamp, "c1", "cb", 4), 0);
  assert.equal(mountCostFromStamp(stamp, "c2", "cb", 3), 0);
  assert.equal(mountCostFromStamp(undefined, "c1", "cb", 3), 0);
});

test("judgeMount names each refusal", () => {
  assert.deepEqual(judgeMount(legal), { ok: true });
  assert.deepEqual(judgeMount({ ...legal, rideableActive: true }), { ok: false, reason: "rideable" });
  assert.deepEqual(judgeMount({ ...legal, mountId: "rider" }), { ok: false, reason: "same" });
  assert.deepEqual(judgeMount({ ...legal, riderAlreadyOn: "other" }), {
    ok: false,
    reason: "already-riding",
  });
  assert.deepEqual(judgeMount({ ...legal, seatsUsed: 1 }), { ok: true });
  assert.deepEqual(judgeMount({ ...legal, seatsUsed: 2 }), { ok: false, reason: "occupied" });
  assert.deepEqual(judgeMount({ ...legal, mountSquares: 16, riderSquares: 1, seatsUsed: 5 }), {
    ok: true,
  });
  assert.deepEqual(judgeMount({ ...legal, mountMax: 240, riderBurden: 80, carriedAlready: 200 }), {
    ok: false,
    reason: "carrying",
  });
  assert.deepEqual(judgeMount({ ...legal, ridingOf: { horse: "rider" } }), {
    ok: false,
    reason: "loop",
  });
  assert.deepEqual(judgeMount({ ...legal, mountRank: 2 }), { ok: false, reason: "size" });
  assert.deepEqual(
    judgeMount({
      ...legal,
      riderIsPlayer: false,
      riderDisposition: DISP.HOSTILE,
      mountDisposition: DISP.FRIENDLY,
    }),
    { ok: false, reason: "disposition" },
  );
  assert.deepEqual(judgeMount({ ...legal, mountMax: 10, riderBurden: 80 }), {
    ok: false,
    reason: "carrying",
  });
  assert.deepEqual(judgeMount({ ...legal, inReach: false }), { ok: false, reason: "too-far" });
  assert.deepEqual(judgeMount({ ...legal, checkSpeed: true, speed: 0 }), {
    ok: false,
    reason: "speed",
  });
  assert.deepEqual(judgeMount({ ...legal, checkSpeed: true, speed: null }), { ok: true });
});
