import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  INITIATIVE_HOLD_MS,
  INITIATIVE_HOLD_TIMEOUT_CHOICE,
  combatantOwesInitiative,
  holdingInitiative,
  owingNames,
  shouldFreezePlayerActivity,
  shouldFreezePlayerMove,
  tokenOwesInitiative,
} from "../src/rules/initiative-hold";

// Two decisions that look "helpful" if inverted:
//
//   1. A timeout on the initiative roll must ROLL, never skip. Ignoring the die is how a player
//      used to walk and act before anyone had an order.
//   2. Initiative 0 is a real number. Treating it as "unrolled" would freeze a character who
//      already went.

test("INITIATIVE_HOLD_TIMEOUT_CHOICE is roll, never skip", () => {
  assert.equal(INITIATIVE_HOLD_TIMEOUT_CHOICE, "roll");
  assert.notEqual(INITIATIVE_HOLD_TIMEOUT_CHOICE, "skip");
  assert.equal(INITIATIVE_HOLD_MS, 30_000);
});

test("combatantOwesInitiative is only a missing number on a living combatant", () => {
  assert.equal(combatantOwesInitiative(null), false);
  assert.equal(combatantOwesInitiative({ initiative: null }), true);
  assert.equal(combatantOwesInitiative({ initiative: undefined }), true);
  assert.equal(combatantOwesInitiative({ initiative: 0 }), false);
  assert.equal(combatantOwesInitiative({ initiative: 14 }), false);
  assert.equal(combatantOwesInitiative({ initiative: null, isDefeated: true }), false);
  assert.equal(combatantOwesInitiative({ initiative: 12, isDefeated: true }), false);
});

test("tokenOwesInitiative matches the token, not a shared actor", () => {
  const combat = {
    combatants: [
      { tokenId: "pc", name: "Monk", initiative: null },
      { tokenId: "npc", name: "Skeleton", initiative: 18 },
    ],
  };
  assert.equal(tokenOwesInitiative(combat, "pc"), true);
  assert.equal(tokenOwesInitiative(combat, "npc"), false);
  assert.equal(tokenOwesInitiative(combat, "missing"), false);
  assert.equal(tokenOwesInitiative(null, "pc"), false);
  assert.equal(tokenOwesInitiative(combat, ""), false);
  assert.deepEqual(owingNames(combat), ["Monk"]);
});

test("shouldFreezePlayerMove is the player's WASD and drag during a hold", () => {
  const freeze = {
    isGM: false,
    holding: true,
    owes: true,
    method: "keyboard",
  };
  assert.equal(shouldFreezePlayerMove(freeze), true);
  assert.equal(shouldFreezePlayerMove({ ...freeze, method: "dragging" }), true);
  assert.equal(shouldFreezePlayerMove({ ...freeze, method: "" }), true);
  assert.equal(shouldFreezePlayerMove({ ...freeze, isGM: true }), false);
  assert.equal(shouldFreezePlayerMove({ ...freeze, holding: false }), false);
  assert.equal(shouldFreezePlayerMove({ ...freeze, owes: false }), false);
  assert.equal(shouldFreezePlayerMove({ ...freeze, method: "api" }), false);
  assert.equal(shouldFreezePlayerMove({ ...freeze, action: "displace" }), false);
  assert.equal(shouldFreezePlayerMove({ ...freeze, action: "noodlrForce" }), false);
});

test("shouldFreezePlayerActivity does not block the GM or an already-rolled token", () => {
  assert.equal(shouldFreezePlayerActivity({ isGM: false, holding: true, owes: true }), true);
  assert.equal(shouldFreezePlayerActivity({ isGM: true, holding: true, owes: true }), false);
  assert.equal(shouldFreezePlayerActivity({ isGM: false, holding: false, owes: true }), false);
  assert.equal(shouldFreezePlayerActivity({ isGM: false, holding: true, owes: false }), false);
});

test("holdingInitiative reads the combat flag and nothing else", () => {
  assert.equal(holdingInitiative(null), false);
  assert.equal(holdingInitiative({}), false);
  assert.equal(holdingInitiative({ flags: { "noodlr-hooks-55e": { initiativeHold: { at: 1 } } } }), true);
  assert.equal(
    holdingInitiative({
      getFlag: (ns: string, key: string) => (ns === "noodlr-hooks-55e" && key === "initiativeHold" ? { at: 1 } : null),
    }),
    true,
  );
});
