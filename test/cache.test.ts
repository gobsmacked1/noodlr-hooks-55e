import { strict as assert } from "node:assert";
import { beforeEach, test } from "node:test";

import {
  __reset,
  all,
  exportAll,
  flush,
  get,
  importAll,
  normalizeProse,
  proseHash,
  put,
  putOverride,
  remove,
  size,
  warm,
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

// ---- A fake disk, addressed by path ------------------------------------------------------------
//
// Every test below turns on the DIFFERENCE between a shard file that is absent and one that is
// present and empty, so the fake has to be a real file table rather than a blanket "not ok".

let disk: Map<string, string>;
let world: string | null;

const LEGACY = "assets/noodlr-hooks-55e/capabilities";
const MINE = "worlds/w1/assets/noodlr-hooks-55e/capabilities";

function writeDisk(folder: string, capabilities: Capability[]): void {
  const shards = new Map<string, Capability[]>();
  for (const capability of capabilities) {
    let acc = 0;
    for (const char of capability.id) acc ^= parseInt(char, 16);
    const shard = (acc % 16).toString(16);
    if (!shards.has(shard)) shards.set(shard, []);
    shards.get(shard)!.push(capability);
  }
  for (const [shard, list] of shards) {
    disk.set(`${folder}/${shard}.json`, JSON.stringify({ format: 1, capabilities: list }));
  }
}

beforeEach(() => {
  __reset();
  disk = new Map();
  world = "w1";

  (globalThis as any).game = {
    get world() {
      return world ? { id: world } : undefined;
    },
    user: { isGM: true, id: "gm-1" },
    users: { activeGM: { id: "gm-1" } },
  };
  (globalThis as any).foundry = {
    applications: {
      apps: {
        FilePicker: {
          createDirectory: async () => {},
          upload: async (_src: string, path: string, file: any) =>
            disk.set(`${path}/${file.name}`, file.parts.join("")),
        },
      },
    },
    utils: { getRoute: (p: string) => `/${p}` },
  };
  (globalThis as any).File = class {
    constructor(
      public parts: any[],
      public name: string,
    ) {}
  };
  (globalThis as any).fetch = async (url: string) => {
    const body = disk.get(String(url).replace(/^\//, ""));
    return body === undefined
      ? { ok: false, text: async () => "" }
      : { ok: true, text: async () => body };
  };
});

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

// ---- World scoping ------------------------------------------------------------------------------

test("a world writes and reads its shards under its own folder", async () => {
  put(cap("3333000000000001"));
  await flush();
  assert.ok(
    [...disk.keys()].every((path) => path.startsWith(MINE)),
    `expected only ${MINE}, got ${[...disk.keys()].join(" ")}`,
  );

  __reset();
  await warm();
  assert.equal(size(), 1, "and reads them back from there");
});

test("the pre-0.7.4 shared tree is never read, whatever is sitting in it", async () => {
  // Deliberately NOT a migration (user, 2026-08-17). A cache from another campaign is a plausible
  // route to a descriptor nobody in this world asked for, and that failure surfaces weeks later as a
  // rule behaving oddly rather than as anything traceable to an adoption.
  writeDisk(LEGACY, [cap("4444000000000001"), cap("4444000000000002")]);
  await warm();

  assert.equal(size(), 0, "a world starts empty and re-buys its own wordings");
  assert.equal(get("4444000000000001"), undefined);
});

test("a world whose id cannot be read stores nothing rather than falling back to the shared tree", async () => {
  // The only fallback available is the tree being retired, and a path built from `undefined` would
  // scatter shards into a folder literally named "undefined". With no world there is nothing to
  // cache for, so `flush` clears rather than warning on every attempt for ever.
  world = null;
  writeDisk(LEGACY, [cap("6666000000000001")]);
  const before = [...disk.keys()].sort();
  await warm();
  assert.equal(size(), 0, "the shared tree is not read");

  put(cap("6666000000000002"));
  assert.equal(await flush(), 0, "and nothing is written");
  assert.deepEqual([...disk.keys()].sort(), before, "no file anywhere was created or rewritten");
});
