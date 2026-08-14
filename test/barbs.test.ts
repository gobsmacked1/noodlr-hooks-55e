import { strict as assert } from "node:assert";
import { beforeEach, test } from "node:test";

import { barbsReady, gambitsOwnsBarbs, isSilveryBarbs } from "../src/system/dnd5e-barbs";
import { rerollLower } from "../src/system/dnd5e-reroll";

// TWO THINGS ARE PINNED HERE, and they are the two that can be wrong without anything being reported.
//
//   1. THE ARITHMETIC OF MAKING A DIE WORSE. `rerollLower` rewrites an evaluated roll, and everything
//      downstream — whether the attack still hits, whether the save still makes its DC, whether a critical
//      is still a critical — reads the result rather than recomputing it. A total that is off by the
//      modifier, or a `results` array whose `active` flags are the wrong way round, produces a plausible
//      number and a card that agrees with itself. Nothing anywhere raises.
//   2. THE SPELL IS NOT IN ANY COMPENDIUM, so the recogniser is all there is. It is Strixhaven content,
//      which means every table's copy was imported or typed, so an anchored name match and the flag are
//      load-bearing in a way Counterspell's are not.
//
// Deliberately not tested here: who gets asked. That is `reactorsAgainst`, which Counterspell shares, and a
// second copy of those assertions would only pin the shared helper twice.

beforeEach(() => {
  (globalThis as any).game = { system: { id: "dnd5e" }, modules: new Map() };
  (globalThis as any).CONFIG = {
    DND5E: {
      spellcasting: {
        spell: { slots: true },
        pact: { slots: true },
        innate: { slots: false },
        atwill: { slots: false },
      },
    },
  };
});

/**
 * A minimal evaluated d20 roll, in the shape `rerollLower` reads and writes.
 *
 * `total` is deliberately independent of the die: that is what a modifier is, and conflating the two is the
 * mistake this file exists to catch.
 */
function message(die: number, total: number, options: Record<string, unknown> = {}) {
  const term = {
    faces: 20,
    total: die,
    options,
    results: [{ result: die, active: true }],
  };
  const roll = {
    total,
    terms: [term],
    toJSON: () => ({
      total,
      evaluated: true,
      terms: [
        {
          faces: 20,
          options,
          results: term.results.map((r) => ({ ...r })),
        },
      ],
    }),
  };
  const updates: any[] = [];
  return {
    doc: {
      id: "msg",
      rolls: [roll],
      update: async (data: any) => {
        updates.push(data);
      },
    },
    updates,
  };
}

/** Force the next d20 so the arithmetic is checkable rather than sampled. */
function nextD20(value: number): void {
  (globalThis as any).Roll = class {
    total = value;
    async evaluate() {
      return this;
    }
  };
}

/* -------------------------------------------- */
/*  Rerolling a die that has already landed      */
/* -------------------------------------------- */

test("a lower fresh die is kept and the modifier is preserved", async () => {
  // 18 on the die, +7 from somewhere, for 25. A fresh 4 keeps the +7: 11, not 4.
  nextD20(4);
  const { doc } = message(18, 25);
  const reroll = await rerollLower(doc);
  assert.ok(reroll);
  assert.equal(reroll?.was, 18);
  assert.equal(reroll?.rolled, 4);
  assert.equal(reroll?.kept, 4);
  assert.equal(reroll?.total, 11);
  assert.equal(reroll?.changed, true);
});

test("a higher fresh die changes nothing, and says so", async () => {
  // The spell has been cast and the slot is gone either way. What matters is that the caller is told the
  // roll stands rather than being handed a silently unchanged total it might read as a spoil.
  nextD20(20);
  const { doc } = message(11, 18);
  const reroll = await rerollLower(doc);
  assert.equal(reroll?.kept, 11);
  assert.equal(reroll?.total, 18);
  assert.equal(reroll?.changed, false);
});

test("the loser is struck through rather than deleted, and the winner is what the die sums", async () => {
  // This is the whole reason the patch is shaped like a disadvantage roll: `D20Die#total` sums its ACTIVE
  // results, so discarding the 19 is what makes a downstream `isCritical` come right with nothing telling it.
  nextD20(3);
  const { doc, updates } = message(19, 19);
  await rerollLower(doc);
  const results = updates[0]?.rolls?.[0]?.terms?.[0]?.results;
  assert.equal(results?.length, 2);
  assert.deepEqual(
    results.map((r: any) => [r.result, r.active === true]),
    [
      [19, false],
      [3, true],
    ],
  );
  assert.equal(updates[0]?.rolls?.[0]?.total, 3);
  assert.equal(updates[0]?.rolls?.[0]?.evaluated, true);
});

test("crit and fumble are read from the die's own thresholds, not from 20 and 1", async () => {
  // A Champion crits on 19. Hardcoding 20 here would report a critical as an ordinary hit, which on the
  // attack path is the difference between a reroll being pointless and being worth a slot.
  nextD20(19);
  const { doc } = message(20, 20, { criticalSuccess: 19, criticalFailure: 1 });
  const reroll = await rerollLower(doc);
  assert.equal(reroll?.kept, 19);
  assert.equal(reroll?.crit, true, "19 is still a critical for this creature");
  assert.equal(reroll?.fumble, false);
});

