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
