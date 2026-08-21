import test from "node:test";
import assert from "node:assert/strict";

import { rangedCovers, searchOptions, survivalOptions } from "../src/tactics/planner.js";
import { type Consideration, tierProfile } from "../src/tactics/tiers.js";

// The floor option, which is the whole of what is testable here without a scene. `planTurn` needs
// canvas, game.combat and a placed token; `survivalOptions` needs a board shape and a tier, so it is
// exported for this the way `timeoutChoice` is exported for the reaction tests.

function board(over: Record<string, unknown> = {}): any {
  return {
    self: { name: "Troll Limb", hpFraction: 1 },
    enemies: [{ name: "Rogwiz Ardue", distance: 60 }],
    allies: [],
    unseen: [],
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

const lost = { tokenId: "t1", name: "Rogwiz Ardue", point: { x: 0, y: 0 }, elevation: 0 };
const HOUND = tierProfile(2);

test("a creature that has lost its quarry goes to look, rather than calling for help", () => {
  // The bug this closes: `board.enemies` was every hostile in the tracker, so a creature walked
  // unerringly at somebody it could not see. With the awareness filter the enemy list is empty, and
  // the FLOOR must not be what fills the gap — "nothing in sight" scores above 1 and would otherwise
  // beat everything, leaving a hunter bellowing beside the bush its quarry stepped behind.
  const b = board({ enemies: [], unseen: [{ ...lost, distance: 40 }] });
  const search = searchOptions(b, HOUND, false)[0];
  assert.ok(search, "tier 2 is where object permanence starts");
  assert.equal(search.kind, "search");
  assert.ok(Number(search.score) > 1, "beats the blind floor, which is what makes it happen");
  assert.equal(search.lost?.name, "Rogwiz Ardue");
});

test("…and does not, once it is standing on the spot", () => {
  // Not zero: it still beats nothing at all, and a creature milling about where the trail went cold
  // reads correctly. What it must not do is outscore a genuine option.
  const b = board({ enemies: [], unseen: [{ ...lost, distance: 5 }] });
  const search = searchOptions(b, HOUND, false)[0];
  assert.ok(Number(search.score) < 1);
  assert.match(String(search.reasons?.[0]), /right about here/);
});

test("an ambush is not a search: nothing is offered for an enemy it never saw", () => {
  // `applyAwareness` drops an unseen enemy with no remembered sighting instead of adding it to
  // `unseen`, so there is nothing here to look for and nothing to give the ambush away.
  assert.equal(searchOptions(board({ enemies: [] }), HOUND, false).length, 0);
});

test("a mind with no object permanence does not search", () => {
  const b = board({ enemies: [], unseen: [{ ...lost, distance: 40 }] });
  assert.equal(searchOptions(b, INSECT, false).length, 0);
});

test("the blind floor knows the difference between an empty field and a lost quarry", () => {
  // `blind` gates on BOTH lists. Reading only `enemies` would score "nothing in sight" above 1 in
  // exactly the case a search exists for, and win.
  const b = board({ enemies: [], unseen: [{ ...lost, distance: 40 }] });
  const call = survivalOptions(b, HOUND, true).find((o) => o.kind === "call");
  assert.equal(call, undefined, "it can see nothing, but it knows perfectly well where to look");
});

test("hide is not offered when a ranged attack already reaches", () => {
  const burst = {
    available: true,
    kind: "attack",
    ranged: true,
    economy: "action",
    range: 150,
  };
  assert.equal(rangedCovers([burst] as any, 40), true);
  assert.equal(rangedCovers([burst] as any, 200), false);
  assert.equal(rangedCovers([{ ...burst, available: false }] as any, 40), false);
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
