import { strict as assert } from "node:assert";
import { beforeEach, test } from "node:test";

import { MODULE_ID } from "../src/constants";
import {
  alreadyHasAdvantage,
  alreadyHasDisadvantage,
  isLuckyItem,
  luckyCharges,
  luckyHasCharge,
  luckyItem,
  luckyRollKind,
  luckyTimeoutId,
  shouldOfferIncoming,
  shouldOfferSelf,
} from "../src/system/dnd5e-lucky";
import { matchesItem, DICE_MOD_SPECS } from "../src/system/dnd5e-dice-mods";

beforeEach(() => {
  (globalThis as any).game = { system: { id: "dnd5e" }, modules: new Map() };
});

function feat(name: string, identifier: string, extra: Record<string, unknown> = {}) {
  return {
    name,
    type: extra.type ?? "feat",
    system: { identifier, uses: extra.uses ?? { max: 3, spent: 0 } },
    flags: extra.flags ?? {},
  };
}

test("a feat identified lucky is Lucky; a race trait is not", () => {
  assert.equal(isLuckyItem(feat("Lucky", "lucky")), true);
  assert.equal(isLuckyItem(feat("Lucky", "lucky", { type: "race" })), false);
});

test("2024 species Luck and a halflingLucky flag are not the feat", () => {
  assert.equal(isLuckyItem(feat("Luck", "luck", { type: "race" })), false);
  assert.equal(isLuckyItem(feat("Luck", "luck")), false);
  const flagged = feat("Lucky", "", {
    type: "race",
    flags: { dnd5e: { halflingLucky: true } },
  });
  assert.equal(isLuckyItem(flagged), false);
});

test("a name is believed only on a feat with no identifier", () => {
  assert.equal(isLuckyItem(feat("Lucky", "")), true);
  assert.equal(isLuckyItem(feat("Lucky", "", { type: "weapon" })), false);
  assert.equal(isLuckyItem(feat("Lucky", "homebrew-luck")), false);
});

test("the diceMod hatch names Lucky on any type", () => {
  const item = feat("Fortune", "fortune", {
    type: "feat",
    flags: { [MODULE_ID]: { diceMod: "lucky" } },
  });
  assert.equal(isLuckyItem(item), true);
});

test("an empty pool or unreadable uses cannot be spent", () => {
  assert.equal(luckyHasCharge(feat("Lucky", "lucky", { uses: { max: 3, spent: 3 } })), false);
  assert.equal(luckyHasCharge(feat("Lucky", "lucky", { uses: {} })), false);
  assert.equal(luckyCharges(feat("Lucky", "lucky", { uses: { max: 3, spent: 1 } })), 2);
});

test("luckyItem picks the charged feat and ignores Halfling", () => {
  const actor = {
    items: [
      feat("Lucky", "lucky", { type: "race" }),
      feat("Lucky", "lucky", { uses: { max: 2, spent: 0 } }),
    ],
  };
  const found = luckyItem(actor);
  assert.equal(found?.type, "feat");
  assert.equal(found?.system.uses.max, 2);
});

test("after-fail specs still do not match a Lucky feat", () => {
  const lucky = feat("Lucky", "lucky");
  for (const row of DICE_MOD_SPECS) {
    assert.equal(matchesItem(lucky, row), false, row.id);
  }
});

test("initiative is not a Lucky hold; death and concentration are", () => {
  assert.equal(luckyRollKind(["initiativeDialog", "abilityCheck", "d20Test"]), null);
  assert.equal(luckyRollKind(["attack", "d20Test"]), "attack");
  assert.equal(luckyRollKind(["SavingThrow", "d20Test"]), "save");
  assert.equal(luckyRollKind(["concentration", "SavingThrow", "d20Test"]), "concentration");
  assert.equal(luckyRollKind(["skill", "abilityCheck", "d20Test"]), "skill");
  assert.equal(luckyRollKind(["AbilityCheck", "d20Test"]), "check");
  assert.equal(luckyRollKind(["deathSave"]), "death");
  assert.equal(luckyRollKind(["formula"]), null);
});

test("self Lucky is not offered when Advantage is already on the config", () => {
  assert.equal(shouldOfferSelf({ advantage: true }), false);
  assert.equal(shouldOfferSelf({ rolls: [{ options: { advantageMode: 1 } }] }), false);
  assert.equal(shouldOfferSelf({}), true);
  assert.equal(shouldOfferSelf({ disadvantage: true }), true);
});

test("incoming Lucky is not offered when Disadvantage is already on the attack", () => {
  assert.equal(shouldOfferIncoming({ disadvantage: true }), false);
  assert.equal(shouldOfferIncoming({ rolls: [{ options: { advantageMode: -1 } }] }), false);
  assert.equal(shouldOfferIncoming({ advantage: true }), true);
  assert.equal(shouldOfferIncoming({}), true);
});

test("advantage plus disadvantage on the config offers neither spend", () => {
  const both = { advantage: true, disadvantage: true };
  assert.equal(alreadyHasAdvantage(both), true);
  assert.equal(alreadyHasDisadvantage(both), true);
  assert.equal(shouldOfferSelf(both), false);
  assert.equal(shouldOfferIncoming(both), false);
});

test("a timeout never spends a Luck Point", () => {
  assert.equal(luckyTimeoutId(), "decline");
});
