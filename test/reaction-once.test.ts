import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  alreadyProvoked,
  claimOffer,
  claimProvoke,
  clearAllProvokes,
  forgetProvokesFor,
  provokeKey,
  releaseOffer,
  resetOfferLock,
} from "../src/rules/reaction-once";

test("Reactive Strike is claimed once per enemy until the watcher's turn", () => {
  clearAllProvokes();
  assert.equal(claimProvoke("monk", "beholder", "enter"), true);
  assert.equal(alreadyProvoked("monk", "beholder", "enter"), true);
  assert.equal(claimProvoke("monk", "beholder", "enter"), false);
});

test("a second combatant is a different claim — one reaction is the ledger's job", () => {
  clearAllProvokes();
  assert.equal(claimProvoke("monk", "beholder", "enter"), true);
  assert.equal(claimProvoke("monk", "wolf", "enter"), true);
});

test("declining Reactive Strike does not eat the Opportunity Attack on the way out", () => {
  clearAllProvokes();
  assert.equal(claimProvoke("monk", "beholder", "enter"), true);
  assert.equal(claimProvoke("monk", "beholder", "leave"), true);
});

test("the watcher's next turn forgets only their claims", () => {
  clearAllProvokes();
  assert.equal(claimProvoke("monk", "beholder", "enter"), true);
  assert.equal(claimProvoke("fighter", "beholder", "enter"), true);
  forgetProvokesFor("monk");
  assert.equal(alreadyProvoked("monk", "beholder", "enter"), false);
  assert.equal(alreadyProvoked("fighter", "beholder", "enter"), true);
  assert.equal(claimProvoke("monk", "beholder", "enter"), true);
});

test("empty ids never swallow a reaction", () => {
  clearAllProvokes();
  assert.equal(claimProvoke("", "beholder", "enter"), true);
  assert.equal(claimProvoke("monk", "", "enter"), true);
  assert.equal(alreadyProvoked("", "beholder", "enter"), false);
});

test("the key is watcher, mover, then kind", () => {
  assert.equal(provokeKey("a", "b", "enter"), "a|b|enter");
});

test("a second offer for the same actor is refused while the first dialog is open", () => {
  resetOfferLock();
  assert.equal(claimOffer("Actor.monk"), true);
  assert.equal(claimOffer("Actor.monk"), false);
  releaseOffer("Actor.monk");
  assert.equal(claimOffer("Actor.monk"), true);
  resetOfferLock();
});
