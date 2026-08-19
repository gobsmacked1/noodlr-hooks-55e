import { strict as assert } from "node:assert";
import { test } from "node:test";

import { durationPayload, type DurationWorld } from "../src/capability/duration";

const combat: DurationWorld["combat"] = {
  id: "Combat.1",
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
  assert.equal(payload.duration.units, "turns");
  assert.equal(payload.duration.value, 1);
  assert.equal(payload.duration.expiry, "turnStart");
  assert.equal(payload.start?.combatant, "c-caster");
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
