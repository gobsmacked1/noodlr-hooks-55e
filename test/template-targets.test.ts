import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  forgetLeftoverTargets,
  isInstantSelfEmanation,
  placesTemplate,
  stripUsageTargets,
  waitsForTemplate,
} from "../src/rules/template-targets";

const fireball = {
  name: "Fireball",
  type: "save",
  target: { prompt: true, template: { units: "ft" }, override: false },
  item: { system: { target: { template: { type: "sphere", size: "20" } } } },
};

const holdPerson = {
  name: "Hold Person",
  type: "save",
  target: { affects: { type: "creature" }, override: false },
  item: { system: { target: { affects: { type: "creature" } } } },
};

const ray = {
  name: "Ray of Frost",
  type: "attack",
  target: { affects: { type: "creature" }, override: false },
  item: { system: { target: { affects: { type: "creature" } } } },
};

test("Fireball places a template even when the type lives on the item", () => {
  assert.equal(placesTemplate(fireball), true);
});

test("a prepared activity that already carries template.type also places", () => {
  assert.equal(placesTemplate({ target: { template: { type: "cone" } } }), true);
});

test("Hold Person and Ray of Frost do not place a template", () => {
  assert.equal(placesTemplate(holdPerson), false);
  assert.equal(placesTemplate(ray), false);
});

const lightningSave = {
  name: "Lightning Bolt",
  type: "save",
  target: { prompt: true, template: { units: "ft" }, override: false },
  item: { system: { target: { template: { type: "line", size: "100", width: "5" } } } },
};

const lightningCast = {
  name: "Spellcasting (Lightning Bolt)",
  type: "cast",
  target: { template: {} },
  item: { system: { target: {} } },
  cachedSpell: {
    system: {
      activities: { contents: [lightningSave] },
      target: { template: { type: "line", size: "100", width: "5" } },
    },
  },
};

test("Lightning Bolt's own save activity places a line", () => {
  assert.equal(placesTemplate(lightningSave), true);
});

test("a Cast wrapper still places — the spell it points at is the area", () => {
  assert.equal(placesTemplate(lightningCast), true);
});

test("an override with no template type is not a placement", () => {
  assert.equal(
    placesTemplate({
      target: { override: true, template: {} },
      item: { system: { target: { template: { type: "sphere" } } } },
    }),
    false,
  );
});

test("stripUsageTargets empties the snapshot dnd5e wrote before the hook", () => {
  const messageConfig = {
    data: { flags: { dnd5e: { targets: [{ name: "Dire Wolf", uuid: "Actor.wolf" }] } } },
  };
  assert.equal(stripUsageTargets(messageConfig), true);
  assert.deepEqual(messageConfig.data.flags.dnd5e.targets, []);
});

test("stripUsageTargets empties 6.0 system.targets when flags.dnd5e is absent", () => {
  const messageConfig = {
    data: { system: { targets: [{ name: "Dire Wolf", token: "Scene.s.Token.w" }] } },
  };
  assert.equal(stripUsageTargets(messageConfig), true);
  assert.deepEqual(messageConfig.data.system.targets, []);
});

test("stripUsageTargets is a no-op when nothing was targeted", () => {
  const empty = { data: { flags: { dnd5e: { targets: [] } } } };
  assert.equal(stripUsageTargets(empty), false);
  assert.deepEqual(empty.data.flags.dnd5e.targets, []);
  assert.equal(stripUsageTargets({}), false);
});

test("forgetLeftoverTargets rewrites a Fireball card and leaves Hold Person alone", () => {
  const fireballCard = {
    data: { flags: { dnd5e: { targets: [{ name: "Dire Wolf" }] } } },
  };
  const holdCard = {
    data: { flags: { dnd5e: { targets: [{ name: "Assassin" }] } } },
  };
  assert.equal(forgetLeftoverTargets(fireball, fireballCard), true);
  assert.deepEqual(fireballCard.data.flags.dnd5e.targets, []);
  assert.equal(forgetLeftoverTargets(holdPerson, holdCard), false);
  assert.equal(holdCard.data.flags.dnd5e.targets[0].name, "Assassin");
});

const hadar = {
  name: "Arms of Hadar",
  type: "save",
  range: { units: "self", override: false },
  duration: { units: "inst", override: false },
  target: { template: { type: "radius", size: 10 }, override: false },
  item: {
    name: "Arms of Hadar",
    system: {
      range: { units: "self" },
      duration: { units: "inst" },
      target: { template: { type: "radius", size: 10 } },
    },
  },
};

const spiritGuardians = {
  name: "Spirit Guardians",
  type: "save",
  range: { units: "self", override: false },
  duration: { units: "minute", value: 10, concentration: true, override: false },
  target: { template: { type: "radius", size: 15 }, override: false },
  item: {
    system: {
      range: { units: "self" },
      duration: { units: "minute", value: 10, concentration: true },
      target: { template: { type: "radius", size: 15 } },
    },
  },
};

const thunderclap = {
  name: "Thunderclap",
  type: "save",
  range: { units: "self", override: false },
  duration: { units: "inst", override: false },
  target: { template: { type: "radius", size: 5 }, override: false },
  item: {
    system: {
      range: { units: "self" },
      duration: { units: "inst" },
      target: { template: { type: "radius", size: 5 } },
    },
  },
};

test("Arms of Hadar and Thunderclap are instant self emanations", () => {
  assert.equal(isInstantSelfEmanation(hadar), true);
  assert.equal(isInstantSelfEmanation(thunderclap), true);
  assert.equal(waitsForTemplate(hadar), false);
  assert.equal(placesTemplate(hadar), true);
});

test("Spirit Guardians is a lasting field and still waits for placement", () => {
  assert.equal(isInstantSelfEmanation(spiritGuardians), false);
  assert.equal(waitsForTemplate(spiritGuardians), true);
});

test("Witch Bolt is a pointed creature, not an emanation", () => {
  assert.equal(
    isInstantSelfEmanation({
      type: "attack",
      range: { units: "ft", value: 60, override: false },
      target: { affects: { type: "creature", count: 1 }, template: { type: "" }, override: false },
      item: {
        system: {
          range: { units: "ft", value: 60 },
          target: { affects: { type: "creature", count: 1 }, template: { type: "" } },
        },
      },
    }),
    false,
  );
});
