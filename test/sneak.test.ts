import { strict as assert } from "node:assert";
import { beforeEach, test } from "node:test";

import {
  advantageOf,
  alliesBeside,
  qualifyingWeapon,
  readSneak,
  sneakFormula,
} from "../src/system/dnd5e-sneak";
import { sneakClaimedNatively, surveySneak } from "../src/rules/sneak";
import { staticRefusal } from "../src/capability/describe";
import { duplicatesItemDamage } from "../src/capability/duplicate";

// The rule is four clauses long and every one of them is a place a prompt could appear on a swing that
// did not earn it. These pin the reading rather than the plumbing: what qualifies, what does not, and
// which of the two directions each unreadable case falls in.

const GRID = 100;

/** Every setting this graph reads, so a test can turn the offer off without knowing the key shape. */
let settings: Record<string, unknown> = {};

beforeEach(() => {
  settings = { "combat.sneak.npc": true, "combat.sneak.pc": true };
  (globalThis as any).game = {
    system: { id: "dnd5e" },
    modules: new Map(),
    settings: { get: (_ns: string, key: string) => settings[key] },
  };
  (globalThis as any).CONFIG = { specialStatusEffects: { DEFEATED: "dead" } };
  (globalThis as any).canvas = {
    grid: { size: GRID, distance: 5 },
    tokens: { placeables: [] },
  };
});

function token(spec: {
  id: string;
  x?: number;
  disposition?: number;
  items?: any[];
  scale?: Record<string, any>;
  statuses?: string[];
}) {
  const doc = {
    x: (spec.x ?? 0) * GRID,
    y: 0,
    width: 1,
    height: 1,
    elevation: 0,
    disposition: spec.disposition ?? 1,
    hasStatusEffect: (id: string) => (spec.statuses ?? []).includes(id),
  };
  const actor = {
    name: spec.id,
    items: spec.items ?? [],
    statuses: new Set(spec.statuses ?? []),
    system: { attributes: {} },
    getRollData: () => ({ scale: spec.scale ?? {} }),
  };
  return { id: spec.id, name: spec.id, document: doc, actor, ...doc };
}

const FEATURE = { type: "feat", name: "Sneak Attack", system: { identifier: "sneak-attack" } };

function dagger(properties: string[] = ["fin"]) {
  return {
    type: "weapon",
    system: { properties: new Set(properties), type: { value: "simpleM" } },
  };
}

function attack(mode: number) {
  return { rolls: [{ options: { advantageMode: mode } }] };
}

test("finesse or ranged qualifies; a maul does not", () => {
  assert.equal(qualifyingWeapon(dagger(["fin"]), {}), true);
  assert.equal(qualifyingWeapon(dagger([]), { attack: { type: { value: "ranged" } } }), true);
  const bow = { type: "weapon", system: { properties: new Set(), type: { value: "martialR" } } };
  assert.equal(qualifyingWeapon(bow, {}), true);
  assert.equal(qualifyingWeapon(dagger([]), {}), false);
});

// The one place this errs strict rather than generous. A prompt that appears on every swing gets clicked
// through, and then the rogue is dealing damage nobody checked — which is silent. A refusal is quiet too
// but is reported by `api.surveySneak()`, so somebody can find out why.
test("an unreadable weapon refuses rather than offering", () => {
  assert.equal(qualifyingWeapon({ type: "weapon" }, {}), false);
  assert.equal(qualifyingWeapon(null, {}), false);
  assert.equal(
    qualifyingWeapon({ type: "feat", system: { properties: new Set(["fin"]) } }, {}),
    false,
  );
});

// `options.advantageMode` is serialized with the roll, which is what lets the GM's client read a mode set
// on the player's. `hasAdvantage` only survives where the roll deserialized as a real D20Roll.
test("advantage is read off the roll that was made, by either route", () => {
  assert.equal(advantageOf(attack(1)), 1);
  assert.equal(advantageOf(attack(-1)), -1);
  assert.equal(advantageOf(attack(0)), 0);
  assert.equal(advantageOf({ rolls: [{ hasAdvantage: true }] }), 1);
  assert.equal(advantageOf({ rolls: [{ hasDisadvantage: true }] }), -1);
  assert.equal(advantageOf({}), 0);
});

test("the feature's own dice win, and the class scale is the fallback", () => {
  const written = {
    system: {
      activities: [{ damage: { parts: [{ custom: { enabled: true, formula: "3d6" } }] } }],
    },
  };
  assert.equal(sneakFormula({ getRollData: () => ({}) }, written), "3d6");

  // The case that produced this work: an item hollowed out to a Utility, leaving no dice at all.
  const hollow = { system: { activities: [{ type: "utility" }] } };
  const rogue = { getRollData: () => ({ scale: { rogue: { "sneak-attack": "2d6" } } }) };
  assert.equal(sneakFormula(rogue, hollow), "@scale.rogue.sneak-attack");
});

