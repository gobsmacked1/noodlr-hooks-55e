import { strict as assert } from "node:assert";
import { beforeEach, test } from "node:test";

import {
  __reset,
  all,
  exportAll,
  get,
  importAll,
  normalizeProse,
  proseHash,
  put,
  putOverride,
  remove,
  size,
} from "../src/capability/cache";
import type { Capability } from "../src/integration/capability";

const cap = (id: string, over: Partial<Capability> = {}): Capability => ({
  id,
  label: "Pack Tactics",
  prose: "The creature has Advantage on an attack roll against a creature if…",
  status: "compiled",
  rules: [
    {
      trigger: { event: "on_attack_roll" },
      condition: [{ kind: "within_distance", feet: { value: 5, units: "ft" }, of: "target" }],
      effect: { kind: "grant_advantage", rollType: "attack" },
      adjudication: "engine",
    },
  ],
  ...over,
});

beforeEach(() => __reset());

test("prose that differs only in markup or spacing hashes the same", () => {
  // This is where the corpus's 70% dedup rate comes from: 4,661 SRD features, 1,387 wordings.
  const a = "<p>The troll regains 15 Hit&nbsp;Points   at the start of each of its turns.</p>";
  const b = "The troll regains 15 Hit Points at the start of each of its turns.";
  assert.equal(proseHash(a), proseHash(b));
  assert.equal(
    normalizeProse(a),
    "the troll regains 15 hit points at the start of each of its turns.",
  );
});

test("prose that differs in a number does not", () => {
  // "15 or more Slashing damage" and "5 or more Slashing damage" are different rules.
  assert.notEqual(
    proseHash("takes 15 or more Slashing damage"),
    proseHash("takes 5 or more Slashing damage"),
  );
});

test("the key is 64 bits, because a collision hands one creature another's rules", () => {
  const key = proseHash("anything at all");
  assert.match(key, /^[0-9a-f]{16}$/);
});

test("keys spread across shards rather than piling into one", () => {
  // Regression: sharding on the key's FIRST digit put 400 wordings into 3 of the 16 buckets, because
  // djb2's high bits hardly move across short similar strings. The shard folds the whole key now.
  const buckets = new Map<string, number>();
  for (let i = 0; i < 400; i++) {
    put(cap(proseHash(`trait number ${i}`)));
  }
  for (const stored of all()) {
    let acc = 0;
    for (const char of stored.id) acc ^= parseInt(char, 16);
    const shard = (acc % 16).toString(16);
    buckets.set(shard, (buckets.get(shard) ?? 0) + 1);
  }
  assert.equal(buckets.size, 16, `expected all 16 buckets used, got ${buckets.size}`);
  assert.ok(Math.max(...buckets.values()) < 60, "no bucket should hold more than ~2x its share");
});

test("storing and reading back", () => {
  assert.equal(put(cap("aaaa000000000001")), true);
  assert.equal(size(), 1);
  assert.equal(get("aaaa000000000001")?.label, "Pack Tactics");
  assert.equal(remove("aaaa000000000001"), true);
  assert.equal(remove("aaaa000000000001"), false);
});

test("a locked capability survives recompilation", () => {
  // The whole reason `locked` exists: a GM who fixed a bad compile must not have it undone by a model
  // upgrade or a cache miss on the next scene load.
  putOverride(cap("bbbb000000000001", { label: "Fixed by hand", status: "locked" }));
  assert.equal(put(cap("bbbb000000000001", { label: "Recompiled" })), false);
  assert.equal(get("bbbb000000000001")?.label, "Fixed by hand");
});

test("a rejected capability stays rejected", () => {
  putOverride(cap("cccc000000000001", { status: "rejected" }));
  assert.equal(put(cap("cccc000000000001", { label: "Back again" })), false);
  assert.equal(get("cccc000000000001")?.status, "rejected");
});

test("a GM edit beats the lock, because that is the human having the last word", () => {
  putOverride(cap("dddd000000000001", { status: "locked", label: "Old" }));
  putOverride(cap("dddd000000000001", { status: "locked", label: "New" }));
  assert.equal(get("dddd000000000001")?.label, "New");
});

test("export carries mechanics and never book text", () => {
  put(cap("eeee000000000001"));
  putOverride(cap("eeee000000000002", { status: "rejected" }));
  const payload = exportAll();

  assert.equal(
    payload.capabilities.length,
    1,
    "a rejected capability is not somebody else's problem",
  );
  assert.equal(payload.capabilities[0].prose, undefined);
  assert.deepEqual(payload.capabilities[0].rules, cap("x").rules);
  assert.ok(get("eeee000000000001")?.prose, "the local copy still has something to show the GM");
});

test("import merges, and never overwrites what a human touched", () => {
  putOverride(cap("ffff000000000001", { label: "Mine, locked", status: "locked" }));
  const report = importAll({
    format: 1,
    capabilities: [
      cap("ffff000000000001", { label: "Theirs" }),
      cap("ffff000000000002", { label: "New to me" }),
    ],
  });

  assert.deepEqual(report, { added: 1, updated: 0, skipped: 1 });
  assert.equal(get("ffff000000000001")?.label, "Mine, locked");
  assert.equal(get("ffff000000000002")?.label, "New to me");
});

test("import is not a route around the export boundary", () => {
  importAll({
    format: 1,
    capabilities: [cap("1111000000000001", { prose: "verbatim book text" })],
  });
  assert.equal(get("1111000000000001")?.prose, undefined);
});

test("import survives a malformed payload rather than throwing mid-merge", () => {
  assert.deepEqual(importAll(null), { added: 0, updated: 0, skipped: 0 });
  assert.deepEqual(importAll({ capabilities: "nope" }), { added: 0, updated: 0, skipped: 0 });
  const report = importAll({ capabilities: [{ id: "" }, { id: "ok" }, cap("2222000000000001")] });
  assert.equal(report.added, 1);
  assert.equal(report.skipped, 2);
  assert.equal(all().length, 1);
});
