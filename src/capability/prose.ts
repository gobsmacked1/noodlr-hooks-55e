// Turning a sheet's HTML into the words the compiler is allowed to read.
//
// SEPARATE FROM `collect.ts`, AND FOR THE SAME REASON `noodlr` KEEPS ITS PROMPT BUILDERS IN
// `vocabulary.ts`: `scripts/census-meta-notes.mjs` runs this over the 4,674 authored files in the
// dnd5e corpus to measure what the scrubber below removes, and a census that reimplemented the
// regex would be certifying a scrubber nobody ships. Nothing here imports a Foundry global.
//
// THE PROBLEM THIS FILE EXISTS FOR. A sheet's description is not pure rules text. dnd5e's own
// content ships asides written by its content team, addressed to the human GM, describing what
// Foundry cannot do and what the reader must therefore do by hand:
//
//   "The Exhaustion levels from missing limbs must be applied manually."      (Loathsome Limbs)
//   "The resistances outlined will need to be manually enabled/disabled."     (Draconic Origin)
//   "the enchantment needs to be dragged from this item's Effects tab…"       (Antennae)
//   "You can enable the AE in the effects tab of the character sheet."        (Riposte)
//
// Handed to a compiler these are catastrophic, and **a well-behaved instruction-following model is
// MORE vulnerable to them, not less**: the Troll's note is a plain-English instruction not to emit
// the effect the rule states, and the model obliged. The descriptor came back with no exhaustion in
// it at all, which read at the table as the compiler having missed a clause it had in fact been told
// to skip. Nothing anywhere reported it, because a missing rule looks exactly like a rule that was
// never there.
//
// WE STRIP THESE. WE DO NOT REWRITE THEM. Turning "a human must apply this" into "the automation
// must apply this" is tempting and is the one change that could make this worse: most of these notes
// describe things no engine here can do — drag an enchantment onto another item's sheet, tick an
// Active Effect — so rewriting them instructs the model to emit a rule for a capability the executor
// has no primitive for. Best case that is inert and badged on the capability sheet; worst case it
// lands on a near-miss primitive and does the wrong thing confidently. That is fabrication, which
// this module forbids everywhere else. The game's own words are already there: the Troll's prose says
// "has 1 Exhaustion level for each missing limb" in the sentence immediately before its note. Strip
// the note and the clause the model needs is sitting right where it always was.
//
// TWO STRIPS, AND ONLY ONE OF THEM IS REPORTED. A note inside a hidden section is silent:
// `class="secret"` is core's own convention, dnd5e uses it as intended, and warning about correctly
// marked authoring notes would be noise that teaches a GM to ignore the channel. Tooling prose
// standing in the OPEN is reported, because it means somebody's homebrew, importer or premade library
// wrote an instruction into the rule text itself — the case nobody knows about, and the one that will
// silently poison a descriptor.
//
// MEASURED, and the numbers are the argument for the shape above (`npm run census:notes`, 31,845
// descriptions): **848 carry a hidden section, 793 of which are notes and 55 of which are rules, and
// 5 descriptions carry tooling prose out in the open** — two distinct sentences, both of them telling
// the reader to drag something onto a character sheet, so both true positives. The vocabulary half
// therefore almost never fires on official content; it earns its place against imported and homebrew
// sheets, which is exactly where nobody is checking. The same run is what retired `compendium` from
// the vocabulary and what proved a hidden section is not always a note; both are at the definitions
// below.
//
// DO NOT TRUST AN EARLIER RUN OF THAT CENSUS. It was wrong by a factor of 25 for its first two runs —
// it said 34 hidden sections and zero open-prose hits — because the extractor mishandled CRLF and YAML
// folded scalars and truncated every multi-line description to its first line. Neither fault touched
// this file (by the time it runs, Foundry has parsed the YAML and handed over one clean string), and
// that is the point: **the instrument was measuring a file format instead of the thing that ships,
// and it reported a reassuring number rather than an error.** The full story is in AGENTS.md; the
// operational rule is that a suspiciously clean corpus measurement gets cross-checked with `rg`
// before it is believed or quoted anywhere.

/**
 * A section `enrichHTML` hides from players.
 *
 * **NOT the same thing as a note, which is the trap here and was found by measuring.** The obvious
 * reading is that anything hidden from players is addressed to whoever runs the table, and the
 * census disproves it: of the 848 descriptions in the corpus carrying one of these, **55 hold
 * ordinary rules text** that happens to be a surprise — a doughlike difficult-terrain aura, a curse
 * that lasts an hour, a disease's progression after a minute, Sneak Attack's "Once per turn", and
 * every monster feature templated with `[[lookup @name]]`. Those are exactly the abilities worth
 * compiling, and stripping the section wholesale would have deleted them; for several of them the
 * hidden section is the whole of what the ability does.
 *
 * The other 793 are notes, and **all 793 open with the literal words "Foundry Note" — one distinct
 * opening across the entire corpus.** dnd5e's content team is completely consistent about it, which
 * is what makes this half of the scrubber cheap and reliable, and it is also the answer to where the
 * Troll's instruction came from: it is authored upstream, in the system's own compendium.
 *
 * So the section is the unit of granularity and {@link isMetaAside} is the test. Applied before the
 * prose is hashed, which means editing or removing a note correctly invalidates its cache entry.
 */
