import { strict as assert } from "node:assert";
import { beforeEach, test } from "node:test";

import { dispatchesFor, fireSaveTriggers, resetSaveDispatch } from "../src/capability/saves";
import { bindingAppliesToActivity } from "../src/capability/executor";
import { bindCapabilities, clearBindings } from "../src/capability/bindings";
import { __clearShadow } from "../src/capability/uses";
import { __damageLogInternals } from "../src/capability/damage-log";
import { validateCapability, type Capability } from "../src/integration/capability";

const damage = __damageLogInternals();

/**
 * The commonest engine-adjudicated `on_save_failed` rule in the live cache, and the one the
 * direction test hangs on: `npm run census:trigger` over 1,105 wordings found 188 of 249 engine
 * save rules pointing their effect at `target`. Hold Person is the specimen — restrain what failed,
 * not the caster.
 */
const HOLD_PERSON: Capability = {
  id: "hash-hold-person",
  label: "Hold Person",
  status: "compiled",
  rules: [
    {
      trigger: { event: "on_save_failed" },
      condition: [],
      effect: { kind: "apply_status", status: "restrained", target: "target" },
      adjudication: "engine",
    },
  ],
};

/**
 * The refusal specimen. A save-for-half spell compiled to "on a failed save, deal 8d6 fire" is the
 * activity's own `damage.parts` read back. Dispatching without `ctx.activity` doubles it.
 */
const RESTATED_DAMAGE: Capability = {
  id: "hash-fireball",
  label: "Fireball",
  status: "compiled",
  rules: [
    {
      trigger: { event: "on_save_failed" },
      condition: [],
      effect: {
        kind: "damage",
        amount: { dice: "8d6" },
        damageType: "fire",
        target: "target",
      },
      adjudication: "engine",
    },
  ],
};

// ---- Fakes -------------------------------------------------------------------------------------

let chat: any[];
let damaged: Array<{ name: string; description: any }>;

function creature(name: string, uuid: string) {
  const actor: any = {
    uuid,
    name,
    type: "npc",
    statuses: new Set<string>(),
    flags: { "noodlr-hooks-55e": {} },
    system: { attributes: { hp: { value: 30, max: 30 } } },
    async applyDamage(description: any[]) {
      damaged.push({ name, description: description[0] });
    },
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
  };
  const doc: any = { id: `${uuid}-token`, name, actor, x: 0, y: 0 };
  doc.object = doc;
  return { actor, doc };
}

/** A usage card shaped the way dnd5e writes one, with the speaker naming the caster. */
function usageMessage(id: string, casterToken: any, item?: any) {
  return {
    id,
    speaker: { scene: "scene-1", token: casterToken.id },
    flags: { dnd5e: item ? { item: { uuid: "Item.spell" }, activity: { id: "a1" } } : {} },
  };
}

function saveMessage(id: string) {
  return { id };
}

function failed(doc: any, id: string, extra?: { pendingResistance?: boolean }) {
  return {
    doc,
    success: false as const,
    saveMessage: saveMessage(id),
    pendingResistance: extra?.pendingResistance ?? false,
  };
}

function succeeded(doc: any, id: string) {
  return {
    doc,
    success: true as const,
    saveMessage: saveMessage(id),
    pendingResistance: false,
  };
}

beforeEach(() => {
  chat = [];
  damaged = [];
  clearBindings();
  __clearShadow();
  damage.reset();
  resetSaveDispatch();

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
  (globalThis as any).Roll = class {
    total = 7;
    async evaluate() {
      return this;
    }
  };
  (globalThis as any).CONFIG = {
    statusEffects: [
      { id: "poisoned", name: "Poisoned" },
      { id: "restrained", name: "Restrained" },
      { id: "charmed", name: "Charmed" },
    ],
  };
});

function place(...docs: any[]) {
  (globalThis as any).canvas.scene.tokens.contents.push(...docs);
}

function tokenById(id: string): any {
  return (globalThis as any).canvas.scene.tokens.contents.find((t: any) => t.id === id) ?? null;
}

// ---- Who gets what ------------------------------------------------------------------------------

test("one dispatch per creature, and a success is as much a verdict as a failure", () => {
  const a = { id: "t-a" };
  const b = { id: "t-b" };
  const c = { id: "t-c" };
  const dispatches = dispatchesFor([failed(a, "s1"), failed(b, "s2"), succeeded(c, "s3")]);
  assert.deepEqual(
    dispatches.map((d) => `${d.event}:${d.doc.id}`),
    ["on_save_failed:t-a", "on_save_failed:t-b", "on_save_succeeded:t-c"],
  );
});

