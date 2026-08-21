import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  KNOWN_AURAS,
  audienceMatches,
  audienceOfFlag,
  auraSourcesOn,
  interpolateAtRefs,
  knownAuraOf,
  receivesOwnAura,
  resolveAuraRadius,
  resolveAuraValue,
  spellAuraIsActive,
} from "../src/system/dnd5e-auras";

const paladin = {
  abilities: { cha: { mod: 5, value: 20 } },
  scale: { paladin: { aura: 10 } },
};

test("Aura of Protection resolves to max(1, Cha mod)", () => {
  assert.equal(resolveAuraValue("max(1,@abilities.cha.mod)", paladin), "5");
  assert.equal(resolveAuraValue("@abilities.cha.mod", paladin), "5");
  assert.equal(resolveAuraValue("max(1,@abilities.cha.mod)", { abilities: { cha: { mod: -1 } } }), "1");
});

test("paladin aura radius follows the scale, then 10", () => {
  assert.equal(resolveAuraRadius("@scale.paladin.aura", paladin, 10), 10);
  assert.equal(resolveAuraRadius("@scale.paladin.aura", { scale: { paladin: { aura: 30 } } }, 10), 30);
  assert.equal(resolveAuraRadius("@scale.paladin.aura", {}, 10), 10);
});

test("scale objects with a .value are readable", () => {
  assert.equal(interpolateAtRefs("@scale.paladin.aura", { scale: { paladin: { aura: { value: 30 } } } }), "30");
});

test("allies share a disposition; enemies have opposite signs; SECRET is nobody", () => {
  assert.equal(audienceMatches(1, 1, "allies"), true);
  assert.equal(audienceMatches(1, -1, "allies"), false);
  assert.equal(audienceMatches(1, -1, "enemies"), true);
  assert.equal(audienceMatches(1, 0, "enemies"), false);
  assert.equal(audienceMatches(1, -2, "allies"), false);
  assert.equal(audienceMatches(1, 1, "all"), true);
});

test("Active Auras audience strings map", () => {
  assert.equal(audienceOfFlag("Allies"), "allies");
  assert.equal(audienceOfFlag("Enemy"), "enemies");
  assert.equal(audienceOfFlag("All"), "all");
});

test("every known aura is keyed by its identifier", () => {
  for (const row of KNOWN_AURAS) {
    assert.equal(knownAuraOf(row.identifier)?.identifier, row.identifier);
  }
  assert.equal(knownAuraOf("dash"), null);
});

test("DDB Active Auras flags plus a transferred save bonus become one source", () => {
  const actor = {
    items: [
      {
        id: "prot",
        name: "Aura of Protection",
        type: "feat",
        uuid: "Actor.x.Item.prot",
        img: "icons/magic/defensive/shield.webp",
        system: { identifier: "aura-of-protection" },
        effects: [
          {
            id: "fx",
            name: "Aura of Protection",
            transfer: true,
            changes: [{ key: "system.bonuses.abilities.save", type: "add", value: "@abilities.cha.mod" }],
            flags: {
              ActiveAuras: {
                isAura: true,
                aura: "Allies",
                radius: "@scale.paladin.aura",
                ignoreSelf: false,
              },
            },
          },
        ],
      },
    ],
  };
  const sources = auraSourcesOn(actor);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].transferSelf, true);
  assert.equal(sources[0].includeSelf, true);
  assert.equal(sources[0].requiresActive, false);
  assert.equal(sources[0].audience, "allies");
  assert.equal(sources[0].radiusFormula, "@scale.paladin.aura");
  assert.equal(sources[0].changes[0].key, "system.bonuses.abilities.save");
});

test("stock 2024 radius activity with a transferred AE is an aura even without Active Auras flags", () => {
  const actor = {
    items: [
      {
        id: "phb",
        name: "Aura of Protection",
        type: "feat",
        system: {
          identifier: "aura-of-protection",
          activities: {
            a: {
              range: { units: "self" },
              target: { template: { type: "radius", size: "@scale.paladin.aura" } },
            },
          },
        },
        effects: [
          {
            id: "fx",
            name: "Protected",
            transfer: true,
            changes: [{ key: "system.bonuses.abilities.save", mode: 2, value: "@abilities.cha.mod" }],
          },
        ],
      },
    ],
  };
  const sources = auraSourcesOn(actor);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].transferSelf, true);
  assert.ok(sources[0].changes.length >= 1);
});

test("a transferred aura does not write a second copy onto the carrier", () => {
  assert.equal(receivesOwnAura({ includeSelf: true, transferSelf: true } as any), false);
  assert.equal(receivesOwnAura({ includeSelf: true, transferSelf: false } as any), true);
  assert.equal(receivesOwnAura({ includeSelf: false, transferSelf: false } as any), false);
});

test("Aura of Courage with an empty tracker AE still grants frightened immunity", () => {
  const actor = {
    items: [
      {
        id: "courage",
        name: "Aura of Courage",
        type: "feat",
        system: { identifier: "aura-of-courage" },
        effects: [{ id: "fx", name: "Courageous", transfer: false, changes: [] }],
      },
    ],
  };
  const sources = auraSourcesOn(actor);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].changes[0].key, "system.traits.ci.value");
  assert.equal(sources[0].changes[0].value, "frightened");
  assert.equal(sources[0].transferSelf, false);
});

test("a 2014 feat with no effects still compiles from the identifier", () => {
  const actor = {
    items: [{ id: "old", name: "Aura of Protection", type: "feat", system: { identifier: "aura-of-protection" }, effects: [] }],
  };
  const sources = auraSourcesOn(actor);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].id, "old:known");
  assert.ok(sources[0].changes[0].value.includes("cha.mod"));
});

test("Aura of Life waits for the spell to be up", () => {
  const item = {
    id: "life",
    name: "Aura of Life",
    type: "spell",
    uuid: "Actor.x.Item.life",
    system: { identifier: "aura-of-life" },
    effects: [
      {
        id: "fx",
        name: "Aura of Life",
        transfer: false,
        changes: [{ key: "system.traits.dr.value", value: "necrotic" }],
      },
    ],
  };
  const resting = { items: [item], effects: [] };
  const sources = auraSourcesOn(resting);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].requiresActive, true);
  assert.equal(spellAuraIsActive(resting, sources[0]), false);
  const up = {
    items: [item],
    effects: [{ name: "Aura of Life", origin: "Actor.x.Item.life", disabled: false, flags: {} }],
  };
  assert.equal(spellAuraIsActive(up, sources[0]), true);
});
