import { strict as assert } from "node:assert";
import { beforeEach, test } from "node:test";

import {
  DICE_MOD_SPECS,
  diceModTimeoutId,
  hasInspiration,
  inspirationFormula,
  isInspiredEffect,
  isStrBelow,
  matchesItem,
  modsAgainst,
  modsOn,
  specApplies,
  type DiceContext,
  type DiceModSpec,
} from "../src/system/dnd5e-dice-mods";
import {
  addRoll,
  addToTotal,
  replaceD20,
  rerollKeepNew,
  rerollLower,
  setTotal,
  subtractRoll,
} from "../src/system/dnd5e-reroll";

beforeEach(() => {
  (globalThis as any).game = { system: { id: "dnd5e" }, modules: new Map() };
});

function spec(id: string): DiceModSpec {
  const found = DICE_MOD_SPECS.find((row) => row.id === id);
  assert.ok(found, id);
  return found!;
}

function ctx(partial: Partial<DiceContext>): DiceContext {
  return {
    kind: "save",
    success: false,
    missed: false,
    ability: "",
    isSpellAttack: false,
    total: 8,
    strScore: 16,
    ...partial,
  };
}

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
        if (data.rolls?.[0]) {
          const json = data.rolls[0];
          roll.total = json.total;
          term.results = json.terms?.[0]?.results ?? term.results;
        }
      },
    },
    updates,
  };
}

function nextD20(value: number): void {
  (globalThis as any).Roll = class {
    total = value;
    async evaluate() {
      return this;
    }
  };
}

function actor(opts: {
  inspiration?: boolean;
  str?: number;
  fighter?: number;
  items?: any[];
  effects?: any[];
  scale?: unknown;
}) {
  return {
    system: {
      attributes: { inspiration: opts.inspiration === true },
      abilities: { str: { value: opts.str ?? 16 } },
      scale: opts.scale,
    },
    classes: opts.fighter ? { fighter: { system: { levels: opts.fighter } } } : {},
    items: opts.items ?? [],
    appliedEffects: opts.effects ?? [],
    effects: opts.effects ?? [],
  };
}

function item(name: string, identifier: string, extra: Record<string, unknown> = {}) {
  return {
    name,
    type: extra.type ?? "feat",
    system: { identifier, uses: extra.uses },
    flags: extra.flags ?? {},
  };
}

/* -------------------------------------------- */
/*  Discovery — identifier wins, Lucky is not Luck */
/* -------------------------------------------- */

test("indomitable does not match an item identified as indomitable-might", () => {
  const might = item("Indomitable Might", "indomitable-might");
  assert.equal(matchesItem(might, spec("indomitable")), false);
  assert.equal(matchesItem(might, spec("indomitable-might")), true);
});

test("a Lucky feat is not Halfling Luck and is not offered", () => {
  const lucky = item("Lucky", "lucky");
  for (const row of DICE_MOD_SPECS) {
    assert.equal(matchesItem(lucky, row), false, row.id);
  }
  const race = item("Luck", "luck", { type: "race" });
  for (const row of DICE_MOD_SPECS) {
    assert.equal(matchesItem(race, row), false, row.id);
  }
});

test("a name is believed only when there is no identifier, and only on the declared types", () => {
  const named = item("Indomitable", "");
  assert.equal(matchesItem(named, spec("indomitable")), true);
  const weapon = item("Indomitable", "", { type: "weapon" });
  assert.equal(matchesItem(weapon, spec("indomitable")), false);
  const reidentified = item("Indomitable", "homebrew-grit");
  assert.equal(matchesItem(reidentified, spec("indomitable")), false);
});

test("inspiration is read from the actor flag, not from an item", () => {
  assert.equal(hasInspiration(actor({ inspiration: true })), true);
  assert.equal(hasInspiration(actor({})), false);
  const offers = modsOn(actor({ inspiration: true }), ctx({ kind: "save", success: false }));
  assert.deepEqual(
    offers.map((o) => o.spec.id),
    ["inspiration"],
  );
});

