import { strict as assert } from "node:assert";
import { test } from "node:test";

import { durationPayload, type DurationWorld } from "../src/capability/duration";
import { MODULE_ID } from "../src/constants";
import { stampFor } from "../src/rules/economy/ledger";
import { hasHalted, writeHalted } from "../src/rules/halt-state";
import {
  guardianDisengageApplies,
  hasSentinel,
  isSentinelItem,
} from "../src/system/dnd5e-sentinel";

function dnd5eGame(combat: unknown = null): void {
  const game = (globalThis as any).game ?? {};
  game.system = { ...(game.system ?? {}), id: "dnd5e" };
  game.combat = combat;
  (globalThis as any).game = game;
}

function feat(name: string, identifier = ""): any {
  return {
    name,
    type: "feat",
    system: { identifier },
    flags: {},
    getFlag: () => undefined,
  };
}

test("Guardian is the Disengage action, never granted Withdraw or Flyby", () => {
  assert.equal(guardianDisengageApplies(false, true), true);
  assert.equal(guardianDisengageApplies(true, true), false);
  assert.equal(guardianDisengageApplies(false, false), false);
  assert.equal(guardianDisengageApplies(true, false), false);
});

test("Halt expires at the target's turn end, not the Sentinel's", () => {
  const combatDoc = { id: "Combat.1" };
  const world: DurationWorld = {
    generation: 14,
    worldTime: 1000,
    combat: {
      id: "Combat.1",
      document: combatDoc,
      round: 2,
      turn: 1,
      sourceCombatantId: "c-sentinel",
      targetCombatantId: "c-mover",
    },
  };
  const payload = durationPayload({ value: 1, units: "turns" }, "targetEnd", world);
  assert.ok(payload);
  assert.equal(payload.duration.expiry, "turnEnd");
  assert.equal(payload.start?.combatant, "c-mover");
  assert.notEqual(payload.start?.combatant, "c-sentinel");
});

test("identifier sentinel is the feat; sentinel-shield and a named weapon are not", () => {
  assert.equal(isSentinelItem(feat("Sentinel", "sentinel")), true);
  assert.equal(isSentinelItem(feat("Sentinel")), true);
  assert.equal(isSentinelItem(feat("Sentinel Shield", "sentinel-shield")), false);
  assert.equal(
    isSentinelItem({ name: "Sentinel", type: "weapon", system: { identifier: "" }, flags: {} }),
    false,
  );
  assert.equal(
    isSentinelItem({
      name: "Sentinel Shield",
      type: "equipment",
      system: { identifier: "sentinel-shield" },
      flags: {},
    }),
    false,
  );
  assert.equal(
    isSentinelItem({
      name: "Homebrew",
      type: "feat",
      system: { identifier: "" },
      flags: { [MODULE_ID]: { sentinel: true } },
      getFlag: (ns: string, key: string) =>
        ns === MODULE_ID && key === "sentinel" ? true : undefined,
    }),
    true,
  );
});

test("hasSentinel reads the feat off the sheet", () => {
  dnd5eGame();
  assert.equal(hasSentinel({ items: [feat("Sentinel", "sentinel")] }), true);
  assert.equal(hasSentinel({ items: [feat("Sentinel Shield", "sentinel-shield")] }), false);
  assert.equal(hasSentinel({ items: [] }), false);
});

test("hasHalted is this turn, not the rest of the round", () => {
  const actor: any = {
    uuid: "Actor.mover",
    id: "mover",
    flags: {},
    getFlag: (ns: string, key: string) => actor.flags[ns]?.[key],
    setFlag: async (ns: string, key: string, value: unknown) => {
      actor.flags[ns] = { ...(actor.flags[ns] ?? {}), [key]: value };
    },
  };
  const combatant = { id: "c-mover", actor };
  const next = { id: "c-next", actor: { id: "next", uuid: "Actor.next" } };
  const combat: any = {
    started: true,
    id: "combat1",
    round: 1,
    turn: 0,
    turns: [combatant, next],
    combatants: [combatant, next],
    combatant,
  };
  dnd5eGame(combat);

  const stamp = stampFor(combat, combatant);
  actor.flags[MODULE_ID] = { halted: stamp };
  assert.equal(hasHalted(actor), true);

  combat.turn = 1;
  combat.combatant = next;
  assert.equal(stampFor(combat, combatant), stamp, "the economy stamp still names this round");
  assert.equal(hasHalted(actor), false, "Halt ends when they are no longer the current combatant");
});

test("writeHalted stamps the current turn so hasHalted can see it", async () => {
  const actor: any = {
    uuid: "Actor.mover",
    id: "mover",
    flags: {},
    getFlag: (ns: string, key: string) => actor.flags[ns]?.[key],
    setFlag: async (ns: string, key: string, value: unknown) => {
      actor.flags[ns] = { ...(actor.flags[ns] ?? {}), [key]: value };
    },
  };
  const combatant = { id: "c-mover", actor };
  const combat: any = {
    started: true,
    id: "combat1",
    round: 2,
    turn: 0,
    turns: [combatant],
    combatants: [combatant],
    combatant,
  };
  dnd5eGame(combat);
  assert.equal(await writeHalted(actor), true);
  assert.equal(actor.flags[MODULE_ID].halted, stampFor(combat, combatant));
  assert.equal(hasHalted(actor), true);
});
