import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  AURA_AA_FLAGS,
  KNOWN_AURAS,
  audienceMatches,
  audienceOfFlag,
  auraDominates,
  auraSourcesOn,
  auraStatusEntry,
  auraStatusId,
  auraStrength,
  auraPresentationPatch,
  auraWriteFlags,
  collapseOverlappingAuras,
  hostNeedsPresentation,
  interpolateAtRefs,
  isOccupyingField,
  knownAuraOf,
  looksLikeGuttedHostAura,
  looksLikeTransferredAura,
  normalizeRadiusFormula,
  paladinAuraRadiusAtLevel,
  parseAuraLength,
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

test("aura token icons use a status id that is never a canned condition", () => {
  assert.equal(auraStatusId("aura-of-protection"), "noodlr-aura-of-protection");
  assert.equal(auraStatusId("aura-of-courage"), "noodlr-aura-of-courage");
  assert.equal(auraStatusId("frightful-presence"), "noodlr-aura-frightful-presence");
  const canned = [
    "dead",
    "unconscious",
    "paralyzed",
    "frightened",
    "charmed",
    "concentrating",
    "prone",
    "incapacitated",
    "stunned",
    "blinded",
    "invisible",
    "hiding",
    "blessed",
  ];
  for (const id of canned) {
    assert.notEqual(auraStatusId(id), id);
    assert.ok(auraStatusId(id).startsWith("noodlr-aura-"));
  }
  const entry = auraStatusEntry("aura-of-protection", "Aura of Protection");
  assert.equal(entry.hud, false);
  assert.equal(entry.id, "noodlr-aura-of-protection");
});

test("aura copies kill Automated Animations and mark themselves temporary", () => {
  assert.equal(AURA_AA_FLAGS.killAnim, true);
  assert.equal(AURA_AA_FLAGS.isEnabled, false);
  const flags = auraWriteFlags("tok", "src") as {
    autoanimations: { killAnim: boolean; version: number };
    dnd5e: { isTemporary: boolean };
  };
  assert.equal(flags.autoanimations.killAnim, true);
  assert.equal(flags.autoanimations.version, 99);
  assert.equal(flags.dnd5e.isTemporary, true);
});

test("2024 Paladin aura radius is a flat 10 → 30 jump at 18, not a curve", () => {
  assert.equal(paladinAuraRadiusAtLevel(6), 10);
  assert.equal(paladinAuraRadiusAtLevel(17), 10);
  assert.equal(paladinAuraRadiusAtLevel(18), 30);
  assert.equal(paladinAuraRadiusAtLevel(20), 30);
  const twenty = {
    classes: { paladin: { levels: 20 } },
    items: [{ type: "class", system: { identifier: "paladin", levels: 20 } }],
  };
  assert.equal(resolveAuraRadius("@scale.paladin.aura", twenty, 10, { actor: twenty }), 30);
  assert.equal(
    resolveAuraRadius("[[scalevalue]]-ft", twenty, 10, {
      actor: twenty,
      identifier: "aura-of-protection",
    }),
    30,
  );
});

