import { strict as assert } from "node:assert";
import { beforeEach, test } from "node:test";

import {
  counterableCast,
  counterspellReady,
  isCounterspell,
  isCounterspellAction,
} from "../src/system/dnd5e-counterspell";
import { slotAvailable } from "../src/system/dnd5e-spells";

// What is pinned here is the READING, which is the half that can be wrong without anybody noticing. The
// window itself fails loudly — a held cast that never resumes is the first thing reported — but a component
// test read the wrong way round makes a caster silently uncounterable, and a slot test read the wrong way
// round makes an at-will monster refuse to counter. Neither raises anything anywhere.
//
// The four properties, in the order they cost the most if reversed:
//
//   1. UNREADABLE MEANS COUNTERABLE. A monster casting through a feat that points at an unloaded compendium
//      spell cannot have its components read synchronously, and `preUseActivity` is synchronous. Assuming
//      their absence would exempt most of the bestiary.
//   2. A PROPERTY SET THAT NAMES NONE OF THE THREE IS HONEST. That is the one case where the answer really
//      is "no", and it must be distinguishable from case 1.
//   3. AN AT-WILL CASTER HAS NO POOL TO CHECK. Asked of `CONFIG.DND5E.spellcasting`, per the standing rule
//      about never hardcoding what the system already states.

beforeEach(() => {
  (globalThis as any).game = { system: { id: "dnd5e" }, modules: new Map() };
  (globalThis as any).CONFIG = {
    DND5E: {
      spellcasting: {
        spell: { slots: true },
        pact: { slots: true },
        innate: { slots: false },
        atwill: { slots: false },
      },
    },
  };
});

function spell(name: string, properties: string[] | null, extra: Record<string, unknown> = {}) {
  return {
    type: "spell",
    name,
    system: {
      level: 3,
      properties: properties === null ? undefined : new Set(properties),
      ...extra,
    },
  };
}

function cast(item: any, type = "attack") {
  return { type, item, actor: { name: "Caster" } };
}

/* -------------------------------------------- */
/*  What can be countered                        */
/* -------------------------------------------- */

test("a spell with any one of the three components is counterable", () => {
  for (const component of ["vocal", "somatic", "material"]) {
    const read = counterableCast(cast(spell("Fireball", [component])));
    assert.ok(read, `${component} alone should be enough`);
    assert.equal(read?.name, "Fireball");
  }
});

test("a property set that names none of the three is genuinely uncounterable", () => {
  assert.equal(counterableCast(cast(spell("Silent Word", ["concentration"]))), null);
});

test("unreadable components are treated as present, because the alternative is silent immunity", () => {
  const read = counterableCast(cast(spell("Something", null)));
  assert.ok(read, "no property set at all must not exempt the cast");
});

test("a feat wrapping an unresolvable spell is still counterable, and its components unknown", () => {
  (globalThis as any).fromUuidSync = () => ({ name: "Fireball" }); // an index stub: no `system`
  const read = counterableCast({
    type: "cast",
    name: "Innate Spellcasting",
    item: { type: "feat", name: "Innate Spellcasting" },
    spell: { uuid: "Compendium.x.y.Item.z" },
  });
  assert.ok(read);
  assert.equal(read?.level, null, "an unresolved spell states no level");
  assert.equal(read?.vocalOnly, false, "and cannot be called vocal-only");
});

test("an item that is not a spell and not a cast wrapper is not a cast at all", () => {
  assert.equal(counterableCast(cast({ type: "weapon", name: "Longsword", system: {} })), null);
});

/* -------------------------------------------- */
/*  Vocal-only, which is what Deafened turns on  */
/* -------------------------------------------- */

test("verbal alone has nothing to see, so it is flagged for the Deafened check", () => {
  assert.equal(counterableCast(cast(spell("Command", ["vocal"])))?.vocalOnly, true);
});

test("adding anything visible clears it", () => {
  assert.equal(counterableCast(cast(spell("Fireball", ["vocal", "somatic"])))?.vocalOnly, false);
  assert.equal(counterableCast(cast(spell("Fireball", ["vocal", "material"])))?.vocalOnly, false);
});