test("a save with no DC is not a failure", () => {
  // `readSave` answers null when the roll carries no DC. Treating that as a miss would restrain
  // somebody on a sheet roll that was never against this spell.
  const dispatches = dispatchesFor([
    { doc: { id: "t-a" }, success: null, saveMessage: saveMessage("s1"), pendingResistance: false },
  ]);
  assert.deepEqual(dispatches, []);
});

test("a failure still waiting on a legendary resistance is not dispatched", () => {
  // The Resist button can still turn this into a success. Firing `on_save_failed` now and
  // `on_save_succeeded` later would apply both halves.
  const dispatches = dispatchesFor([failed({ id: "t-dragon" }, "s1", { pendingResistance: true })]);
  assert.deepEqual(dispatches, []);
});

// ---- Direction ------------------------------------------------------------------------------------

test("the carrier is the caster and the effect lands on what failed", async () => {
  const caster = creature("Archmage", "Actor.archmage");
  const victim = creature("Bianca", "Actor.bianca");
  place(caster.doc, victim.doc);
  assert.deepEqual(validateCapability(HOLD_PERSON), { ok: true, errors: [], warnings: [] });
  bindCapabilities(caster.actor.uuid, [{ capability: HOLD_PERSON }]);

  await fireSaveTriggers(usageMessage("u1", caster.doc), [failed(victim.doc, "s1")]);

  assert.equal(victim.actor.statuses.has("restrained"), true, "the creature that failed");
  assert.equal(caster.actor.statuses.has("restrained"), false, "…and not the one who cast");
});

test("the creature that saved is also `trigger`, not the caster", async () => {
  const caster = creature("Archmage", "Actor.archmage");
  const victim = creature("Bianca", "Actor.bianca");
  victim.actor.system.attributes.hp.value = 3;
  place(caster.doc, victim.doc);

  const guarded: Capability = {
    ...HOLD_PERSON,
    id: "hash-guarded",
    rules: [
      {
        ...HOLD_PERSON.rules[0],
        condition: [{ kind: "hp_at_most", who: "trigger", amount: { value: 5 } } as any],
      },
    ],
  };
  bindCapabilities(caster.actor.uuid, [{ capability: guarded }]);

  await fireSaveTriggers(usageMessage("u2", caster.doc), [failed(victim.doc, "s2")]);
  assert.equal(victim.actor.statuses.has("restrained"), true);
});

test("a capability bound to the saver does not fire — these are caster-side only", async () => {
  // Evasion / Avoidance / "when I fail a save" compile to the same events and sit on the saver.
  // Running them here would invert `target`. They stay bound and inert until `on_save_failed_by`.
  const caster = creature("Archmage", "Actor.archmage");
  const victim = creature("Bianca", "Actor.bianca");
  place(caster.doc, victim.doc);
  bindCapabilities(victim.actor.uuid, [{ capability: HOLD_PERSON }]);

  await fireSaveTriggers(usageMessage("u3", caster.doc), [failed(victim.doc, "s3")]);
  assert.equal(victim.actor.statuses.has("restrained"), false);
  assert.equal(caster.actor.statuses.has("restrained"), false);
});

// ---- The refusal ------------------------------------------------------------------------------------

test("a restated damage line is refused, because the system already rolled it", async () => {
  const caster = creature("Archmage", "Actor.archmage");
  const victim = creature("Bianca", "Actor.bianca");
  place(caster.doc, victim.doc);

  const activity = { name: "Fireball", damage: { parts: [{ formula: "8d6", types: ["fire"] }] } };
  const item = { name: "Fireball", system: { activities: { get: () => activity } } };
  (globalThis as any).fromUuidSync = () => item;

  assert.deepEqual(validateCapability(RESTATED_DAMAGE), { ok: true, errors: [], warnings: [] });
  bindCapabilities(caster.actor.uuid, [{ capability: RESTATED_DAMAGE }]);
  await fireSaveTriggers(usageMessage("u4", caster.doc, item), [failed(victim.doc, "s4")]);

  assert.deepEqual(damaged, [], "the spell's own 8d6 must not be rolled a second time");
});

