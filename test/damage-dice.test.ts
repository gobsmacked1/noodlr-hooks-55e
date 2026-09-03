import { strict as assert } from "node:assert";
import { beforeEach, test } from "node:test";

import { DICE_MOD_SPECS } from "../src/system/dnd5e-dice-mods";
import {
  damageDieTimeoutId,
  empoweredCount,
  empoweredReady,
  hasPiercing,
  isEmpoweredSpellItem,
  isPiercerItem,
  isSpellDamage,
  listDamageDice,
  lowestUnmaxed,
  piercerItem,
  piercerSpent,
  piercerStamp,
  selfDamageOffers,
} from "../src/system/dnd5e-damage-dice";
import { rerollDamageDice } from "../src/system/dnd5e-reroll";
import { combinedDamageTotal } from "../src/rules/cards";

beforeEach(() => {
  (globalThis as any).game = { system: { id: "dnd5e" }, modules: new Map() };
});

function feat(name: string, identifier: string, extra: Record<string, unknown> = {}) {
  return {
    name,
    type: extra.type ?? "feat",
    system: { identifier, uses: extra.uses },
    flags: extra.flags ?? {},
  };
}

function actor(opts: {
  inspiration?: boolean;
  cha?: number;
  items?: any[];
  piercerTurn?: string;
}) {
  return {
    system: {
      attributes: { inspiration: opts.inspiration === true },
      abilities: { cha: { mod: opts.cha ?? 3 }, str: { value: 16 } },
    },
    items: opts.items ?? [],
    flags: opts.piercerTurn
      ? { "noodlr-hooks-55e": { piercerTurn: opts.piercerTurn } }
      : {},
  };
}

function die(faces: number, value: number, type: string) {
  const results: Array<{ result: number; active: boolean; discarded?: boolean }> = [
    { result: value, active: true },
  ];
  return {
    faces,
    results,
    options: { type },
  };
}

function damageCard(opts: {
  dice: Array<{ faces: number; value: number; type: string }>;
  itemType?: string;
  activityType?: string;
  rollType?: string;
  totals?: number[];
}) {
  const termsByRoll = opts.dice.map((d) => die(d.faces, d.value, d.type));
  const rolls = termsByRoll.map((term, i) => {
    const total = opts.totals?.[i] ?? Number(term.results[0].result);
    return {
      total,
      options: { type: term.options.type },
      terms: [term],
      toJSON: () => ({
        total,
        evaluated: true,
        options: { type: term.options.type },
        terms: [
          {
            faces: term.faces,
            options: { type: term.options.type },
            results: term.results.map((r) => ({ ...r })),
          },
        ],
      }),
    };
  });
  return {
    id: "dmg",
    rolls,
    flags: {
      dnd5e: {
        roll: { type: opts.rollType ?? "damage" },
        item: { type: opts.itemType ?? "weapon" },
        activity: { type: opts.activityType ?? "attack" },
      },
    },
    update: async (data: any) => {
      if (Array.isArray(data.rolls)) {
        for (let i = 0; i < data.rolls.length; i++) {
          const json = data.rolls[i];
          rolls[i].total = json.total;
          if (rolls[i].terms[0] && json.terms?.[0]?.results) {
            rolls[i].terms[0].results = json.terms[0].results;
          }
        }
      }
    },
  };
}

function nextDie(value: number): void {
  (globalThis as any).Roll = class {
    total = value;
    async evaluate() {
      return this;
    }
  };
}

function combat(id = "c1", round = 1, turn = 0) {
  return { id, started: true, round, turn };
}

test("piercer and empowered-spell are not in the d20 table", () => {
  assert.equal(
    DICE_MOD_SPECS.some((row) => row.id === "piercer" || row.id === "empowered-spell"),
    false,
  );
});

test("identifier wins; empowered-spells and empowered-evocation do not match", () => {
  assert.equal(isPiercerItem(feat("Piercer", "piercer")), true);
  assert.equal(isPiercerItem(feat("Puncture", "homebrew-poke")), false);
  assert.equal(isEmpoweredSpellItem(feat("Empowered Spell", "empowered-spell")), true);
  assert.equal(isEmpoweredSpellItem(feat("Empowered Spells", "empowered-spells")), false);
  assert.equal(isEmpoweredSpellItem(feat("Empowered Evocation", "empowered-evocation")), false);
});