/* -------------------------------------------- */
/*  Recognising the spell itself                 */
/* -------------------------------------------- */

test("Counterspell is matched by identifier first and by an anchored name second", () => {
  assert.equal(isCounterspell(spell("Anything", ["vocal"], { identifier: "counterspell" })), true);
  assert.equal(isCounterspell(spell("Counterspell", ["vocal"])), true);
  // An identifier that exists and says otherwise is authoritative: a re-identified spell is a decision.
  assert.equal(
    isCounterspell(spell("Counterspell", ["vocal"], { identifier: "dispel-magic" })),
    false,
  );
  assert.equal(isCounterspell(spell("Greater Counterspell Ward", ["vocal"])), false);
  assert.equal(isCounterspell({ type: "feat", name: "Counterspell", system: {} }), false);
});

test("a feat that casts Counterspell is still that reaction", () => {
  // Protective Magic is type feat; isCounterspell on the item is correctly false. The hurt picker
  // reads actions, so the wrapper has to be recognised or a melee hit spends an illegal Counterspell.
  const feat = { type: "feat", name: "Protective Magic", system: { identifier: "protective-magic" } };
  assert.equal(isCounterspell(feat), false);
  assert.equal(isCounterspellAction({ item: feat, spellKey: "counterspell" }), true);
  assert.equal(isCounterspellAction({ item: feat, spellKey: "shield" }), false);
});

/* -------------------------------------------- */
/*  Whether the creature can pay for it          */
/* -------------------------------------------- */

/** A sheet with the given slot pools. */
function slots(pools: Record<string, { level?: number; max: number; value: number }>) {
  return { system: { spells: pools } };
}

test("a third-level slot or better satisfies it, and lower ones do not", () => {
  assert.equal(slotAvailable(slots({ spell3: { max: 2, value: 1 } }), 3), true);
  assert.equal(slotAvailable(slots({ spell5: { max: 1, value: 1 } }), 3), true);
  assert.equal(slotAvailable(slots({ spell2: { max: 3, value: 3 } }), 3), false);
  assert.equal(
    slotAvailable(slots({ spell3: { max: 2, value: 0 } }), 3),
    false,
    "spent is not available",
  );
});

test("pact magic counts, read from the pool's own level rather than from its key", () => {
  assert.equal(slotAvailable(slots({ pact: { level: 3, max: 2, value: 2 } }), 3), true);
  assert.equal(slotAvailable(slots({ pact: { level: 2, max: 2, value: 2 } }), 3), false);
});

/** An actor holding one Counterspell with a readable save DC. */
function counterspeller(
  dc: number | null,
  method = "spell",
  pools: any = { spell3: { max: 1, value: 1 } },
) {
  const item = {
    type: "spell",
    name: "Counterspell",
    system: {
      level: 3,
      method,
      identifier: "counterspell",
      range: { value: 60 },
      properties: new Set(["somatic"]),
      activities: {
        contents: [{ type: "save", save: { dc: dc === null ? {} : { value: dc } } }],
      },
    },
  };
  return { name: "Wizard", items: [item], system: { spells: pools }, flags: {} };
}

test("a readable DC and a spare slot is all it takes", () => {
  const ready = counterspellReady(counterspeller(15));
  assert.equal(ready?.dc, 15);
  assert.equal(ready?.range, 60);
});

test("no readable DC means not offered, because there is no contest to run", () => {
  assert.equal(counterspellReady(counterspeller(null)), null);
});

test("an empty slot pool refuses a slot caster", () => {
  assert.equal(
    counterspellReady(counterspeller(15, "spell", { spell3: { max: 1, value: 0 } })),
    null,
  );
});

test("an at-will caster has no pool to check and is offered anyway", () => {
  assert.equal(counterspellReady(counterspeller(15, "atwill", {}))?.dc, 15);
});

test("the flag is the escape hatch for a statblock whose slots cannot be read", () => {
  const actor: any = counterspeller(15, "spell", {});
  assert.equal(counterspellReady(actor), null);
  actor.flags = { "noodlr-hooks-55e": { counterspell: true } };
  assert.equal(counterspellReady(actor)?.dc, 15);
});
