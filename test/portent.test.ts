import { strict as assert } from "node:assert";
import { beforeEach, test } from "node:test";

import { MODULE_ID } from "../src/constants";
import { matchesItem, DICE_MOD_SPECS } from "../src/system/dnd5e-dice-mods";
import {
  facesOf,
  isGreaterPortentItem,
  isMonsterPortent,
  isPortentItem,
  parseFaces,
  portentDiceCount,
  portentHasFace,
  portentItem,
  portentRollKind,
  portentSpentThisTurn,
  portentTimeoutId,
  portentTurnStamp,
  spendPortentFace,
  writePortentFaces,
} from "../src/system/dnd5e-portent";

beforeEach(() => {
  (globalThis as any).game = { system: { id: "dnd5e" }, modules: new Map(), combat: null };
});

function feat(name: string, identifier: string, extra: Record<string, unknown> = {}) {
  return {
    name,
    type: extra.type ?? "feat",
    system: {
      identifier,
      description: extra.description ?? { value: "" },
      uses: extra.uses ?? { max: 2, spent: 0 },
    },
    flags: extra.flags ?? {},
  };
}

test("a feat identified portent is Portent; Trigger/Response is the monster trait", () => {
  assert.equal(isPortentItem(feat("Portent", "portent")), true);
  const monster = feat("Portent", "portent", {
    description: {
      value:
        "<p><strong>Trigger:</strong> A creature you can see makes a D20 Test.</p><p><strong>Response:</strong> Roll 1d20 and choose.</p>",
    },
  });
  assert.equal(isMonsterPortent(monster), true);
  assert.equal(isPortentItem(monster), false);
});

test("Greater Portent raises the count and is never the spendable item", () => {
  const greater = feat("Greater Portent", "greater-portent");
  assert.equal(isGreaterPortentItem(greater), true);
  assert.equal(isPortentItem(greater), false);
  const actor = { items: [feat("Portent", "portent"), greater] };
  assert.equal(portentDiceCount(actor), 3);
  assert.equal(portentItem(actor)?.system.identifier, "portent");
});

test("a name is believed only on a feat with no identifier", () => {
  assert.equal(isPortentItem(feat("Portent", "")), true);
  assert.equal(isPortentItem(feat("Portent", "", { type: "weapon" })), false);
  assert.equal(isPortentItem(feat("Portent", "homebrew-omen")), false);
});

test("the diceMod hatch names Portent on any type", () => {
  const item = feat("Foretelling", "foretelling", {
    type: "feat",
    flags: { [MODULE_ID]: { diceMod: "portent" } },
  });
  assert.equal(isPortentItem(item), true);
});

test("after-fail specs still do not match a Portent feat", () => {
  const portent = feat("Portent", "portent");
  for (const row of DICE_MOD_SPECS) {
    assert.equal(matchesItem(portent, row), false, row.id);
  }
});

test("initiative is a Portent hold; attack, save and death still classify", () => {
  assert.equal(portentRollKind(["initiativeDialog", "abilityCheck", "d20Test"]), "initiative");
  assert.equal(portentRollKind(["attack", "d20Test"]), "attack");
  assert.equal(portentRollKind(["SavingThrow", "d20Test"]), "save");
  assert.equal(portentRollKind(["deathSave"]), "death");
  assert.equal(portentRollKind(["formula"]), null);
});

test("a timeout never spends a Portent face", () => {
  assert.equal(portentTimeoutId(), "decline");
});

test("parseFaces keeps integers 1–20 and drops the rest", () => {
  assert.deepEqual(parseFaces([14, 3]), [14, 3]);
  assert.deepEqual(parseFaces({ faces: [20, 0, 21, 7.5, "9"] }), [20, 9]);
  assert.deepEqual(parseFaces(null), []);
});

test("spend removes by index, so two identical 14s stay distinguishable", async () => {
  const item = feat("Portent", "portent");
  await writePortentFaces(item, [14, 14]);
  assert.deepEqual(facesOf(item), [14, 14]);
  assert.equal(await spendPortentFace(item, 0), 14);
  assert.deepEqual(facesOf(item), [14]);
  assert.equal(await spendPortentFace(item, 5), null);
});

test("an empty bank is not offerable", async () => {
  const item = feat("Portent", "portent");
  assert.equal(portentHasFace(item), false);
  await writePortentFaces(item, [11]);
  assert.equal(portentHasFace(item), true);
  await writePortentFaces(item, []);
  assert.equal(portentHasFace(item), false);
});

test("out of combat the once-per-turn stamp is ooc, not unlimited", () => {
  assert.equal(portentTurnStamp(), "ooc");
  const actor = { flags: { [MODULE_ID]: { portentTurn: "ooc" } } };
  assert.equal(portentSpentThisTurn(actor), true);
  const fresh = { flags: {} };
  assert.equal(portentSpentThisTurn(fresh), false);
});
