import { strict as assert } from "node:assert";
import { test } from "node:test";

import { MODULE_ID } from "../src/constants";
import {
  __masteriesInternals,
  applyCleaveCut,
  peekCleaveCut,
  trimCleaveDamage,
} from "../src/rules/masteries";
import { masteryOf } from "../src/rules/cards";
import {
  abilityKeyOf,
  canUseWeaponMastery,
  cleaveDamageAdjustment,
  isHitMastery,
  isMeleeAttack,
  movementKeysOf,
  slowAmount,
  toppleDc,
  usableMastery,
} from "../src/system/dnd5e-masteries";

test("Topple DC is 8 + attack ability modifier + PB, and refuses a missing number", () => {
  assert.equal(toppleDc(4, 3), 15);
  assert.equal(toppleDc(-1, 2), 9);
  assert.equal(toppleDc(Number.NaN, 3), null);
  assert.equal(toppleDc(4, Number.NaN), null);
});

test("Slow is −10 and writes every listed speed, not walk alone", () => {
  assert.equal(slowAmount(), -10);
  assert.deepEqual(movementKeysOf({ system: { attributes: { movement: { walk: 30, fly: 60 } } } }), [
    "walk",
    "fly",
  ]);
  assert.deepEqual(movementKeysOf({ system: { attributes: { movement: { walk: 0, swim: 40 } } } }), [
    "swim",
  ]);
  assert.deepEqual(movementKeysOf({ system: { attributes: { movement: {} } } }), ["walk"]);
});

test("Cleave drops a positive ability modifier and keeps a negative one", () => {
  assert.equal(cleaveDamageAdjustment(4), 4);
  assert.equal(cleaveDamageAdjustment(0), 0);
  assert.equal(cleaveDamageAdjustment(-1), 0);
  assert.equal(cleaveDamageAdjustment(Number.NaN), 0);
});

test("Cleave extra-attack trim subtracts the pending cut from the first part only", () => {
  const { cleavePending } = __masteriesInternals();
  cleavePending.clear();
  const actor = { uuid: "Actor.fighter" };
  const parts = [
    { value: 12, type: "slashing", properties: new Set<string>() },
    { value: 3, type: "fire", properties: new Set<string>() },
  ];
  assert.deepEqual(trimCleaveDamage(actor, parts), parts);
  cleavePending.set("Actor.fighter", { cut: 4, at: Date.now() });
  assert.deepEqual(trimCleaveDamage(actor, parts), [
    { value: 8, type: "slashing", properties: new Set<string>() },
    { value: 3, type: "fire", properties: new Set<string>() },
  ]);
  assert.equal(cleavePending.has("Actor.fighter"), false);
});

test("peeking a Cleave cut does not consume it, so Apply still sees the flag", () => {
  const { cleavePending } = __masteriesInternals();
  cleavePending.clear();
  const actor = { uuid: "Actor.fighter" };
  const card = { flags: { [MODULE_ID]: { cleaveCut: 4 } } };
  assert.equal(peekCleaveCut(actor, card), 4);
  assert.equal(peekCleaveCut(actor, card), 4);
  cleavePending.set("Actor.fighter", { cut: 3, at: Date.now() });
  assert.equal(peekCleaveCut(actor), 3);
  assert.equal(cleavePending.has("Actor.fighter"), true);
  const parts = [{ value: 12, type: "slashing", properties: new Set<string>() }];
  assert.deepEqual(applyCleaveCut(parts, 3), [
    { value: 9, type: "slashing", properties: new Set<string>() },
  ]);
  assert.equal(parts[0].value, 12);
});

test("preCalculateDamage subtracts a stamped Cleave cut in place", () => {
  const { cutCleaveOnApply } = __masteriesInternals();
  const damages = [{ value: 12, type: "slashing" }];
  cutCleaveOnApply(damages, {
    originatingMessage: { flags: { [MODULE_ID]: { cleaveCut: 4 } }, speaker: {} },
  });
  assert.equal(damages[0].value, 8);
});

