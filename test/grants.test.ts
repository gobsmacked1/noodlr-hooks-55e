import { strict as assert } from "node:assert";
import { test } from "node:test";

import { __grantsInternals } from "../src/capability/grants";
import { MODULE_ID } from "../src/constants";

const { rollTypesOf, matchesRoll, collect, actorOf, abilityOf, applyToConfig } = __grantsInternals();

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

test("an expired timed grant is not a grant", () => {
  const actor = {
    effects: [
      {
        duration: { expired: true },
        flags: {
          [MODULE_ID]: {
            timed: { kind: "grant_advantage", capability: "hash", params: { rollType: "attack" } },
          },
        },
      },
    ],
  };
  assert.equal(collect(actor, "attack", "", "").length, 0);
});

test("dnd5e attack config.subject is the Activity, not the Actor", () => {
  const barb = {
    documentName: "Actor",
    uuid: "Actor.barb",
    name: "Barb Arian",
    effects: [
      {
        flags: {
          [MODULE_ID]: {
            timed: { kind: "grant_advantage", capability: "hash", params: { rollType: "attack" } },
          },
        },
      },
    ],
  };
  const activity = { id: "atk", name: "Attack", ability: "str", actor: barb, uuid: "Actor.barb.Item.hal.Activity.atk" };
  assert.equal(actorOf({ subject: activity }), barb);
  assert.equal(actorOf({ subject: barb }), barb);
  assert.equal(abilityOf({ subject: activity }), "str");
});

test("applyToConfig stamps advantageMode, not only the advantage flag", () => {
  const config: { advantage?: boolean; rolls: Array<{ options: Record<string, unknown> }> } = {
    rolls: [{ options: {} }],
  };
  applyToConfig(config, [{ advantage: true, disadvantage: false, source: "Reckless Attack" }]);
  assert.equal(config.advantage, true);
  assert.equal(config.rolls[0].options.advantage, true);
  assert.equal(config.rolls[0].options.advantageMode, 1);
});
