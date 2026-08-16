// Cache hygiene: which cached descriptors can never bind again.
//
// Only the classification is testable — the sweep itself walks `game.actors` and every scene's tokens.
// That is the right thing to pin anyway: the sweep is a loop, and the one judgement that can be got
// backwards destructively is which of `live` and `declined` wins for a wording that is both.

import test from "node:test";
import assert from "node:assert/strict";

import { classifyCache } from "../src/capability/hygiene";
import type { Declined } from "../src/capability/collect";

const cached = [
  { id: "aaa", label: "Regeneration", status: "compiled" },
  { id: "bbb", label: "Unarmed Strike", status: "compiled" },
  { id: "ccc", label: "Hide", status: "compiled" },
  { id: "ddd", label: "Rend", status: "locked" },
];

function declinedMap(entries: [string, Declined][]): Map<string, Declined> {
  return new Map(entries);
}

test("a wording some sheet still produces is not an orphan", () => {
  const orphans = classifyCache(cached, new Set(["aaa", "bbb", "ccc", "ddd"]), declinedMap([]));
  assert.deepEqual(orphans, [], "everything binds, so nothing is unreachable");
});

test("a wording the collector declines is certainly unreachable", () => {
  const orphans = classifyCache(
    cached,
    new Set(["aaa", "ddd"]),
    declinedMap([
      ["bbb", { label: "Unarmed Strike", why: "a general rule of the game", id: "bbb" }],
      ["ccc", { label: "Hide", why: "a general rule of the game", id: "ccc" }],
    ]),
  );
  assert.equal(orphans.length, 2);
  assert.deepEqual(
    orphans.map((o) => o.reason),
    ["declined", "declined"],
  );
  assert.equal(orphans[0].why, "a general rule of the game", "the collector's own sentence survives");
});

test("a wording nothing produced is only PROBABLY unreachable", () => {
  const orphans = classifyCache(cached, new Set(["aaa"]), declinedMap([]));
  assert.equal(orphans.length, 3);
  assert.ok(
    orphans.every((o) => o.reason === "absent"),
    "a compendium creature we did not walk looks exactly like this, so it is never pruned by default",
  );
});

test("BINDING ANYWHERE OUTRANKS BEING DECLINED SOMEWHERE", () => {
  // "Unarmed Strike" is declined on a character sheet, where it is the PHB glossary item, and is a real
  // ability on a monster carrying the same wording. Reading `declined` first would delete a working
  // descriptor in order to tidy up its duplicate — silently, and only discoverable by the ability
  // stopping working. This is the assertion that makes that a test failure instead.
  const orphans = classifyCache(
    cached,
    new Set(["aaa", "bbb", "ddd"]),
    declinedMap([["bbb", { label: "Unarmed Strike", why: "a general rule of the game", id: "bbb" }]]),
  );
  assert.deepEqual(
    orphans.map((o) => o.id),
    ["ccc"],
    "the one that binds nowhere is the only orphan",
  );
});

test("a human's edit is reported but carries its status, so a prune can spare it", () => {
  const orphans = classifyCache(cached, new Set(["aaa", "bbb", "ccc"]), declinedMap([]));
  assert.equal(orphans.length, 1);
  assert.equal(orphans[0].status, "locked", "pruneOrphans reads this and keeps it");
});
