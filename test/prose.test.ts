// The prose scrubber decides which sentences of a sheet reach the compiler, and every mistake it
// makes is silent — a rule wrongly removed produces a creature that quietly never does one of its
// things. So the interesting assertions here are the NEGATIVE ones: real rules that must survive.

import assert from "node:assert/strict";
import test from "node:test";

import {
  SECRET,
  TOOLING,
  isMetaAside,
  plainText,
  scrubMeta,
  unwrapEnrichers,
} from "../src/capability/prose";

// Loathsome Limbs, verbatim from `actors24/giant/troll.yml` — the note that cost a release. Kept
// character-for-character rather than paraphrased, because a paraphrase is a specimen of the bug we
// imagined: the first version of this constant dropped both of the rule's guards, so the test passed
// while saying nothing about whether the sentence a compiler needs survives intact.
const TROLL =
  `<p class="feature">If the [[lookup @name lowercase]]{monster} ends any turn Bloodied and took ` +
  `15+ Slashing damage during that turn, one of the [[lookup @name lowercase]]{monster}l's limbs is ` +
  `severed, falls into the [[lookup @name lowercase]]{monster}'s space, and becomes a ` +
  `<strong>@UUID[Compendium.dnd5e.actors24.Actor.mmTrollLimb00000]{Troll Limb}</strong>. The limb ` +
  `acts immediately after the [[lookup @name lowercase]]{monster}'s turn. The [[lookup @name ` +
  `lowercase]]{monster} has 1 &amp;Reference[Exhaustion apply=false] level for each missing limb, ` +
  `and it grows replacement limbs the next time it regains Hit Points.</p>` +
  `<section class="secret" id="secret-01PBOuaZ8xS1KYt6"><p><strong>Foundry Note</strong></p>` +
  `<p>This feature provides an <strong>Active Effect</strong> condition in the character sheet's ` +
  `Effects tab to enable each level of Exhaustion. Since the condition can be applied multiple ` +
  `times, the GM must manually manage the level of Exhaustion. There is an active effect available ` +
  `for each level of exhaustion.</p></section>`;

test("a hidden note is removed and the rule beside it is not", () => {
  const text = plainText(TROLL);
  assert.match(text, /1 Exhaustion level for each missing limb/);
  assert.doesNotMatch(text, /Foundry Note/);
  assert.doesNotMatch(text, /manually manage/);
  assert.doesNotMatch(text, /Effects tab/);
});

test("BOTH of Loathsome Limbs' guards survive the scrub", () => {
  // Reported twice from play as the Troll shedding limbs at full health. Whatever else is wrong there,
  // it is not that the compiler was handed a rule with its conditions missing: this is the exact string
  // it reads, and each guard has to be legible in it on its own terms.
  const text = plainText(TROLL);
  assert.match(text, /ends any turn Bloodied/);
  assert.match(text, /took 15\+ Slashing damage during that turn/);
  assert.deepEqual(scrubMeta(text).removed, []);
});

test("`apply=false` never reaches the compiler beside a condition it negates", () => {
  // The reason the exhaustion clause survives every other test here and still produces a descriptor
  // with no exhaustion in it. `apply=false` tells the RENDERER not to draw an apply button; welded to
  // the word Exhaustion it reads as an instruction not to apply Exhaustion, and a well-behaved model
  // obeys it. 1,128 of these in the shipped corpus.
  const text = plainText(TROLL);
  assert.doesNotMatch(text, /apply\s*=/);
  assert.doesNotMatch(text, /false/);
  assert.match(text, /has 1 Exhaustion level/);
});

test("an enricher unwraps to its reading, keeping every word and number", () => {
  assert.equal(unwrapEnrichers("&Reference[Exhaustion apply=false]"), "Exhaustion");
  assert.equal(unwrapEnrichers("&Reference[Blinded apply=long]"), "Blinded");
  assert.equal(unwrapEnrichers("&Reference[Bonus Action]"), "Bonus Action");
  // Every token is an option, so the VALUE is the reading — the key names a Foundry lookup table.
  assert.equal(unwrapEnrichers("&Reference[condition=invisible]"), "invisible");
  assert.equal(
    unwrapEnrichers("a @UUID[Compendium.dnd5e.actors24.Actor.mmTrollLimb00000]{Troll Limb}"),
    "a Troll Limb",
  );
  assert.equal(unwrapEnrichers("the [[lookup @name lowercase]]{monster} bites"), "the monster bites");
});

