import { strict as assert } from "node:assert";
import { test } from "node:test";

import { durationPayload, type DurationWorld } from "../src/capability/duration";

const combatDoc = { id: "Combat.1" };

const combat: DurationWorld["combat"] = {
  id: "Combat.1",
  document: combatDoc,
  round: 2,
  turn: 1,
  sourceCombatantId: "c-caster",
  targetCombatantId: "c-target",
};

const v14: DurationWorld = { generation: 14, worldTime: 1000, combat };
const v13: DurationWorld = { generation: 13, worldTime: 1000, combat };

test("a one-turn duration with no until expires at the caster's next turn start", () => {
  const payload = durationPayload({ value: 1, units: "turns" }, undefined, v14);
  assert.ok(payload);
  // Remaining must be a ROUND, not an initiative slot — Foundry's units:"turns"
  // decrements on every combatant, which killed Ray of Frost before the wolves walked.
  assert.equal(payload.duration.units, "rounds");
  assert.equal(payload.duration.value, 1);
  assert.equal(payload.duration.expiry, "turnStart");
  assert.equal(payload.start?.combatant, "c-caster");
  assert.equal(payload.start?.combat, combatDoc);
});

test("start.combat is the Combat document, never a bare id", () => {
  const payload = durationPayload({ value: 1, units: "turns" }, "sourceStart", v14);
  assert.ok(payload);
  assert.equal(payload.start?.combat, combatDoc);
  assert.notEqual(typeof payload.start?.combat, "string");
});

test("without a document, a bare id is still written rather than omitting combat", () => {
  const world: DurationWorld = {
    generation: 14,
    worldTime: 1000,
    combat: { id: "Combat.orphan", sourceCombatantId: "c-caster" },
  };
  const payload = durationPayload({ value: 1, units: "turns" }, "sourceStart", world);
  assert.ok(payload);
  assert.equal(payload.start?.combat, "Combat.orphan");
});

test("a distance filed under duration is not a duration", () => {
  assert.equal(durationPayload({ value: 10, units: "ft" }, undefined, v14), null);
});

test("nothing at all is not a duration", () => {
  assert.equal(durationPayload(undefined, undefined, v14), null);
});

test("until combatEnd writes core's combatEnd without inventing a turn", () => {
  const payload = durationPayload(undefined, "combatEnd", v14);
  assert.ok(payload);
  assert.equal(payload.duration.expiry, "combatEnd");
});

test("targetEnd stamps the target's combatant, not the caster's", () => {
  const payload = durationPayload({ value: 1, units: "turns" }, "targetEnd", v14);
  assert.ok(payload);
  assert.equal(payload.duration.expiry, "turnEnd");
  assert.equal(payload.start?.combatant, "c-target");
});

test("minutes become seconds on v13 and stay minutes on v14", () => {
  const old = durationPayload({ value: 1, units: "minutes" }, undefined, v13);
  assert.ok(old);
  assert.equal(old.duration.seconds, 60);
  assert.equal(old.duration.rounds, undefined);

  const next = durationPayload({ value: 1, units: "minutes" }, undefined, v14);
  assert.ok(next);
  assert.equal(next.duration.units, "minutes");
  assert.equal(next.duration.value, 1);
  assert.equal(next.duration.expiry, undefined);
});

test("v13 writes turns on the old duration fields", () => {
  const payload = durationPayload({ value: 1, units: "turns" }, "sourceStart", v13);
  assert.ok(payload);
  assert.equal(payload.duration.turns, 1);
  assert.equal(payload.duration.startTime, 1000);
  assert.equal(payload.start, undefined);
});
