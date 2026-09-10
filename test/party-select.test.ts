import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  extraCharacterIds,
  pickCharacterToKeep,
  type PartySelectToken,
} from "../src/rules/party-select";

function pc(id: string, actorId = id): PartySelectToken {
  return { id, name: id, actorType: "character", actorId };
}

function npc(id: string): PartySelectToken {
  return { id, name: id, actorType: "npc", actorId: id };
}

test("out of combat a party multi-select is left alone", () => {
  const extras = extraCharacterIds([pc("monkey"), pc("fig")], { combatStarted: false });
  assert.deepEqual(extras, []);
});

test("one character plus a monster is not a linked party", () => {
  const extras = extraCharacterIds([pc("monkey"), npc("beholder")], {
    combatStarted: true,
    currentTokenId: "beholder",
  });
  assert.deepEqual(extras, []);
});

test("in combat the current combatant is the one character kept", () => {
  const tokens = [pc("monkey"), pc("fig"), npc("beholder")];
  const extras = extraCharacterIds(tokens, {
    combatStarted: true,
    currentTokenId: "fig",
    assignedActorId: "monkey-actor",
  });
  assert.deepEqual(extras, ["monkey"]);
  assert.equal(pickCharacterToKeep(tokens.filter((t) => t.actorType === "character"), {
    combatStarted: true,
    currentTokenId: "fig",
  }), "fig");
});

test("with no current combatant in the set, the assigned character wins", () => {
  const extras = extraCharacterIds([pc("monkey", "monk-actor"), pc("fig", "fig-actor")], {
    combatStarted: true,
    currentTokenId: "beholder",
    assignedActorId: "fig-actor",
  });
  assert.deepEqual(extras, ["monkey"]);
});

test("with neither current nor assigned, the first character is kept", () => {
  const extras = extraCharacterIds([pc("monkey"), pc("fig")], { combatStarted: true });
  assert.deepEqual(extras, ["fig"]);
});
