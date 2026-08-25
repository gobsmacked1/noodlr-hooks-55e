import test from "node:test";
import assert from "node:assert/strict";

import {
  matchPointerItem,
  numberedIndex,
  parseItemPointers,
  pickNumbered,
  pointerRangeOf,
} from "../src/system/dnd5e-pointer.js";
import { previewPointer, realizePointer } from "../src/tactics/legendary-act.js";
import type { CreatureAction } from "../src/tactics/actions.js";

test("an enricher names the other item, and 'three times' after it sticks", () => {
  const found = parseItemPointers("[[/item Eye Rays]] three times");
  assert.deepEqual(found, [{ token: "Eye Rays", activity: undefined, times: 3 }]);
});

test("a relative id enricher drops the leading dot", () => {
  const found = parseItemPointers("[[/item .mmDreadfulGlare0]]");
  assert.equal(found[0]?.token, "mmDreadfulGlare0");
  const item = matchPointerItem(found[0]!.token, [
    { id: "mmDreadfulGlare0", name: "Dreadful Glare" },
  ]);
  assert.equal(item?.name, "Dreadful Glare");
});

test("secret 'uses Eye Rays' is a pointer; a self-lookup is not", () => {
  const secret = parseItemPointers(
    '<section class="secret">The beholder uses Eye Rays.</section>[[lookup @item.name]]',
  );
  assert.deepEqual(secret, [{ token: "Eye Rays", activity: undefined, times: 1 }]);
  assert.deepEqual(parseItemPointers("[[lookup @item.name]]"), []);
});

test("makes two Bite attacks", () => {
  const found = parseItemPointers("The beholder makes two Bite attacks.");
  assert.deepEqual(found, [{ token: "Bite", activity: undefined, times: 2 }]);
});

test("a numbered name is the die face; Roll 1d10 is not", () => {
  assert.equal(numberedIndex("7: Sleep Ray"), 7);
  assert.equal(numberedIndex("Roll 1d10"), null);
});

test("pick 7 lands on Sleep Ray; a spent face is skipped", () => {
  const rows = [
    { n: 1, value: "Charm" },
    { n: 7, value: "Sleep" },
    { n: 10, value: "Death" },
  ];
  assert.deepEqual(pickNumbered(rows, [7], new Set()), ["Sleep"]);
  const used = new Set([7]);
  assert.deepEqual(pickNumbered(rows, [7], used), ["Charm"]);
  assert.ok(used.has(1));
});

test("pointer range reads activity.value even when override is false", () => {
  assert.equal(pointerRangeOf({ range: { value: 120, override: false } }, {}), 120);
  assert.equal(pointerRangeOf({ range: { units: "self" } }, { system: { range: { reach: 5 } } }), 5);
});

function row(
  over: Partial<CreatureAction> & { id?: string; itemName?: string; prose?: string; activityName?: string },
): CreatureAction {
  return {
    item: {
      id: over.id ?? "x",
      name: over.itemName ?? over.name ?? "X",
      system: { description: { value: over.prose ?? "" } },
    },
    activity: {
      name: over.activityName ?? over.name ?? "X",
      activation: { type: over.economy === "legendary" ? "legendary" : "special" },
      range: { value: over.range ?? 5 },
    },
    name: over.name ?? "X",
    kind: over.kind ?? "control",
    economy: over.economy ?? "free",
    melee: false,
    ranged: true,
    range: over.range ?? 5,
    available: true,
    depleting: false,
  };
}

test("previewPointer reads 120 off the rays, not infinity off Glare", () => {
  const glare = row({
    id: "glare",
    name: "Glare",
    itemName: "Glare",
    kind: "utility",
    economy: "legendary",
    range: Number.POSITIVE_INFINITY,
    prose: "The beholder uses Eye Rays.",
  });
  const roll = row({
    id: "rays",
    name: "Roll 1d10",
    itemName: "Eye Rays",
    kind: "utility",
    activityName: "Roll 1d10",
  });
  const sleep = row({
    id: "rays",
    name: "7: Sleep Ray",
    itemName: "Eye Rays",
    kind: "control",
    range: 5,
    activityName: "7: Sleep Ray",
  });
  sleep.activity.range = { value: 120, override: false };
  const preview = previewPointer(glare, [glare, roll, sleep]);
  assert.equal(preview?.unresolved, false);
  assert.equal(preview?.range, 120);
  assert.equal(preview?.numbered, true);
  assert.equal(preview?.die, 7);
  assert.equal(preview?.token, "Eye Rays");
});

test("realizePointer with a 7 picks Sleep Ray and never the Roll 1d10 utility", () => {
  const glare = row({
    id: "glare",
    name: "Glare",
    itemName: "Glare",
    kind: "utility",
    economy: "legendary",
    prose: "The beholder uses Eye Rays.",
  });
  const roll = row({
    id: "rays",
    name: "Roll 1d10",
    itemName: "Eye Rays",
    kind: "utility",
    activityName: "Roll 1d10",
  });
  const sleep = row({
    id: "rays",
    name: "7: Sleep Ray",
    itemName: "Eye Rays",
    kind: "control",
    activityName: "7: Sleep Ray",
  });
  const charm = row({
    id: "rays",
    name: "1: Charm Ray",
    itemName: "Eye Rays",
    kind: "control",
    activityName: "1: Charm Ray",
  });
  const got = realizePointer(glare, [glare, roll, sleep, charm], [7], new Set());
  assert.equal(got?.payloads.length, 1);
  assert.equal(got?.payloads[0]?.name, "7: Sleep Ray");
  assert.equal(got?.label, "Glare → Sleep Ray");
});

test("Chomp realizes as two Bites", () => {
  const chomp = row({
    id: "chomp",
    name: "Chomp",
    itemName: "Chomp",
    kind: "utility",
    economy: "legendary",
    prose: "The beholder makes two Bite attacks.",
  });
  const bite = row({
    id: "bite",
    name: "Bite",
    itemName: "Bite",
    kind: "attack",
    activityName: "Bite",
  });
  const got = realizePointer(chomp, [chomp, bite], [], new Set());
  assert.equal(got?.payloads.length, 2);
  assert.equal(got?.payloads[0]?.name, "Bite");
  assert.equal(got?.label, "Chomp → Bite, Bite");
});
