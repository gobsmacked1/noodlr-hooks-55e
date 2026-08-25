import test from "node:test";
import assert from "node:assert/strict";

import {
  isLegendaryActivation,
  legendaryCost,
  legendaryRemaining,
} from "../src/system/dnd5e-legact.js";
import {
  isLegendaryAction,
  legendaryOptions,
  noteLegendaryAdvance,
  pickLegendaryAction,
  resetLegendaryAdvance,
  type LegendaryChoice,
} from "../src/tactics/legendary-act.js";
import type { CreatureAction } from "../src/tactics/actions.js";

function action(
  over: Partial<CreatureAction> & { activation?: string; cost?: number } = {},
): CreatureAction {
  const type = over.activation ?? "legendary";
  return {
    item: {},
    activity: { activation: { type, value: over.cost ?? 1 } },
    name: over.name ?? "Eye Rays",
    kind: over.kind ?? "attack",
    economy: "legendary",
    melee: over.melee ?? false,
    ranged: over.ranged ?? true,
    range: over.range ?? 120,
    available: over.available ?? true,
    depleting: false,
  };
}

const monk = {
  name: "Monkey",
  tokenId: "monk",
  distance: 10,
  elevation: 0,
  hpFraction: 0.8,
};

test("legendary and mythic activations are legendary actions; lair is not", () => {
  assert.equal(isLegendaryActivation("legendary"), true);
  assert.equal(isLegendaryActivation("mythic"), true);
  assert.equal(isLegendaryActivation("lair"), false);
  assert.equal(isLegendaryActivation("action"), false);
  assert.equal(isLegendaryAction(action({ activation: "lair" })), false);
  assert.equal(isLegendaryAction(action({ activation: "legendary" })), true);
});

test("an unreadable cost is 1, never free", () => {
  assert.equal(legendaryCost({ activation: {} }), 1);
  assert.equal(legendaryCost({ activation: { value: 0 } }), 1);
  assert.equal(legendaryCost({ activation: { value: 3 } }), 3);
});

test("remaining is max(0, value) and null when unreadable", () => {
  assert.equal(legendaryRemaining({ system: { resources: { legact: { value: 2 } } } }), 2);
  assert.equal(legendaryRemaining({ system: { resources: { legact: { value: -1 } } } }), 0);
  assert.equal(legendaryRemaining({}), null);
});

test("a 3-cost option is dropped when 1 remains; a 1-cost ray is kept", () => {
  const options = legendaryOptions(
    [action({ name: "Ray", cost: 1 }), action({ name: "Wing Attack", cost: 3 })],
    1,
    { elevation: 0, hpFraction: 1 },
    [monk],
  );
  assert.deepEqual(
    options.map((o) => o.action.name),
    ["Ray"],
  );
});

test("melee out of reach is not offered — a legendary action does not walk", () => {
  const bite = action({ name: "Tail", melee: true, ranged: false, range: 5, kind: "attack" });
  const options = legendaryOptions(
    [bite],
    3,
    { elevation: 0, hpFraction: 1 },
    [{ ...monk, distance: 30 }],
  );
  assert.equal(options.length, 0);
});

test("lair activations never become options even when they share the legendary economy", () => {
  const options = legendaryOptions(
    [action({ name: "Lair", activation: "lair", range: 120 })],
    3,
    { elevation: 0, hpFraction: 1 },
    [monk],
  );
  assert.equal(options.length, 0);
});

test("a legendary utility in range is offered", () => {
  const rays = action({ name: "Eye Rays", kind: "utility", range: 120 });
  const options = legendaryOptions([rays], 3, { elevation: 0, hpFraction: 1 }, [monk]);
  assert.equal(options.length, 1);
  assert.equal(options[0]?.target === "self" ? null : options[0]?.target?.name, "Monkey");
});

test("heal is only offered when bloodied", () => {
  const heal = action({ name: "Recover", kind: "heal", range: 0 });
  const healthy = legendaryOptions([heal], 3, { elevation: 0, hpFraction: 0.9 }, []);
  const hurt = legendaryOptions([heal], 3, { elevation: 0, hpFraction: 0.2 }, []);
  assert.equal(healthy.length, 0);
  assert.equal(hurt.length, 1);
  assert.equal(hurt[0]?.target, "self");
});

test("unavailable or spent options are dropped", () => {
  const spent = action({ name: "Spent", available: false });
  assert.equal(legendaryOptions([spent], 3, { elevation: 0, hpFraction: 1 }, [monk]).length, 0);
});

test("pick is deterministic for a given stream", () => {
  const options: LegendaryChoice[] = legendaryOptions(
    [action({ name: "A", range: 120 }), action({ name: "B", range: 120 })],
    3,
    { elevation: 0, hpFraction: 1 },
    [monk, { ...monk, name: "Other", tokenId: "o", distance: 40 }],
  );
  assert.ok(options.length >= 2);
  let n = 0;
  const rand = () => {
    n += 0.31;
    return n % 1;
  };
  const first = pickLegendaryAction(options, 0.2, rand);
  n = 0;
  const again = pickLegendaryAction(options, 0.2, rand);
  assert.equal(first?.action.name, again?.action.name);
  assert.equal(first?.target === "self" ? "self" : first?.target?.name, again?.target === "self" ? "self" : again?.target?.name);
});

test("the first tracker advance of a combat is not the end of another turn", () => {
  resetLegendaryAdvance();
  assert.equal(noteLegendaryAdvance({ id: "c1", combatant: { id: "beholder" } }), null);
  assert.equal(noteLegendaryAdvance({ id: "c1", combatant: { id: "monk" } }), "beholder");
  assert.equal(noteLegendaryAdvance({ id: "c1", combatant: { id: "beholder" } }), "monk");
});

test("a new combat does not inherit the previous fight's last slot", () => {
  resetLegendaryAdvance();
  noteLegendaryAdvance({ id: "old", combatant: { id: "x" } });
  assert.equal(noteLegendaryAdvance({ id: "new", combatant: { id: "y" } }), null);
});