// Never assume "rogue". A homebrew or translated class identifier holding the scale would otherwise roll
// nothing, and an offer that deals zero looks exactly like the offer being broken.
test("the scale is found under whichever class identifier holds it", () => {
  const actor = { getRollData: () => ({ scale: { scoundrel: { "sneak-attack": "2d6" } } }) };
  assert.equal(sneakFormula(actor, {}), "@scale.scoundrel.sneak-attack");
  assert.equal(sneakFormula({ getRollData: () => ({ scale: {} }) }, {}), "");
});

test("an ally is a token sharing the attacker's disposition, within 5 feet, and conscious", () => {
  const rogue = token({ id: "rogue", x: 0, disposition: 1 });
  const target = token({ id: "goblin", x: 2, disposition: -1 });
  const fighter = token({ id: "fighter", x: 3, disposition: 1 });
  (globalThis as any).canvas.tokens.placeables = [rogue, target, fighter];
  assert.equal(alliesBeside(rogue, target).length, 1);

  // Out of reach.
  fighter.document.x = 5 * GRID;
  assert.equal(alliesBeside(rogue, target).length, 0);
});

// Both exclusions are real on a table where a rogue's summons share its disposition, and the target's is
// the one that would otherwise let a hostile creature qualify itself as "your ally".
test("neither the attacker nor the target counts as its own ally", () => {
  const goblin = token({ id: "goblin", x: 0, disposition: -1 });
  const other = token({ id: "victim", x: 1, disposition: -1 });
  (globalThis as any).canvas.tokens.placeables = [goblin, other];
  assert.equal(alliesBeside(goblin, other).length, 0);
});

test("a defeated or incapacitated ally does not qualify", () => {
  const rogue = token({ id: "rogue", x: 0 });
  const target = token({ id: "goblin", x: 1, disposition: -1 });
  const dead = token({ id: "cleric", x: 1, statuses: ["dead"] });
  (globalThis as any).canvas.tokens.placeables = [rogue, target, dead];
  assert.equal(alliesBeside(rogue, target).length, 0);

  const stunned = token({ id: "wizard", x: 1, statuses: ["incapacitated"] });
  (globalThis as any).canvas.tokens.placeables = [rogue, target, stunned];
  assert.equal(alliesBeside(rogue, target).length, 0);
});

function swing(overrides: Record<string, any> = {}) {
  const rogue = token({
    id: "rogue",
    x: 0,
    items: [FEATURE],
    scale: { rogue: { "sneak-attack": "2d6" } },
  });
  const target = token({ id: "goblin", x: 1, disposition: -1 });
  (globalThis as any).canvas.tokens.placeables = [rogue, target];
  return {
    attackerToken: rogue,
    targetToken: target,
    item: dagger(),
    activity: { damage: { parts: [{ types: new Set(["piercing"]) }] } },
    message: attack(1),
    ...overrides,
  };
}

test("advantage with a finesse weapon qualifies, and names why", () => {
  const reading = readSneak(swing());
  assert.equal(reading.eligible, true);
  assert.equal(reading.because, "advantage");
  assert.equal(reading.formula, "@scale.rogue.sneak-attack");
  assert.equal(reading.damageType, "piercing");
});

// The clause people get wrong: Disadvantage refuses even with an ally beside the target. It is only the
// ALLY route the sentence lets Disadvantage spoil, and it spoils it absolutely.
test("disadvantage refuses whatever else is true", () => {
  const ally = token({ id: "fighter", x: 1 });
  (globalThis as any).canvas.tokens.placeables.push(ally);
  const reading = readSneak(swing({ message: attack(-1) }));
  assert.equal(reading.eligible, false);
  assert.match(reading.reason, /Disadvantage/);
});

test("an ally beside the target qualifies a swing with no advantage", () => {
  const input = swing({ message: attack(0) });
  (globalThis as any).canvas.tokens.placeables.push(token({ id: "fighter", x: 1 }));
  const reading = readSneak(input);
  assert.equal(reading.eligible, true);
  assert.equal(reading.because, "ally");
});

test("neither advantage nor an ally refuses", () => {
  const reading = readSneak(swing({ message: attack(0) }));
  assert.equal(reading.eligible, false);
  assert.match(reading.reason, /ally/);
});

test("a creature with no Sneak Attack feature is never offered it", () => {
  const bare = token({ id: "fighter", x: 0 });
  const reading = readSneak(swing({ attackerToken: bare }));
  assert.equal(reading.eligible, false);
  assert.match(reading.reason, /feature/);
});

// An unreadable damage type is "" rather than a guess: `applyDamage` reads unknown as untyped, which
// skips resistance. Naming one would be the error that silently changes the number.
test("an unreadable damage type is left empty", () => {
  const reading = readSneak(swing({ activity: {}, item: dagger() }));
  assert.equal(reading.eligible, true);
  assert.equal(reading.damageType, "");
});

// The refusal predicate, from the other end. `duplicate.ts` cannot see this case: it compares a rule's
// dice against the ACTIVITY's `damage.parts`, and the feature that produced this work has none.

const CHARACTER = { type: "character" };

function rule(kind: string): any {
  return { trigger: { event: "on_hit" }, effect: { kind, amount: { dice: "2d6" } } };
}