test("a roll with no critical threshold reports null rather than false", async () => {
  // `D20Die` treats a non-numeric threshold as "this roll has no critical", and a saving throw is exactly
  // that: a natural 20 on a save does not automatically succeed. Reporting false would invite a caller to
  // apply the attack rule to a save.
  nextD20(20);
  const { doc } = message(20, 24, {});
  const reroll = await rerollLower(doc);
  assert.equal(reroll?.crit, null);
  assert.equal(reroll?.fumble, null);
});

test("a roll with nothing rerollable is declined rather than guessed at", async () => {
  nextD20(1);
  assert.equal(await rerollLower({ rolls: [] }), null);
  assert.equal(
    await rerollLower({ rolls: [{ total: 12, terms: [{ faces: 6, total: 4, options: {} }] }] }),
    null,
    "a d6 is not a d20 test",
  );
});

test("an unwritable card still reports the arithmetic", async () => {
  // The slot has been spent by the time this is reached, so a failed update must not throw the reaction
  // away. What is lost is the card telling the truth, which is logged and not fatal.
  nextD20(2);
  const { doc } = message(15, 20);
  doc.update = async () => {
    throw new Error("no permission");
  };
  const reroll = await rerollLower(doc);
  assert.equal(reroll?.total, 7);
});

/* -------------------------------------------- */
/*  Recognising a spell nobody ships             */
/* -------------------------------------------- */

function barbs(extra: Record<string, unknown> = {}, name = "Silvery Barbs") {
  return { type: "spell", name, system: { level: 1, ...extra } };
}

test("the identifier is preferred, then the flag, then an anchored name", () => {
  assert.ok(isSilveryBarbs(barbs({ identifier: "silvery-barbs" })));
  assert.ok(isSilveryBarbs(barbs({}, " silvery barbs ")));
  assert.ok(
    isSilveryBarbs({
      type: "spell",
      name: "Whispered Doubt",
      flags: { "noodlr-hooks-55e": { silveryBarbs: true } },
      system: { level: 1 },
    }),
    "a renamed copy is what the flag is for",
  );
});

test("the name match is anchored, because 'barbs' is a plausible weapon", () => {
  assert.equal(isSilveryBarbs(barbs({}, "Barbed Spear")), false);
  assert.equal(isSilveryBarbs(barbs({}, "Silvery Barbs of Doom")), false);
  assert.equal(
    isSilveryBarbs({ type: "weapon", name: "Silvery Barbs", system: {} }),
    false,
    "only a spell can be the spell",
  );
});

test("a stated identifier is not overruled by the name", () => {
  // A world that deliberately re-identified the item has said what it is. Same ordering as the rider table.
  assert.equal(isSilveryBarbs(barbs({ identifier: "something-else" }, "Silvery Barbs")), false);
});

/* -------------------------------------------- */
/*  Whether the creature can cast it             */
/* -------------------------------------------- */

function caster(items: any[], spells: Record<string, unknown> = { spell1: { max: 2, value: 1 } }) {
  return { items, system: { spells } };
}

test("a first-level slot is enough, and an empty pool is not", () => {
  const ready = barbsReady(caster([barbs({ identifier: "silvery-barbs" })]));
  assert.ok(ready);
  assert.equal(ready?.range, 60, "the printed range is the fallback");

  assert.equal(barbsReady(caster([barbs({ identifier: "silvery-barbs" })], {})), null);
  assert.equal(
    barbsReady(caster([barbs({ identifier: "silvery-barbs" })], { spell1: { max: 2, value: 0 } })),
    null,
  );
});

test("a stated range on the item wins over the printed one", () => {
  const ready = barbsReady(
    caster([barbs({ identifier: "silvery-barbs", range: { value: 90 } })]),
  );
  assert.equal(ready?.range, 90);
});

test("an at-will caster has no pool to check", () => {
  // Same rule as Counterspell's: asked of the system's spellcasting config rather than assumed, so a
  // statblock's "at will: silvery barbs" is not refused for want of a resource it does not use.
  const ready = barbsReady(
    caster([barbs({ identifier: "silvery-barbs", method: "atwill" })], {}),
  );
  assert.ok(ready, "an at-will caster is ready with no slots at all");
});

/* -------------------------------------------- */
/*  Standing aside                               */
/* -------------------------------------------- */

function installed(...ids: string[]) {
  (globalThis as any).game.modules = new Map(ids.map((id) => [id, { active: true }]));
}

test("Gambit's owns this only where midi is there to carry it", () => {
  assert.equal(gambitsOwnsBarbs(), false, "neither installed");
  installed("gambits-premades");
  assert.equal(
    gambitsOwnsBarbs(),
    false,
    "its automation is entered from a midi Workflow, so alone it cannot fire",
  );
  installed("gambits-premades", "midi-qol");
  assert.equal(gambitsOwnsBarbs(), true);
});
