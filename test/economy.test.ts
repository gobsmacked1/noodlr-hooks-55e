import { strict as assert } from "node:assert";
import { beforeEach, test } from "node:test";

import { actionDeclarationOf } from "../src/system/dnd5e-declarations";
import { isHideActivity } from "../src/system/dnd5e-stealth";
import {
  PHB_ACTIONS,
  isDisengageActivity,
  isDodgeActivity,
  isInfluenceActivity,
  isStabilizeActivity,
  phbActionOf,
} from "../src/system/dnd5e-actions";
import { lightExtraAttackCost } from "../src/system/dnd5e-two-weapon";
import { notable, slotClaims } from "../src/rules/economy/claims";
import {
  budget,
  check,
  explainAttacksPerAction,
  lightSwings,
  spend,
  takeLightSwing,
} from "../src/rules/economy/ledger";

/** An activity as dnd5e prepares one, reduced to the fields the ledger reads. */
function activity(name: string, type: string, activation: string | null) {
  return { name, type, activation: activation ? { type: activation } : {} };
}

function item(overrides: Record<string, any> = {}) {
  const activities = overrides.activities ?? [];
  return {
    name: overrides.name ?? "Longsword",
    type: overrides.type ?? "weapon",
    system: {
      identifier: overrides.identifier ?? "",
      activities: { contents: activities },
    },
    flags: overrides.flags ?? {},
    getFlag: (scope: string, key: string) => (overrides.flags ?? {})[scope]?.[key],
  };
}

/**
 * An actor whose flags round-trip, which is all the ledger needs: it writes the tally through
 * `setFlag` and reads it back through the raw `flags` object.
 */
function actor(items: any[] = []) {
  const flags: Record<string, any> = {};
  return {
    uuid: "Actor.test",
    id: "test",
    name: "Hobocop",
    items,
    flags,
    getFlag: (scope: string, key: string) => flags[scope]?.[key],
    setFlag: async (scope: string, key: string, value: unknown) => {
      flags[scope] = { ...(flags[scope] ?? {}), [key]: value };
    },
  };
}

/** One combatant, whose turn it is, in round one. */
function fight() {
  const combatant = { id: "c1", name: "Hobocop" };
  return { combat: { id: "combat1", round: 1, turn: 0, turns: [combatant] }, combatant };
}

beforeEach(() => {
  (globalThis as any).game = { system: { id: "dnd5e" }, settings: { get: () => true } };
});

/* -------------------------------------------- */
/*  Which buttons are only announcements         */
/* -------------------------------------------- */

test("the PHB Attack and Magic items are declarations; the other action items are not", () => {
  // Read off the user's own world (api.surveyActions): each ships as a feat with a stable identifier,
  // Attack claiming an action from a `utility` activity and Magic from three of them.
  assert.equal(
    actionDeclarationOf(item({ name: "Attack", type: "feat", identifier: "attack" })),
    "Attack (PHB action item)",
  );
  assert.equal(
    actionDeclarationOf(item({ name: "Magic", type: "feat", identifier: "magic" })),
    "Magic (PHB action item)",
  );

  // Complete actions in themselves: the button IS the action, so it is the right place to charge.
  for (const id of ["dodge", "disengage", "help", "ready", "search", "study", "stabilize", "hide"])
    assert.equal(actionDeclarationOf(item({ name: id, type: "feat", identifier: id })), null, id);

  // Dash is charged twice as well, and is deliberately NOT here: whoever charges it has to record the
  // Dash itself so the movement cap knows the extra Speed is paid for. See system/dnd5e-dash.ts.
  assert.equal(actionDeclarationOf(item({ name: "Dash", type: "feat", identifier: "dash" })), null);
});

test("a weapon called Attack is not a declaration, however it is identified", () => {
  // The dangerous direction: exempting a weapon would not merely miss a rider, it would make that
  // weapon free to use every turn with nothing anywhere reporting it.
  assert.equal(actionDeclarationOf(item({ name: "Attack", type: "weapon" })), null);
  assert.equal(
    actionDeclarationOf(item({ name: "Attack", type: "weapon", identifier: "attack" })),
    null,
  );
});

test("the name is only consulted when the sheet states no identifier", () => {
  assert.equal(
    actionDeclarationOf(item({ name: "Attack", type: "feat" })),
    "Attack (PHB action item)",
  );
  // A world that deliberately re-identified the feature is not overruled by what it is called.
  assert.equal(
    actionDeclarationOf(item({ name: "Attack", type: "feat", identifier: "house-attack-variant" })),
    null,
  );
});

/* -------------------------------------------- */
/*  What that costs at the table                 */
/* -------------------------------------------- */

