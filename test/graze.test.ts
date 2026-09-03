import { strict as assert } from "node:assert";
import { test } from "node:test";

import { grazeDamage } from "../src/system/dnd5e-graze";

// Graze is the one mastery that makes the damage gate's default answer wrong, and the arithmetic it
// wants is deliberately unlike every other damage source in the game: the ability modifier alone, no
// dice, no proficiency, no magic bonus. These pin that, because the tempting "fix" when somebody
// reports a Greatsword doing nothing on a miss is to unlock the Damage button — which would roll 2d6
// plus the modifier, i.e. between two and five times what the rule allows.

function attack(mastery: string) {
  return { flags: { dnd5e: { roll: { mastery } } } };
}

function greatsword() {
  return { system: { type: { baseItem: "greatsword" }, mastery: "graze" } };
}

function activity(mod: number, type = "slashing", ability = "str") {
  return {
    ability,
    actor: {
      type: "character",
      system: {
        abilities: { [ability]: { mod } },
        traits: { weaponProf: { mastery: { value: new Set(["greatsword"]) } } },
      },
    },
    damage: { parts: [{ types: new Set([type]) }] },
  };
}

test("graze deals the ability modifier, in the weapon's own damage type", () => {
  const graze = grazeDamage(attack("graze"), greatsword(), activity(4));
  assert.deepEqual(graze, { amount: 4, type: "slashing" });
});

test("no mastery, or a different one, deals nothing", () => {
  assert.equal(grazeDamage(attack(""), greatsword(), activity(4)), null);
  assert.equal(grazeDamage(attack("topple"), greatsword(), activity(4)), null);
});

test("a leftover graze flag does nothing when the wielder has no Weapon Mastery for it", () => {
  const monk = activity(4);
  monk.actor.system.traits.weaponProf.mastery.value = new Set();
  assert.equal(grazeDamage(attack("graze"), greatsword(), monk), null);
});

// A real case — a Strength 10 fighter with a Greatsword — and the rule says nothing about it. A
// zero-damage entry would post "takes 0 bludgeoning" on every miss for the rest of the campaign.
test("a modifier of zero or less deals nothing rather than nothing loudly", () => {
  assert.equal(grazeDamage(attack("graze"), greatsword(), activity(0)), null);
  assert.equal(grazeDamage(attack("graze"), greatsword(), activity(-1)), null);
});

// Finesse: dnd5e's `get ability()` has already picked the better of Strength and Dexterity by the time
// we read it, so this reads whichever key it names rather than assuming Strength.
test("the modifier comes from the ability the attack actually used", () => {
  const graze = grazeDamage(attack("graze"), greatsword(), activity(3, "piercing", "dex"));
  assert.deepEqual(graze, { amount: 3, type: "piercing" });
});

// The item is the fallback for a weapon whose activity states no parts of its own. `prepareFinalData`
// normally unshifts the base part into the activity, so this is the unprepared or unusual case.
test("the item's base damage type is read when the activity states none", () => {
  const item = {
    system: {
      type: { baseItem: "greatsword" },
      mastery: "graze",
      damage: { base: { types: new Set(["bludgeoning"]) } },
    },
  };
  const bare = activity(2);
  bare.damage = { parts: [] };
  assert.deepEqual(grazeDamage(attack("graze"), item, bare), { amount: 2, type: "bludgeoning" });
});

// An unreadable type is "" and not a guess: `Actor5e#applyDamage` treats an unknown type as untyped,
// which skips resistance rather than inventing an immunity. Naming a type here would be the one error
// that silently changes the number.
test("an unreadable damage type is left empty rather than guessed", () => {
  const bare = activity(2);
  bare.damage = { parts: [] };
  assert.deepEqual(grazeDamage(attack("graze"), greatsword(), bare), { amount: 2, type: "" });
});

test("an attack with no readable ability deals nothing", () => {
  assert.equal(grazeDamage(attack("graze"), {}, { ability: null }), null);
});
