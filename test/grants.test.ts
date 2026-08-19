import { strict as assert } from "node:assert";
import { test } from "node:test";

import { __grantsInternals } from "../src/capability/grants";
import { MODULE_ID } from "../src/constants";

const { rollTypesOf, matchesRoll, collect } = __grantsInternals();

test("rollType is matched as a closed set of three, not as free text", () => {
  assert.deepEqual([...rollTypesOf("attack")].sort(), ["attack"]);
  assert.deepEqual([...rollTypesOf("saving throw")].sort(), ["save"]);
  assert.deepEqual([...rollTypesOf("skill")].sort(), ["check"]);
  assert.deepEqual([...rollTypesOf("any")].sort(), ["attack", "check", "save"]);
});

test("an ability or skill filter refuses the wrong roll rather than granting it", () => {
  assert.equal(matchesRoll({ rollType: "save", ability: "wis" }, "save", "wis", ""), true);
  assert.equal(matchesRoll({ rollType: "save", ability: "wis" }, "save", "dex", ""), false);
  assert.equal(matchesRoll({ rollType: "attack" }, "save", "wis", ""), false);
  assert.equal(matchesRoll({ rollType: "check", skill: "ste" }, "check", "dex", "ste"), true);
  assert.equal(matchesRoll({ rollType: "check", skill: "ste" }, "check", "dex", "prc"), false);
});

test("a timed grant on the actor is found by flag, not by name", () => {
  const actor = {
    name: "Rogue",
    effects: [
      {
        name: "Reckless Attack: Advantage",
        flags: {
          [MODULE_ID]: {
            timed: {
              kind: "grant_advantage",
              capability: "hash-reckless",
              ruleIndex: 0,
              params: { rollType: "attack" },
            },
          },
        },
      },
    ],
  };
  const hits = collect(actor, "attack", "", "");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].advantage, true);
  assert.equal(hits[0].source, "hash-reckless");
  assert.equal(collect(actor, "save", "con", "").length, 0);
});
