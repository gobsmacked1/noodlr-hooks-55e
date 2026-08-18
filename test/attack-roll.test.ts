import { strict as assert } from "node:assert";
import { beforeEach, test } from "node:test";

import {
  fireAttackRollTriggers,
  firstTargetOf,
  isAttackRollMessage,
  resetAttackRollDispatch,
} from "../src/capability/attack-roll";
import { bindCapabilities, clearBindings } from "../src/capability/bindings";
import { __clearShadow } from "../src/capability/uses";
import { __damageLogInternals } from "../src/capability/damage-log";
import { validateCapability, type Capability } from "../src/integration/capability";

const damage = __damageLogInternals();

/** Something that actually runs today — almost every live `on_attack_roll` is advantage. */
const MARK: Capability = {
  id: "hash-mark",
  label: "Hunter's Mark",
  status: "compiled",
  rules: [
    {
      trigger: { event: "on_attack_roll" },
      condition: [],
      effect: { kind: "apply_status", status: "marked", target: "target" },
      adjudication: "engine",
    },
  ],
};

const RECKLESS: Capability = {
  id: "hash-reckless",
  label: "Reckless Attack",
  status: "compiled",
  rules: [
    {
      trigger: { event: "on_attack_roll" },
      condition: [],
      effect: { kind: "apply_status", status: "reckless", target: "self" },
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

function attackMessage(id: string, attackerToken: any, extras?: { targets?: any[]; item?: any }) {
  return {
    id,
    speaker: { scene: "scene-1", token: attackerToken.id },
    flags: {
      dnd5e: {
        roll: { type: "attack" },
        targets: extras?.targets ?? [],
        ...(extras?.item ? { item: { uuid: "Item.weapon" }, activity: { id: "a1" } } : {}),
      },
    },
  };
}

beforeEach(() => {
  chat = [];
  clearBindings();
  __clearShadow();
  damage.reset();
  resetAttackRollDispatch();

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
    scene: { id: "scene-1", tokens: { contents: [] as any[], get: (id: string) => tokenById(id) } },
  };
  (globalThis as any).ChatMessage = {
    create: (message: any) => {
      chat.push(message);
      return message;
    },
  };
  (globalThis as any).CONFIG = {
    statusEffects: [
      { id: "marked", name: "Marked" },
      { id: "reckless", name: "Reckless" },
    ],
  };
  (globalThis as any).fromUuidSync = () => null;
});

function tokenById(id: string): any {
  return (globalThis as any).canvas.scene.tokens.contents.find((t: any) => t.id === id) ?? null;
}

function place(...docs: any[]) {
  (globalThis as any).canvas.scene.tokens.contents.push(...docs);
}

test("only an attack-roll card is an attack-roll card", () => {
  assert.equal(isAttackRollMessage({ flags: { dnd5e: { roll: { type: "attack" } } } }), true);
  assert.equal(isAttackRollMessage({ flags: { dnd5e: { roll: { type: "save" } } } }), false);
  assert.equal(isAttackRollMessage({ flags: {} }), false);
});

test("the carrier is the attacker and the mark lands on the first target", async () => {
  const hunter = creature("Hunter", "Actor.hunter");
  const prey = creature("Deer", "Actor.deer");
  place(hunter.doc, prey.doc);
  (globalThis as any).fromUuidSync = (uuid: string) =>
    uuid === prey.actor.uuid ? prey.actor : prey.doc;

  prey.actor.token = prey.doc;
  assert.deepEqual(validateCapability(MARK), { ok: true, errors: [], warnings: [] });
  bindCapabilities(hunter.actor.uuid, [{ capability: MARK }]);

  const message = attackMessage("m1", hunter.doc, {
    targets: [{ name: "Deer", uuid: prey.actor.uuid, ac: 12 }],
  });
  assert.equal(firstTargetOf(message)?.actor, prey.actor);

  await fireAttackRollTriggers(message);
  assert.equal(prey.actor.statuses.has("marked"), true);
  assert.equal(hunter.actor.statuses.has("marked"), false);
});

test("a self-targeted rule lands on the attacker, and trigger is the attacker too", async () => {
  const barbarian = creature("Barbarian", "Actor.barb");
  const goblin = creature("Goblin", "Actor.gob");
  place(barbarian.doc, goblin.doc);
  bindCapabilities(barbarian.actor.uuid, [{ capability: RECKLESS }]);

  await fireAttackRollTriggers(
    attackMessage("m2", barbarian.doc, {
      targets: [{ name: "Goblin", uuid: goblin.actor.uuid, ac: 13 }],
    }),
  );
  assert.equal(barbarian.actor.statuses.has("reckless"), true);
  assert.equal(goblin.actor.statuses.has("reckless"), false);
});

test("one message is one event, even when it names two targets", async () => {
  const hunter = creature("Hunter", "Actor.hunter");
  const a = creature("Deer A", "Actor.a");
  const b = creature("Deer B", "Actor.b");
  place(hunter.doc, a.doc, b.doc);
  a.actor.token = a.doc;
  (globalThis as any).fromUuidSync = (uuid: string) => {
    if (uuid === a.actor.uuid) return a.actor;
    if (uuid === b.actor.uuid) return b.actor;
    return null;
  };
  bindCapabilities(hunter.actor.uuid, [{ capability: MARK }]);

  const message = attackMessage("m3", hunter.doc, {
    targets: [
      { name: "Deer A", uuid: a.actor.uuid, ac: 12 },
      { name: "Deer B", uuid: b.actor.uuid, ac: 12 },
    ],
  });
  await fireAttackRollTriggers(message);
  a.actor.statuses.delete("marked");
  await fireAttackRollTriggers(message);
  assert.equal(a.actor.statuses.has("marked"), false);
  assert.equal(b.actor.statuses.has("marked"), false, "the second target is not a second event");
});

test("a card with no token on the scene is skipped rather than thrown over", async () => {
  await fireAttackRollTriggers({
    id: "m4",
    speaker: { scene: "scene-1", token: "nobody" },
    flags: { dnd5e: { roll: { type: "attack" } } },
  });
});