test("an empty attack type is melee; only an explicit ranged type is not", () => {
  assert.equal(isMeleeAttack({}), true);
  assert.equal(isMeleeAttack({ attack: { type: { value: "" } } }), true);
  assert.equal(isMeleeAttack({ attack: { type: { value: "melee" } } }), true);
  assert.equal(isMeleeAttack({ attack: { type: { value: "ranged" } } }), false);
  assert.equal(isMeleeAttack({}, { system: { actionType: "rwak" } }), false);
});

test("Sap Topple Cleave are hit masteries; Slow and Vex are not", () => {
  assert.equal(isHitMastery("sap"), true);
  assert.equal(isHitMastery("topple"), true);
  assert.equal(isHitMastery("cleave"), true);
  assert.equal(isHitMastery("slow"), false);
  assert.equal(isHitMastery("vex"), false);
});

test("the attack ability prefers the activity over the item", () => {
  assert.equal(abilityKeyOf({ ability: "dex" }, { system: { ability: "str" } }), "dex");
  assert.equal(abilityKeyOf({}, { system: { ability: "str" } }), "str");
  assert.equal(abilityKeyOf({}, {}), "str");
});

function staff(mastery = "topple", base = "quarterstaff") {
  return { system: { mastery, type: { baseItem: base } } };
}

function monk(masteries: string[] = []) {
  return {
    type: "character",
    system: {
      traits: {
        weaponProf: {
          value: new Set(["sim"]),
          mastery: { value: new Set(masteries), bonus: new Set<string>() },
        },
      },
    },
  };
}

test("Weapon Mastery is a feature, not a tag on the item", () => {
  // RAW: "To use this property, you must have a feature that lets you use it."
  // Proficiency with simple weapons is not that feature — the Monk's quarterstaff,
  // shortbow, dagger and spear all carry a mastery string.
  const untrained = monk();
  assert.equal(canUseWeaponMastery(untrained, staff("topple"), "topple"), false);
  assert.equal(canUseWeaponMastery(untrained, staff("vex", "shortbow"), "vex"), false);
  assert.equal(canUseWeaponMastery(untrained, staff("nick", "dagger"), "nick"), false);
  assert.equal(canUseWeaponMastery(untrained, staff("sap", "spear"), "sap"), false);
  assert.equal(usableMastery(untrained, staff()), "");

  const fighter = monk(["quarterstaff"]);
  assert.equal(canUseWeaponMastery(fighter, staff("topple"), "topple"), true);
  assert.equal(usableMastery(fighter, staff()), "topple");
  assert.equal(canUseWeaponMastery(fighter, staff("vex", "shortbow"), "vex"), false);
});

test("a leftover roll.mastery flag still needs the wielder's feature", () => {
  const card = { flags: { dnd5e: { roll: { mastery: "topple" } } } };
  assert.equal(masteryOf(card, staff(), monk()), "");
  assert.equal(masteryOf(card, staff(), monk(["quarterstaff"])), "topple");
});

test("Weapon Master extras only apply on a weapon the wielder already masters", () => {
  const feat = monk(["quarterstaff"]);
  feat.system.traits.weaponProf.mastery.bonus = new Set(["sap"]);
  assert.equal(canUseWeaponMastery(feat, staff("topple"), "sap"), true);
  assert.equal(canUseWeaponMastery(feat, staff("vex", "shortbow"), "sap"), false);
});

test("an NPC without a mastery list uses the printed tag; an empty list is a no", () => {
  const bandit = { type: "npc", system: { traits: {} } };
  assert.equal(canUseWeaponMastery(bandit, staff("nick", "scimitar"), "nick"), true);
  assert.equal(canUseWeaponMastery(bandit, staff("nick", "scimitar"), "topple"), false);

  const listed = {
    type: "npc",
    system: { traits: { weaponProf: { mastery: { value: new Set<string>() } } } },
  };
  assert.equal(canUseWeaponMastery(listed, staff("nick", "scimitar"), "nick"), false);
});

test("opposite dispositions are hostile; SECRET is never a Cleave target", () => {
  const { isHostilePair } = __masteriesInternals();
  assert.equal(isHostilePair({ disposition: 1 }, { disposition: -1 }), true);
  assert.equal(isHostilePair({ disposition: 1 }, { disposition: 1 }), false);
  assert.equal(isHostilePair({ disposition: 0 }, { disposition: -1 }), true);
  assert.equal(isHostilePair({ disposition: 1 }, { disposition: -2 }), false);
});
