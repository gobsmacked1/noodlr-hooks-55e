import { strict as assert } from "node:assert";
import { beforeEach, test } from "node:test";

import { acBoostOf, canTakeEnterReach, isPolearmWeapon } from "../src/system/dnd5e-reactions";
import { readHits } from "../src/rules/cards";
import { timeoutChoice } from "../src/rules/offer";

// Two decisions are pinned here, and both are the sort that a later reader would "simplify" back into a
// bug, because in each case the wrong version looks more helpful than the right one:
//
//   1. WHAT A SIX-SECOND CLOCK IS ALLOWED TO SPEND. A reaction is gone at the end of the round whether or
//      not it is used, so taking a free swing on a timeout costs nobody anything they were saving. A spell
//      slot spent because somebody was refilling their drink is unrecoverable. The generous-looking version
//      of this — default to the best option — is the one that loses a wizard their fourth-level slot.
//   2. WHETHER AN AC BONUS WOULD CHANGE THE ANSWER. Offering Shield against an attack that beat the AC by
//      nine spends the slot to be hit anyway, and a player under a clock reads an offer as a
//      recommendation. So the margin has to be read, which means `readHits` has to record it.

/** A token registered so `fromUuidSync` finds its actor, as the target records do. */
const world = new Map<string, any>();

function targetActor(uuid: string, name: string) {
  const doc = { id: `${name}-token`, name };
  world.set(uuid, { name, token: doc, getActiveTokens: () => [] });
  return doc;
}

function attack(total: number, targets: Array<{ name: string; ac: number | null }>, extra = {}) {
  return {
    rolls: [{ total, isCritical: false, isFumble: false, ...extra }],
    flags: {
      dnd5e: {
        roll: { type: "attack" },
        targets: targets.map((t) => ({ name: t.name, ac: t.ac, uuid: `Actor.${t.name}` })),
      },
    },
  };
}

/** An item as the AC table reads one: a name, an identifier, and our own flag namespace. */
function item(name: string, identifier = "", flags: Record<string, any> = {}) {
  return { name, system: { identifier }, flags, getFlag: (s: string, k: string) => flags[s]?.[k] };
}

/** An option as `readActions` produces one, reduced to what the default rule reads. */
function option(name: string, depleting: boolean) {
  return { name, depleting } as any;
}

beforeEach(() => {
  world.clear();
  (globalThis as any).fromUuidSync = (uuid: string) => world.get(uuid) ?? null;
  (globalThis as any).game = { system: { id: "dnd5e" }, modules: { get: () => undefined } };
});

/* -------------------------------------------- */
/*  What the clock may spend                     */
/* -------------------------------------------- */

test("a timeout takes a free reaction and never a depleting one", () => {
  const free = option("Halberd", false);
  const slot = option("Hellish Rebuke", true);

  // Ordered with the expensive one first on purpose: the rule is about cost, not about position.
  assert.equal(timeoutChoice([slot, free], "opportunity"), free);
  assert.equal(timeoutChoice([slot], "opportunity"), null, "nothing free means nothing chosen");
  assert.equal(timeoutChoice([], "opportunity"), null);
});

test("an incoming attack is never answered by the clock, free option or not", () => {
  // Every AC boost costs something and every one of them is the difference between being hit and not, so
  // this is exactly the decision a person has to make. A free-looking option here would be a homebrew
  // Parry, and defaulting it either way is still choosing for somebody.
  assert.equal(timeoutChoice([option("Parry", false)], "incoming"), null);
});

test("being hurt off-turn follows the same rule as a departure", () => {
  const free = option("Retaliation", false);
  assert.equal(timeoutChoice([option("Shield", true), free], "hurt"), free);
});

test("entering reach follows the same clock rule as a departure", () => {
  const free = option("Quarterstaff", false);
  assert.equal(timeoutChoice([option("Hellish Rebuke", true), free], "enter"), free);
});

/* -------------------------------------------- */
/*  Which reactions raise AC                     */
/* -------------------------------------------- */

test("Shield is recognised by identifier and by its exact name", () => {
  assert.equal(acBoostOf(item("Shield", "shield"), null)?.bonus, 5);
  assert.equal(acBoostOf(item("Shield"), null)?.bonus, 5);
});

