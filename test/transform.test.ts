import { strict as assert } from "node:assert";
import { test } from "node:test";

import { MODULE_ID } from "../src/constants";
import {
  TRANSFORM_BADGE_FLAG,
  TRANSFORM_BADGE_ID,
  TRANSFORM_STATUS_ID,
  isOurTransformBadge,
  isPolymorphed,
  isTransformBadge,
} from "../src/system/dnd5e-transform";

const CANNED = [
  "dead",
  "unconscious",
  "paralyzed",
  "frightened",
  "charmed",
  "concentrating",
  "prone",
  "incapacitated",
  "stunned",
  "blinded",
  "invisible",
  "hiding",
  "blessed",
  "transformed",
];

test("withdrawn transform status id is never a canned condition", () => {
  assert.equal(TRANSFORM_STATUS_ID, "noodlr-transformed");
  for (const id of CANNED) {
    assert.notEqual(TRANSFORM_STATUS_ID, id);
  }
  assert.ok(TRANSFORM_STATUS_ID.startsWith("noodlr-"));
  assert.equal(TRANSFORM_BADGE_ID.length, 16);
});

test("isOurTransformBadge reads the leftover flag or the keepId", () => {
  assert.equal(isOurTransformBadge({ flags: { [MODULE_ID]: { [TRANSFORM_BADGE_FLAG]: true } } }), true);
  assert.equal(isOurTransformBadge({ id: TRANSFORM_BADGE_ID }), true);
  assert.equal(isOurTransformBadge({ flags: { [MODULE_ID]: { auraHost: true } } }), false);
  assert.equal(isOurTransformBadge({ statuses: [TRANSFORM_STATUS_ID] }), false);
});

test("isTransformBadge also matches a leftover status-only twin", () => {
  assert.equal(isTransformBadge({ statuses: [TRANSFORM_STATUS_ID] }), true);
  assert.equal(isTransformBadge({ statuses: ["transformed"] }), false);
});

test("isPolymorphed reads the getter and the dnd5e flag", () => {
  assert.equal(isPolymorphed(null), false);
  assert.equal(isPolymorphed({ isPolymorphed: true }), true);
  assert.equal(isPolymorphed({ flags: { dnd5e: { isPolymorphed: true } } }), true);
  assert.equal(isPolymorphed({ isPolymorphed: false, flags: { dnd5e: {} } }), false);
});
