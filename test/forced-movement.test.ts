import { strict as assert } from "node:assert";
import { afterEach, test } from "node:test";

import {
  FORCE_ACTION,
  beginForced,
  endForced,
  isForcedMovement,
} from "../src/rules/shove";

function doc(id = "beholder", extras: Record<string, any> = {}) {
  return { id, name: "Beholder", ...extras };
}

afterEach(() => {
  endForced(doc());
});

test("empty movement is not forced", () => {
  assert.equal(isForcedMovement({}), false);
  assert.equal(isForcedMovement({ origin: { x: 0, y: 0 } }, undefined, doc()), false);
});

test("noodlrForced on the operation is forced", () => {
  assert.equal(isForcedMovement({}, { noodlrForced: true }), true);
});

test("riding follow is forced", () => {
  assert.equal(isForcedMovement({}, { noodlrRiding: "follow" }), true);
});

test("a displace or noodlrForce waypoint is forced", () => {
  assert.equal(
    isForcedMovement({ passed: { waypoints: [{ action: "displace", x: 100, y: 0 }] } }),
    true,
  );
  assert.equal(
    isForcedMovement({ passed: { waypoints: [{ action: FORCE_ACTION, x: 100, y: 0 }] } }),
    true,
  );
});

test("a walk waypoint is not forced", () => {
  assert.equal(
    isForcedMovement({ passed: { waypoints: [{ action: "walk", x: 100, y: 0 }] } }),
    false,
  );
});

test("destination.action without passed waypoints is still forced", () => {
  assert.equal(
    isForcedMovement({ destination: { action: FORCE_ACTION, x: 200, y: 0 } }),
    true,
  );
});

test("an in-flight mark makes the updateToken fallback forced", () => {
  const token = doc();
  beginForced(token);
  assert.equal(isForcedMovement({ origin: { x: 0, y: 0 } }, undefined, token), true);
  endForced(token);
  assert.equal(isForcedMovement({ origin: { x: 0, y: 0 } }, undefined, token), false);
});

test("compelled movement walks and is not forced", () => {
  // Dissonant Whispers / Command spend the victim's own Speed. Those arrive as
  // walk/fly with method: api and no mark — they must still provoke.
  assert.equal(
    isForcedMovement(
      { passed: { waypoints: [{ action: "walk", x: 100, y: 0 }] } },
      { method: "api" },
      doc(),
    ),
    false,
  );
});

test("history at the shove destination is forced when waypoints are empty", () => {
  const token = doc("beholder", {
    movementHistory: [{ action: FORCE_ACTION, x: 300, y: 100 }],
    _source: { x: 300, y: 100 },
  });
  assert.equal(isForcedMovement({ origin: { x: 0, y: 0 } }, undefined, token), true);
});

test("a later walk this turn is not shadowed by an earlier shove in history", () => {
  const token = doc("beholder", {
    movementHistory: [
      { action: FORCE_ACTION, x: 300, y: 100 },
      { action: "walk", x: 400, y: 100 },
    ],
    _source: { x: 400, y: 100 },
  });
  assert.equal(
    isForcedMovement(
      { passed: { waypoints: [{ action: "walk", x: 400, y: 100 }] } },
      undefined,
      token,
    ),
    false,
  );
  assert.equal(isForcedMovement({ origin: { x: 300, y: 100 } }, undefined, token), false);
});