test("a name is believed only on a feat with no identifier", () => {
  assert.equal(isPiercerItem(feat("Piercer", "")), true);
  assert.equal(isPiercerItem(feat("Puncture", "")), true);
  assert.equal(isPiercerItem(feat("Piercer", "", { type: "weapon" })), false);
  assert.equal(isPiercerItem(feat("Piercer", "homebrew-spike")), false);
  assert.equal(isEmpoweredSpellItem(feat("Empowered Spell", "")), true);
  assert.equal(isEmpoweredSpellItem(feat("Empowered Spell", "", { type: "spell" })), false);
  assert.equal(isEmpoweredSpellItem(feat("Empowered Spell", "homebrew-meta")), false);
});

test("flags.diceMod is a hatch and a re-flagged item is not matched by name", () => {
  const flagged = feat("Whatever", "other", {
    flags: { "noodlr-hooks-55e": { diceMod: "piercer" } },
  });
  assert.equal(isPiercerItem(flagged), true);
  const wrongFlag = feat("Piercer", "", {
    flags: { "noodlr-hooks-55e": { diceMod: "empowered-spell" } },
  });
  assert.equal(isPiercerItem(wrongFlag), false);
  assert.equal(isEmpoweredSpellItem(wrongFlag), true);
});

test("lowestUnmaxed skips a maxed face and picks the lowest remainder", () => {
  const dice = [
    { rollIndex: 0, termIndex: 0, resultIndex: 0, faces: 8, value: 8, type: "piercing" },
    { rollIndex: 1, termIndex: 0, resultIndex: 0, faces: 6, value: 2, type: "fire" },
    { rollIndex: 2, termIndex: 0, resultIndex: 0, faces: 6, value: 1, type: "fire" },
  ];
  const picks = lowestUnmaxed(dice, 2);
  assert.deepEqual(
    picks.map((d) => d.value),
    [1, 2],
  );
  assert.deepEqual(lowestUnmaxed(dice.filter((d) => d.type === "piercing"), 1), []);
});

test("empoweredCount floors Cha at 1 and caps at the dice on the card", () => {
  assert.equal(empoweredCount(actor({ cha: 4 }), 2), 2);
  assert.equal(empoweredCount(actor({ cha: 4 }), 6), 4);
  assert.equal(empoweredCount(actor({ cha: 0 }), 6), 1);
  assert.equal(empoweredCount(actor({ cha: -1 }), 6), 1);
  assert.equal(empoweredCount({ system: { abilities: {} } }, 6), 1);
});

test("isSpellDamage reads the item type or a cast wrapper", () => {
  const weapon = damageCard({ dice: [{ faces: 8, value: 3, type: "piercing" }] });
  assert.equal(isSpellDamage(weapon), false);
  const spell = damageCard({
    dice: [{ faces: 6, value: 4, type: "fire" }],
    itemType: "spell",
  });
  assert.equal(isSpellDamage(spell), true);
  const wrapper = damageCard({
    dice: [{ faces: 6, value: 4, type: "fire" }],
    itemType: "feat",
    activityType: "cast",
  });
  assert.equal(isSpellDamage(wrapper), true);
});

test("Piercer needs a hit, piercing, and an unspent turn stamp", () => {
  const fighter = actor({ items: [feat("Piercer", "piercer")] });
  const card = damageCard({ dice: [{ faces: 8, value: 3, type: "piercing" }] });
  assert.deepEqual(
    selfDamageOffers(fighter, card, combat(), true).map((o) => o.id),
    ["piercer"],
  );
  assert.deepEqual(selfDamageOffers(fighter, card, combat(), false).map((o) => o.id), []);
  assert.deepEqual(selfDamageOffers(fighter, card, combat(), null).map((o) => o.id), []);
  const fire = damageCard({ dice: [{ faces: 8, value: 3, type: "slashing" }] });
  assert.deepEqual(selfDamageOffers(fighter, fire, combat(), true).map((o) => o.id), []);
  const spent = actor({
    items: [feat("Piercer", "piercer")],
    piercerTurn: "c1:1:0",
  });
  assert.equal(piercerSpent(spent, combat()), true);
  assert.deepEqual(selfDamageOffers(spent, card, combat(), true).map((o) => o.id), []);
});

test("Piercer is unlimited out of combat", () => {
  const fighter = actor({
    items: [feat("Piercer", "piercer")],
    piercerTurn: "c1:1:0",
  });
  assert.equal(piercerStamp(null), "");
  assert.equal(piercerStamp({ started: false }), "");
  assert.equal(piercerSpent(fighter, null), false);
  const card = damageCard({ dice: [{ faces: 8, value: 3, type: "piercing" }] });
  assert.deepEqual(
    selfDamageOffers(fighter, card, null, true).map((o) => o.id),
    ["piercer"],
  );
});

