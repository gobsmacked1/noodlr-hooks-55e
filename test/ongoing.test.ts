import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  followOnDamageOf,
  followOnTargetOut,
  isFollowOnDamage,
  otherActionEndsFollowOn,
  shouldContinueFollowOn,
  startedOnSlot,
} from "../src/system/dnd5e-ongoing";
import { concentrationDurationOf } from "../src/capability/live-item";

const attack = { type: "attack", name: "Cast" };
const ongoing = {
  type: "damage",
  name: "Ongoing Damage",
  target: { override: true, affects: {} },
  consumption: { spellSlot: false },
};

function witchBolt() {
  const item = { name: "Witch Bolt", system: { activities: { contents: [] as any[] } } };
  const later = { ...ongoing, item };
  const first = { ...attack, item };
  item.system.activities.contents = [first, later];
  return { item, first, later };
}

test("Witch Bolt's empty-target Damage is follow-on; its Attack is not", () => {
  (globalThis as any).game = { system: { id: "dnd5e" } };
  const { first, later } = witchBolt();
  assert.equal(isFollowOnDamage(later), true);
  assert.equal(isFollowOnDamage(first), false);
  assert.equal(followOnDamageOf(later.item), later);
});

test("a spell-slot Damage beside an Attack is a real extra cast, not follow-on", () => {
  const { later } = witchBolt();
  later.consumption = { spellSlot: true };
  assert.equal(isFollowOnDamage(later), false);
});

test("a killed or missing target ends the bolt; an alive one does not", () => {
  assert.equal(followOnTargetOut({ hp: 0 }), true);
  assert.equal(followOnTargetOut({ dead: true }), true);
  assert.equal(followOnTargetOut({ defeated: true }), true);
  assert.equal(followOnTargetOut({ missing: true }), true);
  assert.equal(followOnTargetOut({ hp: 9 }), false);
  assert.equal(followOnTargetOut({}), false);
});

test("another Action ends Witch Bolt; the bolt itself and a declaration do not", () => {
  const { item } = witchBolt();
  const dagger = { id: "dagger", name: "Dagger" };
  assert.equal(
    otherActionEndsFollowOn({
      activationType: "action",
      usedItem: dagger,
      heldItem: item,
    }),
    true,
  );
  assert.equal(
    otherActionEndsFollowOn({
      activationType: "action",
      usedItem: item,
      heldItem: item,
    }),
    false,
  );
  assert.equal(
    otherActionEndsFollowOn({
      activationType: "bonus",
      usedItem: { id: "misty", name: "Misty Step" },
      heldItem: item,
    }),
    false,
  );
  assert.equal(
    otherActionEndsFollowOn({
      activationType: "action",
      declaration: true,
      usedItem: { id: "attack", name: "Attack" },
      heldItem: item,
    }),
    false,
  );
});

test("the 1d12 waits until a later turn and only if the bonus is still free", () => {
  assert.equal(startedOnSlot({ startRound: 1, startTurn: 0 }, { round: 1, turn: 0 }), true);
  assert.equal(startedOnSlot({ startRound: 1, startTurn: 0 }, { round: 2, turn: 0 }), false);
  assert.equal(
    shouldContinueFollowOn({ startedThisSlot: true, targetOut: false, bonusFree: true }),
    false,
  );
  assert.equal(
    shouldContinueFollowOn({ startedThisSlot: false, targetOut: true, bonusFree: true }),
    false,
  );
  assert.equal(
    shouldContinueFollowOn({ startedThisSlot: false, targetOut: false, bonusFree: false }),
    false,
  );
  assert.equal(
    shouldContinueFollowOn({ startedThisSlot: false, targetOut: false, bonusFree: true }),
    true,
  );
});

test("concentration duration is the AE's, not the item list", () => {
  const item = { id: "wb", uuid: "Actor.s.Item.wb" };
  const effect = { origin: item.uuid, duration: { startRound: 2, startTurn: 1 } };
  const actor = { concentration: { items: [item], effects: [effect] } };
  assert.deepEqual(concentrationDurationOf(actor, item), { startRound: 2, startTurn: 1 });
  assert.equal(concentrationDurationOf(actor, { uuid: "Actor.s.Item.other" }), null);
});
