import { strict as assert } from "node:assert";
import { beforeEach, test } from "node:test";

import {
  fireConditionTriggers,
  resetConditionDispatch,
  ruleMatchesApplied,
  statusesOf,
} from "../src/capability/condition-applied";
import { bindCapabilities, clearBindings } from "../src/capability/bindings";
import { __clearShadow } from "../src/capability/uses";
import { __damageLogInternals } from "../src/capability/damage-log";
import { validateCapability, type Capability } from "../src/integration/capability";

const damage = __damageLogInternals();

/** Nature's Ward in the live cache: when poisoned lands on me, it does not stay. */
const NATURES_WARD: Capability = {
  id: "hash-natures-ward",
  label: "Nature's Ward",
  status: "compiled",
  rules: [
    {
      trigger: { event: "on_condition_applied" },
      condition: [{ kind: "has_status", status: "poisoned", who: "self" }],
      effect: { kind: "remove_status", status: "poisoned", target: "self" },
      adjudication: "engine",
    },
  ],
};

/** Wild Shape in the live cache: incapacitated ends the form, not the form arriving. */
const WILD_SHAPE: Capability = {
  id: "hash-wild-shape",
  label: "Wild Shape",
  status: "compiled",
  rules: [
    {
      trigger: { event: "on_condition_applied" },
      condition: [{ kind: "has_status", status: "incapacitated", who: "self" }],
      effect: { kind: "remove_status", status: "transformed", target: "self" },
      adjudication: "engine",
    },
  ],
};

let chat: any[];

function creature(name: string, uuid: string) {
  const actor: any = {
    uuid,
    name,
    type: "npc",
    statuses: new Set<string>(),
    flags: { "noodlr-hooks-55e": {} },
    system: { attributes: { hp: { value: 30, max: 30 } } },
    async setFlag(_ns: string, key: string, value: any) {
      actor.flags["noodlr-hooks-55e"][key] = value;
    },
    getFlag(_ns: string, key: string) {
      return actor.flags["noodlr-hooks-55e"][key];
    },
    async toggleStatusEffect(id: string, options?: any) {
      if (options?.active === false) actor.statuses.delete(id);
      else actor.statuses.add(id);
      return true;
    },
    getActiveTokens() {
      return [doc];
    },
  };
  const doc: any = { id: `${uuid}-token`, name, actor, x: 0, y: 0 };
  doc.object = doc;
  actor.token = doc;
  return { actor, doc };
}

function effect(id: string, actor: any, statuses: string[]) {
  return { id, parent: actor, statuses: new Set(statuses) };
}

beforeEach(() => {
  chat = [];
  clearBindings();
  __clearShadow();
  damage.reset();
  resetConditionDispatch();

  (globalThis as any).game = {
    system: { id: "dnd5e" },
    user: { isGM: true, id: "gm-1" },
    users: { activeGM: { id: "gm-1" } },
    combat: null,
    actors: { getName: () => null, get: () => null },
    scenes: { get: () => (globalThis as any).canvas.scene },
    packs: [],
  };
  (globalThis as any).canvas = {
    grid: { size: 100, distance: 5 },
    scene: { id: "scene-1", tokens: { contents: [] as any[] } },
  };
  (globalThis as any).ChatMessage = {
    create: (message: any) => {
      chat.push(message);
      return message;
    },
  };
  (globalThis as any).CONFIG = {
    statusEffects: [
      { id: "poisoned", name: "Poisoned" },
      { id: "frightened", name: "Frightened" },
      { id: "incapacitated", name: "Incapacitated" },
      { id: "transformed", name: "Transformed" },
      { id: "surprised", name: "Surprised" },
    ],
  };
});

test("statusesOf reads a Set or an array", () => {
  assert.deepEqual(statusesOf({ statuses: new Set(["Poisoned", "prone"]) }), ["poisoned", "prone"]);
  assert.deepEqual(statusesOf({ statuses: ["hiding"] }), ["hiding"]);
  assert.deepEqual(statusesOf({}), []);
});

test("a rule about poison does not match frightened", () => {
  assert.equal(ruleMatchesApplied(NATURES_WARD.rules[0], ["poisoned"]), true);
  assert.equal(ruleMatchesApplied(NATURES_WARD.rules[0], ["frightened"]), false);
});

test("Wild Shape matches incapacitated, not the form arriving", () => {
  // Matching `effect.status` (`transformed`) would cancel the form the moment it landed.
  assert.equal(ruleMatchesApplied(WILD_SHAPE.rules[0], ["incapacitated"]), true);
  assert.equal(ruleMatchesApplied(WILD_SHAPE.rules[0], ["transformed"]), false);
});

test("a rule that names no status is skipped", () => {
  const bare = {
    trigger: { event: "on_condition_applied" as const },
    condition: [],
    effect: { kind: "other" as const, note: "something happened" },
    adjudication: "engine" as const,
  };
  assert.equal(ruleMatchesApplied(bare, ["poisoned"]), false);
});

test("Nature's Ward strips poison when poison lands, and only then", async () => {
  const druid = creature("Druid", "Actor.druid");
  assert.deepEqual(validateCapability(NATURES_WARD), { ok: true, errors: [], warnings: [] });
  bindCapabilities(druid.actor.uuid, [{ capability: NATURES_WARD }]);

  druid.actor.statuses.add("poisoned");
  await fireConditionTriggers(effect("ae-poison", druid.actor, ["poisoned"]));
  assert.equal(druid.actor.statuses.has("poisoned"), false);

  druid.actor.statuses.add("poisoned");
  druid.actor.statuses.add("frightened");
  await fireConditionTriggers(effect("ae-fear", druid.actor, ["frightened"]));
  assert.equal(druid.actor.statuses.has("poisoned"), true, "frightened is not poison");
});

test("Wild Shape drops the form when incapacitated lands, not when the form does", async () => {
  const druid = creature("Druid", "Actor.druid");
  bindCapabilities(druid.actor.uuid, [{ capability: WILD_SHAPE }]);

  druid.actor.statuses.add("transformed");
  await fireConditionTriggers(effect("ae-form", druid.actor, ["transformed"]));
  assert.equal(
    druid.actor.statuses.has("transformed"),
    true,
    "the form arriving is not the trigger",
  );

  druid.actor.statuses.add("incapacitated");
  await fireConditionTriggers(effect("ae-down", druid.actor, ["incapacitated"]));
  assert.equal(druid.actor.statuses.has("transformed"), false);
});

test("the same effect is dispatched once", async () => {
  const druid = creature("Druid", "Actor.druid");
  bindCapabilities(druid.actor.uuid, [{ capability: NATURES_WARD }]);
  druid.actor.statuses.add("poisoned");
  const ae = effect("ae-once", druid.actor, ["poisoned"]);
  await fireConditionTriggers(ae);
  druid.actor.statuses.add("poisoned");
  await fireConditionTriggers(ae);
  assert.equal(druid.actor.statuses.has("poisoned"), true, "the second pass must not strip again");
});