test("DDB radius strings with units or an unexpanded scalevalue enricher still resolve", () => {
  assert.equal(parseAuraLength("30-ft"), 30);
  assert.equal(parseAuraLength("10 foot"), 10);
  assert.equal(parseAuraLength("30 ft."), 30);
  assert.equal(normalizeRadiusFormula("[[scalevalue]]-ft"), "@scale.paladin.aura");
  assert.equal(
    resolveAuraRadius("[[scalevalue]]-ft", { scale: { paladin: { aura: { value: 30 } } } }, 10),
    30,
  );
  assert.equal(
    resolveAuraRadius("@scale.paladin.aura", { scale: { paladin: { "aura-of-protection": { value: 30 } } } }, 10, {
      identifier: "aura-of-protection",
    }),
    30,
  );
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

test("the Paladin's transferred AE is never classified as ours", () => {
  const source = {
    id: "prot:fx",
    itemId: "prot",
    identifier: "aura-of-protection",
    name: "Aura of Protection",
  } as any;
  const transferred = {
    name: "Aura of Protection",
    origin: "Actor.p.Item.prot",
    changes: [{ key: "system.bonuses.abilities.save", value: "5" }],
    flags: { dnd5e: {} },
  };
  assert.equal(looksLikeTransferredAura(transferred, source), true);
  assert.equal(looksLikeGuttedHostAura(transferred, source), false);
});

test("a hollow badge that ate the transferred AE is gutted, not a copy to delete", () => {
  const source = {
    id: "prot:fx",
    itemId: "prot",
    identifier: "aura-of-protection",
    name: "Aura of Protection",
  } as any;
  const gutted = {
    name: "Aura of Protection",
    origin: "Actor.p.Item.prot",
    changes: [],
    flags: { "noodlr-hooks-55e": { aura: { sourceToken: "tok", sourceId: "prot:fx" } } },
  };
  assert.equal(looksLikeGuttedHostAura(gutted, source), true);
  assert.equal(looksLikeTransferredAura(gutted, source), false);
});

test("an ally copy with real changes is not a gutted host aura", () => {
  const source = {
    id: "prot:fx",
    itemId: "prot",
    identifier: "aura-of-protection",
    name: "Aura of Protection",
  } as any;
  const copy = {
    name: "Aura of Protection",
    origin: "Actor.p.Item.prot",
    changes: [{ key: "system.bonuses.abilities.save", value: "5" }],
    flags: { "noodlr-hooks-55e": { aura: { sourceToken: "tok", sourceId: "prot:fx" } } },
  };
  assert.equal(looksLikeGuttedHostAura(copy, source), false);
  assert.equal(looksLikeTransferredAura(copy, source), false);
});

test("host presentation is a dotted patch and does not replace flags.dnd5e", () => {
  const patch = auraPresentationPatch("noodlr-aura-of-protection", "icons/svg/aura.svg");
  assert.equal(patch["flags.dnd5e.isTemporary"], true);
  assert.equal(Object.prototype.hasOwnProperty.call(patch, "flags"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(patch, "dnd5e"), false);
  const bare = {
    img: "icons/svg/mystery-man.svg",
    statuses: [],
    flags: { dnd5e: { dependents: [{ uuid: "keep-me" }] } },
  };
  assert.equal(hostNeedsPresentation(bare, "noodlr-aura-of-protection", "icons/svg/aura.svg"), true);
  const stamped = {
    img: "icons/svg/aura.svg",
    statuses: ["noodlr-aura-of-protection"],
    flags: { dnd5e: { isTemporary: true }, autoanimations: { killAnim: true, isEnabled: false } },
  };
  assert.equal(hostNeedsPresentation(stamped, "noodlr-aura-of-protection", "icons/svg/aura.svg"), false);
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

test("two Protection auras keep the higher bonus; Protection and Courage both stay", () => {
  const prot5 = {
    identifier: "aura-of-protection",
    changes: [{ key: "system.bonuses.abilities.save", mode: 2, value: "5" }],
  };
  const prot3 = {
    identifier: "aura-of-protection",
    changes: [{ key: "system.bonuses.abilities.save", mode: 2, value: "3" }],
  };
  const courage = {
    identifier: "aura-of-courage",
    changes: [{ key: "system.traits.ci.value", mode: 2, value: "frightened" }],
  };
  const same = collapseOverlappingAuras([prot5, prot3]);
  assert.equal(same.length, 1);
  assert.equal(same[0].changes[0].value, "5");
  const mixed = collapseOverlappingAuras([prot5, courage]);
  assert.equal(mixed.length, 2);
  assert.ok(mixed.some((r) => r.identifier === "aura-of-protection"));
  assert.ok(mixed.some((r) => r.identifier === "aura-of-courage"));
});

test("two Courage auras collapse to one; a Paladin's own +3 only takes the neighbour's extra +2", () => {
  const a = {
    identifier: "aura-of-courage",
    changes: [{ key: "system.traits.ci.value", mode: 2, value: "frightened" }],
  };
  const b = {
    identifier: "aura-of-courage",
    changes: [{ key: "system.traits.ci.value", mode: 2, value: "frightened" }],
  };
  assert.equal(collapseOverlappingAuras([a, b]).length, 1);
  const incoming = {
    identifier: "aura-of-protection",
    changes: [{ key: "system.bonuses.abilities.save", mode: 2, value: "5" }],
  };
  const net = collapseOverlappingAuras([incoming], { "aura-of-protection": 3 });
  assert.equal(net.length, 1);
  assert.equal(net[0].changes[0].value, "2");
  assert.equal(collapseOverlappingAuras([incoming], { "aura-of-protection": 5 }).length, 0);
  assert.equal(collapseOverlappingAuras([incoming], { "aura-of-protection": 6 }).length, 0);
});

test("two hostile auras of the same kind keep the harsher number", () => {
  assert.equal(auraDominates(-4, -2), true);
  assert.equal(auraStrength([{ value: "-4" }]), -4);
  const kept = collapseOverlappingAuras([
    { identifier: "frightful-presence", changes: [{ key: "x", mode: 2, value: "-2" }] },
    { identifier: "frightful-presence", changes: [{ key: "x", mode: 2, value: "-4" }] },
  ]);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].changes[0].value, "-4");
});

test("Spirit Guardians is an occupying field, never a grant aura", () => {
  const item = {
    id: "sg",
    name: "Spirit Guardians",
    type: "spell",
    system: {
      identifier: "spirit-guardians",
      range: { units: "self" },
      target: { template: { type: "radius", size: "15" } },
      activities: {
        save: {
          type: "save",
          save: { ability: "wis" },
          damage: { parts: [{ number: 3, denomination: 8, types: ["radiant"] }] },
          range: { units: "ft", value: "15" },
        },
      },
    },
    effects: [
      {
        id: "half",
        name: "Half Speed",
        transfer: false,
        changes: [
          { key: "system.attributes.movement.walk", mode: 1, value: "0.5" },
          { key: "system.attributes.movement.fly", mode: 1, value: "0.5" },
        ],
        flags: { ActiveAuras: { isAura: true, aura: "Enemy", radius: "15" } },
      },
    ],
  };
  assert.equal(isOccupyingField(item), true);
  assert.equal(auraSourcesOn({ items: [item] }).length, 0);
});

test("a DDB Half Speed stamp without the identifier is still not a grant", () => {
  const item = {
    id: "hollow",
    name: "Spirit Guardians",
    type: "spell",
    system: { identifier: "" },
    effects: [
      {
        id: "half",
        name: "Half Speed",
        transfer: false,
        changes: [{ key: "system.attributes.movement.walk", mode: 1, value: "0.5" }],
        flags: { ActiveAuras: { isAura: true, aura: "Enemy", radius: "15" } },
      },
    ],
  };
  assert.equal(isOccupyingField(item), false);
  assert.equal(auraSourcesOn({ items: [item] }).length, 0);
});
