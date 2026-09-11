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
  (globalThis as any).game = { system: { id: "dnd5e", version: "5.3.3" } };
});

test("rollType prefers the 5.3.3 flag, then message.type", () => {
  assert.equal(rollType({ flags: { dnd5e: { roll: { type: "save" } } } }), "save");
  assert.equal(rollType({ type: "attack" }), "attack");
  assert.equal(rollType({ type: "save", system: { type: "death" } }), "death");
  assert.equal(rollType({ type: "save", system: { type: "concentration" } }), "concentration");
  assert.equal(rollType({ type: "check", system: { skill: "ste" } }), "skill");
  assert.equal(rollType({ type: "healing" }), "healing");
});

test("isUsageCard accepts a 6.0 usage type and the 5.3.3 no-type-plus-activity shape", () => {
  assert.equal(isUsageCard({ type: "usage", system: { activity: { type: "save" } } }), true);
  assert.equal(isUsageCard({ flags: { dnd5e: { activity: { id: "abc" } } } }), true);
  assert.equal(isUsageCard({ type: "attack" }), false);
});

test("isResisted reads forceSuccess or system.resisted", () => {
  assert.equal(isResisted({ flags: { dnd5e: { roll: { forceSuccess: true } } } }), true);
  assert.equal(isResisted({ type: "save", system: { resisted: true } }), true);
  assert.equal(isResisted({ type: "save", system: { forceSuccess: true } }), true);
  assert.equal(isResisted({ type: "save", system: { ability: "wis" } }), false);
});

test("targetsOf prefers system.targets token, then actor, then the 5.3.3 uuid", () => {
  const six = targetsOf({
    type: "attack",
    system: { targets: [{ name: "Monk", token: "Scene.s.Token.t", actor: "Actor.a", ac: 16 }] },
    flags: { dnd5e: { targets: [{ name: "Stale", uuid: "Actor.stale", ac: 10 }] } },
  });
  assert.equal(six.length, 1);
  assert.equal(six[0].uuid, "Scene.s.Token.t");
  assert.equal(six[0].ac, 16);

  const five = targetsOf({
    flags: { dnd5e: { targets: [{ name: "Monk", uuid: "Actor.monk", ac: 16 }] } },
  });
  assert.equal(five[0].uuid, "Actor.monk");
});

test("originatingId and originatingMessageData dual-write on 6.0", () => {
  assert.equal(originatingId({ flags: { dnd5e: { originatingMessage: "msg5" } } }), "msg5");
  assert.equal(originatingId({ system: { origin: "msg6" } }), "msg6");
  assert.equal(originatingId({ system: { origin: { id: "msgObj" } } }), "msgObj");

  (globalThis as any).game.system.version = "6.0.0";
  const six = originatingMessageData("usage-1");
  assert.equal(six.flags.dnd5e.originatingMessage, "usage-1");
  assert.equal(six.system?.origin, "usage-1");

  (globalThis as any).game.system.version = "5.3.3";
  const five = originatingMessageData("usage-1");
  assert.equal(five.flags.dnd5e.originatingMessage, "usage-1");
  assert.equal(five.system, undefined);
});

test("cardUpdateIsRelevant treats a system write as a verdict change", () => {
  assert.equal(cardUpdateIsRelevant(null), true);
  assert.equal(cardUpdateIsRelevant({ flags: { dnd5e: { roll: {} } } }), true);
  assert.equal(cardUpdateIsRelevant({ system: { resisted: true } }), true);
  assert.equal(cardUpdateIsRelevant({ name: "renamed" }), false);
});

test("isSaveDamage requires a stamped onSave, not the half default", () => {
  assert.equal(isSaveDamage({ type: "damage", system: { onSave: "half" } }), true);
  assert.equal(isSaveDamage({ flags: { dnd5e: { roll: { type: "damage", damageOnSave: "half" } } } }), true);
  assert.equal(isSaveDamage({ type: "damage" }), false);
});

test("attackModeOf reads the flag, then system.mode", () => {
  assert.equal(attackModeOf({ flags: { dnd5e: { roll: { attackMode: "thrown" } } } }), "thrown");
  assert.equal(attackModeOf({ type: "attack", system: { mode: "ranged" } }), "ranged");
});
