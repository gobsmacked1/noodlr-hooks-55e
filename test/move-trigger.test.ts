import { strict as assert } from "node:assert";
import { beforeEach, test } from "node:test";

import {
  alreadyMoved,
  fireMoveTriggers,
  noteTokenTransformed,
  resetMoveDispatch,
  skipBecauseTransformed,
  tokenDeltaIsLocomotion,
  tokenDeltaIsTransform,
  TRANSFORM_GRACE_MS,
} from "../src/capability/move";
import { bindCapabilities, clearBindings } from "../src/capability/bindings";
import { onMoveDamageRefusal } from "../src/capability/describe";
import { __clearShadow } from "../src/capability/uses";
import { __damageLogInternals } from "../src/capability/damage-log";
import { validateCapability, type Capability } from "../src/integration/capability";

const damage = __damageLogInternals();

/** Ashardalon's Stride as the live cache compiled it: damage, target unset, 5 ft of self. */
const ASHARDALON: Capability = {
  id: "hash-ashardalon",
  label: "Ashardalon's Stride",
  status: "compiled",
  rules: [
    {
      trigger: { event: "on_move" },
      condition: [{ kind: "within_distance", feet: { value: 5, units: "ft" } }],
      effect: { kind: "damage", amount: { dice: "1d6" }, damageType: "fire" },
      uses: { max: 1, per: "turn" },
      adjudication: "engine",
    },
  ],
};

/** An explicit self-target is a real (if odd) rule and must still run. */
const BURN_SELF: Capability = {
  id: "hash-burn-self",
  label: "Cursed Stride",
  status: "compiled",
  rules: [
    {
      trigger: { event: "on_move" },
      condition: [],
      effect: { kind: "damage", amount: { value: 3 }, damageType: "fire", target: "self" },
      adjudication: "engine",
    },
  ],
};

/** A rider that names who it hits — the allow direction for move damage. */
const TRAIL: Capability = {
  id: "hash-trail",
  label: "Burning Trail",
  status: "compiled",
  rules: [
    {
      trigger: { event: "on_move" },
      condition: [],
      effect: { kind: "apply_status", status: "burning", target: "self" },
      adjudication: "engine",
    },
  ],
};

let chat: any[];
let damaged: Array<{ name: string; description: any }>;

function creature(name: string, uuid: string, xy = { x: 0, y: 0 }) {
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
    getActiveTokens() {
      return [doc];
    },
  };
  const doc: any = { id: `${uuid}-token`, name, actor, x: xy.x, y: xy.y, elevation: 0 };
  doc.object = doc;
  actor.token = doc;
  return { actor, doc };
}

beforeEach(() => {
  chat = [];
  damaged = [];
  clearBindings();
  __clearShadow();
  damage.reset();
  resetMoveDispatch();

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
  (globalThis as any).Roll = class {
    total = 4;
    async evaluate() {
      return this;
    }
  };
  (globalThis as any).CONFIG = {
    statusEffects: [{ id: "burning", name: "Burning" }],
  };
});

test("Ashardalon's unset damage target is refused rather than aimed at the mover", async () => {
  const caster = creature("Sorcerer", "Actor.sorc");
  assert.deepEqual(validateCapability(ASHARDALON), { ok: true, errors: [], warnings: [] });
  bindCapabilities(caster.actor.uuid, [{ capability: ASHARDALON }]);

  await fireMoveTriggers(caster.doc);
  assert.deepEqual(damaged, [], "the compiler left the victim unnamed; we do not guess the caster");
});

test("an explicit self-target still runs", async () => {
  const cursed = creature("Cursed", "Actor.cursed");
  assert.deepEqual(validateCapability(BURN_SELF), { ok: true, errors: [], warnings: [] });
  bindCapabilities(cursed.actor.uuid, [{ capability: BURN_SELF }]);

  await fireMoveTriggers(cursed.doc);
  assert.equal(damaged.length, 1);
  assert.equal(damaged[0].name, "Cursed");
});

test("the mover is the carrier, so a status on self lands on the creature that walked", async () => {
  const walker = creature("Monk", "Actor.monk");
  assert.deepEqual(validateCapability(TRAIL), { ok: true, errors: [], warnings: [] });
  bindCapabilities(walker.actor.uuid, [{ capability: TRAIL }]);

  await fireMoveTriggers(walker.doc);
  assert.equal(walker.actor.statuses.has("burning"), true);
});

