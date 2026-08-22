import { strict as assert } from "node:assert";
import { test } from "node:test";

import { MODULE_ID } from "../src/constants";
import {
  FORM_LOOT_FLAG,
  TRANSFORM_BADGE_FLAG,
  TRANSFORM_BADGE_ID,
  TRANSFORM_STATUS_ID,
  addCurrency,
  currencyDelta,
  currencyOf,
  emptyCurrency,
  hasCoin,
  isFormLootSnapshot,
  isOurTransformBadge,
  isPolymorphed,
  isTransformBadge,
  itemPayloadForCarry,
  newItemsFrom,
  planFormLoot,
  stampFormLootOnCreateData,
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

test("planFormLoot copies only items and coin the form did not start with", () => {
  const snapshot = {
    originalActor: "drew",
    itemIds: ["talons", "owl-eyes"],
    currency: emptyCurrency(),
  };
  const items = [{ _id: "talons", name: "Talons" }, { id: "potion", name: "Potion of Healing" }];
  const plan = planFormLoot({ items, currency: { ...emptyCurrency(), gp: 12, sp: 4 }, snapshot });
  assert.ok(plan);
  assert.equal(plan.items.length, 1);
  assert.equal(plan.items[0].name, "Potion of Healing");
  assert.equal(plan.currency.gp, 12);
  assert.equal(plan.currency.sp, 4);
  assert.equal(plan.currency.cp, 0);
});

test("planFormLoot is null when already copied or there is no stamp", () => {
  assert.equal(planFormLoot({ items: [{ id: "x" }], currency: emptyCurrency(), snapshot: null }), null);
  assert.equal(
    planFormLoot({
      items: [{ id: "x" }],
      currency: { ...emptyCurrency(), gp: 1 },
      snapshot: { originalActor: "a", itemIds: [], currency: emptyCurrency(), copied: true },
    }),
    null,
  );
});

test("currencyDelta never subtracts and stampFormLoot writes our flag", () => {
  assert.deepEqual(currencyDelta({ ...emptyCurrency(), gp: 5 }, { ...emptyCurrency(), gp: 3 }), emptyCurrency());
  assert.ok(hasCoin({ ...emptyCurrency(), cp: 1 }));
  assert.equal(hasCoin(emptyCurrency()), false);
  assert.deepEqual(addCurrency({ ...emptyCurrency(), gp: 10 }, { ...emptyCurrency(), gp: 3, sp: 2 }).gp, 13);
  assert.deepEqual(currencyOf({ system: { currency: { gp: 2, foo: 9 } } }).gp, 2);

  const d: any = {
    flags: { dnd5e: { originalActor: "drew" } },
    items: [{ _id: "talons" }],
    system: { currency: {} },
  };
  const snap = stampFormLootOnCreateData(d, { id: "host" });
  assert.equal(snap.originalActor, "drew");
  assert.deepEqual(snap.itemIds, ["talons"]);
  assert.equal(d.flags[MODULE_ID][FORM_LOOT_FLAG], snap);
  assert.equal(isFormLootSnapshot(snap), true);
  assert.equal(newItemsFrom(d.items, snap.itemIds).length, 0);
});

test("itemPayloadForCarry drops the form id and a container link", () => {
  const payload = itemPayloadForCarry({
    _id: "abc",
    id: "abc",
    name: "Potion",
    type: "consumable",
    folder: "nope",
    system: { container: "backpack", quantity: 1 },
    toObject() {
      return this;
    },
  });
  assert.equal(payload._id, undefined);
  assert.equal(payload.id, undefined);
  assert.equal(payload.folder, undefined);
  assert.equal((payload.system as { container?: string; quantity: number }).container, undefined);
  assert.equal((payload.system as { quantity: number }).quantity, 1);
});