test("a suit of armour is not the spell, which is why the name match is anchored", () => {
  // "Shield" is also every buckler in the game. An unanchored match would offer a fighter their shield as
  // a reaction, and then try to cast it.
  assert.equal(acBoostOf(item("Shield, +1"), null), null);
  assert.equal(acBoostOf(item("Tower Shield"), null), null);
  assert.equal(acBoostOf(item("Ring of Shielding"), null), null);
});

test("Defensive Duelist reads the proficiency off the sheet and floors it at 2", () => {
  assert.equal(
    acBoostOf(item("Defensive Duelist", "defensive-duelist"), {
      system: { attributes: { prof: 4 } },
    })?.bonus,
    4,
  );
  // Under-promising on an unreadable sheet: a bonus that decides a hit should be the smallest it could be.
  assert.equal(acBoostOf(item("Defensive Duelist", "defensive-duelist"), {})?.bonus, 2);
});

test("the flag is the escape hatch, so a homebrew Parry needs no change here", () => {
  const parry = item("Parry", "parry", { "noodlr-hooks-55e": { acReaction: 3 } });
  assert.equal(acBoostOf(parry, null)?.bonus, 3);
  assert.equal(acBoostOf(parry, null)?.label, "Parry");
});

test("an ordinary reaction raises no AC at all", () => {
  assert.equal(acBoostOf(item("Hellish Rebuke", "hellish-rebuke"), null), null);
  assert.equal(acBoostOf(null, null), null);
});

/* -------------------------------------------- */
/*  The margin Shield is judged against          */
/* -------------------------------------------- */

test("the margin by which an attack beat the AC is recorded, hit or miss", () => {
  const goblin = targetActor("Actor.Goblin", "Goblin");
  const orc = targetActor("Actor.Orc", "Orc");
  const reading = readHits(
    attack(18, [
      { name: "Goblin", ac: 15 },
      { name: "Orc", ac: 20 },
    ]),
  );
  assert.equal(reading.margin[goblin.id], 3, "beat 15 by three");
  assert.equal(reading.margin[orc.id], -2, "fell two short");
});

test("a critical and a fumble record no margin, because no AC bonus reaches either", () => {
  const goblin = targetActor("Actor.Goblin", "Goblin");
  const crit = readHits(attack(3, [{ name: "Goblin", ac: 30 }], { isCritical: true }));
  assert.equal(crit.margin[goblin.id], undefined);

  const fumble = readHits(attack(40, [{ name: "Goblin", ac: 5 }], { isFumble: true }));
  assert.equal(fumble.margin[goblin.id], undefined);
});

test("a +5 is worth offering against a hit by four and not against a hit by five", () => {
  // The comparison the offer layer makes, stated here as the arithmetic rather than as a mock: Shield
  // raises AC by 5, so it turns a hit that landed by 0 through 4 into a miss and leaves 5 alone.
  const shield = acBoostOf(item("Shield", "shield"), null)!;
  assert.equal(shield.bonus > 4, true);
  assert.equal(shield.bonus > 5, false);
});

test("Polearm Master weapons are the printed list, not every melee item", () => {
  const staff = { type: "weapon", name: "Quarterstaff", system: { identifier: "quarterstaff" } };
  const spear = { type: "weapon", name: "Spear", system: { identifier: "spear" } };
  const glaive = {
    type: "weapon",
    name: "Glaive",
    system: { identifier: "glaive", properties: ["rch", "hvy"] },
  };
  const dagger = { type: "weapon", name: "Dagger", system: { identifier: "dagger" } };
  const unarmed = { type: "weapon", name: "Unarmed Strike", system: { identifier: "unarmed-strike" } };
  assert.equal(isPolearmWeapon(staff), true);
  assert.equal(isPolearmWeapon(spear), true);
  assert.equal(isPolearmWeapon(glaive), true);
  assert.equal(isPolearmWeapon(dagger), false);
  assert.equal(isPolearmWeapon(unarmed), false);
});

test("Reactive Strike is recognised from the feat, not from a utility activity", () => {
  const monk = {
    items: [{ name: "Polearm Master", type: "feat", system: { identifier: "polearm-master" } }],
  };
  assert.equal(canTakeEnterReach(monk), true);
  assert.equal(canTakeEnterReach({ items: [] }), false);
});