test("Empowered Spell needs a spell, remaining Sorcery Points, and skips healing", () => {
  const sorc = actor({
    cha: 3,
    items: [
      feat("Empowered Spell", "empowered-spell"),
      feat("Font of Magic", "font-of-magic", { uses: { max: 4, spent: 0 } }),
    ],
  });
  const spell = damageCard({
    dice: [
      { faces: 6, value: 2, type: "fire" },
      { faces: 6, value: 1, type: "fire" },
    ],
    itemType: "spell",
  });
  const offers = selfDamageOffers(sorc, spell, combat(), false);
  assert.deepEqual(
    offers.map((o) => o.id),
    ["empowered-spell"],
  );
  assert.equal(offers[0]?.picks.length, 2);
  assert.equal(empoweredReady(sorc)?.pool.system.identifier, "font-of-magic");

  const empty = actor({
    items: [
      feat("Empowered Spell", "empowered-spell"),
      feat("Font of Magic", "font-of-magic", { uses: { max: 4, spent: 4 } }),
    ],
  });
  assert.equal(empoweredReady(empty), null);
  assert.deepEqual(selfDamageOffers(empty, spell, combat(), false).map((o) => o.id), []);

  const heal = damageCard({
    dice: [{ faces: 8, value: 3, type: "healing" }],
    itemType: "spell",
    rollType: "healing",
  });
  assert.deepEqual(selfDamageOffers(sorc, heal, combat(), false).map((o) => o.id), []);
});

test("Inspiration on a damage card is the lowest unmaxed die, including healing", () => {
  const hero = actor({ inspiration: true });
  const card = damageCard({
    dice: [
      { faces: 8, value: 7, type: "slashing" },
      { faces: 6, value: 2, type: "fire" },
    ],
  });
  const offers = selfDamageOffers(hero, card, combat(), false);
  assert.deepEqual(
    offers.map((o) => o.id),
    ["inspiration"],
  );
  assert.equal(offers[0]?.picks[0]?.value, 2);

  const heal = damageCard({
    dice: [{ faces: 8, value: 3, type: "healing" }],
    rollType: "healing",
  });
  assert.deepEqual(
    selfDamageOffers(hero, heal, combat(), false).map((o) => o.id),
    ["inspiration"],
  );
});

test("the clock takes Piercer and declines Empowered or Inspiration", () => {
  assert.equal(damageDieTimeoutId([{ id: "piercer", depleting: false }]), "piercer");
  assert.equal(
    damageDieTimeoutId([
      { id: "piercer", depleting: false },
      { id: "empowered-spell", depleting: true },
    ]),
    "piercer",
  );
  assert.equal(damageDieTimeoutId([{ id: "empowered-spell", depleting: true }]), "decline");
  assert.equal(damageDieTimeoutId([{ id: "inspiration", depleting: true }]), "decline");
});

test("combinedDamageTotal sums every readable roll", () => {
  const card = damageCard({
    dice: [
      { faces: 8, value: 5, type: "piercing" },
      { faces: 6, value: 3, type: "fire" },
    ],
    totals: [5, 3],
  });
  assert.equal(combinedDamageTotal(card), 8);
  assert.ok(Number.isNaN(combinedDamageTotal({ rolls: [] })));
});

test("listDamageDice skips inactive faces; hasPiercing reads the type", () => {
  const card = damageCard({
    dice: [
      { faces: 8, value: 4, type: "piercing" },
      { faces: 6, value: 2, type: "fire" },
    ],
  });
  const listed = listDamageDice(card);
  assert.equal(listed.length, 2);
  assert.equal(hasPiercing(listed), true);
  card.rolls[0].terms[0].results[0].active = false;
  assert.equal(listDamageDice(card).length, 1);
});

test("rerollDamageDice strikes the old face and rewrites the roll total", async () => {
  nextDie(6);
  const card = damageCard({
    dice: [{ faces: 8, value: 2, type: "piercing" }],
    totals: [2],
  });
  const applied = await rerollDamageDice(card, [
    { rollIndex: 0, termIndex: 0, resultIndex: 0, faces: 8, value: 2 },
  ]);
  assert.ok(applied);
  assert.equal(applied?.was, 2);
  assert.equal(applied?.rolled, 6);
  assert.equal(applied?.total, 6);
  assert.equal(card.rolls[0].total, 6);
  const faces = card.rolls[0].terms[0].results;
  assert.equal(faces[0].active, false);
  assert.equal(faces[0].discarded, true);
  assert.equal(faces[1].result, 6);
  assert.equal(faces[1].active, true);
});

test("piercerItem finds the first matching item", () => {
  const fighter = actor({
    items: [feat("Great Weapon Fighting", "gwf"), feat("Piercer", "piercer")],
  });
  assert.equal(piercerItem(fighter)?.system.identifier, "piercer");
  assert.equal(piercerItem(actor({ items: [] })), null);
});
