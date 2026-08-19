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
import { isExecutable, validateCapability, type Capability } from "../src/integration/capability";

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
      if (entry.type !== "healing") return;
      const pool = (this as any).system.attributes.hp;
      pool.value = Math.min(pool.max, pool.value + entry.value);
      (this as any).healed.push(entry.value);
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
    release: { generation: 14 },
    time: { worldTime: 0 },
  };
  (globalThis as any).canvas = {
    grid: { size: 100, distance: 5 },
    scene: {
      tokens: { contents: [] },
      async createEmbeddedDocuments(_type: string, data: any[]) {
        created.push(...data);
        const docs = data.map((d, i) => ({ ...d, id: `summon-${created.length + i}` }));
        // Placed on the scene for real, so `summonedTokens` can count what is standing. A fake that
        // creates nothing cannot exercise a cap that reads the canvas back.
        (globalThis as any).canvas.scene.tokens.contents.push(...docs);
        return docs;
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
    assert.deepEqual(
      validateCapability(capability),
      { ok: true, errors: [], warnings: [] },
      capability.label,
    );
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

test("…and reports what it restored rather than what it asked for", async () => {
  // Reported from the first smoke test as a Troll "exploding". The clamp was always right; the chat
  // line was not, and a creature announcing "regains 15" every turn while sitting at full health is
  // indistinguishable from one gaining hit points without limit.
  const actor = troll(80);
  bindCapabilities(actor.uuid, [{ capability: REGENERATION }]);
  noteTurnStart(actor.uuid);
  damage.record({ uuid: actor.uuid }, 20, ["slashing"]);
  noteTurnStart(actor.uuid);

  await fireTrigger("on_turn_start", { self: { actor } });
  assert.equal(actor.system.attributes.hp.value, 84);
  assert.match(String(chat[0].content), /regains 4 hit points/);
});

test("…and stays quiet at full health, spending no use on a heal that cannot land", async () => {
  const actor = troll(84);
  bindCapabilities(actor.uuid, [{ capability: REGENERATION }]);
  noteTurnStart(actor.uuid);
  damage.record({ uuid: actor.uuid }, 20, ["slashing"]);
  noteTurnStart(actor.uuid);

  const outcomes = await fireTrigger("on_turn_start", { self: { actor } });
  assert.equal(outcomes[0].fired, false);
  assert.equal(chat.length, 0);
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

// ---- The runaway a play test found ----------------------------------------------------------------

/** The Loathsome Limbs shape with no allowance and no guards: what a miscompile looks like. */
const UNCAPPED_SUMMON: Capability = {
  id: "hash-uncapped",
  label: "Troll Spawn",
  status: "compiled",
  rules: [
    {
      trigger: { event: "on_turn_end" },
      condition: [],
      effect: { kind: "summon_creature", creature: "Troll Limb", count: { value: 1 } },
      adjudication: "engine",
    },
  ],
};

function limbActorExists(): void {
  (globalThis as any).game.actors.getName = (name: string) => ({
    name,
    async getTokenDocument(data: any) {
      return { toObject: () => ({ ...data, name }) };
    },
  });
}

test("a summoned creature may not summon, whatever its sheet says", async () => {
  // The stock bestiary closes the circle by itself: a Troll's Loathsome Limbs makes a Troll Limb, and
  // the Troll Limb's own Troll Spawn makes a Troll. Read as instructions rather than as once-a-day and
  // once-in-24-hours-on-a-12, that is exponential, and no allowance can stop it because each
  // generation gets a fresh ledger.
  const actor = troll();
  limbActorExists();
  bindCapabilities(actor.uuid, [{ capability: UNCAPPED_SUMMON }]);
  const token = {
    document: {
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      uuid: "Token.limb",
      flags: { "noodlr-hooks-55e": { summonedBy: "Token.troll" } },
    },
  };

  const outcomes = await fireTrigger("on_turn_end", { self: { actor, token } });
  assert.equal(outcomes[0].fired, false);
  assert.match(String(outcomes[0].reason), /summoned creature may not summon/);
  assert.equal(created.length, 0);
});

test("…and an uncapped one still stops filling the map", async () => {
  const actor = troll();
  limbActorExists();
  bindCapabilities(actor.uuid, [{ capability: UNCAPPED_SUMMON }]);
  const self = {
    actor,
    token: { document: { x: 0, y: 0, width: 1, height: 1, uuid: "Token.troll" } },
  };

  for (let round = 1; round <= 12; round++) await fireTrigger("on_turn_end", { self });
  assert.equal(created.length, 8, "the standing cap holds even with no allowance on the rule");
});

test("a creature that is out of the fight stops running its stat block", async () => {
  // Reported from the play test: a troll flagged dead went on summoning a limb a round. Only rules
  // that are ABOUT being at zero are exempt, since those cannot be gated on not having dropped.
  const actor = troll();
  actor.statuses.add("dead");
  limbActorExists();
  bindCapabilities(actor.uuid, [{ capability: UNCAPPED_SUMMON }]);
  const token = {
    document: {
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      uuid: "Token.troll",
      hasStatusEffect: (id: string) => id === "dead",
    },
  };

  const outcomes = await fireTrigger("on_turn_end", { self: { actor, token } });
  assert.equal(outcomes[0].fired, false);
  assert.match(String(outcomes[0].reason), /out of the fight/);
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

const SPEND: Capability = {
  id: "hash-spend",
  label: "Loathsome Limbs",
  status: "compiled",
  rules: [
    {
      trigger: { event: "on_turn_end" },
      condition: [],
      effect: { kind: "spend_resource", resource: "Loathsome Limbs", amount: { value: 1 } },
      adjudication: "engine",
    },
  ],
};

test("an empty pool is a refusal, not a spend of nothing", async () => {
  // `adjustUses` clamps, so a 4/day item at zero went on reporting "0 left" and SUCCESS forever. Where
  // a descriptor splits an ability into a spend rule and a separate effect rule, that success is the
  // only thing standing between the sheet's allowance and an unlimited one.
  const item = { name: "Loathsome Limbs", system: { uses: { max: 4, spent: 0 } } } as any;
  item.update = async (data: any) => {
    item.system.uses.spent = data["system.uses.spent"];
  };
  const actor = { ...troll(), items: [item] };
  bindCapabilities(actor.uuid, [{ capability: SPEND }]);

  for (let round = 1; round <= 6; round++) {
    const outcomes = await fireTrigger("on_turn_end", { self: { actor } });
    if (round <= 4) assert.equal(outcomes[0].fired, true, `round ${round}: ${outcomes[0].reason}`);
    else assert.match(String(outcomes[0].reason), /no uses left/);
  }
  assert.equal(item.system.uses.spent, 4);
});

/** The shape the play test produced: the allowance on one rule, the effect on another beside it. */
const SPLIT_SUMMON: Capability = {
  id: "hash-split",
  label: "Loathsome Limbs",
  status: "compiled",
  rules: [
    {
      trigger: { event: "on_turn_end" },
      condition: [],
      effect: { kind: "spend_resource", resource: "Loathsome Limbs", amount: { value: 1 } },
      adjudication: "engine",
    },
    {
      trigger: { event: "on_turn_end" },
      condition: [],
      effect: { kind: "summon_creature", creature: "Troll Limb", count: { value: 1 } },
      adjudication: "engine",
    },
  ],
};

test("a rule the creature could not pay for takes the rest of its capability down with it", async () => {
  // v0.6.0 made an empty pool report a refusal and it changed nothing at the table, because the summon
  // was a SEPARATE rule with an allowance of its own — i.e. none. So the fifth limb appeared beside a
  // chat line reading "0 left". A spend that fails has to stop what it was paying for.
  const item = { name: "Loathsome Limbs", system: { uses: { max: 4, spent: 0 } } } as any;
  item.update = async (data: any) => {
    item.system.uses.spent = data["system.uses.spent"];
  };
  const actor = { ...troll(), items: [item] };
  limbActorExists();
  bindCapabilities(actor.uuid, [{ capability: SPLIT_SUMMON }]);
  const self = {
    actor,
    token: { document: { x: 0, y: 0, width: 1, height: 1, uuid: "Token.troll" } },
  };

  for (let round = 1; round <= 6; round++) await fireTrigger("on_turn_end", { self });
  assert.equal(created.length, 4, "the sheet's allowance is what bounds the summon");

  const outcomes = await fireTrigger("on_turn_end", { self });
  assert.equal(outcomes[1].fired, false);
  assert.match(String(outcomes[1].reason), /not paid for/);
});

test("paying comes first, whatever order the rules are listed in", async () => {
  // Otherwise the guard is an accident of how the compiler happened to order its answer.
  const item = { name: "Loathsome Limbs", system: { uses: { max: 1, spent: 1 } } } as any;
  const actor = { ...troll(), items: [item] };
  limbActorExists();
  bindCapabilities(actor.uuid, [
    { capability: { ...SPLIT_SUMMON, rules: [...SPLIT_SUMMON.rules].reverse() } },
  ]);

  const outcomes = await fireTrigger("on_turn_end", {
    self: {
      actor,
      token: { document: { x: 0, y: 0, width: 1, height: 1, uuid: "Token.troll" } },
    },
  });
  assert.equal(created.length, 0);
  assert.ok(
    outcomes.some((o) => /not paid for/.test(String(o.reason))),
    "the summon listed first still waits for the spend listed second",
  );
});

// ---- Rest ------------------------------------------------------------------------------------------

/**
 * The realistic rest specimen, and it is realistic on purpose: a census of the live cache's 25
 * rest-triggered rules (`npm run census:rests`) found all nine engine-adjudicated ones using
 * `recover_resource`, so a `heal` on a rest would have been a simpler fake exercising a path nothing
 * in the world takes. The one liberty is the event: all nine are `on_long_rest`, and `on_short_rest` is
 * used here on purpose because it is the harder case — the event a warlock depends on, and the one a
 * LONG rest has to fire as well.
 */
const PACT_MAGIC: Capability = {
  id: "hash-pact-magic",
  label: "Pact Magic",
  status: "compiled",
  rules: [
    {
      trigger: { event: "on_short_rest" },
      condition: [],
      effect: { kind: "recover_resource", resource: "Pact Slots", amount: { value: 2 } },
      adjudication: "engine",
    },
  ],
};

test("a compiled rest rule runs, and is badged as running", async () => {
  const item = { name: "Pact Slots", system: { uses: { max: 2, spent: 2 } } } as any;
  item.update = async (data: any) => {
    item.system.uses.spent = data["system.uses.spent"];
  };
  const actor = { ...troll(), items: [item] };
  assert.deepEqual(validateCapability(PACT_MAGIC), { ok: true, errors: [], warnings: [] });
  assert.equal(
    isExecutable(PACT_MAGIC.rules[0]),
    true,
    "the trigger is wired, so the capability sheet must not call it inert",
  );

  bindCapabilities(actor.uuid, [{ capability: PACT_MAGIC }]);
  const outcomes = await fireTrigger("on_short_rest", { self: { actor } });
  assert.equal(outcomes[0].fired, true, outcomes[0].reason);
  assert.equal(item.system.uses.spent, 0);
});

test("…and recovering twice over is a no-op rather than an overflow", async () => {
  // The double-fire hazard, measured before it was designed around: two capabilities in the live cache
  // carry an `on_short_rest` AND an `on_long_rest` rule for the same mechanic, so a long rest runs both.
  // `adjustUses` clamps, which makes the redundancy free — the second recovery reports "already at 2"
  // and changes nothing. Were that clamp ever removed this would be a compiler bug with teeth.
  const item = { name: "Pact Slots", system: { uses: { max: 2, spent: 2 } } } as any;
  item.update = async (data: any) => {
    item.system.uses.spent = data["system.uses.spent"];
  };
  const actor = { ...troll(), items: [item] };
  bindCapabilities(actor.uuid, [{ capability: PACT_MAGIC }]);

  await fireTrigger("on_short_rest", { self: { actor } });
  const again = await fireTrigger("on_short_rest", { self: { actor } });
  assert.equal(item.system.uses.spent, 0, "no negative spend, no pool above its maximum");
  assert.equal(again[0].fired, false);
  assert.match(String(again[0].reason), /already at 2/);
});

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

test("…but an acting-client event is not narrowed, or a player's own rest recovers nothing", async () => {
  // The mirror of the test above, and the reason the gate reads a table rather than one flag.
  // `dnd5e.restCompleted` arrives on the client that rested, which for a character IS the player — so
  // the same gate that stops four assistant GMs summoning four limbs would discard every rest the
  // party takes, silently, on a table where the identical rule works for the GM's monsters.
  const item = { name: "Pact Slots", system: { uses: { max: 2, spent: 2 } } } as any;
  item.update = async (data: any) => {
    item.system.uses.spent = data["system.uses.spent"];
  };
  const actor = { ...troll(), items: [item] };
  bindCapabilities(actor.uuid, [{ capability: PACT_MAGIC }]);
  (globalThis as any).game.user = { isGM: false, id: "player-1" };
  (globalThis as any).game.users.activeGM = { id: "gm-1" };

  const outcomes = await fireTrigger("on_short_rest", { self: { actor } });
  assert.equal(outcomes[0]?.fired, true, outcomes[0]?.reason);
  assert.equal(item.system.uses.spent, 0);
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
            effect: { kind: "teleport", destination: "chosen location" },
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

/** Fire Bolt, compiled as 45 of the live cache's 71 `on_hit` rules were: its own printed damage. */
function restated(dice: string, damageType: string): Capability {
  return {
    id: `hash-firebolt-${dice}`,
    label: "Fire Bolt",
    status: "compiled",
    rules: [
      {
        trigger: { event: "on_activity_use" },
        condition: [],
        effect: { kind: "damage", amount: { dice }, damageType, target: "target" },
        adjudication: "engine",
      },
    ],
  };
}

const FIRE_BOLT_ACTIVITY = {
  name: "Fire Bolt",
  damage: { parts: [{ number: 1, denomination: 10, types: new Set(["fire"]), formula: "1d10" }] },
};

test("a rule restating the platform's own damage is refused rather than doubling it", async () => {
  // The doctrine now states the platform boundary, and this is here because a prompt cannot be relied
  // on never to re-emit something while a guard can. The failure it prevents is silent: the dice are
  // rolled twice, nothing throws, and a table just watches a ten-damage cantrip deal twenty.
  const actor = troll();
  const victim = troll();
  bindCapabilities(actor.uuid, [{ capability: restated("1d10", "fire") }]);

  const outcomes = await fireTrigger("on_activity_use", {
    self: { actor },
    target: { actor: victim },
    activity: FIRE_BOLT_ACTIVITY,
  });
  assert.equal(outcomes[0].fired, false);
  assert.match(String(outcomes[0].reason), /already rolls 1d10/);
});

test("…and a genuine rider on the same activity still runs", async () => {
  // The direction that must not break. A refused rider is damage a player is owed and has no way to
  // see was declined.
  const actor = troll();
  const victim = troll();
  bindCapabilities(actor.uuid, [{ capability: restated("2d6", "fire") }]);

  const outcomes = await fireTrigger("on_activity_use", {
    self: { actor },
    target: { actor: victim },
    activity: FIRE_BOLT_ACTIVITY,
  });
  assert.equal(outcomes[0].fired, true, outcomes[0].reason);
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

test("grant_advantage writes a timed effect rather than approximating the roll", async () => {
  const actor = withEffects(troll());
  bindCapabilities(actor.uuid, [
    {
      capability: {
        id: "hash-reckless",
        label: "Reckless Attack",
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
  assert.equal(outcomes[0].fired, true, outcomes[0].reason);
  assert.equal(actor.effects.length, 1);
  assert.equal(actor.effects[0].flags["noodlr-hooks-55e"].timed.kind, "grant_advantage");
  assert.equal(actor.effects[0].duration?.units, "rounds");
});

test("modify_speed refuses a costMultiplier it cannot write", async () => {
  const actor = withEffects(troll());
  bindCapabilities(actor.uuid, [
    {
      capability: {
        id: "hash-slow",
        label: "Slow",
        status: "compiled",
        rules: [
          {
            trigger: { event: "on_turn_start" },
            condition: [],
            effect: { kind: "modify_speed", costMultiplier: 2, target: "self" },
            adjudication: "engine",
          },
        ],
      },
    },
  ]);
  const outcomes = await fireTrigger("on_turn_start", { self: { actor } });
  assert.equal(outcomes[0].fired, false);
  assert.match(String(outcomes[0].reason), /costMultiplier/);
  assert.equal(actor.effects.length, 0);
});

test("modify_speed writes an ADD change on walk Speed", async () => {
  const actor = withEffects(troll());
  bindCapabilities(actor.uuid, [
    {
      capability: {
        id: "hash-frost",
        label: "Ray of Frost",
        status: "compiled",
        rules: [
          {
            trigger: { event: "on_hit" },
            condition: [],
            effect: { kind: "modify_speed", amount: { value: -10 }, target: "target" },
            adjudication: "engine",
          },
        ],
      },
    },
  ]);
  const victim = withEffects(troll());
  const outcomes = await fireTrigger("on_hit", {
    self: { actor },
    target: { actor: victim },
    activity: FIRE_BOLT_ACTIVITY,
  });
  assert.equal(outcomes[0].fired, true, outcomes[0].reason);
  assert.equal(victim.effects.length, 1);
  assert.equal(victim.effects[0].changes[0].key, "system.attributes.movement.walk");
  assert.equal(victim.effects[0].changes[0].value, "-10");
});