/* -------------------------------------------- */
/*  Windows                                     */
/* -------------------------------------------- */

test("Seeking Spell is only a missed spell attack", () => {
  const seeking = spec("seeking-spell");
  assert.equal(
    specApplies(seeking, ctx({ kind: "attack", missed: true, isSpellAttack: true })),
    true,
  );
  assert.equal(
    specApplies(seeking, ctx({ kind: "attack", missed: true, isSpellAttack: false })),
    false,
    "a longbow miss is not Seeking Spell",
  );
  assert.equal(
    specApplies(seeking, ctx({ kind: "save", success: false, isSpellAttack: true })),
    false,
  );
});

test("Indomitable is only a failed save", () => {
  const row = spec("indomitable");
  assert.equal(specApplies(row, ctx({ kind: "save", success: false })), true);
  assert.equal(specApplies(row, ctx({ kind: "save", success: true })), false);
  assert.equal(specApplies(row, ctx({ kind: "check", success: false })), false);
  assert.equal(specApplies(row, ctx({ kind: "attack", missed: true, success: false })), false);
});

test("Indomitable Might is only a Strength total below the score", () => {
  const row = spec("indomitable-might");
  assert.equal(specApplies(row, ctx({ kind: "save", ability: "str", total: 12, strScore: 18 })), true);
  assert.equal(specApplies(row, ctx({ kind: "check", ability: "str", total: 12, strScore: 18 })), true);
  assert.equal(
    specApplies(row, ctx({ kind: "save", ability: "con", total: 12, strScore: 18 })),
    false,
  );
  assert.equal(
    specApplies(row, ctx({ kind: "save", ability: "str", total: 18, strScore: 18 })),
    false,
    "equal is already the score",
  );
  assert.equal(isStrBelow({ ability: "str", total: 17, strScore: 18 }), true);
  assert.equal(
    specApplies(row, ctx({ kind: "save", ability: "str", success: true, total: 12, strScore: 18 })),
    false,
    "already succeeded — do not pop a dialog for a higher number",
  );
  assert.equal(
    specApplies(row, ctx({ kind: "check", ability: "str", success: null, total: 12, strScore: 18 })),
    true,
    "no DC is a contest; the score can still change who wins",
  );
});

test("Inspiration fires on a fail or a miss and not on a success", () => {
  const row = spec("inspiration");
  assert.equal(specApplies(row, ctx({ kind: "save", success: false })), true);
  assert.equal(specApplies(row, ctx({ kind: "check", success: false })), true);
  assert.equal(specApplies(row, ctx({ kind: "attack", missed: true, success: false })), true);
  assert.equal(specApplies(row, ctx({ kind: "save", success: true })), false);
  assert.equal(specApplies(row, ctx({ kind: "check", success: null })), false);
});

test("a spent Indomitable is not offered", () => {
  const spent = item("Indomitable", "indomitable", { uses: { max: 2, spent: 2 } });
  const offers = modsOn(actor({ items: [spent] }), ctx({ kind: "save", success: false }));
  assert.equal(offers.length, 0);
});

/* -------------------------------------------- */
/*  Clock                                       */
/* -------------------------------------------- */

test("the clock declines a depleting option and takes a free one", () => {
  assert.equal(diceModTimeoutId([{ id: "inspiration", depleting: true }]), "decline");
  assert.equal(
    diceModTimeoutId([
      { id: "inspiration", depleting: true },
      { id: "indomitable-might", depleting: false },
    ]),
    "indomitable-might",
  );
});

/* -------------------------------------------- */
/*  Card arithmetic                             */
/* -------------------------------------------- */

test("rerollKeepNew keeps the new face even when it is worse", async () => {
  nextD20(3);
  const { doc, updates } = message(18, 25);
  const reroll = await rerollKeepNew(doc);
  assert.ok(reroll);
  assert.equal(reroll?.was, 18);
  assert.equal(reroll?.rolled, 3);
  assert.equal(reroll?.kept, 3);
  assert.equal(reroll?.total, 10);
  assert.equal(reroll?.changed, true);
  const results = updates[0]?.rolls?.[0]?.terms?.[0]?.results;
  assert.deepEqual(
    results.map((r: any) => [r.result, r.active === true, r.discarded === true]),
    [
      [18, false, true],
      [3, true, false],
    ],
  );
});

