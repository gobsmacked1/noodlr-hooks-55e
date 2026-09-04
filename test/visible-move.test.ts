import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  VISIBLE_POLL_MS,
  sameVisible,
  watchOrigin,
  watchVisibleMove,
  type VisiblePoint,
} from "../src/core/visible-move";

test("the shipped poll is 250 ms — faster is a tax nobody at the table can use", () => {
  assert.equal(VISIBLE_POLL_MS, 250);
});

const origin: VisiblePoint = { x: 0, y: 0, elevation: 0 };
const mid: VisiblePoint = { x: 200, y: 0, elevation: 0 };
const dest: VisiblePoint = { x: 800, y: 0, elevation: 0 };

function clock() {
  let t = 0;
  const steps: VisiblePoint[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
    steps,
    onStep: (from: VisiblePoint, to: VisiblePoint) => {
      steps.push(to);
      void from;
    },
  };
}

test("watchOrigin stays at the planned start when the first read is already the dest", () => {
  const doc = {
    x: dest.x,
    y: dest.y,
    elevation: 0,
    _source: { x: dest.x, y: dest.y, elevation: 0 },
  };
  assert.deepEqual(watchOrigin(doc, origin), origin);
});

test("watchOrigin uses the sprite when it has actually left the origin", () => {
  const doc = {
    object: { x: mid.x, y: mid.y, elevation: 0 },
    _source: { x: dest.x, y: dest.y, elevation: 0 },
  };
  assert.deepEqual(watchOrigin(doc, origin), mid);
});

test("an instant move still steps origin to the committed square", async () => {
  const c = clock();
  await watchVisibleMove({ _source: dest }, origin, {
    pollMs: 50,
    startGraceMs: 400,
    idleGraceMs: 400,
    budgetMs: 2000,
    stillMoving: () => false,
    read: () => dest,
    committed: () => dest,
    now: c.now,
    sleep: c.sleep,
    onStep: c.onStep,
  });
  assert.equal(c.steps.length, 1);
  assert.ok(sameVisible(c.steps[0], dest));
});

test("no step until the sprite actually moves", async () => {
  const c = clock();
  let pos = origin;
  let moving = false;
  const run = watchVisibleMove({}, origin, {
    pollMs: 50,
    startGraceMs: 200,
    idleGraceMs: 200,
    budgetMs: 5000,
    stillMoving: () => moving,
    read: () => pos,
    committed: () => dest,
    now: c.now,
    sleep: async (ms) => {
      c.sleep(ms);
      if (c.now() === 200) moving = true;
      if (c.now() === 400) pos = mid;
      if (c.now() === 800) {
        pos = dest;
        moving = false;
      }
    },
    onStep: c.onStep,
  });
  await run;
  assert.ok(c.steps.length >= 1);
  assert.ok(!sameVisible(c.steps[0], dest), "first step must not be the planned dest");
  assert.ok(sameVisible(c.steps[c.steps.length - 1], dest));
});

test("a read that already matches the committed dest while sliding is not a step", async () => {
  const c = clock();
  let moving = true;
  await watchVisibleMove({}, origin, {
    pollMs: 50,
    startGraceMs: 50,
    idleGraceMs: 100,
    budgetMs: 2000,
    stillMoving: () => moving,
    read: () => dest,
    committed: () => dest,
    now: c.now,
    sleep: async (ms) => {
      c.sleep(ms);
      if (c.now() >= 400) moving = false;
    },
    onStep: c.onStep,
  });
  assert.equal(c.steps.length, 1, "offer only when the slide ends, not at the planned dest");
  assert.ok(sameVisible(c.steps[0], dest));
});

test("shouldStop ends the watch without waiting out the budget", async () => {
  const c = clock();
  const moving = true;
  let stopped = false;
  await watchVisibleMove({}, origin, {
    pollMs: 50,
    startGraceMs: 50,
    idleGraceMs: 400,
    budgetMs: 60_000,
    stillMoving: () => moving,
    read: () => mid,
    committed: () => dest,
    now: c.now,
    sleep: async (ms) => {
      c.sleep(ms);
      if (c.now() >= 200) stopped = true;
    },
    shouldStop: () => stopped,
    onStep: c.onStep,
  });
  assert.ok(c.now() < 1000);
});