test("…and a genuine rider on the same spell still lands", async () => {
  const caster = creature("Archmage", "Actor.archmage");
  const victim = creature("Troll", "Actor.troll");
  place(caster.doc, victim.doc);

  const activity = {
    name: "Fireball",
    damage: { parts: [{ formula: "8d6", types: ["fire"] }] },
  };
  const item = { name: "Fireball", system: { activities: { get: () => activity } } };
  (globalThis as any).fromUuidSync = () => item;

  const rider: Capability = {
    id: "hash-rider",
    label: "Lingering Embers",
    status: "compiled",
    rules: [
      {
        trigger: { event: "on_save_failed" },
        condition: [],
        effect: {
          kind: "damage",
          amount: { dice: "1d6" },
          damageType: "fire",
          target: "target",
        },
        adjudication: "engine",
      },
    ],
  };
  assert.deepEqual(validateCapability(rider), { ok: true, errors: [], warnings: [] });
  bindCapabilities(caster.actor.uuid, [{ capability: rider }]);
  await fireSaveTriggers(usageMessage("u5", caster.doc, item), [failed(victim.doc, "s5")]);

  assert.equal(damaged.length, 1);
  assert.equal(damaged[0].name, "Troll");
});

// ---- Once per save ---------------------------------------------------------------------------------

test("a card read twice fires once", async () => {
  const caster = creature("Archmage", "Actor.archmage");
  const victim = creature("Bianca", "Actor.bianca");
  place(caster.doc, victim.doc);
  bindCapabilities(caster.actor.uuid, [{ capability: HOLD_PERSON }]);

  const verdicts = [failed(victim.doc, "s6")];
  await fireSaveTriggers(usageMessage("u6", caster.doc), verdicts);
  victim.actor.statuses.delete("restrained");
  await fireSaveTriggers(usageMessage("u6", caster.doc), verdicts);

  assert.equal(victim.actor.statuses.has("restrained"), false, "the second read must do nothing");
});

test("two creatures on one spell are two events", async () => {
  // Keyed by the save message, not the usage card: one Fireball is five saves.
  const caster = creature("Archmage", "Actor.archmage");
  const a = creature("Goblin A", "Actor.goba");
  const b = creature("Goblin B", "Actor.gobb");
  place(caster.doc, a.doc, b.doc);
  bindCapabilities(caster.actor.uuid, [{ capability: HOLD_PERSON }]);

  await fireSaveTriggers(usageMessage("u7", caster.doc), [
    failed(a.doc, "s7a"),
    failed(b.doc, "s7b"),
  ]);
  assert.equal(a.actor.statuses.has("restrained"), true);
  assert.equal(b.actor.statuses.has("restrained"), true);
});

test("a usage with no caster on the scene is skipped rather than thrown over", async () => {
  await fireSaveTriggers({ id: "u8", speaker: { scene: "scene-1", token: "nobody" }, flags: {} }, [
    failed({ id: "t-x", actor: null }, "s8"),
  ]);
  assert.deepEqual(damaged, []);
});

test("no usage card means no dispatch", async () => {
  await fireSaveTriggers(null, [failed({ id: "t-x" }, "s9")]);
  assert.deepEqual(damaged, []);
});

test("the announcement names who the effect landed on, not the caster", async () => {
  const caster = creature("Bardo", "Actor.bardo");
  const victim = creature("Assassin", "Actor.assassin");
  place(caster.doc, victim.doc);
  bindCapabilities(caster.actor.uuid, [{ capability: HOLD_PERSON }]);

  await fireSaveTriggers(usageMessage("u-announce", caster.doc), [failed(victim.doc, "s-announce")]);

  assert.equal(victim.actor.statuses.has("restrained"), true);
  assert.match(String(chat[0]?.content ?? ""), /Assassin is restrained/);
  assert.doesNotMatch(String(chat[0]?.content ?? ""), /Bardo is restrained/);
});

test("another spell's save rider does not fire on this spell's save", async () => {
  // Hold Person failed; Otto's is also `on_save_failed` on the same caster. Firing both
  // charmed the Assassin in a live fight (2026-08-18).
  const caster = creature("Bardo", "Actor.bardo");
  const victim = creature("Assassin", "Actor.assassin");
  place(caster.doc, victim.doc);

  const holdItem: { id: string; type: string; name: string; uuid: string; system?: any } = {
    id: "hold",
    type: "spell",
    name: "Hold Person",
    uuid: "Item.hold",
  };
  const activity = { name: "Save", item: holdItem };
  holdItem.system = { activities: { get: () => activity } };
  (globalThis as any).fromUuidSync = () => holdItem;

  const ottos: Capability = {
    id: "hash-ottos",
    label: "Otto's Irresistible Dance",
    status: "compiled",
    rules: [
      {
        trigger: { event: "on_save_failed" },
        condition: [],
        effect: { kind: "apply_status", status: "charmed", target: "target" },
        adjudication: "engine",
      },
    ],
  };

  bindCapabilities(caster.actor.uuid, [
    { capability: HOLD_PERSON, item: holdItem },
    { capability: ottos, item: { id: "otto", type: "spell", name: "Otto's Irresistible Dance" } },
  ]);

  await fireSaveTriggers(usageMessage("u-otto", caster.doc, holdItem), [failed(victim.doc, "s-otto")]);

  assert.equal(victim.actor.statuses.has("restrained"), true, "Hold Person still lands");
  assert.equal(victim.actor.statuses.has("charmed"), false, "Otto's does not ride along");
});

