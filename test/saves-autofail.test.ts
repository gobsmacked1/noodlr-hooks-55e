import test from "node:test";
import assert from "node:assert/strict";

import { originatingUsageIdFromRoll } from "../src/rules/cards.js";
import { applyAutoFailedSave } from "../src/rules/saves.js";

test("an auto-fail is a failed save, not a missing verdict", () => {
  const state = { success: null as boolean | null, rolling: true };
  assert.equal(applyAutoFailedSave(state), true);
  assert.equal(state.success, false);
  assert.equal(state.rolling, false);
});

test("an auto-fail does not overwrite a save that already has a verdict", () => {
  const made = { success: true as boolean | null, rolling: false };
  assert.equal(applyAutoFailedSave(made), false);
  assert.equal(made.success, true);

  const failed = { success: false as boolean | null, rolling: false };
  assert.equal(applyAutoFailedSave(failed), false);
  assert.equal(failed.success, false);
});

test("originatingUsageIdFromRoll reads a stamp on the message config", () => {
  assert.equal(
    originatingUsageIdFromRoll({}, { data: { flags: { dnd5e: { originatingMessage: "usage-1" } } } }),
    "usage-1",
  );
});

test("originatingUsageIdFromRoll falls back to the click event, the same reading buildPost uses", () => {
  const event = {
    target: {
      closest: (sel: string) => (sel === "[data-message-id]" ? { dataset: { messageId: "usage-2" } } : null),
    },
  };
  assert.equal(originatingUsageIdFromRoll({ event }, {}), "usage-2");
});

test("a stamped usage id beats a stale click event", () => {
  const event = {
    target: {
      closest: () => ({ dataset: { messageId: "stale" } }),
    },
  };
  assert.equal(
    originatingUsageIdFromRoll(
      { event },
      { data: { flags: { dnd5e: { originatingMessage: "usage-3" } } } },
    ),
    "usage-3",
  );
});

test("originatingUsageIdFromRoll is empty when neither source is present", () => {
  assert.equal(originatingUsageIdFromRoll({}, {}), "");
});
