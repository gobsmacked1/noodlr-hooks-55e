import { strict as assert } from "node:assert";
import { beforeEach, test } from "node:test";

import {
  APPROACHES,
  approachApplies,
  attitudeOf,
  attitudeSwing,
  influenceDc,
  isCoaxable,
} from "../src/system/dnd5e-influence";
import { clearInfluenceLocks, lockFor, setAttitude } from "../src/rules/influence";

const HOSTILE = -1;
const NEUTRAL = 0;
const FRIENDLY = 1;
const SECRET = -2;

/** A token document with working flags, which is all the lockout and attitude code touches. */
function token(overrides: Record<string, any> = {}) {
  const flags: Record<string, any> = overrides.flags ?? {};
  const doc: any = {
    name: overrides.name ?? "Guard Captain",
    disposition: overrides.disposition ?? NEUTRAL,
    flags,
    getFlag: (scope: string, key: string) => flags[scope]?.[key],
    setFlag: async (scope: string, key: string, value: unknown) => {
      flags[scope] = { ...(flags[scope] ?? {}), [key]: value };
    },
    unsetFlag: async (scope: string, key: string) => {
      if (flags[scope]) delete flags[scope][key];
    },
  };
  return { name: doc.name, document: doc, actor: overrides.actor ?? null };
}

function creature(overrides: Record<string, any> = {}) {
  return {
    name: "Guard Captain",
    system: {
      abilities: { int: { value: overrides.int ?? 10 } },
      details: { type: { value: overrides.type ?? "humanoid" } },
      traits: { languages: { value: overrides.languages ?? ["common"] } },
    },
  };
}

beforeEach(() => {
  (globalThis as any).CONST = { TOKEN_DISPOSITIONS: { HOSTILE, NEUTRAL, FRIENDLY, SECRET } };
  (globalThis as any).game = {
    system: { id: "dnd5e" },
    settings: { get: () => true },
    time: { worldTime: 0 },
  };
  (globalThis as any).canvas = { tokens: { controlled: [], placeables: [] } };
});

/* -------------------------------------------- */
/*  The DC                                       */
/* -------------------------------------------- */

test("the DC is 15 or the creature's Intelligence SCORE, whichever is higher", () => {
  assert.equal(influenceDc(creature({ int: 20 })), 20);
  // A floor rather than a scale: a dim creature is not easier to talk round than an average one.
  assert.equal(influenceDc(creature({ int: 5 })), 15);
});

test("an unreadable sheet falls back to the floor rather than to nothing", () => {
  assert.equal(influenceDc({ system: {} }), 15);
});

/* -------------------------------------------- */
/*  Attitude                                     */
/* -------------------------------------------- */

test("attitude defaults to what the token's disposition implies", () => {
  assert.equal(attitudeOf(token({ disposition: HOSTILE })).attitude, "hostile");
  assert.equal(attitudeOf(token({ disposition: FRIENDLY })).attitude, "friendly");
  assert.equal(attitudeOf(token({ disposition: NEUTRAL })).attitude, "indifferent");
});

test("Secret disposition is GM bookkeeping, not a stance, so it reads as indifferent", () => {
  assert.equal(attitudeOf(token({ disposition: SECRET })).attitude, "indifferent");
});

test("a GM's ruling overrules the disposition in either direction", async () => {
  // The case the flag exists for: a Hostile-disposition guard captain who is merely Indifferent to
  // a bribe. Disposition drives target rings and who counts as an enemy; attitude is a social stance.
  const captain = token({ disposition: HOSTILE });
  await setAttitude(captain, "indifferent");
  const reading = attitudeOf(captain);
  assert.equal(reading.attitude, "indifferent");
  assert.match(reading.source, /GM/);
});

test("the legacy flag namespace is still read", () => {
  const captain = token({ flags: { noodlr: { attitude: "friendly" } } });
  assert.equal(attitudeOf(captain).attitude, "friendly");
});

test("a nonsense attitude flag is ignored rather than trusted", () => {
  const captain = token({ disposition: HOSTILE, flags: { "noodlr-hooks-55e": { attitude: "" } } });
  assert.equal(attitudeOf(captain).attitude, "hostile");
});

