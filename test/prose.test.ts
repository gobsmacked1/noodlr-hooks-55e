// The prose scrubber decides which sentences of a sheet reach the compiler, and every mistake it
// makes is silent — a rule wrongly removed produces a creature that quietly never does one of its
// things. So the interesting assertions here are the NEGATIVE ones: real rules that must survive.

import assert from "node:assert/strict";
import test from "node:test";

import { SECRET, TOOLING, isMetaAside, plainText, scrubMeta } from "../src/capability/prose";

// The Troll's, verbatim from `actors24/giant/troll.yml` — the note that cost a release.
const TROLL = `<p>If the troll takes damage while it is Bloodied, one of its limbs is severed.</p>
<p>The troll has 1 Exhaustion level for each missing limb.</p>
<section class="secret">
<p><strong>Foundry Note</strong></p>
<p>The Exhaustion levels from missing limbs must be applied manually.</p>
</section>`;

test("a hidden note is removed and the rule beside it is not", () => {
  const text = plainText(TROLL);
  assert.match(text, /1 Exhaustion level for each missing limb/);
  assert.doesNotMatch(text, /Foundry Note/);
  assert.doesNotMatch(text, /applied manually/);
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
