// The insult library: parsing `banter/banter.txt` into lines that know who they are about.
//
// The file stays plain text on purpose. It is the GM's to edit — add a line, delete one that does not
// suit the table, translate the lot — without a build step or a JSON schema to get wrong. Sections are
// marked `# Heading`, one line per taunt, blank lines ignored.
//
// Tagging happens on load, two ways:
//
//   1. From the section heading, via HEADINGS below. "# Rogue taunt" makes every line under it a
//      rogue line; "# Curses & Malicious Wishes" makes them curses.
//   2. From the line itself. The race jabs all live in one section but name their target ("Elf! Go
//      stare meaningfully at a leaf!"), and the follow-up line usually belongs to the same race
//      without repeating it ("Two hundred years old and still this bad?"). So a race word LATCHES:
//      it applies to that line and to the ones after it until another race word appears. Same for the
//      handful of lines that only work said to a man or to a woman.
//
// Nothing here is scored or chosen — see `speak.ts`. This module only answers "what is this line
// about", so that a bad match (calling a dwarf an elf) is impossible rather than unlikely.

import { log } from "../../constants";

export interface BanterLine {
  text: string;
  /** Character class the line mocks, if any: "rogue", "bard", ... */
  klass?: string;
  /** Broad style of fighting it mocks: "spellcaster" or "martial". */
  style?: string;
  /** Ancestry it names: "elf", "dwarf", ... */
  race?: string;
  /** "male" or "female" when the wording only works on one. */
  gender?: string;
  /** Loose flavor bucket, used to nudge selection (curses suit the undead, and so on). */
  flavor?: string;
  /** Very short exclamations, which fit anywhere and never look out of place. */
  bark?: boolean;
}

type HeadingTags = Omit<BanterLine, "text">;

// Section heading (lowercased, trimmed of "#") to the tags its lines inherit.
const HEADINGS: Array<{ match: RegExp; tags: HeadingTags }> = [
  { match: /spellcaster/, tags: { style: "spellcaster" } },
  { match: /^martial/, tags: { style: "martial" } },
  { match: /rogue/, tags: { klass: "rogue", style: "martial" } },
  { match: /bard/, tags: { klass: "bard" } },
  { match: /cleric/, tags: { klass: "cleric" } },
  { match: /ranger/, tags: { klass: "ranger", style: "martial" } },
  { match: /barbarian/, tags: { klass: "barbarian", style: "martial" } },
  { match: /paladin/, tags: { klass: "paladin", style: "martial" } },
  { match: /monk/, tags: { klass: "monk", style: "martial" } },
  { match: /druid/, tags: { klass: "druid" } },
  { match: /necromancer/, tags: { klass: "necromancer", style: "spellcaster" } },
  { match: /race & trope|race and trope/, tags: { flavor: "race" } },
  { match: /curses|malicious/, tags: { flavor: "curse" } },
  { match: /short barks|snarls/, tags: { bark: true, flavor: "bark" } },
  { match: /battle cries|defiance/, tags: { flavor: "defiance" } },
  { match: /brains|wit|learning/, tags: { flavor: "wit" } },
  { match: /cowardice|low birth|servile/, tags: { flavor: "cowardice" } },
  { match: /fat|lean|foul|deformed/, tags: { flavor: "appearance" } },
  { match: /family|ancestry/, tags: { flavor: "ancestry" } },
  { match: /food|tavern/, tags: { flavor: "tavern" } },
  { match: /bureaucratic|guild|merchant/, tags: { flavor: "trade" } },
  { match: /proverbial|period formulae/, tags: { flavor: "proverb" } },
];

// Ancestry words that latch onto the lines that follow them.
const RACES: Array<[RegExp, string]> = [
  [/\bhalf-elf\b/i, "half-elf"],
  [/\belf\b|\belves\b/i, "elf"],
  [/\bdwarf\b|\bdwarves\b/i, "dwarf"],
  [/\bhalfling\b|second breakfast/i, "halfling"],
  [/\borc\b/i, "orc"],
  [/\bgnome\b/i, "gnome"],
  [/\btiefling\b/i, "tiefling"],
  [/\bdragonborn\b/i, "dragonborn"],
];

// Lines whose wording is aimed at one sex. Small on purpose: a false positive silences a good line
// for half the table, so only unmistakable wording counts.
// "Hag-seed" is deliberately absent: it means the SPAWN of a hag and Shakespeare aims it at Caliban,
// so it works on anyone. "Fellows" likewise reads as a plural crowd rather than a man.
const FEMALE =
  /\bshe-|\bhag\b(?!-seed)|\bwitch\b|painted queen|painted maypole|mother o' the bawds/i;
const MALE = /\bboy\b|\bman\b|\bsir\b|\bson and heir\b|milk-livered/i;

let library: BanterLine[] = [];
let loaded = false;

function tagsForHeading(heading: string): HeadingTags {
  const h = heading.toLowerCase();
  for (const { match, tags } of HEADINGS) {
    if (match.test(h)) return tags;
  }
  return {};
}

export function parseBanter(raw: string): BanterLine[] {
  const out: BanterLine[] = [];
  let tags: HeadingTags = {};
  let latchedRace: string | undefined;

  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("#")) {
      tags = tagsForHeading(line.replace(/^#+/, "").trim());
      // A new section drops whatever ancestry the previous one was talking about.
      latchedRace = undefined;
      continue;
    }

    const named = RACES.find(([re]) => re.test(line))?.[1];
    if (named) latchedRace = named;

    const entry: BanterLine = { text: line, ...tags };
    // Only the ancestry section latches; elsewhere a stray "boy" or "witch" should not make every
    // following line about elves.
    if (tags.flavor === "race" && latchedRace) entry.race = latchedRace;
    else if (named) entry.race = named;

    if (FEMALE.test(line)) entry.gender = "female";
    else if (MALE.test(line)) entry.gender = "male";

    // A short exclamation reads as a bark wherever it appears, not only in the barks section.
    if (!entry.bark && line.length <= 22) entry.bark = true;

    out.push(entry);
  }
  return out;
}

/**
 * Load the library once. Fetched at runtime rather than bundled so a GM can edit the text file in
 * place; a missing or unreadable file simply means no banter, never an error at the table.
 */
export async function loadBanter(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const response = await fetch("modules/noodlr/banter/banter.txt");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    library = parseBanter(await response.text());
    log(`banter: ${library.length} lines loaded`);
  } catch (err) {
    log("banter: no library loaded —", err);
    library = [];
  }
}

export function banterLines(): BanterLine[] {
  return library;
}
