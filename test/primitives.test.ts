import { strict as assert } from "node:assert";
import { beforeEach, test } from "node:test";

import {
  addCombatants,
  adjustUses,
  dealDamage,
  healActor,
  setCondition,
  summonedTokens,
  usesRemaining,
} from "../src/capability/primitives";

// These are the smallest fakes that still exercise the thing worth testing: the SHAPE of the call
// made into dnd5e. Every one of these primitives is a thin, deliberate wrapper, and the bugs they can
// have are all "passed the convenient argument that quietly means something else".

function fakeActor(overrides: Record<string, any> = {}) {
  const calls: any[] = [];
  return {
    name: "Troll",
    system: { attributes: { exhaustion: 0, hp: { value: 40, max: 84, temp: 0 } } },
    statuses: new Set<string>(),
    calls,
    // Clamped at the maximum, because that is what dnd5e does and it is the property `healActor`
    // now reads back: a heal that hits the ceiling has to be reportable as the nothing it was.
    async applyDamage(description: any, options: any) {
      calls.push({ method: "applyDamage", description, options });
      const hp = (this as any).system?.attributes?.hp;
      if (!hp) return;
      for (const part of Array.isArray(description) ? description : []) {
        const value = Number(part?.value) || 0;
        if (String(part?.type) === "healing") hp.value = Math.min(hp.max, hp.value + value);
        else hp.value = Math.max(0, hp.value - value);
      }
    },
    async applyTempHP(amount: number) {
      calls.push({ method: "applyTempHP", amount });
      const hp = (this as any).system?.attributes?.hp;
      if (hp) hp.temp = Math.max(Number(hp.temp) || 0, amount);
    },
    async toggleStatusEffect(id: string, options: any) {
      calls.push({ method: "toggleStatusEffect", id, options });
      if (options?.active) (this as any).statuses.add(id);
      else (this as any).statuses.delete(id);
      return true;
    },
    async update(changes: any) {
      calls.push({ method: "update", changes });
      if ("system.attributes.exhaustion" in changes) {
        (this as any).system.attributes.exhaustion = changes["system.attributes.exhaustion"];
      }
    },
    ...overrides,
  };
}

beforeEach(() => {
  (globalThis as any).game = { system: { id: "dnd5e" } };
  (globalThis as any).canvas = { grid: { size: 100 }, scene: { tokens: { contents: [] } } };
});

// ---- Damage and healing ----------------------------------------------------------------------

test("typed damage is described, never passed as a bare number", () => {
  // A bare number sets `options.ignore = true` inside dnd5e, which skips resistance and immunity.
  // A troll taking 20 fire and a troll taking 20 fire *through its resistances* are different fights.
  const actor = fakeActor();
  return dealDamage(actor, { amount: 20, damageType: "Fire" }).then((ok) => {
    assert.equal(ok, true);
    const call = actor.calls[0];
    assert.equal(call.method, "applyDamage");
    assert.deepEqual(call.description, [{ value: 20, type: "fire" }]);
  });
});

test("untyped damage is still a description", async () => {
  const actor = fakeActor();
  await dealDamage(actor, { amount: 7 });
  assert.deepEqual(actor.calls[0].description, [{ value: 7 }]);
});

test("zero and negative damage do nothing at all", async () => {
  const actor = fakeActor();
  assert.equal(await dealDamage(actor, { amount: 0 }), false);
  assert.equal(await dealDamage(actor, { amount: -5 }), false);
  assert.equal(actor.calls.length, 0);
});

test("a throwing system does not propagate out of a primitive", async () => {
  // A capability firing mid-turn must not take the turn down with it.
  const actor = fakeActor({
    applyDamage: async () => {
      throw new Error("midi exploded");
    },
  });
  assert.equal(await dealDamage(actor, { amount: 5, damageType: "acid" }), false);
});

test("healing goes through the damage pipeline as type healing", async () => {
  // Not a direct write to hp.value: the clamp at maximum, the hook and the dying layer all live on
  // this path, and Regeneration must behave exactly like a cure spell.
  const actor = fakeActor();
  assert.equal(await healActor(actor, { amount: 15 }), 15);
  assert.deepEqual(actor.calls[0].description, [{ value: 15, type: "healing" }]);
});

test("what is REPORTED is what landed, not what was asked for", async () => {
  // The Troll bug. Regeneration asks for 15 every turn and the clamp was already correct; what was
  // wrong was announcing 15 to a creature that gained 4, which reads as runaway healing.
  const actor = fakeActor();
  actor.system.attributes.hp.value = 80;
  assert.equal(await healActor(actor, { amount: 15 }), 4);
});

test("a heal on a creature at full health restores nothing, and says nothing", async () => {
  const actor = fakeActor();
  actor.system.attributes.hp.value = actor.system.attributes.hp.max;
  assert.equal(await healActor(actor, { amount: 15 }), 0);
});

test("an unreadable pool answers with the request, since there is nothing better", async () => {
  const actor = fakeActor({ system: { attributes: { exhaustion: 0 } } });
  assert.equal(await healActor(actor, { amount: 15 }), 15);
});

test("temporary hit points use the pool that does not stack", async () => {
  const actor = fakeActor();
  assert.equal(await healActor(actor, { amount: 9, temporary: true }), 9);
  assert.deepEqual(actor.calls[0], { method: "applyTempHP", amount: 9 });
});

test("temporary hit points that lose to a bigger pool are reported as the nothing they are", async () => {
  const actor = fakeActor();
  actor.system.attributes.hp.temp = 12;
  assert.equal(await healActor(actor, { amount: 9, temporary: true }), 0);
});

// ---- Conditions ------------------------------------------------------------------------------

