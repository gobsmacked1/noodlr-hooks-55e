import test from "node:test";
import assert from "node:assert/strict";

import { isIncapacitated, INCAPACITATED_BY } from "../src/system/dnd5e-conditions.js";
import { isDown, isUnableToAct, skipReason } from "../src/tactics/skip.js";

function actor(statuses: string[] = [], hp?: number) {
  return {
    statuses: new Set(statuses),
    effects: [],
    system: hp === undefined ? {} : { attributes: { hp: { value: hp, max: 40 } } },
  };
}

function combatant(over: { statuses?: string[]; hp?: number; isDefeated?: boolean } = {}) {
  return { isDefeated: over.isDefeated ?? false, actor: actor(over.statuses, over.hp) };
}

test("paralyzed, stunned, unconscious and petrified are Incapacitated even without the nest", () => {
  for (const status of INCAPACITATED_BY) {
    assert.equal(isIncapacitated(actor([status])), true, status);
  }
});

test("grappled, restrained and prone still get a turn", () => {
  for (const status of ["grappled", "restrained", "prone"]) {
    assert.equal(isIncapacitated(actor([status])), false, status);
    assert.equal(isUnableToAct(combatant({ statuses: [status], hp: 20 })), false, status);
  }
});

test("a healthy combatant with no status is played", () => {
  const c = combatant({ hp: 20 });
  assert.equal(isUnableToAct(c), false);
  assert.equal(skipReason(c), null);
});

test("dead or defeated is skipped as out of the fight, not as incapacitated", () => {
  assert.equal(skipReason(combatant({ isDefeated: true, hp: 20 })), "out of the fight");
  assert.equal(skipReason(combatant({ hp: 0 })), "out of the fight");
  assert.equal(isDown(combatant({ hp: 0 })), true);
});

test("Hold Person's paralyzed Assassin is skipped, including when only paralyzed landed", () => {
  const c = combatant({ statuses: ["paralyzed"], hp: 20 });
  assert.equal(isUnableToAct(c), true);
  assert.equal(skipReason(c), "incapacitated");
});

test("defeated wins the reason when a corpse is also incapacitated", () => {
  assert.equal(skipReason(combatant({ statuses: ["unconscious"], hp: 0 })), "out of the fight");
});
