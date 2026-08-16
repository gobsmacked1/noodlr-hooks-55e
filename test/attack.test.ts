import { strict as assert } from "node:assert";
import { beforeEach, test } from "node:test";

import { dispatchesFor, fireAttackTriggers, resetAttackDispatch } from "../src/capability/attack";
import { bindCapabilities, clearBindings } from "../src/capability/bindings";
import { __clearShadow } from "../src/capability/uses";
import { __damageLogInternals } from "../src/capability/damage-log";
import { validateCapability, type Capability } from "../src/integration/capability";

const damage = __damageLogInternals();

/**
 * The commonest engine-adjudicated `on_hit` rule in the live cache, and the one the direction test
 * hangs on: `npm run census:subset`-style peek over 1,022 wordings found 46 of 47 engine `on_hit`
 * rules pointing their effect at `target`, with no guard naming a subject at all. Every one of them
 * reads "when I hit something, do this TO the thing I hit" — so a dispatch that put the carrier in
 * `target` would poison the biter.
 */
const VENOMOUS_BITE: Capability = {
  id: "hash-venomous-bite",
  label: "Venomous Bite",
  status: "compiled",
  rules: [
    {
      trigger: { event: "on_hit" },
      condition: [],
      effect: { kind: "apply_status", status: "poisoned", target: "target" },
      adjudication: "engine",
    },
  ],
};

/**
 * The refusal specimen. 45 of 71 `on_hit` rules in the pre-doctrine cache were the ability's own
 * printed damage line read back — Fire Bolt compiling to "on a hit, deal 1d10 fire" — which dnd5e has
 * rolled off `damage.parts` since long before any of this existed. Dispatching the trigger without
 * `ctx.activity` doubles every one of them, in arithmetic, with nothing thrown and nothing logged.
 */
