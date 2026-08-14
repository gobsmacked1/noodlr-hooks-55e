import { strict as assert } from "node:assert";
import { beforeEach, test } from "node:test";

import { readSave } from "../src/rules/cards";
import { worthAsking } from "../src/rules/legendary";
import { canResist, legendaryResistances } from "../src/system/dnd5e-legendary";

// Three things are pinned here, and each of them is a way this feature can fail silently rather than loudly:
//
//   1. A SUCCESS SOMEBODY PAID FOR IS A SUCCESS. `forceSuccess` is the flag dnd5e's own Resist button
//      writes, and it is read by that system's renderer and by nothing else — `BasicRoll#isSuccess` is
//      still the arithmetic. So a reader that trusts the arithmetic applies full damage on the one roll of
//      the evening the GM intervened in, and the card beside it says "Resisted".
//   2. WHEN THE GM IS WORTH INTERRUPTING. A prompt on every failed save teaches a GM to dismiss prompts,
//      and then the one that mattered gets dismissed too. The generous-looking version — always ask — is
//      the one that makes the feature useless.
//   3. THAT A PLAYER CHARACTER HAS NOTHING TO SPEND. `resources.legres` is a field on the NPC data model
//      only, so the absence of the field is the test rather than the sheet type.

beforeEach(() => {
  (globalThis as any).game = { system: { id: "dnd5e" } };
});

/** A save message as it appears in chat: a d20 total, a DC on the roll, and the flags around it. */
function save(total: number, dc: number | null, roll: Record<string, unknown> = {}) {
  return {
    rolls: [{ total, options: dc === null ? {} : { target: dc } }],
    flags: { dnd5e: { roll: { type: "save", ability: "wis", ...roll } } },
  };
}

/* -------------------------------------------- */
/*  Reading a bought success                     */
/* -------------------------------------------- */

test("a save is judged against the DC on the roll", () => {
  assert.equal(readSave(save(18, 15)).success, true);
  assert.equal(readSave(save(9, 15)).success, false);
  assert.equal(readSave(save(9, 15)).forced, false);
});

test("no DC means cannot say, which is not the same as failed", () => {
  assert.equal(readSave(save(9, null)).success, null);
});

test("forceSuccess outranks the arithmetic, so a spent resistance is not overruled", () => {
  const resisted = readSave(save(4, 20, { forceSuccess: true }));
  assert.equal(resisted.success, true);
  assert.equal(resisted.forced, true);
});

test("a bought success survives an unreadable DC, because somebody paid for it explicitly", () => {
  assert.equal(readSave(save(4, null, { forceSuccess: true })).success, true);
});

/* -------------------------------------------- */
/*  Whether the GM is worth interrupting         */
/* -------------------------------------------- */

/** A creature with hit points and, optionally, resistances left. */
function creature(hp: number, legres?: { max: number; value: number }) {
  return {
    system: {
      attributes: { hp: { value: hp } },
      resources: legres ? { legres } : {},
    },
  };
}

test("a failure that is not damage is always worth asking about", () => {
  // Banishment on a dragon: no number to weigh, and the whole reason resistances exist.
  assert.equal(worthAsking(creature(300), null), true);
});

test("damage worth a fifth of what is left is asked about; less is not", () => {
  const lich = creature(135);
  assert.equal(worthAsking(lich, 27), true); // exactly a fifth
  assert.equal(worthAsking(lich, 60), true);
  assert.equal(worthAsking(lich, 9), false); // a Firebolt. Do not interrupt the GM for this.
});

test("damage that would drop the creature is asked about whatever the fraction says", () => {
  assert.equal(worthAsking(creature(20), 24), true);
});

test("a save that changes nothing about the damage is not worth asking about at zero stake", () => {
  assert.equal(worthAsking(creature(200), 0), false);
});

test("an unreadable sheet is asked about, because the cost of being wrong is one prompt", () => {
  assert.equal(worthAsking({}, 5), true);
});

/* -------------------------------------------- */
/*  Who has any                                  */
/* -------------------------------------------- */

test("resistances are read from the pair, and a spent-out creature cannot resist", () => {
  assert.deepEqual(legendaryResistances(creature(300, { max: 3, value: 2 })), {
    value: 2,
    max: 3,
  });
  assert.equal(canResist(creature(300, { max: 3, value: 2 })), true);
  assert.equal(canResist(creature(300, { max: 3, value: 0 })), false);
});

test("a character has nothing to spend, because the field is not on its data model", () => {
  assert.equal(legendaryResistances(creature(52)), null);
  assert.equal(canResist(creature(52)), false);
});