test("declaring the Attack action and then swinging costs ONE action, not two", () => {
  // The bug: the button charged an Action as a non-attack claim, and the weapon then charged another
  // through the attack count, so a fighter without Extra Attack was refused their first swing.
  const { combat, combatant } = fight();
  const hero = actor();

  // The button is exempted before anything is spent, so only the swing reaches the ledger.
  spend(hero, combat, combatant, "action", true);

  assert.equal(budget(hero, combat, combatant).action, 0);
  assert.equal(check(hero, combat, combatant, "action", true).allowed, false);
  // And the swing that was paid for is not retroactively unpaid.
  assert.equal(budget(hero, combat, combatant).attack, 0);
});

test("a second Action is still refused once one has genuinely been spent", () => {
  const { combat, combatant } = fight();
  const hero = actor();

  spend(hero, combat, combatant, "action", false);

  assert.equal(check(hero, combat, combatant, "action", false).allowed, false);
  assert.equal(check(hero, combat, combatant, "action", true).allowed, false);
});

/* -------------------------------------------- */
/*  How many attacks one Action buys             */
/* -------------------------------------------- */

test("a Pact of the Blade warlock's Extra Attack is an invocation, and still counts", () => {
  // Thirsting Blade carries no `extra-attack` identifier — it is an Eldritch Invocation granting the
  // feature for the pact weapon only — so a warlock read as having one attack and was refused a legal
  // second swing every turn.
  const warlock = actor([
    item({ name: "Thirsting Blade", type: "feat", identifier: "thirsting-blade" }),
  ]);
  assert.equal(explainAttacksPerAction(warlock).value, 2);
});

test("Devouring Blade outranks Thirsting Blade, which it requires", () => {
  // "The Extra Attack of your Thirsting Blade invocation confers two extra attacks rather than one."
  // A level 12 warlock holds both, so reading the earlier one first would report three attacks as two.
  const warlock = actor([
    item({ name: "Thirsting Blade", type: "feat", identifier: "thirsting-blade" }),
    item({ name: "Devouring Blade", type: "feat", identifier: "devouring-blade" }),
  ]);
  assert.equal(explainAttacksPerAction(warlock).value, 3);
});

/* -------------------------------------------- */
/*  The Light property's extra attack            */
/* -------------------------------------------- */

/** A Light melee weapon, optionally with a mastery the wielder may or may not be entitled to. */
function lightWeapon(mastery = "", base = "dagger") {
  return {
    ...item({ name: "Dagger" }),
    system: {
      identifier: "",
      properties: new Set(["lgt", "fin"]),
      mastery,
      type: { baseItem: base },
      activities: { contents: [] },
    },
  };
}

const swing = { type: "attack", attack: { type: { value: "melee" } } };

test("a Light melee weapon offers the extra attack out of the bonus action", () => {
  const hero = actor();
  assert.equal(lightExtraAttackCost(hero, lightWeapon(), swing), "bonus");
});

test("Nick makes it free, but only for a wielder entitled to the mastery", () => {
  // `system.mastery` sits on every dagger in the world whether or not its holder may use it, so
  // reading the field alone would make the bonus action free for everybody.
  const untrained = actor();
  assert.equal(lightExtraAttackCost(untrained, lightWeapon("nick"), swing), "bonus");

  const trained = actor();
  (trained as any).system = { traits: { weaponProf: { mastery: { value: new Set(["dagger"]) } } } };
  assert.equal(lightExtraAttackCost(trained, lightWeapon("nick"), swing), "free");
});

test("a heavy weapon, a ranged attack and a spell offer nothing", () => {
  const hero = actor();
  const heavy = {
    ...lightWeapon(),
    system: { ...lightWeapon().system, properties: new Set(["hvy"]) },
  };
  assert.equal(lightExtraAttackCost(hero, heavy, swing), null);
  assert.equal(
    lightExtraAttackCost(hero, lightWeapon(), {
      type: "attack",
      attack: { type: { value: "ranged" } },
    }),
    null,
  );
  assert.equal(lightExtraAttackCost(hero, lightWeapon(), { type: "save" }), null);
});

test("the extra attack is once per turn, free or not", () => {
  const { combat, combatant } = fight();
  const hero = actor();

  assert.equal(lightSwings(hero, combat, combatant), 0);
  takeLightSwing(hero, combat, combatant, null);
  assert.equal(lightSwings(hero, combat, combatant), 1);
  // Nick spends no slot, which is exactly why the counter has to exist: free is not unlimited.
  assert.equal(budget(hero, combat, combatant).bonus, 1);

  takeLightSwing(hero, combat, combatant, "bonus");
  assert.equal(budget(hero, combat, combatant).bonus, 0);
});

/* -------------------------------------------- */
/*  Which button is the Hide action              */
/* -------------------------------------------- */

