import { strict as assert } from "node:assert";
import { test } from "node:test";

import { bindingAppliesToActivity } from "../src/capability/executor";
import {
  afflictedBy,
  bindingShouldFire,
  concentratingOn,
  damageTakenGrantAllowed,
  itemIsInPlay,
  itemKindOf,
} from "../src/capability/live-item";
import { MODULE_ID } from "../src/constants";

const feast = {
  id: "feast",
  uuid: "Actor.drew.Item.feast",
  type: "spell",
  name: "Feast of Flesh",
};

test("item kinds close on the sheet type, not the name", () => {
  assert.equal(itemKindOf({ type: "feat" }), "feat");
  assert.equal(itemKindOf({ type: "class" }), "feat");
  assert.equal(itemKindOf({ type: "weapon" }), "weapon");
  assert.equal(itemKindOf({ type: "spell" }), "spell");
  assert.equal(itemKindOf({ type: "consumable" }), "consumable");
});

test("a feat is always in play; a known-but-uncast spell is not", () => {
  const actor = { effects: [], concentration: { items: [], effects: [] } };
  assert.equal(itemIsInPlay({ type: "feat", name: "Reckless Attack" }, actor), true);
  assert.equal(itemIsInPlay(undefined, actor), true);
  assert.equal(itemIsInPlay(feast, actor), false);
});

test("an unequipped weapon is not in play; unreadable equipped is", () => {
  const actor = {};
  assert.equal(itemIsInPlay({ type: "weapon", system: { equipped: false } }, actor), false);
  assert.equal(itemIsInPlay({ type: "weapon", system: { equipped: true } }, actor), true);
  assert.equal(itemIsInPlay({ type: "weapon", system: {} }, actor), true);
});

test("concentrating on a spell puts it in play", () => {
  const actor = { concentration: { items: [feast], effects: [] }, effects: [] };
  assert.equal(concentratingOn(actor, feast), true);
  assert.equal(itemIsInPlay(feast, actor), true);
  assert.equal(concentratingOn(actor, { uuid: "Actor.drew.Item.other" }), false);
});

test("a real affliction AE puts the spell in play; our timed grant does not", () => {
  const real = {
    origin: feast.uuid,
    flags: { dnd5e: { item: { uuid: feast.uuid } } },
  };
  const timed = {
    origin: "0c0b84f5c704b8cb",
    flags: {
      [MODULE_ID]: { timed: { kind: "grant_advantage", capability: "0c0b84f5c704b8cb" } },
    },
  };
  assert.equal(afflictedBy({ effects: [real] }, feast), true);
  assert.equal(afflictedBy({ effects: [timed] }, feast), false);
  assert.equal(itemIsInPlay(feast, { effects: [timed], concentration: { items: [] } }), false);
  assert.equal(itemIsInPlay(feast, { effects: [real], concentration: { items: [] } }), true);
});

test("no used item: an uncast spell does not fire; a feat does", () => {
  const actor = { effects: [], concentration: { items: [] } };
  assert.equal(
    bindingShouldFire({ item: feast }, actor, null, bindingAppliesToActivity),
    false,
  );
  assert.equal(
    bindingShouldFire({ item: { type: "feat", id: "reckless" } }, actor, null, bindingAppliesToActivity),
    true,
  );
});

test("a used item still uses the Hold Person / Otto split", () => {
  const actor = { effects: [], concentration: { items: [] } };
  const used = { id: "hold", type: "spell" };
  assert.equal(
    bindingShouldFire({ item: { id: "hold", type: "spell" } }, actor, used, bindingAppliesToActivity),
    true,
  );
  assert.equal(
    bindingShouldFire({ item: { id: "otto", type: "spell" } }, actor, used, bindingAppliesToActivity),
    false,
  );
});

test("a concentrating caster does not get their own on_damage_taken grant", () => {
  const actor = { concentration: { items: [feast], effects: [] }, effects: [] };
  assert.equal(itemIsInPlay(feast, actor), true, "the spell is up");
  assert.equal(
    damageTakenGrantAllowed({ item: feast }, actor, "on_damage_taken", "grant_advantage"),
    false,
    "she is concentrating, not afflicted",
  );
  assert.equal(
    damageTakenGrantAllowed({ item: feast }, actor, "on_damage_taken", "damage"),
    true,
    "Armor of Agathys still burns whoever hit her",
  );
  const afflicted = {
    concentration: { items: [feast], effects: [] },
    effects: [{ origin: feast.uuid }],
  };
  assert.equal(
    damageTakenGrantAllowed({ item: feast }, afflicted, "on_damage_taken", "grant_advantage"),
    true,
  );
});
