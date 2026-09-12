import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  ammoRecovered,
  canSearchBattlefield,
  isPartySearcher,
  partyHeldTheField,
} from "../src/system/dnd5e-ammo";

test("half spent, round down — one arrow is gone", () => {
  assert.equal(ammoRecovered(0), 0);
  assert.equal(ammoRecovered(1), 0);
  assert.equal(ammoRecovered(2), 1);
  assert.equal(ammoRecovered(3), 1);
  assert.equal(ammoRecovered(13), 6);
  assert.equal(ammoRecovered(-1), 0);
  assert.equal(ammoRecovered(Number.NaN), 0);
});

test("the party held the field only after a real fight they did not lose", () => {
  assert.equal(partyHeldTheField({ hostiles: 3, standing: 0, mercy: false }), true);
  assert.equal(partyHeldTheField({ hostiles: 3, standing: 1, mercy: false }), false);
  assert.equal(partyHeldTheField({ hostiles: 0, standing: 0, mercy: false }), false);
  assert.equal(partyHeldTheField({ hostiles: 2, standing: 0, mercy: true }), false);
});

test("knocked out or dead cannot search; 1 HP awake can", () => {
  assert.equal(canSearchBattlefield({ hp: 12, dead: false, unconscious: false }), true);
  assert.equal(canSearchBattlefield({ hp: 1, dead: false, unconscious: false }), true);
  assert.equal(canSearchBattlefield({ hp: 1, dead: false, unconscious: true }), false);
  assert.equal(canSearchBattlefield({ hp: 0, dead: false, unconscious: false }), false);
  assert.equal(canSearchBattlefield({ hp: 8, dead: true, unconscious: false }), false);
  assert.equal(canSearchBattlefield({ hp: null, dead: false, unconscious: false }), false);
});

test("only the party side searches", () => {
  assert.equal(isPartySearcher({ character: true, playerOwned: false, friendly: false }), true);
  assert.equal(isPartySearcher({ character: false, playerOwned: true, friendly: false }), true);
  assert.equal(isPartySearcher({ character: false, playerOwned: false, friendly: true }), true);
  assert.equal(isPartySearcher({ character: false, playerOwned: false, friendly: false }), false);
});
