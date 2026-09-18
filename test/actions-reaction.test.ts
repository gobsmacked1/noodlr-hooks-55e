import { strict as assert } from "node:assert";
import { test } from "node:test";

import { readActions } from "../src/tactics/actions";

test("Shield as a reaction utility is offerable; Dodge as an action utility is not", () => {
  (globalThis as any).game = { system: { id: "dnd5e" }, settings: { get: () => true } };
  (globalThis as any).canvas = { scene: { grid: { distance: 5 } } };
  const shield = {
    name: "Shield",
    type: "spell",
    system: {
      identifier: "shield",
      level: 1,
      method: "spell",
      activities: {
        contents: [{ type: "utility", name: "Cast", activation: { type: "reaction" } }],
      },
    },
  };
  const dodge = {
    name: "Dodge",
    type: "feat",
    system: {
      identifier: "dodge",
      activities: {
        contents: [{ type: "utility", name: "Use", activation: { type: "action" } }],
      },
    },
  };
  const actor = {
    name: "Sorc",
    items: [shield, dodge],
    system: { spells: { spell1: { value: 2 } } },
  };
  const actions = readActions(actor);
  assert.ok(
    actions.some((a) => a.item === shield && a.economy === "reaction"),
    `expected Shield; got ${actions.map((a) => `${a.name}:${a.economy}`).join(",")}`,
  );
  assert.equal(
    actions.some((a) => a.item === dodge),
    false,
  );
});
