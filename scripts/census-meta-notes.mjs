// What the prose scrubber removes, measured over the whole authored corpus.
//
// `src/capability/prose.ts` decides which sentences of a sheet's description are addressed to a
// human rather than to the game, and everything downstream of that decision is invisible: a rule
// wrongly removed does not throw, it produces a creature that quietly never does one of its things.
// The only honest way to size that risk is to run the real scrubber over every description the
// system ships and read what comes out.
//
// It bundles `prose.ts` rather than reimplementing the regex, for the same reason the corpus harness
// imports `noodlr`'s prompt builders: a census measuring its own copy certifies nothing.
//
//   node scripts/census-meta-notes.mjs [path-to-dnd5e-packs-source]
//
// Reads TWO numbers that matter and prints every distinct sentence behind them:
//   secret   — removed structurally, by `<section class="secret">`. Expected, silent at runtime.
//   content  — removed by vocabulary, from prose NOT in a secret section. These are the ones the
//              module reports to the GM, and the ones to read for false positives.

import { build } from "esbuild";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CORPUS = "C:/Project/_research/dnd5e/packs/_source";
const corpus = process.argv[2] ?? DEFAULT_CORPUS;

try {
  statSync(corpus);
} catch {
  console.error(`no corpus at ${corpus}`);
  console.error("pass the path to dnd5e's packs/_source as the first argument.");
  process.exit(1);
}

// ---- The real scrubber ---------------------------------------------------------------------------

const out = mkdtempSync(join(tmpdir(), "noodlr-census-"));
await build({
  entryPoints: [join(here, "..", "src", "capability", "prose.ts")],
  outfile: join(out, "prose.mjs"),
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  logLevel: "warning",
});
const { SECRET, isMetaAside, plainText, scrubMeta } = await import(
  pathToFileURL(join(out, "prose.mjs")).href
);
rmSync(out, { recursive: true, force: true });

// ---- Walking the corpus -------------------------------------------------------------------------

function* files(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* files(path);
    else if (entry.name.endsWith(".yml")) yield path;
  }
}

