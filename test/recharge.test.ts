import { strict as assert } from "node:assert";
import { test } from "node:test";

import { decideRecharge, rechargeSubjects } from "../src/rules/recharge";

test("recharge rolls only at turnStart for an NPC, when we are on and the system is not", () => {
  const yes = decideRecharge({
    ourMode: "silent",
    systemMode: "no",
    isNpc: true,
    periods: ["turn", "turnStart"],
  });
  assert.equal(yes.roll, true);
  if (yes.roll) assert.equal(yes.announce, false);

  const announced = decideRecharge({
    ourMode: "yes",
    systemMode: "no",
    isNpc: true,
    periods: ["turnStart"],
  });
  assert.equal(announced.roll, true);
  if (announced.roll) assert.equal(announced.announce, true);
});

test("recharge stands aside when dnd5e is already rolling, including an unreadable setting", () => {
  for (const systemMode of ["yes", "silent", null] as const) {
    const d = decideRecharge({
      ourMode: "silent",
      systemMode,
      isNpc: true,
      periods: ["turnStart"],
    });
    assert.equal(d.roll, false, `systemMode=${String(systemMode)} should stand aside`);
  }
});

test("recharge does not roll for a PC, a non-turnStart recovery, or when ours is off", () => {
  assert.equal(
    decideRecharge({
      ourMode: "silent",
      systemMode: "no",
      isNpc: false,
      periods: ["turnStart"],
    }).roll,
    false,
  );
  assert.equal(
    decideRecharge({
      ourMode: "silent",
      systemMode: "no",
      isNpc: true,
      periods: ["turn"],
    }).roll,
    false,
  );
  assert.equal(
    decideRecharge({
      ourMode: "no",
      systemMode: "no",
      isNpc: true,
      periods: ["turnStart"],
    }).roll,
    false,
  );
});

test("rechargeSubjects finds a spent recharge on the item or on one of its activities", () => {
  const breath = {
    name: "Fire Breath",
    system: {
      uses: { spent: 1, max: 1, recovery: [{ period: "recharge", formula: "5" }] },
      activities: {},
    },
  };
  const charged = {
    name: "Bite",
    system: {
      uses: { spent: 0, max: 1, recovery: [{ period: "recharge", formula: "5" }] },
      activities: {},
    },
  };
  const onActivity = {
    name: "Swallow",
    system: {
      uses: { spent: 0, recovery: [] },
      activities: {
        swa: {
          name: "Swallow",
          uses: { spent: 1, max: 1, recovery: [{ period: "recharge", formula: "6" }] },
        },
      },
    },
  };
  const actor = { items: [breath, charged, onActivity] };
  const found = rechargeSubjects(actor);
  assert.deepEqual(
    found.map((s) => s.name),
    ["Fire Breath", "Swallow"],
  );
});
