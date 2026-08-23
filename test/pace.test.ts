import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  ROUND_SECONDS,
  animationDurationMs,
  sheetFeetPerRound,
  sheetSpacesPerSecond,
} from "../src/core/pace";

test("a 30 ft walk on a 5 ft grid is one space per second", () => {
  assert.equal(sheetSpacesPerSecond(30, 5), 1);
  assert.equal(ROUND_SECONDS, 6);
});

test("an 80 ft fly on a 5 ft grid is faster than a 30 ft walk", () => {
  const fly = sheetSpacesPerSecond(80, 5);
  const walk = sheetSpacesPerSecond(30, 5);
  assert.ok(fly !== null && walk !== null);
  assert.ok(fly > walk);
  assert.equal(fly, 80 / 5 / 6);
});

test("dragging 30 ft at a 30 ft walk takes exactly one round", () => {
  // Six squares, 100 px each, 1 space/sec → 6000 ms.
  const ms = animationDurationMs({ x: 0, y: 0 }, { x: 600, y: 0 }, 1, 100, 5);
  assert.equal(ms, 6000);
});

test("elevation is included, so a 10 ft climb at 30 ft walk is two seconds", () => {
  const ms = animationDurationMs({ x: 0, y: 0, elevation: 0 }, { x: 0, y: 0, elevation: 10 }, 1, 100, 5);
  assert.equal(ms, 2000);
});

test("jump spends walk speed and crawl is half of it", () => {
  const modes = { walk: 30, fly: 60 };
  assert.equal(sheetFeetPerRound({ action: "jump", modes }), 30);
  assert.equal(sheetFeetPerRound({ action: "crawl", modes }), 15);
  assert.equal(sheetFeetPerRound({ action: "fly", modes }), 60);
  assert.equal(sheetFeetPerRound({ action: "swim", modes }), 30);
});

test("blink and displace have no travel pace", () => {
  assert.equal(sheetFeetPerRound({ action: "blink", modes: { walk: 30 } }), null);
  assert.equal(sheetFeetPerRound({ action: "displace", modes: { walk: 30 } }), null);
});

test("an unreadable or non-positive speed is not a pace", () => {
  assert.equal(sheetFeetPerRound({ action: "walk", modes: {} }), null);
  assert.equal(sheetSpacesPerSecond(0, 5), null);
  assert.equal(sheetSpacesPerSecond(30, 0), null);
});
