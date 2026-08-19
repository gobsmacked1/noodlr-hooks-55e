import test from "node:test";
import assert from "node:assert/strict";

import {
  applyDamageCritDefault,
  damageActivityMayCrit,
  markAttackCritical,
  shouldForceCrit,
} from "../src/rules/crit.js";
import { critOnHitWithin5 } from "../src/system/dnd5e-conditions.js";

function actor(statuses: string[]) {
  return { statuses: new Set(statuses), effects: [] };
}

test("Incapacitated, Stunned and Petrified are not the auto-crit statuses", () => {
  for (const status of ["incapacitated", "stunned", "petrified", "restrained", "prone"]) {
    assert.equal(critOnHitWithin5(actor([status])), null, status);
  }
});

test("Paralyzed and Unconscious are the auto-crit statuses", () => {
  assert.equal(critOnHitWithin5(actor(["paralyzed"])), "paralyzed");
  assert.equal(critOnHitWithin5(actor(["unconscious"])), "unconscious");
});

test("a hit within 5 feet of a paralyzed creature is a forced crit", () => {
  assert.equal(
    shouldForceCrit({ reason: "paralyzed", distance: 5, isFumble: false, total: 14, ac: 13 }),
    true,
  );
});

test("more than 5 feet is not a forced crit, even on a paralyzed target", () => {
  assert.equal(
    shouldForceCrit({ reason: "paralyzed", distance: 10, isFumble: false, total: 18, ac: 13 }),
    false,
  );
});

test("a miss, a fumble, or an unreadable AC is never a forced crit", () => {
  assert.equal(
    shouldForceCrit({ reason: "paralyzed", distance: 5, isFumble: false, total: 10, ac: 16 }),
    false,
  );
  assert.equal(
    shouldForceCrit({ reason: "paralyzed", distance: 5, isFumble: true, total: 14, ac: 13 }),
    false,
  );
  assert.equal(
    shouldForceCrit({ reason: "paralyzed", distance: 5, isFumble: false, total: 14, ac: null }),
    false,
  );
  assert.equal(
    shouldForceCrit({ reason: null, distance: 5, isFumble: false, total: 14, ac: 13 }),
    false,
  );
});

test("only an Attack activity's damage dialog may default to critical", () => {
  assert.equal(damageActivityMayCrit("attack"), true);
  assert.equal(damageActivityMayCrit("damage"), false);
  assert.equal(damageActivityMayCrit("heal"), false);
  assert.equal(damageActivityMayCrit("save"), false);
  assert.equal(damageActivityMayCrit(undefined), false);
});

test("markAttackCritical uses the die total, never 1", () => {
  const roll = {
    total: 14,
    d20: { total: 9, options: { criticalSuccess: 20 } },
    options: { criticalSuccess: 20 },
  };
  assert.equal(markAttackCritical(roll), true);
  assert.equal(roll.d20.options.criticalSuccess, 9);
  assert.equal(roll.options.criticalSuccess, 9);
});

test("applyDamageCritDefault overwrites a stored false so the dialog offers Critical", () => {
  const config = { isCritical: false, rolls: [{ options: { isCritical: false } }] };
  const dialog = { options: {} as { defaultButton?: string } };
  applyDamageCritDefault(config, dialog);
  assert.equal(config.isCritical, true);
  assert.equal(config.rolls[0].options.isCritical, true);
  assert.equal(dialog.options.defaultButton, "critical");
});