test("the sheet's Hide button is recognised by identifier and by activity name", () => {
  // The standalone PHB item: midi renames its activity to "Midi Use", so the identifier is the only route.
  assert.equal(
    isHideActivity(
      item({ name: "Hide", type: "feat", identifier: "hide" }),
      activity("Midi Use", "utility", "action"),
    ),
    true,
  );

  // A multi-purpose feature keeps its activities named, and ONLY the Hide one may be caught — intercepting
  // Cunning Action wholesale would swallow Dash and Disengage with it.
  const cunning = item({ name: "Cunning Action", type: "feat", identifier: "cunning-action" });
  assert.equal(isHideActivity(cunning, activity("Hide", "utility", "bonus")), true);
  assert.equal(isHideActivity(cunning, activity("Dash", "utility", "bonus")), false);
  assert.equal(isHideActivity(cunning, activity("Disengage", "utility", "bonus")), false);
});

test("a re-identified feature is not intercepted on the strength of its name", () => {
  // Same discipline as the declaration table: the name is consulted only when the sheet states no
  // identifier, so a house variant keeps whatever behaviour its own sheet describes.
  assert.equal(
    isHideActivity(item({ name: "Hide", type: "feat" }), activity("Use", "utility", "action")),
    true,
  );
  assert.equal(
    isHideActivity(
      item({ name: "Hide", type: "feat", identifier: "house-hide-variant" }),
      activity("Use", "utility", "action"),
    ),
    false,
  );
});

/* -------------------------------------------- */
/*  Which button is which PHB action             */
/* -------------------------------------------- */

test("each of the intercepted PHB buttons is recognised, and only itself", () => {
  const phb = (name: string, identifier: string) => item({ name, type: "feat", identifier });

  assert.equal(
    isDisengageActivity(phb("Disengage", "disengage"), activity("Midi Use", "utility", "action")),
    true,
  );
  assert.equal(
    isStabilizeActivity(phb("Stabilize", "stabilize"), activity("Midi Use", "utility", "action")),
    true,
  );
  assert.equal(
    isDodgeActivity(phb("Dodge", "dodge"), activity("Midi Use", "utility", "action")),
    true,
  );

  // Influence carries a "Use" and a "Check" activity and neither is named for the action, so the
  // identifier is the only route — and both must match, since either may be the one pressed.
  const influence = phb("Influence", "influence");
  assert.equal(isInfluenceActivity(influence, activity("Use", "utility", "action")), true);
  assert.equal(isInfluenceActivity(influence, activity("Check", "check", "action")), true);

  // A feature holding several of them hands over only the branch that was pressed.
  const cunning = item({ name: "Cunning Action", type: "feat", identifier: "cunning-action" });
  assert.equal(isDisengageActivity(cunning, activity("Disengage", "utility", "bonus")), true);
  assert.equal(isDisengageActivity(cunning, activity("Hide", "utility", "bonus")), false);
  assert.equal(isDodgeActivity(cunning, activity("Dash", "utility", "bonus")), false);
});

test("the action inventory answers what pressing a button does", () => {
  // The point of the table: a rule nobody wired looks exactly like one that broke, so every button
  // has to have an answer on record — including "nothing, and here is why".
  const found = phbActionOf(
    item({ name: "Dodge", type: "feat", identifier: "dodge" }),
    activity("Midi Use", "utility", "action"),
  );
  assert.equal(found?.handling, "observed");
  assert.equal(
    phbActionOf(item({ name: "Longsword" }), activity("Attack", "attack", "action")),
    null,
  );

  // Every one of the thirteen states how it is handled, and the four that resolve themselves are the
  // four `enforce.ts` hands over. If a fifth appears here it needs a hand-over too.
  const intercepted = PHB_ACTIONS.filter((a) => a.handling === "intercepted").map((a) => a.spec.id);
  assert.deepEqual(intercepted.sort(), ["dash", "hide", "influence", "stabilize"]);
});

/* -------------------------------------------- */
/*  What the diagnostic says about it            */
/* -------------------------------------------- */

test("the claims census names the rule that exempted a claim", () => {
  const claims = slotClaims(
    actor([
      item({
        name: "Attack",
        type: "feat",
        identifier: "attack",
        activities: [activity("Use", "utility", "action")],
      }),
      item({ activities: [activity("Attack", "attack", "action")] }),
    ]),
  );

  assert.equal(claims.length, 2);
  assert.equal(claims[0].exemptedAs, "Attack (PHB action item)");
  assert.equal(claims[1].exemptedAs, null);
  // Both are worth a human's attention: the first to confirm the exemption fired, the second because a
  // weapon claiming an Action is ordinary and so is filtered out.
  assert.equal(notable(claims[0]), true);
  assert.equal(notable(claims[1]), false);
});
