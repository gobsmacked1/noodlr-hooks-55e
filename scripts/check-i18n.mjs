/**
 * Every key referenced in source or templates must exist in lang/en.json.
 * A missing key renders as the raw dotted string at the table, which reads as a broken window
 * rather than as a missing translation, so this runs with the other checks rather than by hand.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname.replace(/^\//, "");

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|hbs|js|mjs)$/.test(name)) out.push(p);
  }
  return out;
}

const lang = JSON.parse(readFileSync(join(root, "lang", "en.json"), "utf8"));
const have = new Set();
(function flatten(obj, prefix) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object") flatten(v, key);
    else have.add(key);
  }
})(lang, "");

const files = [...walk(join(root, "src")), ...walk(join(root, "templates"))];
const used = new Map();
for (const file of files) {
  const text = readFileSync(file, "utf8");
  for (const m of text.matchAll(/NOODLRHOOKS\.[A-Za-z0-9_.]+/g)) {
    // A match that stops at a `${` is a prefix, not a key; its members are asserted below.
    if (text[m.index + m[0].length] === "$") continue;
    const key = m[0].replace(/\.$/, "");
    if (!used.has(key)) used.set(key, file);
  }
}

// Families assembled at runtime, so the members have to be named here or nothing checks them.
const families = {
  "NOODLRHOOKS.Rules.State": ["live", "planned", "system", "external"],
  "NOODLRHOOKS.Capabilities.Status": ["uncompiled", "compiled", "edited", "locked", "rejected"],
  // Every reason the damage layer can decline to apply a roll. These reach a GM's chat log, so a
  // missing one would render as a dotted string in the middle of a sentence.
  "NOODLRHOOKS.Combat.AutoDamage.Why": [
    "NeedsSave",
    "NoActivity",
    "NoAttack",
    "NoHitPoints",
    "NoTargets",
    "UnknownToken",
    "UpdateFailed",
  ],
  // The same, for the save layer.
  "NOODLRHOOKS.Combat.AutoSaves.Why": ["NoActivation"],
  // The Damage button's four states, as a tooltip and as the refusal a press produces. Both are built
  // from one `state` string in gate.ts, so the two lists are deliberately identical — a state that
  // gained a tooltip and no refusal would notify the raw key at the moment somebody clicked.
  "NOODLRHOOKS.Combat.Gate.Title": ["Graze", "Hit", "Miss", "Open", "Spent", "Waiting"],
  "NOODLRHOOKS.Combat.Gate.Refused": ["Graze", "Miss", "Spent", "Waiting"],
  // Why a readied action woke up. Built from a variable in ready-events.ts, and shown to the player in
  // the release prompt — a missing one reads as the trigger having fired for no reason.
  // After-fail / after-miss offer labels, assembled from each spec id in dnd5e-dice-mods.ts.
  "NOODLRHOOKS.DiceMod": [
    "Inspiration",
    "InspirationHint",
    "Indomitable",
    "IndomitableHint",
    "StrokeOfLuck",
    "StrokeOfLuckHint",
    "DisciplinedSurvivor",
    "DisciplinedSurvivorHint",
    "SeekingSpell",
    "SeekingSpellHint",
    "IndomitableMight",
    "IndomitableMightHint",
    "BardicInspiration",
    "BardicInspirationHint",
    "PeerlessSkill",
    "PeerlessSkillHint",
    "CuttingWords",
    "CuttingWordsHint",
    "InspirationDamageHint",
    "Piercer",
    "PiercerHint",
    "EmpoweredSpell",
    "EmpoweredSpellHint",
  ],
  "NOODLRHOOKS.Ready.Why": [
    "Appeared",
    "Attacked",
    "Cast",
    "Condition",
    "DoorOpen",
    "DoorShut",
    "Dropped",
    "Hurt",
    "Moved",
    "TurnEnded",
  ],
};
for (const [prefix, members] of Object.entries(families))
  for (const member of members) used.set(`${prefix}.${member}`, `${prefix}.* (runtime)`);

const missing = [...used].filter(([key]) => !have.has(key));
if (missing.length) {
  console.error(`Missing ${missing.length} i18n key(s):`);
  for (const [key, file] of missing) console.error(`  ${key}  <- ${file}`);
  process.exit(1);
}
console.log(`i18n: ${used.size} keys referenced, all present in lang/en.json.`);