const RESTATED_DAMAGE: Capability = {
  id: "hash-restated",
  label: "Fire Bolt",
  status: "compiled",
  rules: [
    {
      trigger: { event: "on_hit" },
      condition: [],
      effect: {
        kind: "damage",
        amount: { dice: "1d10" },
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

/** An attack message shaped the way dnd5e writes one, with the speaker naming the attacker. */
function attackMessage(id: string, attackerToken: any, item?: any) {
  return {
    id,
    speaker: { scene: "scene-1", token: attackerToken.id },
    flags: { dnd5e: item ? { item: { uuid: "Item.weapon" }, activity: { id: "a1" } } : {} },
  };
}

beforeEach(() => {
  chat = [];
  damaged = [];
  clearBindings();
  __clearShadow();
  damage.reset();
  resetAttackDispatch();

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
  (globalThis as any).CONFIG = { statusEffects: [{ id: "poisoned", name: "Poisoned" }] };
});

function place(...docs: any[]) {
  (globalThis as any).canvas.scene.tokens.contents.push(...docs);
}

function tokenById(id: string): any {
  return (globalThis as any).canvas.scene.tokens.contents.find((t: any) => t.id === id) ?? null;
}

// ---- Who gets what ------------------------------------------------------------------------------

test("one dispatch per creature, and a miss is as much a verdict as a hit", () => {
  const a = { id: "t-a" };
  const b = { id: "t-b" };
  const c = { id: "t-c" };
  const dispatches = dispatchesFor({
    hits: [a, b],
    missed: [c],
    unresolved: [],
    margin: new Map(),
  } as any);
  assert.deepEqual(
    dispatches.map((d) => `${d.event}:${d.doc.id}`),
    ["on_hit:t-a", "on_hit:t-b", "on_miss:t-c"],
  );
});

test("an unresolved target gets no dispatch", () => {
  // Two identical tokens the target record cannot tell apart. `readHits` refuses to guess which was
  // hit and neither may be poisoned on the strength of a coin flip — the same rule the damage layer
  // already follows, and the reason `unresolved` is a third list rather than folded into `missed`.
  const dispatches = dispatchesFor({
    hits: [],
    missed: [],
    unresolved: [{ name: "Goblin", uuid: "Actor.gob", ac: 13 }],
    margin: new Map(),
  } as any);
  assert.deepEqual(dispatches, []);
});

// ---- Direction ------------------------------------------------------------------------------------

test("the carrier is the attacker and the effect lands on what it hit", async () => {
  const biter = creature("Giant Spider", "Actor.spider");
  const bitten = creature("Bianca", "Actor.bianca");
  place(biter.doc, bitten.doc);
  assert.deepEqual(validateCapability(VENOMOUS_BITE), { ok: true, errors: [], warnings: [] });
  bindCapabilities(biter.actor.uuid, [{ capability: VENOMOUS_BITE }]);

  await fireAttackTriggers(attackMessage("m1", biter.doc), {
    hits: [bitten.doc],
    missed: [],
    unresolved: [],
    margin: new Map(),
  } as any);

  assert.equal(bitten.actor.statuses.has("poisoned"), true, "the creature that was bitten");
  assert.equal(biter.actor.statuses.has("poisoned"), false, "…and not the one doing the biting");
});

test("the creature that was hit is also `trigger`, not the attacker", async () => {
  // `trigger` means "the creature this event is about" everywhere else in the vocabulary, and its old
  // fallback resolved to `attacker` — which is `self` here, because these fire from the attacker's
  // side. Without the explicit `trigger` on the context a guard reading `who: "trigger"` would test
  // the biter instead of the bitten, silently and in the plausible direction.
  const biter = creature("Giant Spider", "Actor.spider");
  const bitten = creature("Bianca", "Actor.bianca");
  bitten.actor.system.attributes.hp.value = 3;
  place(biter.doc, bitten.doc);

  const guarded: Capability = {
    ...VENOMOUS_BITE,
    id: "hash-guarded",
    rules: [
      {
        ...VENOMOUS_BITE.rules[0],
        condition: [{ kind: "hp_at_most", who: "trigger", amount: { value: 5 } } as any],
      },
    ],
  };
  bindCapabilities(biter.actor.uuid, [{ capability: guarded }]);

  await fireAttackTriggers(attackMessage("m2", biter.doc), {
    hits: [bitten.doc],
    missed: [],
    unresolved: [],
    margin: new Map(),
  } as any);
  assert.equal(bitten.actor.statuses.has("poisoned"), true);
});

// ---- The refusal ------------------------------------------------------------------------------------

test("a restated damage line is refused, because the system already rolled it", async () => {
  const caster = creature("Archmage", "Actor.archmage");
  const victim = creature("Bianca", "Actor.bianca");
  place(caster.doc, victim.doc);

  const activity = { name: "Fire Bolt", damage: { parts: [{ formula: "1d10", types: ["fire"] }] } };
  const item = { name: "Fire Bolt", system: { activities: { get: () => activity } } };
  (globalThis as any).fromUuidSync = () => item;

  // Validated here as well as in the direction tests, because this specimen only proves anything if
  // its damage is expressed the way the schema states it. A rule whose amount is misspelt resolves to
  // nothing, applies no damage, and passes this assertion for entirely the wrong reason.
  assert.deepEqual(validateCapability(RESTATED_DAMAGE), { ok: true, errors: [], warnings: [] });
  bindCapabilities(caster.actor.uuid, [{ capability: RESTATED_DAMAGE }]);
  await fireAttackTriggers(attackMessage("m3", caster.doc, item), {
    hits: [victim.doc],
    missed: [],
    unresolved: [],
    margin: new Map(),
  } as any);

  assert.deepEqual(damaged, [], "the cantrip's own 1d10 must not be rolled a second time");
});

test("…and a genuine rider on the same weapon still lands", async () => {
  // The allow direction, and the reason the match is on the exact formula rather than on "this rule
  // deals damage during an attack". A refusal here is damage a player is owed, with nothing saying so.
  const rogue = creature("Bianca", "Actor.bianca");
  const victim = creature("Troll", "Actor.troll");
  place(rogue.doc, victim.doc);

  const activity = {
    name: "Dagger",
    damage: { parts: [{ formula: "1d4 + 3", types: ["piercing"] }] },
  };
  const item = { name: "Dagger", system: { activities: { get: () => activity } } };
  (globalThis as any).fromUuidSync = () => item;

  const rider: Capability = {
    id: "hash-rider",
    label: "Envenomed Blade",
    status: "compiled",
    rules: [
      {
        trigger: { event: "on_hit" },
        condition: [],
        effect: {
          kind: "damage",
          amount: { dice: "2d6" },
          damageType: "poison",
          target: "target",
        },
        adjudication: "engine",
      },
    ],
  };
  assert.deepEqual(validateCapability(rider), { ok: true, errors: [], warnings: [] });
  bindCapabilities(rogue.actor.uuid, [{ capability: rider }]);
  await fireAttackTriggers(attackMessage("m4", rogue.doc, item), {
    hits: [victim.doc],
    missed: [],
    unresolved: [],
    margin: new Map(),
  } as any);

  assert.equal(damaged.length, 1);
  assert.equal(damaged[0].name, "Troll");
});

// ---- Once per attack ---------------------------------------------------------------------------------

test("a card read twice fires once", async () => {
  // Midi rewrites its card several times per attack and dnd5e re-renders on every flag write, so the
  // damage layer's own `consider` can reach a settled attack more than once. Keyed on the message, not
  // on the pair, because the whole attack is one event however many creatures it named.
  const biter = creature("Giant Spider", "Actor.spider");
  const bitten = creature("Bianca", "Actor.bianca");
  place(biter.doc, bitten.doc);
  bindCapabilities(biter.actor.uuid, [{ capability: VENOMOUS_BITE }]);

  const reading = {
    hits: [bitten.doc],
    missed: [],
    unresolved: [],
    margin: new Map(),
  } as any;
  await fireAttackTriggers(attackMessage("m5", biter.doc), reading);
  bitten.actor.statuses.delete("poisoned");
  await fireAttackTriggers(attackMessage("m5", biter.doc), reading);

  assert.equal(bitten.actor.statuses.has("poisoned"), false, "the second read must do nothing");
});

test("a token with no actor on the scene is skipped rather than thrown over", async () => {
  // An attack rolled from a sheet with nothing placed. Ordinary, and it must not take the attack down.
  await fireAttackTriggers(
    { id: "m6", speaker: { scene: "scene-1", token: "nobody" }, flags: {} },
    { hits: [], missed: [{ id: "t-x" }], unresolved: [], margin: new Map() } as any,
  );
  assert.deepEqual(damaged, []);
});
