import { strict as assert } from "node:assert";
import { test } from "node:test";

import { MODULE_ID } from "../src/constants";
import {
  TRANSFORM_AA_FLAGS,
  TRANSFORM_BADGE_FLAG,
  TRANSFORM_BADGE_ID,
  TRANSFORM_SHOW_ICON_ALWAYS,
  TRANSFORM_STATUS_ID,
  TRANSFORM_STATUS_IMG,
  extrasToDrop,
  isOurTransformBadge,
  isPolymorphed,
  isTransformBadge,
  transformBadgePayload,
  transformStatusEntry,
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

test("transform status id is never a canned condition", () => {
  assert.equal(TRANSFORM_STATUS_ID, "noodlr-transformed");
  for (const id of CANNED) {
    assert.notEqual(TRANSFORM_STATUS_ID, id);
  }
  assert.ok(TRANSFORM_STATUS_ID.startsWith("noodlr-"));
});

test("transform status is hidden from the Token HUD toggle list", () => {
  const entry = transformStatusEntry();
  assert.equal(entry.hud, false);
  assert.equal(entry.id, TRANSFORM_STATUS_ID);
  assert.equal(entry.img, TRANSFORM_STATUS_IMG);
  assert.notEqual(entry.img, "icons/svg/aura.svg");
});

test("transform badge uses ALWAYS showIcon, empty changes, and a keepId", () => {
  const payload = transformBadgePayload({ uuid: "Actor.abc" });
  assert.equal(payload.showIcon, TRANSFORM_SHOW_ICON_ALWAYS);
  assert.equal(TRANSFORM_SHOW_ICON_ALWAYS, 2);
  assert.deepEqual(payload.changes, []);
  assert.deepEqual(payload.statuses, [TRANSFORM_STATUS_ID]);
  assert.equal(payload.transfer, false);
  assert.equal(payload._id, TRANSFORM_BADGE_ID);
  assert.equal(TRANSFORM_BADGE_ID.length, 16);
  const flags = payload.flags as Record<string, any>;
  assert.equal(flags[MODULE_ID][TRANSFORM_BADGE_FLAG], true);
  assert.equal(flags.autoanimations.killAnim, TRANSFORM_AA_FLAGS.killAnim);
});

test("isOurTransformBadge reads the flag or the keepId", () => {
  assert.equal(isOurTransformBadge({ flags: { [MODULE_ID]: { [TRANSFORM_BADGE_FLAG]: true } } }), true);
  assert.equal(isOurTransformBadge({ id: TRANSFORM_BADGE_ID }), true);
  assert.equal(isOurTransformBadge({ flags: { [MODULE_ID]: { auraHost: true } } }), false);
  assert.equal(isOurTransformBadge({ statuses: [TRANSFORM_STATUS_ID] }), false);
});

test("isTransformBadge also matches a status-only twin", () => {
  assert.equal(isTransformBadge({ statuses: [TRANSFORM_STATUS_ID] }), true);
  assert.equal(isTransformBadge({ statuses: ["transformed"] }), false);
});

test("extrasToDrop keeps the keepId badge and drops the rest", () => {
  const keep = { id: TRANSFORM_BADGE_ID, flags: { [MODULE_ID]: { [TRANSFORM_BADGE_FLAG]: true } } };
  const leftover = { id: "randomid1234567", flags: { [MODULE_ID]: { [TRANSFORM_BADGE_FLAG]: true } } };
  const statusOnly = { id: "statusonly000001", statuses: [TRANSFORM_STATUS_ID] };
  assert.deepEqual(extrasToDrop([keep]), []);
  const dropped = extrasToDrop([leftover, keep, statusOnly]);
  assert.equal(dropped.length, 2);
  assert.ok(dropped.includes(leftover));
  assert.ok(dropped.includes(statusOnly));
  assert.ok(!dropped.includes(keep));
});

test("isPolymorphed reads the getter and the dnd5e flag", () => {
  assert.equal(isPolymorphed(null), false);
  assert.equal(isPolymorphed({ isPolymorphed: true }), true);
  assert.equal(isPolymorphed({ flags: { dnd5e: { isPolymorphed: true } } }), true);
  assert.equal(isPolymorphed({ isPolymorphed: false, flags: { dnd5e: {} } }), false);
});
