import { strict as assert } from "node:assert";
import { beforeEach, test } from "node:test";

import {
  attackModeOf,
  cardUpdateIsRelevant,
  isResisted,
  isSaveDamage,
  isUsageCard,
  originatingId,
  originatingMessageData,
  rollType,
  targetsOf,
} from "../src/rules/cards";

beforeEach(() => {
  (globalThis as any).game = { system: { id: "dnd5e", version: "6.0.1" } };
});

test("rollType reads message.type and the 6.0 subtypes", () => {
  assert.equal(rollType({ type: "attack" }), "attack");
  assert.equal(rollType({ type: "save", system: { type: "death" } }), "death");
  assert.equal(rollType({ type: "save", system: { type: "concentration" } }), "concentration");
  assert.equal(rollType({ type: "check", system: { skill: "ste" } }), "skill");
  assert.equal(rollType({ type: "healing" }), "healing");
  assert.equal(rollType({ flags: { dnd5e: { roll: { type: "save" } } } }), "");
});

test("isUsageCard is type usage only", () => {
  assert.equal(isUsageCard({ type: "usage", system: { activity: { type: "save" } } }), true);
  assert.equal(isUsageCard({ flags: { dnd5e: { activity: { id: "abc" } } } }), false);
  assert.equal(isUsageCard({ type: "attack" }), false);
});

test("isResisted reads system.resisted or the forceSuccess getter", () => {
  assert.equal(isResisted({ flags: { dnd5e: { roll: { forceSuccess: true } } } }), false);
  assert.equal(isResisted({ type: "save", system: { resisted: true } }), true);
  assert.equal(isResisted({ type: "save", system: { forceSuccess: true } }), true);
  assert.equal(isResisted({ type: "save", system: { ability: "wis" } }), false);
});

test("targetsOf reads system.targets and ignores leftover flags", () => {
  const six = targetsOf({
    type: "attack",
    system: { targets: [{ name: "Monk", token: "Scene.s.Token.t", actor: "Actor.a", ac: 16 }] },
    flags: { dnd5e: { targets: [{ name: "Stale", uuid: "Actor.stale", ac: 10 }] } },
  });
  assert.equal(six.length, 1);
  assert.equal(six[0].uuid, "Scene.s.Token.t");
  assert.equal(six[0].ac, 16);

  const leftover = targetsOf({
    flags: { dnd5e: { targets: [{ name: "Monk", uuid: "Actor.monk", ac: 16 }] } },
  });
  assert.equal(leftover.length, 0);
});

test("originatingId and originatingMessageData write system.origin only", () => {
  assert.equal(originatingId({ flags: { dnd5e: { originatingMessage: "msg5" } } }), "");
  assert.equal(originatingId({ system: { origin: "msg6" } }), "msg6");
  assert.equal(originatingId({ system: { origin: { id: "msgObj" } } }), "msgObj");

  const stamped = originatingMessageData("usage-1");
  assert.equal(stamped.system.origin, "usage-1");
  assert.equal((stamped as { flags?: unknown }).flags, undefined);
});

test("cardUpdateIsRelevant treats a system write as a verdict change", () => {
  assert.equal(cardUpdateIsRelevant(null), true);
  assert.equal(cardUpdateIsRelevant({ flags: { dnd5e: { roll: {} } } }), false);
  assert.equal(cardUpdateIsRelevant({ system: { resisted: true } }), true);
  assert.equal(cardUpdateIsRelevant({ name: "renamed" }), false);
});

test("isSaveDamage requires a stamped onSave, not the half default", () => {
  assert.equal(isSaveDamage({ type: "damage", system: { onSave: "half" } }), true);
  assert.equal(
    isSaveDamage({ flags: { dnd5e: { roll: { type: "damage", damageOnSave: "half" } } } }),
    false,
  );
  assert.equal(isSaveDamage({ type: "damage" }), false);
});

test("attackModeOf reads system.mode", () => {
  assert.equal(attackModeOf({ flags: { dnd5e: { roll: { attackMode: "thrown" } } } }), "");
  assert.equal(attackModeOf({ type: "attack", system: { mode: "ranged" } }), "ranged");
});