test("a feat that watches any save still fires beside the spell that was used", () => {
  const used = { id: "hold", type: "spell" };
  assert.equal(bindingAppliesToActivity({ item: { id: "hold", type: "spell" } }, used), true);
  assert.equal(bindingAppliesToActivity({ item: { id: "otto", type: "spell" } }, used), false);
  assert.equal(bindingAppliesToActivity({ item: { id: "war-caster", type: "feat" } }, used), true);
  assert.equal(bindingAppliesToActivity({ item: undefined }, used), true);
});

function withEffects(actor: any) {
  actor.effects = [];
  actor.createEmbeddedDocuments = async (_type: string, data: any[]) => {
    const docs = data.map((d: any, i: number) => ({
      ...d,
      id: `ae-${actor.effects.length + i}`,
      async update(patch: any) {
        Object.assign(this, patch);
      },
    }));
    actor.effects.push(...docs);
    return docs;
  };
  return actor;
}

/** DDB Stunning Strike: one linked AE, stun on a failed save only. */
function failOnlySaveItem() {
  const activity: any = {
    id: "a1",
    type: "save",
    name: "Save",
    save: { ability: "con", dc: { value: 15 } },
    effects: [{ _id: "stun", onSave: false }],
  };
  const item: any = {
    id: "ss",
    type: "feat",
    name: "Stunning Strike",
    uuid: "Item.ss",
    system: { activities: { get: (id: string) => (id === "a1" ? activity : null) } },
  };
  activity.item = item;
  return { item, activity };
}

const CONSOLATION: Capability = {
  id: "hash-ss-consolation",
  label: "Stunning Strike",
  status: "compiled",
  rules: [
    {
      trigger: { event: "on_save_succeeded" },
      condition: [],
      effect: { kind: "grant_advantage", rollType: "attack", target: "self" },
      adjudication: "engine",
    },
    {
      trigger: { event: "on_save_succeeded" },
      condition: [],
      effect: { kind: "modify_speed", amount: { value: -15 }, target: "target" },
      adjudication: "engine",
    },
  ],
};

test("a succeeded save does not apply compiled consolation the item never declared", async () => {
  // The Beholder bought the Con save. The compiler still emitted 2024 Advantage + Speed on
  // `on_save_succeeded`. The sheet only has `onSave: false`. Do not recompile to "fix" this.
  const caster = creature("Monk", "Actor.monk");
  withEffects(caster.actor);
  const victim = creature("Beholder", "Actor.beholder");
  withEffects(victim.actor);
  place(caster.doc, victim.doc);
  const { item } = failOnlySaveItem();
  (globalThis as any).fromUuidSync = () => item;
  assert.deepEqual(validateCapability(CONSOLATION), { ok: true, errors: [], warnings: [] });
  bindCapabilities(caster.actor.uuid, [{ capability: CONSOLATION, item }]);

  await fireSaveTriggers(usageMessage("u-ss", caster.doc, item), [succeeded(victim.doc, "s-ss")]);

  assert.equal(caster.actor.effects.length, 0, "Monk must not gain Advantage");
  assert.equal(victim.actor.effects.length, 0, "Beholder Speed must not change");
});

test("Hold Person with no effect links still restrains on a failed save", async () => {
  // Unspecified `onSave` — the compiler is the only account. Gate 2 must not invent a fail-only
  // sheet and refuse the restrain.
  const caster = creature("Archmage", "Actor.archmage2");
  const victim = creature("Assassin", "Actor.assassin2");
  place(caster.doc, victim.doc);
  bindCapabilities(caster.actor.uuid, [{ capability: HOLD_PERSON }]);

  await fireSaveTriggers(usageMessage("u-hold-unspec", caster.doc), [failed(victim.doc, "s-hold-unspec")]);

  assert.equal(victim.actor.statuses.has("restrained"), true);
});
