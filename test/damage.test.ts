import { strict as assert } from "node:assert";
import { beforeEach, test } from "node:test";

import {
  damageOnSave,
  damageParts,
  isHealing,
  readCheck,
  readHits,
  readSave,
  saveMultiplier,
} from "../src/rules/cards";

// Reading a chat card is the load-bearing half of applying damage automatically, and every one of these
// facts was read out of dnd5e 5.3.3 rather than assumed. They are pinned here because getting any of them
// wrong subtracts the wrong number of hit points from the wrong creature, which is both the most visible
// failure this module can have and the hardest to notice after the fact.

/** A token registered so `fromUuidSync` can find its actor, as the target records do. */
const world = new Map<string, any>();

function targetActor(uuid: string, name: string) {
  const doc = { id: `${name}-token`, name };
  world.set(uuid, { name, token: doc, getActiveTokens: () => [] });
  return doc;
}

/** An attack message: one d20 roll, plus the target descriptors dnd5e writes beside it. */
function attack(total: number, targets: Array<{ name: string; ac: number | null }>, extra = {}) {
  return {
    rolls: [{ total, isCritical: false, isFumble: false, ...extra }],
    flags: {
      dnd5e: {
        roll: { type: "attack" },
        targets: targets.map((t) => ({ name: t.name, ac: t.ac, uuid: `Actor.${t.name}` })),
      },
    },
  };
}

beforeEach(() => {
  world.clear();
  (globalThis as any).fromUuidSync = (uuid: string) => world.get(uuid) ?? null;
  // Only the healing types matter to any of this; a type absent from the map is damage.
  (globalThis as any).CONFIG = { DND5E: { healingTypes: { healing: {}, temphp: {} } } };
});

test("an attack that meets the AC hits, and one below it misses", () => {
  targetActor("Actor.Goblin", "Goblin");
  targetActor("Actor.Orc", "Orc");
  const reading = readHits(
    attack(15, [
      { name: "Goblin", ac: 15 },
      { name: "Orc", ac: 16 },
    ]),
  );
  assert.equal(reading.hits.length, 1);
  assert.equal(reading.hits[0].name, "Goblin");
  assert.equal(reading.missed.length, 1);
  assert.equal(reading.unresolved.length, 0);
});

test("a critical hits whatever the AC says, and a fumble misses whatever the total says", () => {
  targetActor("Actor.Goblin", "Goblin");
  const crit = readHits(attack(3, [{ name: "Goblin", ac: 30 }], { isCritical: true }));
  assert.equal(crit.hits.length, 1);

  const fumble = readHits(attack(40, [{ name: "Goblin", ac: 5 }], { isFumble: true }));
  assert.equal(fumble.missed.length, 1);
  assert.equal(fumble.hits.length, 0);
});

test("an unreadable AC is unresolved rather than a hit, which diverges from dnd5e's renderer", () => {
  // The system's own formula scores a null AC as a hit, because `total < null` coerces to `total < 0`.
  // That is fine for a label a human reads and not fine for something that subtracts hit points.
  targetActor("Actor.Ghost", "Ghost");
  const reading = readHits(attack(20, [{ name: "Ghost", ac: null }]));
  assert.equal(reading.hits.length, 0);
  assert.equal(reading.missed.length, 0);
  assert.equal(reading.unresolved.length, 1);
});

test("a target whose token cannot be identified is unresolved, never guessed at", () => {
  const reading = readHits(attack(20, [{ name: "Twin", ac: 10 }]));
  assert.equal(reading.hits.length, 0);
  assert.equal(reading.unresolved.length, 1);
});

test("a save is judged against the DC on the roll, and no DC means no verdict", () => {
  const made = readSave({
    rolls: [{ total: 14, options: { target: 14 } }],
    flags: { dnd5e: { roll: { type: "save", ability: "dex" } } },
  });
  assert.equal(made.success, true, "a save meets its DC on equal");
  assert.equal(made.ability, "dex");
  assert.equal(made.dc, 14);

  const failed = readSave({ rolls: [{ total: 13, options: { target: 14 } }], flags: {} });
  assert.equal(failed.success, false);

  // `BasicRoll#isSuccess` returns false here rather than undefined, which would read as a failed save and
  // cost a creature its hit points. Null is the only honest answer.
  const unjudgeable = readSave({ rolls: [{ total: 19, options: {} }], flags: {} });
  assert.equal(unjudgeable.success, null);
});

test("a check is judged against the DC on the roll, and no DC means no verdict", () => {
  const made = readCheck({
    rolls: [{ total: 14, options: { target: 14 } }],
    flags: { dnd5e: { roll: { type: "skill", skillId: "ste", ability: "dex" } } },
  });
  assert.equal(made.success, true, "a check meets its DC on equal");
  assert.equal(made.skill, "ste");
  assert.equal(made.ability, "dex");
  assert.equal(made.dc, 14);

  const failed = readCheck({
    rolls: [{ total: 13, options: { target: 14 } }],
    flags: { dnd5e: { roll: { type: "ability", ability: "str" } } },
  });
  assert.equal(failed.success, false);
  assert.equal(failed.ability, "str");

  // Same hole as a save: BasicRoll#isSuccess is false with no DC. Null, or Inspiration fires on every
  // uncontested Athletics check the table ever rolls.
  const unjudgeable = readCheck({ rolls: [{ total: 19, options: {} }], flags: {} });
  assert.equal(unjudgeable.success, null);
  assert.equal(unjudgeable.dc, null);
});

test("what a made save is worth comes off the damage message, defaulting to half", () => {
  assert.equal(damageOnSave({ flags: { dnd5e: { roll: { damageOnSave: "none" } } } }), "none");
  assert.equal(damageOnSave({ flags: { dnd5e: { roll: { damageOnSave: "full" } } } }), "full");
  assert.equal(damageOnSave({ flags: { dnd5e: {} } }), "half");

  assert.equal(saveMultiplier("half"), 0.5);
  assert.equal(saveMultiplier("none"), 0);
  assert.equal(saveMultiplier("full"), 1);
  assert.equal(saveMultiplier("something dnd5e adds later"), 0.5);
});

test("healing arrives as a negative value, the way the damage tray sends it", () => {
  const parts = damageParts({
    rolls: [{ total: 7, options: { type: "healing" } }],
  });
  assert.equal(parts.length, 1);
  assert.equal(parts[0].value, -7);
  assert.equal(isHealing(parts), true);
});

test("a damage roll's properties travel with it, because resistance is read from them", () => {
  const parts = damageParts({
    rolls: [
      { total: 6, options: { type: "slashing", properties: ["mgc"] } },
      { total: 4, options: { type: "fire" } },
    ],
  });
  assert.equal(parts.length, 2);
  assert.equal(parts[0].properties.has("mgc"), true);
  assert.equal(isHealing(parts), false, "mixed damage is not healing");
});
