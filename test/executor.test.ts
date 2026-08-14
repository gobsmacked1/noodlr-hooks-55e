import { strict as assert } from "node:assert";
import { beforeEach, test } from "node:test";

import {
  bindCapabilities,
  capabilityAttacksPerAction,
  clearBindings,
} from "../src/capability/bindings";
import { fireTrigger } from "../src/capability/executor";
import { __clearShadow, noteRest, spendUse, usesLeft } from "../src/capability/uses";
import { __damageLogInternals, noteTurnStart } from "../src/capability/damage-log";
import { validateCapability, type Capability } from "../src/integration/capability";

const damage = __damageLogInternals();

// The Troll from the scenario that prompted this whole architecture. Every rule below is what a
// compiler is expected to produce from the stat block's own prose, so these tests double as the
// worked example the schema was designed against.

const REGENERATION: Capability = {
  id: "hash-regeneration",
  label: "Regeneration",
  status: "compiled",
  rules: [
    {
      trigger: { event: "on_turn_start" },
      condition: [
        { kind: "hp_at_least", amount: { value: 1 } },
        // "unless it took Acid or Fire damage since its last turn". Two things this one rule needed
        // that the mined vocabulary did not have: a WINDOW spanning the gap between the troll's turns,
        // and `negate`, because the guard is the absence of a match rather than a match.
        {
          kind: "damage_taken",
          window: "since_last_turn",
          damageTypes: ["acid", "fire"],
          negate: true,
        },
      ],
      effect: { kind: "heal", amount: { value: 15, units: "hp" } },
      adjudication: "engine",
    },
  ],
};

const LOATHSOME_LIMBS: Capability = {
  id: "hash-limbs",
  label: "Loathsome Limbs",
  status: "compiled",
  rules: [
    {
      trigger: { event: "on_turn_end" },
      condition: [
        {
          kind: "damage_taken",
          window: "this_turn",
          damageTypes: ["slashing"],
          minimum: { value: 15 },
        },
      ],
      effect: {
        kind: "summon_creature",
        creature: "Troll Limb",
        count: { value: 1 },
        placement: "self_space",
        disposition: "same_as_summoner",
      },
      uses: { max: 4, per: "day" },
      adjudication: "engine",
    },
  ],
};

const MULTIATTACK: Capability = {
  id: "hash-multiattack",
  label: "Multiattack",
  status: "compiled",
  rules: [
    {
      trigger: { event: "always" },
      condition: [],
      effect: { kind: "extra_attack", attacks: 3 },
      adjudication: "engine",
    },
  ],
};

// ---- Fakes -------------------------------------------------------------------------------------

let flags: Record<string, any>;
let chat: any[];
let created: any[];

function troll(hp = 40) {
  return {
    uuid: "Actor.troll",
    name: "Troll",
    type: "npc",
    statuses: new Set<string>(),
    flags: { "noodlr-hooks-55e": flags },
    system: { attributes: { hp: { value: hp, max: 84 } }, details: { type: { value: "giant" } } },
    healed: [] as number[],
    async applyDamage(description: any[]) {
      const entry = description[0];
      if (entry.type === "healing") (this as any).healed.push(entry.value);
    },
    async setFlag(_ns: string, key: string, value: any) {
      flags[key] = value;
    },
    getFlag(_ns: string, key: string) {
      return flags[key];
    },
  };
}