// The description as authored, straight out of the YAML text.
//
// Deliberately NOT a YAML parse. The only field wanted is a long HTML string, every one of these
// files folds it across indented lines, and adding a YAML dependency to read one key would be a
// dependency this module does not otherwise need. What matters for the measurement is the prose,
// and the folding is whitespace.
//
// TWO FILE-FORMAT TRAPS, both of which made this census report a number far lower than the truth.
// Neither touches the shipped scrubber — by the time `prose.ts` runs, Foundry has parsed the YAML and
// the description is one clean string — so both are the instrument measuring the file format instead
// of the thing being measured. That is the worst kind of bug to have in a census, because it reports
// a reassuring number rather than an error.
//
//  1. CRLF. These files are CRLF, and in JavaScript `.` does not match `\r` (it is a line terminator
//     alongside `\n`). So a folded-scalar continuation of `(?:\1\s+.*\n?)+` matched exactly ONE line
//     and stopped, and every multi-line description — which is nearly all of them, and every one
//     carrying a hidden section — was truncated to its opening clause. Normalising first is the fix;
//     the alternative of sprinkling `\r?` through the pattern leaves the next author the same trap.
//  2. Escaping. Many values are double-quoted YAML scalars, so the authored `class="secret"` is on
//     disk as `class=\"secret\"`, and an earlier run reported ONE secret section in the whole corpus
//     because of it while the "Foundry Note" sentences fell through to the vocabulary half.
function descriptions(text) {
  const unescape = (s) => s.replace(/\\"/g, '"').replace(/\\n/g, "\n").replace(/\\\\/g, "\\");
  const lf = text.replace(/\r\n/g, "\n");
  const found = [];
  const re = /^([ \t]*)value:[ \t]*(?:([>|])[-+]?[ \t]*)?\n((?:\1[ \t]+[^\n]*\n?)+)/gm;
  for (const match of lf.matchAll(re)) {
    // A folded scalar (`>`) turns its newlines into spaces when Foundry parses it; a literal one (`|`)
    // keeps them. Leaving the newlines in for the folded case splits sentences mid-clause, which is
    // how three of the four open-prose hits below first showed up as fragments ending in "and".
    const body = match[3];
    found.push(
      unescape(match[2] === "|" ? body.replace(/^[ \t]+/gm, "") : body.replace(/\s*\n\s*/g, " ")),
    );
  }
  // The single-line form, for the short ones.
  for (const match of lf.matchAll(/^[ \t]*value:[ \t]*(['"])([\s\S]*?)\1[ \t]*$/gm))
    found.push(unescape(match[2]));
  return found;
}

const notes = new Map(); // first line of a dropped hidden section -> count
const rules = new Map(); // first line of a KEPT hidden section -> Set<file>
const content = new Map(); // sentence removed from open prose -> Set<file>
let scanned = 0;
let sections = 0;
let dropped = 0;
let withContent = 0;

for (const file of files(corpus)) {
  const raw = readFileSync(file, "utf8");
  const short = file.slice(corpus.length + 1).replace(/\\/g, "/");
  for (const html of descriptions(raw)) {
    scanned++;

    // Half one: the hidden sections, split by the decision `plainText` makes about each. The wrapper
    // tags are removed by hand rather than through `plainText`, which drops a meta section by design
    // — running one through it returns the empty string and reports nothing, which is how the first
    // version of this census managed to measure a single secret section in the whole corpus.
    for (const section of html.match(SECRET) ?? []) {
      sections++;
      const text = plainText(section.replace(/<\/?section\b[^>]*>/gi, ""));
      const head = text.split("\n").find((line) => line.trim()) ?? "(empty)";
      if (isMetaAside(section)) {
        dropped++;
        notes.set(head, (notes.get(head) ?? 0) + 1);
      } else {
        if (!rules.has(head)) rules.set(head, new Set());
        rules.get(head).add(short);
      }
    }

    // Half two: what is left over after the structural strip — i.e. tooling prose sitting in the
    // rule text itself. This is the number that decides whether the vocabulary is safe.
    const { removed } = scrubMeta(plainText(html));
    if (removed.length) {
      withContent++;
      for (const sentence of removed) {
        if (!content.has(sentence)) content.set(sentence, new Set());
        content.get(sentence).add(short);
      }
    }
  }
}

// ---- Report -------------------------------------------------------------------------------------

function heading(text) {
  console.log("");
  console.log(text);
  console.log("-".repeat(text.length));
}

console.log(`corpus:       ${corpus}`);
console.log(`descriptions: ${scanned}`);
console.log(
  `hidden sections: ${sections}  (${dropped} dropped as notes, ${sections - dropped} kept as rules)`,
);
console.log(`descriptions with tooling prose in the open: ${withContent}  (REPORTED to the GM)`);

heading(`Removed from open prose — ${content.size} distinct sentences`);
console.log(
  "READ EVERY ONE. Any that is a game rule is a false positive in TOOLING, and at runtime",
);
console.log(
  "it is a rule silently deleted from a creature. Zero here on official content is right:",
);
console.log("dnd5e marks its notes properly, so this half is for importers and homebrew.");
console.log("");
for (const [sentence, where] of [...content.entries()].sort((a, b) => b[1].size - a[1].size)) {
  console.log(`[${String(where.size).padStart(4)}] ${sentence}`);
  console.log(`       ${[...where].slice(0, 3).join(", ")}${where.size > 3 ? ", …" : ""}`);
}

heading(`Hidden sections KEPT as rules — ${rules.size} distinct`);
console.log(
  "These are hidden from players and compiled anyway. Any that is an authoring note is a",
);
console.log("false NEGATIVE: a term the vocabulary is missing.");
console.log("");
for (const [head, where] of [...rules.entries()].sort((a, b) => b[1].size - a[1].size)) {
  console.log(`[${String(where.size).padStart(4)}] ${head}`);
  console.log(`       ${[...where].slice(0, 3).join(", ")}${where.size > 3 ? ", …" : ""}`);
}

heading(`Hidden sections DROPPED as notes — ${notes.size} distinct openings`);
console.log("Expected, and silent at runtime. Skim for anything that opens with a rule.");
console.log("");
for (const [head, count] of [...notes.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`[${String(count).padStart(4)}] ${head}`);
}