export const SECRET =
  /<section\b[^>]*\bclass\s*=\s*(["'])[^"']*\bsecret\b[^"']*\1[^>]*>[\s\S]*?<\/section>/gi;

/**
 * Vocabulary that talks about the SOFTWARE rather than about the game.
 *
 * This is the whole test, and it is a narrow one on purpose: a rule is a statement about a world
 * with creatures and dice in it, and it has no reason to mention a tab, an Active Effect, or a
 * module. Every term here was taken from a note that exists in the shipped corpus, and the set was
 * then measured against all 4,674 authored files to count what else it catches
 * (`npm run census:notes`).
 *
 * **DELIBERATELY ABSENT, and each omission is a false positive that was found by measuring rather
 * than reasoned about:**
 * - `compendium` — **the one that would have done real damage, and it was caught by measuring
 *   rather than by review.** It reads as pure tooling and it is not: `@UUID[Compendium.dnd5e.…]`
 *   and `@Embed[Compendium.…]` are how the content team writes a link to a spell, so the word sits
 *   in the middle of thousands of ordinary rules. Re-measured 2026-08-15 with {@link unwrapEnrichers}
 *   in place: adding it takes the open-prose strip from **5 descriptions to 1,336, and from 2
 *   distinct sentences to 452** — every one of them a rule, in the shape "You can cast Armor of
 *   Shadows". Anyone tempted to add it can reproduce that in seven seconds, which is the whole
 *   reason the census exists.
 *
 *   Those two numbers were **2,469 and 1,334 before enrichers were unwrapped**, and the halving is
 *   worth understanding rather than editing over: unwrapping deletes the word `Compendium` along
 *   with the markup carrying it, so the counterfactual now only catches prose that says "compendium"
 *   in English. It is still 452 rules deleted, so the verdict is unchanged — but it is a reminder
 *   that **a counterfactual recorded in a comment ages against changes nowhere near it**, and this
 *   one has now been re-measured twice.
 * - `drag` — "the target is dragged 10 feet" is a real grapple rule.
 * - `token` — a Feather Token is an item, and "token" is game vocabulary in this system.
 * - `\bAE\b` — two letters, and a bare abbreviation is not worth the risk when "Active Effect"
 *   appears in the same sentence in every note that uses it.
 * - `automatic`/`automatically` — game text uses it constantly ("automatically fails").
 * - `enchantment` on its own — dnd5e has an Enchant activity, so it is game vocabulary here.
 *
 * If a new book breaks this, the census is the instrument: it prints every sentence the scrubber
 * would remove, so a false positive is visible as a rule going missing from the list rather than as
 * a creature quietly behaving oddly six sessions later.
 */
export const TOOLING = new RegExp(
  [
    // The literal heading the content team uses, and the only unambiguous marker in the set.
    String.raw`\bfoundry\b`,
    // Foundry's own nouns. None is a thing that exists inside the fiction.
    String.raw`\bactive effects?\b`,
    String.raw`\beffects? tab\b`,
    String.raw`\b(?:character|actor|creature|item|monster)(?:'s|s')? sheet\b`,
    String.raw`\bsheet(?:'s|s')? (?:effects?|details|inventory) tab\b`,
    String.raw`\bmacros?\b`,
    String.raw`\bmidi[\s-]?qol\b`,
    String.raw`\bdae\b`,
    String.raw`\blibwrapper\b`,
    // Meta-instruction phrasing: a sentence about what a PERSON has to do to the software.
    String.raw`\bmanually\b`,
    String.raw`\benabled\s*\/\s*disabled\b`,
  ].join("|"),
  "i",
);

/**
 * Does this passage talk about the software?
 *
 * One test, two granularities, and the split is what the corpus asked for. A whole hidden section is
 * judged at once, because a "Foundry Note" heading is followed by sentences that are pure tooling
 * and contain no marker of their own — "You can select the damage type in the damage roll's dialog
 * box" names nothing this vocabulary knows, and judging it alone would leave most of every note
 * behind. Prose in the open is judged a sentence at a time, because there the surrounding text is
 * the rule and dropping the paragraph would take it with us.
 */
export function isMetaAside(text: string): boolean {
  return TOOLING.test(text);
}

/**
 * Turn Foundry's enricher syntax into the words it renders as.
 *
 * THE SECOND CONTAMINATION, AND IT IS SHARPER THAN THE NOTES. An enricher's OPTIONS are instructions
 * to the renderer, and they are written in the imperative English of the thing the rule is about:
 *
 *   The troll has 1 &Reference[Exhaustion apply=false] level for each missing limb.
 *
 * `apply=false` means "do not draw an apply button on the chat card". Beside the word `Exhaustion`,
 * to a model reading for what to emit, it is a plain-English instruction not to apply Exhaustion —
 * and that is the exact clause the Troll reportedly never acts on. Same failure as the hidden notes
 * (an instruction about the software read as an instruction about the rule) at a much smaller
 * granularity, and much harder to see, because there is no heading and no hidden section to notice.
 * **1,128 occurrences of `apply=false` in the shipped corpus**, essentially all of them welded to a
 * condition name.
 *
 * UNWRAP RATHER THAN DELETE, and the distinction is the whole design. The words inside an enricher
 * are the rule — `Exhaustion` is the condition, `{Troll Limb}` is what gets summoned, `2d6` is the
 * damage — so this keeps the reading and throws away the markup, exactly as tag-stripping does one
 * line above. Nothing here removes a word or a number, which is the standing rule for everything
 * upstream of the cache key.
 *
 * WHAT IS DELIBERATELY LEFT ALONE. An **unlabelled** `@UUID[…]` (3,460 of them) renders as a
 * document's name, and that name is only resolvable through a Foundry global this file is not
 * allowed to touch — so the choice is between a noisy id and deleting a noun out of the middle of a
 * sentence, and a noisy id is plainly the safer of the two. An unlabelled `[[…]]` roll (4,120) is
 * left whole for a better reason: `[[/damage 2d6 slashing]]` carries the dice, and they are the
 * point.
 *
 * The generic-name templating survives: `[[lookup @name lowercase]]{monster}` unwraps to `monster`,
 * not to this creature's name, so 270 creatures still share one wording and one cache entry.
 */
export function unwrapEnrichers(text: string): string {
  return (
    text
      // `&Reference[Exhaustion apply=false]` → `Exhaustion`; `&Reference[condition=blinded]` →
      // `blinded`. Option tokens are dropped, and when EVERY token is an option the value is the
      // reading — the key names a Foundry lookup table rather than anything in the fiction.
      .replace(/&Reference\[([^\]]*)\]/gi, (_all, inner: string) => {
        const tokens = String(inner).trim().split(/\s+/).filter(Boolean);
        const plain = tokens.filter((t) => !t.includes("="));
        if (plain.length) return plain.join(" ");
        return tokens.map((t) => t.slice(t.indexOf("=") + 1)).join(" ");
      })
      // A labelled link of any flavour (`@UUID`, `@Embed`, `@Item`, …) reads as its label, which is
      // what the content team wrote it for.
      .replace(/@\w+\[[^\]]*\]\{([^}]*)\}/g, "$1")
      // A labelled roll or lookup, same reasoning.
      .replace(/\[\[[^\]]*\]\]\{([^}]*)\}/g, "$1")
  );
}

