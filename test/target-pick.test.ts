import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  actorTokenIds,
  affectsTypeOf,
  isSelfOnlyTargetSet,
  needsExternalCreatureTarget,
  templateTypeOf,
} from "../src/system/dnd5e-target";
import { dropControlledSelfLeftover, refuseSelfOnlyCreatureTarget } from "../src/rules/target-pick";

const witchCast = {
  name: "Cast",
  type: "attack",
  target: { override: false, affects: { type: "creature", count: 1 }, template: { type: "" } },
  item: {
    name: "Witch Bolt",
    system: {
      range: { units: "ft", value: 60 },
      target: { affects: { type: "creature", count: 1 }, template: { type: "" } },
    },
  },
};

const witchOngoing = {
  name: "Ongoing Damage",
  type: "damage",
  target: { override: true, affects: { type: "", count: null }, template: { type: "" } },
  item: witchCast.item,
};

const fireball = {
  name: "Fireball",
  type: "save",
  target: { override: false, template: { type: "sphere", size: 20 } },
  item: { system: { target: { template: { type: "sphere", size: 20 } } } },
};

const heal = {
  name: "Healing Word",
  type: "heal",
  target: { override: false, affects: { type: "creature", count: 1 } },
  item: { system: { target: { affects: { type: "creature", count: 1 } } } },
};

test("Witch Bolt's first cast needs an external creature", () => {
  assert.equal(affectsTypeOf(witchCast), "creature");
  assert.equal(templateTypeOf(witchCast), "");
  assert.equal(needsExternalCreatureTarget(witchCast), true);
});

test("Witch Bolt's ongoing damage does not ask for a new token", () => {
  assert.equal(affectsTypeOf(witchOngoing), "");
  assert.equal(needsExternalCreatureTarget(witchOngoing), false);
});

test("a sphere is the area's problem, not a leftover click", () => {
  assert.equal(needsExternalCreatureTarget(fireball), false);
});

test("Healing Word still needs a creature — an ally is legal", () => {
  assert.equal(needsExternalCreatureTarget(heal), true);
});

test("empty is not self-only — the sheet still picks at the attack", () => {
  assert.equal(isSelfOnlyTargetSet([], ["sorc"]), false);
});

test("the caster alone is self-only; the wolf is not", () => {
  assert.equal(isSelfOnlyTargetSet(["sorc"], ["sorc"]), true);
  assert.equal(isSelfOnlyTargetSet(["wolf"], ["sorc"]), false);
  assert.equal(isSelfOnlyTargetSet(["sorc", "wolf"], ["sorc"]), false);
});

test("actorTokenIds matches the caster's tokens only", () => {
  const actor = { id: "A" };
  const mine = { id: "sorc", actor: { id: "A" } };
  const wolf = { id: "wolf", actor: { id: "W" } };
  assert.deepEqual(actorTokenIds(actor, [mine, wolf]), ["sorc"]);
});

test("drop leftover self when the Target tool comes on, not an allied PC", () => {
  const me = { id: "sorc", name: "Empowered Sorc" };
  const ally = { id: "barb", name: "Barb Arian" };
  assert.equal(dropControlledSelfLeftover([me], [me]).length, 1);
  assert.equal(dropControlledSelfLeftover([ally], [me]).length, 0);
  assert.equal(dropControlledSelfLeftover([me, ally], [me]).length, 0);
});

test("refuse Witch Bolt at the caster; allow the wolf; allow ongoing", () => {
  const actor = { id: "A" };
  const me = { id: "sorc", actor: { id: "A" } };
  const wolf = { id: "wolf", actor: { id: "W" } };
  assert.equal(refuseSelfOnlyCreatureTarget(witchCast, [me], actor), true);
  assert.equal(refuseSelfOnlyCreatureTarget(witchCast, [wolf], actor), false);
  assert.equal(refuseSelfOnlyCreatureTarget(witchCast, [], actor), false);
  assert.equal(refuseSelfOnlyCreatureTarget(witchOngoing, [me], actor), false);
});