test("a compiled damage rule on the Sneak Attack feature is refused while we deal it", () => {
  const item = { ...FEATURE, actor: CHARACTER };
  assert.match(String(sneakClaimedNatively(rule("damage"), item)), /natively/);
});

test("only damage is refused; a capability describing the feature is left alone", () => {
  const item = { ...FEATURE, actor: CHARACTER };
  assert.equal(sneakClaimedNatively(rule("grant_capability"), item), null);
  assert.equal(
    sneakClaimedNatively(rule("damage"), { type: "feat", name: "Cunning Action" }),
    null,
  );
  assert.equal(sneakClaimedNatively(rule("damage"), null), null);
});

// A table that switched the offer off and compiled the feature deliberately has exactly one thing
// dealing the dice. Refusing there would leave nothing dealing them, which is the failure that reads as
// the compiler having been paid for nothing.
test("nothing is refused when the offer is off", () => {
  settings["combat.sneak.pc"] = false;
  assert.equal(sneakClaimedNatively(rule("damage"), { ...FEATURE, actor: CHARACTER }), null);
});

test("Chris's Premades outranks the switch, because its macro deals the dice either way", () => {
  settings["combat.sneak.pc"] = false;
  (globalThis as any).game.modules = new Map([
    ["chris-premades", { active: true }],
    ["midi-qol", { active: true }],
  ]);
  const claimed = {
    ...FEATURE,
    actor: CHARACTER,
    flags: { "chris-premades": { info: { identifier: "sneakAttack" } } },
  };
  assert.match(String(sneakClaimedNatively(rule("damage"), claimed)), /Chris's Premades/);

  // And a feature it never touched is still ours to refuse.
  assert.equal(sneakClaimedNatively(rule("damage"), { ...FEATURE, actor: CHARACTER }), null);
});

// Both readers of the refusal — the capability sheet and `surveyCapabilities` — go through one
// function, because they did not and disagreed. The console asked `duplicatesItemDamage` alone, so a
// live rogue's compiled Sneak Attack was badged in the window and printed clean in the console from the
// same descriptor in the same session.
test("the static refusal reports what duplicate.ts alone cannot see", () => {
  const item = { ...FEATURE, actor: CHARACTER };
  assert.equal(duplicatesItemDamage(rule("damage"), item), null);
  assert.match(staticRefusal(rule("damage"), item), /natively/);
});

test("no feature in hand is not checked, and must never read as clear", () => {
  assert.equal(staticRefusal(rule("damage"), undefined), "");
});

// The survey, pinned for the same reason `hideLine` is: both of the failures it exists to catch produce a
// perfectly reasonable-looking block when the line is missing, so a review cannot see them. A rogue whose
// dice do not resolve and whose weapons do not qualify will never be asked, and every other line reads
// healthy — feature present, setting on, nobody else automating, nothing spent.

/** A dagger as a sheet holds one: the weapon's own activity is what `qualifyingWeapon` is asked about. */
function blade() {
  const item = dagger(["fin"]);
  return { ...item, name: "Dagger", system: { ...item.system, activities: [{ attack: {} }] } };
}

function survey(actor: any): string {
  const printed: string[] = [];
  const real = console.log;
  console.log = (...args: unknown[]) => void printed.push(args.map(String).join(" "));
  try {
    (globalThis as any).canvas.tokens.controlled = [{ name: "Rogue", actor }];
    surveySneak();
  } finally {
    console.log = real;
  }
  return printed.join("\n");
}

test("the survey names dice that would roll nothing, and weapons that cannot qualify", () => {
  const hollow = { ...FEATURE, system: { activities: [{ type: "utility" }] } };
  const block = survey({
    type: "character",
    items: [hollow, dagger([])],
    getRollData: () => ({ scale: {} }),
  });
  assert.match(block, /dice: NONE/);
  assert.match(block, /qualifying weapons: NONE/);
});

test("and reports both when they are healthy, resolving a scale reference to its dice", () => {
  (globalThis as any).Roll = { replaceFormulaData: (f: string) => f.replace(/@\S+/, "2d6") };
  const hollow = { ...FEATURE, system: { activities: [{ type: "utility" }] } };
  const block = survey({
    type: "character",
    items: [hollow, blade()],
    getRollData: () => ({ scale: { rogue: { "sneak-attack": "2d6" } } }),
  });
  assert.match(block, /dice: @scale\.rogue\.sneak-attack \(resolves to 2d6\)/);
  assert.match(block, /qualifying weapons: Dagger/);
});

// A reference the actor's roll data cannot answer is the one case worth shouting about: it is the shape
// the dice line was added for, and it resolves to itself rather than to an error.
test("a dead scale reference says so rather than printing itself back", () => {
  (globalThis as any).Roll = { replaceFormulaData: (f: string) => f };
  const written = {
    ...FEATURE,
    system: {
      activities: [{ damage: { parts: [{ custom: { enabled: true, formula: "@scale.x.y" } }] } }],
    },
  };
  const block = survey({ type: "character", items: [written], getRollData: () => ({}) });
  assert.match(block, /dice: @scale\.x\.y \(UNRESOLVED/);
});
