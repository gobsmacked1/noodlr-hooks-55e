import { strict as assert } from "node:assert";
import { test } from "node:test";

import { followOnDamageOf, isFollowOnDamage } from "../src/system/dnd5e-ongoing";
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

test("concentration duration is the AE's, not the item list", () => {
  const item = { id: "wb", uuid: "Actor.s.Item.wb" };
  const effect = { origin: item.uuid, duration: { startRound: 2, startTurn: 1 } };
  const actor = { concentration: { items: [item], effects: [effect] } };
  assert.deepEqual(concentrationDurationOf(actor, item), { startRound: 2, startTurn: 1 });
  assert.equal(concentrationDurationOf(actor, { uuid: "Actor.s.Item.other" }), null);
});