test("a condition is toggled through the system so every watcher sees it", async () => {
  const actor = fakeActor();
  assert.equal(await setCondition(actor, "Prone", true), true);
  assert.deepEqual(actor.calls[0], {
    method: "toggleStatusEffect",
    id: "prone",
    options: { active: true },
  });
});

test("applying a condition a creature already has is a no-op, not a second effect", async () => {
  const actor = fakeActor();
  await setCondition(actor, "prone", true);
  actor.calls.length = 0;
  assert.equal(await setCondition(actor, "prone", true), false);
  assert.equal(actor.calls.length, 0);
});

test("exhaustion counts instead of toggling", async () => {
  const actor = fakeActor();
  assert.equal(await setCondition(actor, "exhaustion", true, { levels: 2 }), true);
  assert.deepEqual(actor.calls[0].changes, { "system.attributes.exhaustion": 2 });
  await setCondition(actor, "exhaustion", true, { levels: 1 });
  assert.equal(actor.system.attributes.exhaustion, 3);
  await setCondition(actor, "exhaustion", false, { levels: 3 });
  assert.equal(actor.system.attributes.exhaustion, 0);
});

test("exhaustion clamps at both ends rather than going negative or past six", async () => {
  const actor = fakeActor();
  await setCondition(actor, "exhaustion", true, { levels: 99 });
  assert.equal(actor.system.attributes.exhaustion, 6);
  assert.equal(await setCondition(actor, "exhaustion", true, { levels: 1 }), false);
  await setCondition(actor, "exhaustion", false, { levels: 99 });
  assert.equal(actor.system.attributes.exhaustion, 0);
});

// ---- Uses ------------------------------------------------------------------------------------

test("uses are written as SPENT, because remaining is derived", async () => {
  // Writing `system.uses.value` looks right and is discarded on the next data preparation, silently.
  const item = {
    name: "Breath Weapon",
    system: { uses: { max: 3, spent: 0 } },
    updates: [] as any[],
    async update(changes: any) {
      (this as any).updates.push(changes);
      (this as any).system.uses.spent = changes["system.uses.spent"];
    },
  };
  assert.equal(usesRemaining(item), 3);
  assert.equal(await adjustUses(item, -1), 2);
  assert.deepEqual(item.updates[0], { "system.uses.spent": 1 });
  assert.equal(await adjustUses(item, 1), 3);
});

test("uses never go past either end, and an unlimited item answers null", async () => {
  const item = {
    system: { uses: { max: 2, spent: 2 } },
    async update() {},
  };
  assert.equal(await adjustUses(item, -1), 0, "already exhausted stays exhausted");
  assert.equal(usesRemaining({ system: {} }), null);
  assert.equal(await adjustUses({ system: {} }, -1), null);
});

// ---- Initiative ------------------------------------------------------------------------------

function fakeCombat(existing: any[] = []) {
  const created: any[] = [];
  return {
    created,
    combatants: {
      find: (fn: (c: any) => boolean) => existing.find(fn),
    },
    async createEmbeddedDocuments(_type: string, data: any[]) {
      created.push(...data);
      return data;
    },
  };
}

test("a summoned creature can be slotted in immediately after its summoner", async () => {
  const combat = fakeCombat();
  (globalThis as any).game.combat = combat;
  const troll = { combatant: { initiative: 14 } };
  const limb = { document: { id: "tok-limb", actorId: "act-limb", parent: { id: "scene-1" } } };

  await addCombatants([limb], { after: troll });

  assert.equal(combat.created.length, 1);
  // Fractionally below, because core sorts initiative numerically descending and only breaks EXACT
  // ties by id. Anything else would leave the placement to a coin flip.
  assert.equal(combat.created[0].initiative, 13.99);
  assert.equal(combat.created[0].tokenId, "tok-limb");
  assert.equal(combat.created[0].sceneId, "scene-1");
});

test("an explicit count wins over a relative placement", async () => {
  const combat = fakeCombat();
  (globalThis as any).game.combat = combat;
  await addCombatants([{ document: { id: "t", parent: { id: "s" } } }], {
    initiative: 20,
    after: { combatant: { initiative: 3 } },
  });
  assert.equal(combat.created[0].initiative, 20);
});

test("with no placement asked for, no initiative is written and the tracker rolls as usual", async () => {
  const combat = fakeCombat();
  (globalThis as any).game.combat = combat;
  await addCombatants([{ document: { id: "t", parent: { id: "s" } } }]);
  assert.equal("initiative" in combat.created[0], false);
});

test("a token already in the fight is not added twice", async () => {
  const combat = fakeCombat([{ tokenId: "t" }]);
  (globalThis as any).game.combat = combat;
  const added = await addCombatants([{ document: { id: "t", parent: { id: "s" } } }]);
  assert.deepEqual(added, []);
  assert.equal(combat.created.length, 0);
});

test("out of combat, adding combatants is a no-op rather than an error", async () => {
  (globalThis as any).game.combat = null;
  assert.deepEqual(await addCombatants([{ document: { id: "t" } }]), []);
});

// ---- Summon bookkeeping ------------------------------------------------------------------------

test("summoned tokens are findable by their summoner, which is how a cap gets counted", () => {
  (globalThis as any).canvas.scene.tokens.contents = [
    { name: "Troll Limb", flags: { "noodlr-hooks-55e": { summonedBy: "Actor.troll" } } },
    { name: "Other Limb", flags: { "noodlr-hooks-55e": { summonedBy: "Actor.ogre" } } },
    { name: "Passing Goblin", flags: {} },
  ];
  assert.deepEqual(
    summonedTokens("Actor.troll").map((t: any) => t.name),
    ["Troll Limb"],
  );
  assert.equal(summonedTokens().length, 2);
});