beforeEach(() => {
  flags = {};
  chat = [];
  created = [];
  clearBindings();
  __clearShadow();
  damage.reset();

  (globalThis as any).game = {
    system: { id: "dnd5e" },
    user: { isGM: true, id: "gm-1" },
    users: { activeGM: { id: "gm-1" } },
    combat: null,
    actors: { getName: () => null },
    packs: [],
  };
  (globalThis as any).canvas = {
    grid: { size: 100, distance: 5 },
    scene: {
      tokens: { contents: [] },
      async createEmbeddedDocuments(_type: string, data: any[]) {
        created.push(...data);
        return data.map((d, i) => ({ ...d, id: `summon-${i}` }));
      },
    },
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
});

// ---- The descriptors themselves ------------------------------------------------------------------

test("every Troll capability validates against the closed vocabulary", () => {
  for (const capability of [REGENERATION, LOATHSOME_LIMBS, MULTIATTACK]) {
    assert.deepEqual(validateCapability(capability), { ok: true, errors: [] }, capability.label);
  }
});

// ---- Regeneration ---------------------------------------------------------------------------------

test("Regeneration heals when nothing burned it", async () => {
  const actor = troll();
  bindCapabilities(actor.uuid, [{ capability: REGENERATION }]);
  noteTurnStart(actor.uuid);
  damage.record({ uuid: actor.uuid }, 20, ["slashing"]);
  noteTurnStart(actor.uuid);

  const outcomes = await fireTrigger("on_turn_start", { self: { actor } });
  assert.equal(outcomes[0].fired, true, outcomes[0].reason);
  assert.deepEqual(actor.healed, [15]);
  assert.match(String(chat[0].content), /Regeneration/);
});

test("…and does not when it did", async () => {
  const actor = troll();
  bindCapabilities(actor.uuid, [{ capability: REGENERATION }]);
  noteTurnStart(actor.uuid);
  damage.record({ uuid: actor.uuid }, 6, ["fire"]);
  noteTurnStart(actor.uuid);

  const outcomes = await fireTrigger("on_turn_start", { self: { actor } });
  assert.equal(outcomes[0].fired, false);
  assert.deepEqual(actor.healed, []);
  assert.equal(chat.length, 0, "a rule that did not fire says nothing at the table");
});

test("…and not at 0 hit points, because a dead troll stops regenerating", async () => {
  const actor = troll(0);
  bindCapabilities(actor.uuid, [{ capability: REGENERATION }]);
  noteTurnStart(actor.uuid);
  noteTurnStart(actor.uuid);
  const outcomes = await fireTrigger("on_turn_start", { self: { actor } });
  assert.equal(outcomes[0].fired, false);
});

test("out of combat Regeneration does not fire, because the window has no meaning", async () => {
  // `since_last_turn` is unevaluable with no initiative, and an unevaluable guard stops the rule
  // rather than widening to "has never been burned".
  const actor = troll();
  bindCapabilities(actor.uuid, [{ capability: REGENERATION }]);
  const outcomes = await fireTrigger("on_turn_start", { self: { actor } });
  assert.equal(outcomes[0].fired, false);
  assert.match(String(outcomes[0].reason), /damage_taken/);
});

// ---- Loathsome Limbs ------------------------------------------------------------------------------

test("Loathsome Limbs summons on enough slashing, and stops at four for the day", async () => {
  const actor = troll();
  bindCapabilities(actor.uuid, [{ capability: LOATHSOME_LIMBS }]);
  (globalThis as any).game.actors.getName = (name: string) =>
    name === "Troll Limb"
      ? {
          name,
          async getTokenDocument(data: any) {
            return { toObject: () => ({ ...data, name: "Troll Limb" }) };
          },
        }
      : null;

  for (let round = 1; round <= 5; round++) {
    noteTurnStart(actor.uuid);
    damage.record({ uuid: actor.uuid }, 16, ["slashing"]);
    const outcomes = await fireTrigger("on_turn_end", {
      self: {
        actor,
        token: { document: { x: 0, y: 0, width: 1, height: 1, uuid: "Token.troll" } },
      },
    });
    if (round <= 4) assert.equal(outcomes[0].fired, true, `round ${round}: ${outcomes[0].reason}`);
    else assert.match(String(outcomes[0].reason), /no uses left/);
  }
  assert.equal(created.length, 4);
});

test("…and not on the wrong damage type, however much of it there is", async () => {
  const actor = troll();
  bindCapabilities(actor.uuid, [{ capability: LOATHSOME_LIMBS }]);
  noteTurnStart(actor.uuid);
  damage.record({ uuid: actor.uuid }, 40, ["bludgeoning"]);
  const outcomes = await fireTrigger("on_turn_end", { self: { actor } });
  assert.equal(outcomes[0].fired, false);
  assert.equal(created.length, 0);
});

test("a use is only spent when the effect actually happened", async () => {
  // The limb cannot be found, so nothing is placed. Charging the day's allowance for a summon that
  // never appeared would silently cost the creature a limb.
  const actor = troll();
  bindCapabilities(actor.uuid, [{ capability: LOATHSOME_LIMBS }]);
  noteTurnStart(actor.uuid);
  damage.record({ uuid: actor.uuid }, 16, ["slashing"]);

  const outcomes = await fireTrigger("on_turn_end", { self: { actor } });
  assert.equal(outcomes[0].fired, false);
  const left = usesLeft(actor, "hash-limbs:0", { max: 4, per: "day" }, null, null);
  assert.equal(left.spent, 0);
});

// ---- Rest ------------------------------------------------------------------------------------------

test("a rest gives a rest-scoped allowance back, and the short one does not refresh the daily", async () => {
  // Every stamp here is derived from a counter on the actor, and nothing was bumping it — so a 1/day
  // rule spent its charge once and stayed spent for the campaign. `noteRest` is what the
  // `dnd5e.restCompleted` listener calls.
  const actor = troll();
  const daily = { max: 1, per: "day" } as const;
  const perShort = { max: 1, per: "short_rest" } as const;

  await spendUse(actor, "daily", daily, null, null);
  await spendUse(actor, "short", perShort, null, null);
  assert.equal(usesLeft(actor, "daily", daily, null, null).remaining, 0);
  assert.equal(usesLeft(actor, "short", perShort, null, null).remaining, 0);

  await noteRest(actor, false);
  assert.equal(
    usesLeft(actor, "short", perShort, null, null).remaining,
    1,
    "a short rest recharges",
  );
  assert.equal(usesLeft(actor, "daily", daily, null, null).remaining, 0, "but not the daily one");

  await noteRest(actor, true);
  assert.equal(usesLeft(actor, "daily", daily, null, null).remaining, 1);
});

test("the ledger keeps what was spent since the rest, rather than being cleared by it", async () => {
  // The stamp goes stale; nothing is deleted. That is what makes a use spent before a reload still
  // spent after one, and it must survive a rest for the same reason.
  const actor = troll();
  const daily = { max: 2, per: "day" } as const;
  await spendUse(actor, "daily", daily, null, null);
  await noteRest(actor, true);
  await spendUse(actor, "daily", daily, null, null);
  assert.equal(
    usesLeft(actor, "daily", daily, null, null).spent,
    1,
    "only the post-rest use counts",
  );
});

// ---- Multiattack -----------------------------------------------------------------------------------

test("a compiled Multiattack answers the action ledger", () => {
  const actor = troll();
  assert.equal(capabilityAttacksPerAction(actor), null, "nothing bound, nothing claimed");
  bindCapabilities(actor.uuid, [{ capability: MULTIATTACK }]);
  assert.equal(capabilityAttacksPerAction(actor), 3);
});

test("a rejected capability claims nothing and fires nothing", async () => {
  const actor = troll();
  bindCapabilities(actor.uuid, [
    { capability: { ...MULTIATTACK, status: "rejected" } },
    { capability: { ...REGENERATION, status: "rejected" } },
  ]);
  assert.equal(capabilityAttacksPerAction(actor), null);
  assert.deepEqual(await fireTrigger("on_turn_start", { self: { actor } }), []);
});

// ---- The guard rails --------------------------------------------------------------------------------

test("only the primary GM executes, or every assistant summons their own limbs", async () => {
  const actor = troll();
  bindCapabilities(actor.uuid, [{ capability: REGENERATION }]);
  (globalThis as any).game.users.activeGM = { id: "gm-2" };
  assert.deepEqual(await fireTrigger("on_turn_start", { self: { actor } }), []);
});

test("a rule left to the GM is reported, never performed", async () => {
  const actor = troll();
  bindCapabilities(actor.uuid, [
    {
      capability: {
        id: "hash-gm",
        label: "Ancient Grudge",
        status: "compiled",
        rules: [
          {
            trigger: { event: "on_turn_start" },
            condition: [],
            effect: { kind: "other", note: "the GM decides whether the grudge applies" },
            adjudication: "gm",
            note: "ask the table",
          },
        ],
      },
    },
  ]);
  const outcomes = await fireTrigger("on_turn_start", { self: { actor } });
  assert.equal(outcomes[0].fired, false);
  assert.match(String(outcomes[0].reason), /GM/);
});

test("an effect with no executor is inert rather than approximated", async () => {
  const actor = troll();
  bindCapabilities(actor.uuid, [
    {
      capability: {
        id: "hash-inert",
        label: "Frightful Presence",
        status: "compiled",
        rules: [
          {
            trigger: { event: "on_turn_start" },
            condition: [],
            effect: { kind: "grant_advantage", rollType: "attack" },
            adjudication: "engine",
          },
        ],
      },
    },
  ]);
  const outcomes = await fireTrigger("on_turn_start", { self: { actor } });
  assert.equal(outcomes[0].fired, false);
  assert.match(String(outcomes[0].reason), /no executor/);
});

test("a descriptor that throws does not take the turn down with it", async () => {
  const actor = troll();
  actor.applyDamage = async () => {
    throw new Error("the sheet is broken");
  };
  bindCapabilities(actor.uuid, [{ capability: REGENERATION }]);
  noteTurnStart(actor.uuid);
  noteTurnStart(actor.uuid);
  const outcomes = await fireTrigger("on_turn_start", { self: { actor } });
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].fired, false);
});

test("nothing bound means nothing happens, which is the no-compiler world", async () => {
  assert.deepEqual(await fireTrigger("on_turn_start", { self: { actor: troll() } }), []);
});