/**
 * Prose as a human reads it, with the block structure kept.
 *
 * Newlines matter more here than anywhere else in the module: a stat block's Multiattack and the
 * attacks it refers to are separate paragraphs, and collapsing them into one line is how "makes
 * three attacks" ends up attached to the wrong one.
 */
export function plainText(html: unknown): string {
  return (
    unwrapEnrichers(
      String(html ?? "")
        .replace(SECRET, (section) => (isMetaAside(section) ? "" : section))
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
        .replace(/<li[^>]*>/gi, "• ")
        .replace(/<[^>]+>/g, "")
        .replace(/&nbsp;/gi, " ")
        // Before the enrichers, or `&amp;Reference[…]` is not a reference to anything.
        .replace(/&amp;/gi, "&")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&(?:quot|#34);/gi, '"')
        .replace(/&(?:apos|#39);/gi, "'"),
    )
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

export interface Scrubbed {
  /** The rule, with anything addressed to a human taken out of it. */
  prose: string;
  /** What was taken out, verbatim, so it can be reported rather than silently discarded. */
  removed: string[];
}

/**
 * Remove sentences that instruct a person about the software.
 *
 * SENTENCE GRANULARITY, NOT PARAGRAPH. These notes sit in the same paragraph as real rules often
 * enough that dropping the block would take the rule with it — which is the failure this function
 * exists to prevent, arriving from the other direction.
 *
 * Line structure is preserved so the paragraph boundaries `plainText` worked to keep survive.
 */
export function scrubMeta(text: string): Scrubbed {
  // The common case by a wide margin, and it must cost nothing: most abilities say nothing about
  // Foundry, and re-joining every line of every sheet on every scene load would be pure waste.
  if (!TOOLING.test(text)) return { prose: text, removed: [] };

  const removed: string[] = [];
  const lines = text.split("\n").map((line) => {
    if (!TOOLING.test(line)) return line;
    // Chunks that keep their own terminator, so a kept sentence is not silently restyled. A lone
    // fragment with no full stop (a heading, a bullet) is one chunk and is judged as one.
    const chunks = line.match(/[^.!?]+[.!?]*\s*/g) ?? [line];
    const kept = chunks.filter((chunk) => {
      if (!TOOLING.test(chunk)) return true;
      const note = chunk.trim();
      if (note) removed.push(note);
      return false;
    });
    return kept.join("").trim();
  });

  return {
    prose: lines
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
    removed,
  };
}
