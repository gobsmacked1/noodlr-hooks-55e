import { strict as assert } from "node:assert";
import { test } from "node:test";

import { skipRollDialogWhen } from "../src/tactics/auto-roll";

// The Attack Roll dialog that paused the Assassin's Light Crossbow (2026-08-18).
// A player's own roll must never be silenced; an automated NPC's must.

test("an automated NPC skips the roll dialog", () => {
  assert.equal(
    skipRollDialogWhen({ automating: true, hasPlayerOwner: false, automatedCombatant: false }),
    true,
  );
  assert.equal(
    skipRollDialogWhen({ automating: false, hasPlayerOwner: false, automatedCombatant: true }),
    true,
  );
});

test("a player character keeps the dialog, even mid-automation", () => {
  assert.equal(
    skipRollDialogWhen({ automating: true, hasPlayerOwner: true, automatedCombatant: false }),
    false,
  );
});

test("an unplayed NPC keeps the dialog — the GM may be rolling by hand", () => {
  assert.equal(
    skipRollDialogWhen({ automating: false, hasPlayerOwner: false, automatedCombatant: false }),
    false,
  );
});