test("a watcher bound on someone else does not fire when this token moves", async () => {
  // Crown of Radiance is the incoming reading: damage the thing that walked near me. Firing it
  // on the mover would invert `self` and `trigger`.
  const cleric = creature("Cleric", "Actor.cleric", { x: 0, y: 0 });
  const fiend = creature("Fiend", "Actor.fiend", { x: 200, y: 0 });
  const crown: Capability = {
    id: "hash-crown",
    label: "Crown of Radiance",
    status: "compiled",
    rules: [
      {
        trigger: { event: "on_move" },
        condition: [],
        effect: { kind: "damage", amount: { value: 8 }, damageType: "radiant", target: "trigger" },
        adjudication: "engine",
      },
    ],
  };
  bindCapabilities(cleric.actor.uuid, [{ capability: crown }]);

  await fireMoveTriggers(fiend.doc);
  assert.deepEqual(damaged, [], "the crown is not on the fiend");
});

test("the same destination inside the settle window fires once", async () => {
  const walker = creature("Monk", "Actor.monk");
  bindCapabilities(walker.actor.uuid, [{ capability: TRAIL }]);

  await fireMoveTriggers(walker.doc);
  walker.actor.statuses.delete("burning");
  await fireMoveTriggers(walker.doc);
  assert.equal(walker.actor.statuses.has("burning"), false);

  walker.doc.x = 100;
  resetMoveDispatch();
  await fireMoveTriggers(walker.doc);
  assert.equal(walker.actor.statuses.has("burning"), true);
});

test("alreadyMoved keys on destination, not on the token alone", () => {
  const walker = creature("Monk", "Actor.monk");
  assert.equal(alreadyMoved(walker.doc, 1_000), false);
  assert.equal(alreadyMoved(walker.doc, 1_100), true);
  walker.doc.x = 300;
  assert.equal(alreadyMoved(walker.doc, 1_200), false);
});

/** Investiture of Flame as the live cache compiled it: on_move, damage the trigger. */
const INVESTITURE: Capability = {
  id: "hash-investiture",
  label: "Investiture of Flame",
  status: "compiled",
  rules: [
    {
      trigger: { event: "on_move" },
      condition: [{ kind: "within_distance", feet: { value: 5, units: "ft" } }],
      effect: { kind: "damage", amount: { dice: "1d10" }, damageType: "fire", target: "trigger" },
      adjudication: "engine",
    },
  ],
};

test("on_move damage aimed at trigger is refused — that is the mover", async () => {
  const druid = creature("Drew Id", "Actor.drew");
  assert.deepEqual(validateCapability(INVESTITURE), { ok: true, errors: [], warnings: [] });
  bindCapabilities(druid.actor.uuid, [{ capability: INVESTITURE }]);

  await fireMoveTriggers(druid.doc);
  assert.deepEqual(damaged, [], "trigger on on_move is the walker; we do not burn them");
  assert.match(onMoveDamageRefusal(INVESTITURE.rules[0]), /trigger/);
});

test("a walk is locomotion; a Wild Shape recenter is not", () => {
  assert.equal(tokenDeltaIsLocomotion({ x: 100, y: 200 }), true);
  assert.equal(tokenDeltaIsLocomotion({ elevation: 5 }), true);
  assert.equal(tokenDeltaIsLocomotion({ hidden: true }), false);

  assert.equal(tokenDeltaIsTransform({ x: 50, y: 50, width: 2, height: 2 }), true);
  assert.equal(tokenDeltaIsLocomotion({ x: 50, y: 50, width: 2, height: 2 }), false);
  assert.equal(tokenDeltaIsTransform({ actorId: "Actor.owl", x: 50, y: 50 }), true);
  assert.equal(tokenDeltaIsTransform({ flags: { dnd5e: { isPolymorphed: true } } }), true);
  assert.equal(tokenDeltaIsTransform({ "flags.dnd5e.isPolymorphed": true, x: 50 }), true);
  assert.equal(tokenDeltaIsTransform({ x: 100, y: 200 }), false);
});

test("a follow-up x/y after a transform is skipped, a later walk is not", () => {
  const id = "token-drew";
  const t0 = 10_000;
  noteTokenTransformed(id, t0);
  assert.equal(skipBecauseTransformed(id, t0 + 100), true);
  assert.equal(skipBecauseTransformed(id, t0 + TRANSFORM_GRACE_MS - 1), true);
  assert.equal(skipBecauseTransformed(id, t0 + TRANSFORM_GRACE_MS), false);
});
