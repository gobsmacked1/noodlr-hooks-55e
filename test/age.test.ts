import { strict as assert } from "node:assert";
import { beforeEach, test } from "node:test";

import { __reset, get, put, putOverride } from "../src/capability/cache";
import { currentProvenance, describeStamp, driftOf } from "../src/capability/age";
import { CAPABILITY_SCHEMA, type Capability } from "../src/integration/capability";

const cap = (id: string, over: Partial<Capability> = {}): Capability => ({
  id,
  label: "Regeneration",
  prose: "The troll regains 15 Hit Points at the start of each of its turns.",
  status: "compiled",
  rules: [],
  ...over,
});

beforeEach(() => {
  __reset();
  (globalThis as any).game = {
    world: { id: "w1" },
    version: "14.365",
    system: { id: "dnd5e", version: "5.3.3" },
    user: { isGM: true, id: "gm-1" },
    users: { activeGM: { id: "gm-1" } },
  };
});

test("a stamp matching this world is not drift", () => {
  const now = currentProvenance();
  const stored = cap("aaaa000000000001", {
    compiledIn: { foundry: "14.365", system: "dnd5e 5.3.3" },
    compiledBy: { model: "m", at: 1, schema: CAPABILITY_SCHEMA },
  });
  assert.deepEqual(driftOf(stored, now), []);
});

test("an unstamped entry is 'unstamped', never a version mismatch", () => {
  // The distinction is the whole reason `unstamped` exists as its own reason: there is no version to
  // mismatch, and reporting one would invent a fact about a ruleset nobody recorded.
  const now = currentProvenance();
  const reasons = driftOf(cap("bbbb000000000001"), now);
  assert.deepEqual(reasons, ["unstamped"]);
  assert.equal(describeStamp(cap("bbbb000000000001")), "");
});

test("a system or Foundry version change is reported, per axis", () => {
  const now = currentProvenance();
  assert.deepEqual(
    driftOf(
      cap("cccc000000000001", { compiledIn: { foundry: "14.365", system: "dnd5e 5.3.2" } }),
      now,
    ),
    ["system"],
  );
  assert.deepEqual(
    driftOf(
      cap("cccc000000000002", { compiledIn: { foundry: "14.360", system: "dnd5e 5.3.3" } }),
      now,
    ),
    ["foundry"],
  );
  assert.deepEqual(
    driftOf(
      cap("cccc000000000003", { compiledIn: { foundry: "13.351", system: "pf2e 6.0.0" } }),
      now,
    ),
    ["system", "foundry"],
  );
});

test("an older vocabulary is drift and a newer one is not", () => {
  // A cache written by a LATER build and read by an earlier one is a downgrade. The normaliser is what
  // has to cope with that; reporting it would tell the GM to re-buy a reading that is ahead of them.
  //
  // `now` is built by hand rather than read from CAPABILITY_SCHEMA, which is 1 today: `schema - 1` is
  // zero, and zero means "no vocabulary stated" rather than "vocabulary 0". So the shipped constant
  // cannot express an older-but-stated schema at all, and a test written against it asserts nothing.
  const now = { foundry: "14.365", system: "dnd5e 5.3.3", schema: 3 };
  const stamp = { foundry: "14.365", system: "dnd5e 5.3.3" };
  assert.deepEqual(
    driftOf(
      cap("dddd000000000001", { compiledIn: stamp, compiledBy: { model: "m", at: 1, schema: 2 } }),
      now,
    ),
    ["schema"],
  );
  assert.deepEqual(
    driftOf(
      cap("dddd000000000002", { compiledIn: stamp, compiledBy: { model: "m", at: 1, schema: 4 } }),
      now,
    ),
    [],
  );
});

test("an unstated vocabulary is not an old one", () => {
  // 0 is the absence of a number, and the two are read differently on purpose: `unstamped` already
  // says an entry is from before we recorded anything, and adding `schema` beside it would claim we
  // know which vocabulary it was written against.
  const now = { foundry: "14.365", system: "dnd5e 5.3.3", schema: 3 };
  const stamp = { foundry: "14.365", system: "dnd5e 5.3.3" };
  assert.deepEqual(driftOf(cap("dddd000000000003", { compiledIn: stamp }), now), []);
});

test("a schema is comparable with no environment stamp at all", () => {
  // Both axes are reported, because an entry from before `compiledIn` existed can ALSO be behind the
  // vocabulary, and collapsing the two would hide the actionable one.
  const now = { foundry: "14.365", system: "dnd5e 5.3.3", schema: 3 };
  const reasons = driftOf(
    cap("eeee000000000001", { compiledBy: { model: "m", at: 1, schema: 2 } }),
    now,
  );
  assert.deepEqual(reasons, ["schema", "unstamped"]);
});

test("storing stamps the world it was read in", () => {
  put(cap("ffff000000000001"));
  assert.deepEqual(get("ffff000000000001")?.compiledIn, {
    foundry: "14.365",
    system: "dnd5e 5.3.3",
  });
  assert.deepEqual(driftOf(get("ffff000000000001")!, currentProvenance()), []);
});

test("Lock is a free answer to drift, because a GM who checked it has certified it", () => {
  // The load-bearing half of the report: a version bump must not become a bill. Recompile buys a
  // fresh reading; Lock records that a human read this one against the ruleset in front of them, and
  // `putOverride` restamps so the row stops asking.
  putOverride(cap("1111000000000001", { compiledIn: { foundry: "13.351", system: "dnd5e 5.3.2" } }));
  const stored = get("1111000000000001")!;
  assert.deepEqual(stored.compiledIn, { foundry: "14.365", system: "dnd5e 5.3.3" });
  assert.deepEqual(driftOf(stored, currentProvenance()), []);
});

test("an unreadable world compares as nothing to say, rather than as drift on every row", () => {
  // A stamp that cannot be read must not manufacture a mismatch: every cached reading in the world
  // would light up at once, which is the noise that teaches a GM to ignore the line.
  (globalThis as any).game = { world: { id: "w1" } };
  const now = currentProvenance();
  assert.equal(now.system, "");
  assert.equal(now.foundry, "");
  assert.deepEqual(
    driftOf(cap("2222000000000001", { compiledIn: { foundry: "9.9", system: "dnd5e 1.0" } }), now),
    [],
  );
});

test("what a reading was made against reads as a sentence", () => {
  assert.equal(
    describeStamp(
      cap("3333000000000001", {
        compiledIn: { foundry: "14.365", system: "dnd5e 5.3.3" },
        compiledBy: { model: "m", at: 1, schema: 2 },
      }),
    ),
    "dnd5e 5.3.3, Foundry 14.365, vocabulary 2",
  );
});