test("rerollLower still keeps the lower, so Barbs did not move", async () => {
  nextD20(20);
  const { doc } = message(11, 18);
  const reroll = await rerollLower(doc);
  assert.equal(reroll?.kept, 11);
  assert.equal(reroll?.total, 18);
  assert.equal(reroll?.changed, false);
});

test("replaceD20 writes a 20 and preserves the modifier", async () => {
  const { doc, updates } = message(4, 9);
  const reroll = await replaceD20(doc, 20);
  assert.ok(reroll);
  assert.equal(reroll?.kept, 20);
  assert.equal(reroll?.total, 25);
  assert.equal(updates[0]?.rolls?.[0]?.total, 25);
});

test("addToTotal leaves the die and moves the total", async () => {
  const { doc, updates } = message(12, 17);
  const total = await addToTotal(doc, 7);
  assert.equal(total, 24);
  assert.equal(updates[0]?.rolls?.[0]?.total, 24);
  assert.equal(doc.rolls[0].terms[0].total, 12);
});

test("setTotal overwrites the check without inventing a d20 face", async () => {
  const { doc, updates } = message(7, 10);
  const total = await setTotal(doc, 18);
  assert.equal(total, 18);
  assert.equal(updates[0]?.rolls?.[0]?.total, 18);
  assert.equal(doc.rolls[0].terms[0].total, 7);
});

test("addRoll and subtractRoll move the total and leave the d20", async () => {
  nextD20(5);
  const added = message(12, 17);
  const up = await addRoll(added.doc, "1d8");
  assert.equal(up?.was, 17);
  assert.equal(up?.rolled, 5);
  assert.equal(up?.total, 22);
  assert.equal(added.doc.rolls[0].terms[0].total, 12);

  nextD20(4);
  const cut = message(18, 23);
  const down = await subtractRoll(cut.doc, "1d8");
  assert.equal(down?.was, 23);
  assert.equal(down?.rolled, 4);
  assert.equal(down?.total, 19);
  assert.equal(cut.doc.rolls[0].terms[0].total, 18);
});

/* -------------------------------------------- */
/*  Bardic Inspiration / Peerless / Cutting Words */
/* -------------------------------------------- */

test("inspirationFormula reads a scale object or a die string", () => {
  assert.equal(inspirationFormula(actor({ scale: { bard: { inspiration: { faces: 8, number: 1 } } } })), "1d8");
  assert.equal(inspirationFormula(actor({ scale: { bard: { inspiration: "d10" } } })), "1d10");
  assert.equal(inspirationFormula(actor({ scale: { bard: { inspiration: "1d12" } } })), "1d12");
  assert.equal(inspirationFormula(actor({})), null);
});

test("isInspiredEffect believes origin, name+prose, and a flag — not a bare Inspired", () => {
  assert.equal(isInspiredEffect({ name: "Inspired", description: "" }), false);
  assert.equal(
    isInspiredEffect({ name: "Inspired", description: "You have a Bardic Inspiration die." }),
    true,
  );
  assert.equal(isInspiredEffect({ name: "Bardic Inspiration", description: "" }), true);
  (globalThis as any).fromUuidSync = () => ({ system: { identifier: "bardic-inspiration" } });
  assert.equal(isInspiredEffect({ name: "Boost", origin: "Item.bi", description: "" }), true);
  (globalThis as any).fromUuidSync = () => null;
});