test("Friendly rolls with Advantage and Hostile with Disadvantage, and never both", () => {
  assert.deepEqual(attitudeSwing("friendly"), { advantage: true, disadvantage: false });
  assert.deepEqual(attitudeSwing("hostile"), { advantage: false, disadvantage: true });
  assert.deepEqual(attitudeSwing("indifferent"), { advantage: false, disadvantage: false });
});

/* -------------------------------------------- */
/*  Which approaches even apply                  */
/* -------------------------------------------- */

test("you cannot persuade something that does not understand a word you say", () => {
  const beast = creature({ languages: [], type: "beast" });
  assert.equal(approachApplies(APPROACHES.persuade, beast).ok, false);
  assert.equal(approachApplies(APPROACHES.deceive, beast).ok, false);
});

test("intimidation carries without a shared language, which is why it is flagged differently", () => {
  // A drawn blade reads in any tongue, and the glossary's Intimidation line omits the "that
  // understands you" qualifier the other two carry.
  assert.equal(approachApplies(APPROACHES.intimidate, creature({ languages: [] })).ok, true);
});

test("coaxing is for Beasts and Monstrosities", () => {
  assert.equal(isCoaxable(creature({ type: "beast" })), true);
  assert.equal(isCoaxable(creature({ type: "monstrosity" })), true);
  assert.equal(isCoaxable(creature({ type: "humanoid" })), false);
  assert.equal(approachApplies(APPROACHES.coax, creature({ type: "humanoid" })).ok, false);
});

test("every approach names a behavior verb the contract already declares", () => {
  const declared = new Set(["PERSUADE", "DECEIVE", "INTIMIDATE", "PARLEY", "BRIBE"]);
  for (const approach of Object.values(APPROACHES)) {
    assert.ok(declared.has(approach.verb), `${approach.label} fires ${approach.verb}`);
  }
});

/* -------------------------------------------- */
/*  The 24-hour lockout                          */
/* -------------------------------------------- */

async function lockOut(target: any, until: number, clock: "world" | "real") {
  await target.document.setFlag("noodlr-hooks-55e", "influenceLocks", {
    PERSUADE: { until, clock, label: "Persuasion" },
  });
}

test("a refusal shuts that approach until the day is out", async () => {
  const captain = token();
  const day = 24 * 60 * 60;
  await lockOut(captain, Math.floor(Date.now() / 1000) + day, "real");
  assert.ok(lockFor(captain, APPROACHES.persuade));
  // ...and only that approach. Being argued at does not stop you being threatened.
  assert.equal(lockFor(captain, APPROACHES.intimidate), null);
});

test("an expired lockout is no lockout", async () => {
  const captain = token();
  await lockOut(captain, Math.floor(Date.now() / 1000) - 60, "real");
  assert.equal(lockFor(captain, APPROACHES.persuade), null);
});

test("world time is used once the world's clock has actually been advanced", async () => {
  (globalThis as any).game.time.worldTime = 500_000;
  const captain = token();
  await lockOut(captain, 500_000 + 10, "world");
  assert.ok(lockFor(captain, APPROACHES.persuade));
  (globalThis as any).game.time.worldTime = 500_000 + 90_000;
  assert.equal(lockFor(captain, APPROACHES.persuade), null);
});

test("a lock set on the other clock is let through rather than compared across clocks", async () => {
  // A world that starts tracking time mid-campaign must not read a Unix timestamp as an in-world
  // one and conclude the guard is unpersuadable for the next sixteen thousand years.
  const captain = token();
  await lockOut(captain, Math.floor(Date.now() / 1000) + 3600, "real");
  (globalThis as any).game.time.worldTime = 500_000;
  assert.equal(lockFor(captain, APPROACHES.persuade), null);
});

test("clearing lifts every lockout and reports how many creatures were freed", async () => {
  const captain = token();
  const clerk = token({ name: "Clerk" });
  await lockOut(captain, Math.floor(Date.now() / 1000) + 3600, "real");
  (globalThis as any).canvas.tokens.placeables = [captain, clerk];
  assert.equal(await clearInfluenceLocks(), 1);
  assert.equal(lockFor(captain, APPROACHES.persuade), null);
});
