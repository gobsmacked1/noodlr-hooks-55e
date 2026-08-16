import { strict as assert } from "node:assert";
import { test } from "node:test";

import { readRest } from "../src/system/dnd5e-rest";

// `readRest` is pure and needs no Foundry global, which is the reason it is a separate file from the
// dispatch it feeds: every row below is a shape `dnd5e.restCompleted` really delivers, and the two
// answers it returns come apart in ways that are invisible from the call site.

test("a long rest fires both events, because it includes everything a short one gives", () => {
  assert.deepEqual(readRest({ type: "long" }, {}), {
    triggers: ["on_short_rest", "on_long_rest"],
    long: true,
  });
});

test("a short rest fires one", () => {
  assert.deepEqual(readRest({ type: "short" }, {}), {
    triggers: ["on_short_rest"],
    long: false,
  });
});

test("the legacy boolean is read, in both directions", () => {
  // Rest Recovery cancels dnd5e's `pre*` hooks and re-enters `actor._rest()`, so what arrives here is
  // whatever that module's result object carries rather than what the current schema promises.
  assert.equal(readRest({ longRest: true }, {}).long, true);
  assert.deepEqual(readRest({ longRest: false }, {}).triggers, ["on_short_rest"]);
});

test("a new day advances the counter WITHOUT claiming a long rest happened", () => {
  // The one place the two answers must differ. One counter serves both `day` and `long_rest`, and
  // dnd5e recovers per-day uses on any rest flagged `newDay` — so the ledger has to bump or a daily
  // allowance never returns. Firing `on_long_rest` off the same signal would be a different claim:
  // it would run a creature's long-rest rules on the strength of a short rest, which is a rule
  // executing when the fiction says it should not.
  const reading = readRest({ type: "short", newDay: true }, {});
  assert.equal(reading.long, true, "the allowance comes back");
  assert.deepEqual(reading.triggers, ["on_short_rest"], "but the long-rest rules do not run");
});

test("…and the flag is read off the config as well as the result", () => {
  assert.equal(readRest({ type: "short" }, { newDay: true }).long, true);
});

test("an unrecognisable rest fires nothing and moves no counter", () => {
  // A rest type we cannot read is not a reason to guess at one. Nothing fires, the ledger is
  // untouched, and the failure is a rest-scoped ability staying spent — which the capability sheet
  // and the item's own uses both show, rather than a rule firing on a rest that never happened.
  assert.deepEqual(readRest({}, {}), { triggers: [], long: false });
  assert.deepEqual(readRest(null, null), { triggers: [], long: false });
});

test("the type falls back to the configuration when the result omits it", () => {
  assert.deepEqual(readRest({}, { type: "long" }), {
    triggers: ["on_short_rest", "on_long_rest"],
    long: true,
  });
});

// ---- The system's own answer, which is the path that runs in a real world -------------------------

function withRestTypes<T>(types: Record<string, unknown> | null, fn: () => T): T {
  const previous = (globalThis as any).CONFIG;
  (globalThis as any).CONFIG = types ? { DND5E: { restTypes: types } } : undefined;
  try {
    return fn();
  } finally {
    (globalThis as any).CONFIG = previous;
  }
}

test("the rest table is read rather than the name compared", () => {
  // dnd5e's own `restTypes.long.recoverPeriods` is `["lr", "sr"]`, which is the system stating the
  // inclusion this dispatch depends on. Every assertion above exercises the fallback; this is the
  // branch a live world takes.
  const types = {
    short: { recoverPeriods: ["sr"] },
    long: { recoverPeriods: ["lr", "sr"] },
  };
  withRestTypes(types, () => {
    assert.deepEqual(readRest({ type: "long" }, {}).triggers, ["on_short_rest", "on_long_rest"]);
    assert.deepEqual(readRest({ type: "short" }, {}).triggers, ["on_short_rest"]);
  });
});

test("a rest type another module registered works with no change here", () => {
  // The reason for reading the table at all. A homebrew rest that recovers short-rest resources fires
  // our short-rest rules; one that recovers neither fires nothing, rather than being guessed at.
  const types = {
    nap: { recoverPeriods: ["sr"] },
    vigil: { recoverPeriods: [] },
    "week-off": { recoverPeriods: ["lr", "sr"] },
  };
  withRestTypes(types, () => {
    assert.deepEqual(readRest({ type: "nap" }, {}).triggers, ["on_short_rest"]);
    assert.deepEqual(readRest({ type: "vigil" }, {}).triggers, []);
    assert.deepEqual(readRest({ type: "week-off" }, {}).triggers, [
      "on_short_rest",
      "on_long_rest",
    ]);
  });
});

test("a Set of periods reads the same as an array", () => {
  // `recoverSpellSlotTypes` beside it IS a Set, so the field's shape is not a safe assumption.
  withRestTypes({ long: { recoverPeriods: new Set(["lr", "sr"]) } }, () => {
    assert.deepEqual(readRest({ type: "long" }, {}).triggers, ["on_short_rest", "on_long_rest"]);
  });
});
