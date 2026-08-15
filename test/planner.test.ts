import test from "node:test";
import assert from "node:assert/strict";

import { survivalOptions } from "../src/tactics/planner.js";
import { type Consideration, tierProfile } from "../src/tactics/tiers.js";

// The floor option, which is the whole of what is testable here without a scene. `planTurn` needs
// canvas, game.combat and a placed token; `survivalOptions` needs a board shape and a tier, so it is
// exported for this the way `timeoutChoice` is exported for the reaction tests.

function board(over: Record<string, unknown> = {}): any {
  return {
    self: { name: "Troll Limb", hpFraction: 1 },
    enemies: [{ name: "Rogwiz Ardue", distance: 60 }],
    allies: [],
    units: "ft",
    speed: 20,
    locomotion: { modes: { walk: 20 }, speed: 20 },
    ...over,
  };
}

const INSECT = tierProfile(1);

test("the floor is absent when the creature has something real to do", () => {
  // AN OPTION THAT MUST NEVER BEAT A REAL ONE HAS TO BE ABSENT, NOT CHEAP. `noise` is 0.85 at tier 1,
  // which flattens the distribution — so 0.35 against advancing's 0.9 was close to a coin flip and a
  // Troll Limb spent half its turns bellowing for help instead of walking. Lowering the score cannot
  // fix that; only declining to offer it can.
  const options = survivalOptions(board(), INSECT, true);
  assert.equal(
    options.find((o) => o.kind === "call"),
    undefined,
  );
});

test("…and present when it has nothing", () => {
  const options = survivalOptions(board(), INSECT, false);
  const call = options.find((o) => o.kind === "call");
  assert.ok(call, "with no other option the floor is the whole turn");
  assert.match(String(call?.reasons?.[0]), /nothing else it can reach/);
});

test("nothing in sight is offered on its own terms, whatever else was generated", () => {
  // This is the case the option exists for rather than a floor: with no enemy on the board there is
  // nothing better available, so it outscores a hazard step or an ally it could help.
  const options = survivalOptions(board({ enemies: [] }), INSECT, true);
  const call = options.find((o) => o.kind === "call");
  assert.ok(call);
  assert.ok(Number(call?.score) > 1, "the blind case is a real choice, not a floor");
  assert.match(String(call?.reasons?.[0]), /nothing in sight/);
});

test("a creature that cannot conceive of calling for help never does", () => {
  const mute = {
    ...INSECT,
    unlocks: INSECT.unlocks.filter((u: Consideration) => u !== "callForHelp"),
  };
  assert.equal(survivalOptions(board(), mute, false).length, 0);
});

test("fleeing competes on merit and is not suppressed by the floor rule", () => {
  // Deliberately unlike the call: a badly hurt creature SHOULD sometimes run instead of swinging, and
  // noise is what makes that a temperament rather than a threshold. Tier 2 is where it unlocks.
  const scared = tierProfile(2);
  const options = survivalOptions(board({ self: { name: "x", hpFraction: 0.1 } }), scared, true);
  const flee = options.find((o) => o.kind === "flee");
  assert.ok(flee, "still offered even though something else was generated");
  assert.ok(Number(flee?.score) > 1.4);
});