test("an unlabelled roll keeps its dice, which are the point", () => {
  // Deleting the markup here would delete the rule. Left whole deliberately; same for an unlabelled
  // @UUID, whose name is only resolvable through a Foundry global this file may not touch.
  const roll = "deals [[/damage 2d6 slashing]] damage";
  assert.equal(unwrapEnrichers(roll), roll);
});

test("the whole note goes, not just the sentences carrying a marker", () => {
  // "The Regain Spell Slot activity will convert your Sorcery Points into spell slots." names nothing
  // in the vocabulary, so sentence-level judgement would leave most of every note behind. This is why
  // a hidden section is judged as one unit.
  const note = `<section class="secret"><p><strong>Foundry Note</strong></p>
<p>The Regain Spell Slot activity will convert your Sorcery Points into spell slots.</p></section>`;
  assert.equal(plainText(note), "");
});

test("a hidden section holding rules is KEPT", () => {
  // Four of these exist in the shipped corpus. Stripping every hidden section would delete them, and
  // they are exactly the abilities worth compiling: a surprise is still a rule.
  const hidden = `<section class="secret"><p>The ground in a 10-foot radius is difficult terrain.
Each creature that starts its turn there must succeed on a DC 10 Strength saving throw.</p></section>`;
  const text = plainText(hidden);
  assert.match(text, /difficult terrain/);
  assert.match(text, /DC 10 Strength saving throw/);
});

test("an enricher link is rule text, not tooling", () => {
  // `compendium` was in the vocabulary until the census scored 243 hits on it, every one a sentence
  // like this. Removing it would have deleted the rule and reported nothing.
  const rule = "You can cast @UUID[Compendium.dnd5e.spells24.Item.abc]{Armor of Shadows} at will.";
  assert.equal(scrubMeta(rule).prose, rule);
  assert.deepEqual(scrubMeta(rule).removed, []);
  assert.equal(isMetaAside(rule), false);
});

test("ordinary rules vocabulary is left alone", () => {
  // Each of these was a candidate term, and each is a real rule somewhere in the game.
  for (const rule of [
    "The target is dragged 10 feet toward the creature.",
    "A creature holding a Feather Token can use it as an Action.",
    "On a failed save the creature automatically fails its next Strength check.",
    "The item's enchantment ends when the spell ends.",
    "The effect lasts until the start of its next turn.",
  ]) {
    assert.equal(scrubMeta(rule).prose, rule, rule);
  }
});

test("tooling standing in open prose is removed and reported", () => {
  // The homebrew and importer case. Nothing dnd5e ships does this — the vocabulary half scored zero
  // over all 31,905 authored descriptions — so anything it catches is worth telling the GM about.
  const mixed =
    "The creature has resistance to fire damage. " +
    "The resistances will need to be manually enabled/disabled. " +
    "It also has Darkvision 60 feet.";
  const { prose, removed } = scrubMeta(mixed);
  assert.match(prose, /resistance to fire damage/);
  assert.match(prose, /Darkvision 60 feet/);
  assert.doesNotMatch(prose, /manually/);
  assert.equal(removed.length, 1);
  assert.match(removed[0], /manually enabled\/disabled/);
});

test("a note is removed sentence by sentence, keeping the rule in the same paragraph", () => {
  const line = "You can use this once per turn. You can enable the AE in the effects tab.";
  const { prose } = scrubMeta(line);
  assert.equal(prose, "You can use this once per turn.");
});

test("prose with nothing to scrub is returned untouched", () => {
  const rule = "The dragon exhales fire in a 60-foot Cone.";
  const scrubbed = scrubMeta(rule);
  assert.equal(scrubbed.prose, rule);
  assert.deepEqual(scrubbed.removed, []);
});

test("paragraph structure survives, because Multiattack depends on it", () => {
  const text = plainText(
    "<p>The troll makes three Rend attacks.</p><p>Rend. Melee Attack Roll.</p>",
  );
  assert.equal(text, "The troll makes three Rend attacks.\nRend. Melee Attack Roll.");
});

test("SECRET matches the attribute forms the content team actually writes", () => {
  for (const open of [
    '<section class="secret">',
    "<section class='secret'>",
    '<section class="secret" id="x">',
    '<section id="x" class="foo secret">',
  ]) {
    SECRET.lastIndex = 0;
    assert.ok(SECRET.test(`${open}<p>Foundry Note</p></section>`), open);
  }
});

test("TOOLING is stateless, so a repeated test cannot alternate", () => {
  // A global flag on a shared regex would make every second call return false, which would show up as
  // roughly half the notes surviving — a bug that looks like the vocabulary being incomplete.
  assert.equal(TOOLING.global, false);
  const note = "Apply this manually.";
  assert.equal(isMetaAside(note), true);
  assert.equal(isMetaAside(note), true);
});