test("the Bard's own feat is not a self offer; an Inspired AE is", () => {
  const feat = item("Bardic Inspiration", "bardic-inspiration", { uses: { max: 5, spent: 0 } });
  const scale = { bard: { inspiration: { faces: 8 } } };
  const fail = ctx({ kind: "save", success: false });
  assert.deepEqual(
    modsOn(actor({ items: [feat], scale }), fail).map((o) => o.spec.id),
    [],
    "granting the die is not spending it",
  );
  const held = actor({
    scale,
    effects: [{ name: "Inspired", description: "Bardic Inspiration die", disabled: false }],
  });
  const offers = modsOn(held, fail);
  assert.deepEqual(
    offers.map((o) => o.spec.id),
    ["bardic-inspiration"],
  );
  assert.equal(offers[0]?.formula, "1d8");
});

test("Cutting Words is opposed after a made attack, check, or damage roll, never a save", () => {
  const row = spec("cutting-words");
  assert.equal(specApplies(row, ctx({ kind: "attack", success: true, missed: false })), true);
  assert.equal(specApplies(row, ctx({ kind: "check", success: true })), true);
  assert.equal(specApplies(row, ctx({ kind: "damage", success: true, missed: false })), true);
  assert.equal(specApplies(row, ctx({ kind: "save", success: true })), false);
  assert.equal(specApplies(row, ctx({ kind: "attack", missed: true, success: false })), false);

  const bard = actor({
    scale: { bard: { inspiration: { faces: 10 } } },
    items: [
      item("Cutting Words", "cutting-words"),
      item("Bardic Inspiration", "bardic-inspiration", { uses: { max: 5, spent: 1 } }),
    ],
  });
  assert.deepEqual(
    modsOn(bard, ctx({ kind: "save", success: false })).map((o) => o.spec.id),
    [],
    "CW is not a self offer",
  );
  const against = modsAgainst(bard, ctx({ kind: "attack", success: true, missed: false }));
  assert.deepEqual(
    against.map((o) => o.spec.id),
    ["cutting-words"],
  );
  assert.deepEqual(
    modsAgainst(bard, ctx({ kind: "damage", success: true, missed: false })).map((o) => o.spec.id),
    ["cutting-words"],
  );
  assert.equal(against[0]?.formula, "1d10");
  assert.equal(against[0]?.spendItem?.system?.identifier, "bardic-inspiration");
});

test("Peerless Skill is a failed check or missed attack, and refunds if it still fails", () => {
  const row = spec("peerless-skill");
  assert.equal(row.refundIfStillFails, true);
  assert.equal(specApplies(row, ctx({ kind: "check", success: false })), true);
  assert.equal(specApplies(row, ctx({ kind: "attack", missed: true, success: false })), true);
  assert.equal(specApplies(row, ctx({ kind: "save", success: false })), false);

  const bard = actor({
    scale: { bard: { inspiration: "1d8" } },
    items: [
      item("Peerless Skill", "peerless-skill"),
      item("Bardic Inspiration", "bardic-inspiration", { uses: { max: 5, spent: 0 } }),
    ],
  });
  assert.deepEqual(
    modsOn(bard, ctx({ kind: "check", success: false })).map((o) => o.spec.id),
    ["peerless-skill"],
  );
});

test("a Lucky feat is still matched by no spec after the Bardic rows landed", () => {
  const lucky = item("Lucky", "lucky");
  for (const row of DICE_MOD_SPECS) {
    assert.equal(matchesItem(lucky, row), false, row.id);
  }
});

test("an unreadable inspiration scale is a refusal, not a guessed d6", () => {
  const bard = actor({
    items: [
      item("Cutting Words", "cutting-words"),
      item("Bardic Inspiration", "bardic-inspiration", { uses: { max: 5, spent: 0 } }),
    ],
  });
  assert.deepEqual(
    modsAgainst(bard, ctx({ kind: "attack", success: true, missed: false })).map((o) => o.spec.id),
    [],
  );
});

test("a spent Bardic Inspiration pool is not offered", () => {
  const bard = actor({
    scale: { bard: { inspiration: "1d8" } },
    items: [
      item("Peerless Skill", "peerless-skill"),
      item("Bardic Inspiration", "bardic-inspiration", { uses: { max: 5, spent: 5 } }),
    ],
  });
  assert.equal(modsOn(bard, ctx({ kind: "check", success: false })).length, 0);
});
