// What fraction of a compiled cache actually runs — measured, and with the dead weight named.
//
// `npm run census:yield -- <cache-dir>`
//
// The number this replaces was 12.4%, and it was wrong in both directions at once. Too LOW because 576
// of 693 guards were filed under a key nothing read, so every rule carrying one was scored against an
// executor that had discarded its conditions. Too HIGH as a denominator because the cache had never been
// swept, so `Hide`, `Dash`, `Influence` and friends — compiled before v0.6.3 taught the collector to
// decline them — were counted as though they ran.
//
// WHY THIS BUNDLES THE REAL CODE RATHER THAN REIMPLEMENTING THE PREDICATES. A census that carries its
// own copy of `isExecutable` measures its own copy, which is exactly how the previous baseline came to
// be quoted for three releases. `scripts/census-meta-notes.mjs` records the same lesson learned the hard
// way: it bundled the real scrubber and still certified nothing for two runs, because its INPUT was
// wrong. So the predicates here are the shipped ones, and the one thing this file owns is the counting.
//
// The glossary half is deliberately an APPROXIMATION and says so in the output. `generalRuleOf` reads an
// item — its type, its `system.identifier`, its flags — and a cache holds only a label. So a label match
// is the best an offline run can do, and it is a LOWER bound: a re-identified item, or one whose name
// differs from the rule it implements, is missed. **`api.surveyOrphans()` in a live world is the
// authority**, because it is the only thing that can answer "does any sheet still produce this".

import { readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

const dir = process.argv[2] ?? "C:/Project/noodlr-vtt/capcache";

// ---- the shipped predicates, bundled ------------------------------------------------------------

const bundle = join(tmpdir(), `noodlr-yield-${process.pid}.mjs`);
execFileSync(
  "npx",
  [
    "esbuild",
    "src/integration/capability.ts",
    "--bundle",
    "--format=esm",
    "--platform=node",
    `--outfile=${bundle}`,
    "--log-level=warning",
  ],
  { stdio: "inherit", shell: true },
);
const { normalizeCapability, isExecutable, isStanding, isTerminal } = await import(
  `file:///${bundle.replace(/\\/g, "/")}`
);
rmSync(bundle, { force: true });

// ---- the glossary approximation ------------------------------------------------------------------
//
// Transcribed from `system/dnd5e-glossary.ts` and the thirteen `PHB_ACTIONS` in `dnd5e-actions.ts`.
// A SECOND COPY, knowingly, because the alternative is bundling half the module and stubbing `game` —
// and unlike the predicates above, being wrong here costs a slightly conservative count in a report
// rather than a wrong verdict at a table. Anything matched is reported separately, never silently
// dropped, so an over-match is visible rather than load-bearing.
const GLOSSARY_LABELS =
  /^\s*(check\s+cover|fall(ing)?|underwater|(long|short)\s+rest|jump(ing)?|difficult\s+terrain|opportunity\s+attack|two[-\s]weapon\s+fighting|unarmed\s+strike|attack|magic|dash|disengage|dodge|help|hide|influence|ready|search|study|stabilize|utilize)\s*$/i;

// ---- read ---------------------------------------------------------------------------------------

const caps = [];
for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
  const shard = JSON.parse(readFileSync(join(dir, file), "utf8"));
  for (const cap of shard.capabilities ?? []) caps.push(cap);
}

const SUBJECTS = new Set(["self", "target", "attacker", "trigger"]);

const tally = {
  capabilities: 0,
  rules: 0,
  runs: 0,
  standing: 0,
  runsBefore: 0,
  gm: 0,
  narration: 0,
  terminal: 0,
  inertTrigger: 0,
  inertEffect: 0,
  inertGuard: 0,
  // Counted independently of the buckets above, because these two are the go/no-go on the Phase 2
  // recompile and an exclusive bucket would hide most of them behind `adjudication: "gm"`.
  other: 0,
  badSubject: 0,
  badSubjectRules: 0,
};
const dead = { capabilities: 0, rules: 0, runs: 0, standing: 0, labels: new Map() };
const guardsRecovered = new Set();
const guardsOnRunning = new Set();
const inertTriggers = new Map();
const badSubjects = new Map();

for (const raw of caps) {
  const before = raw.rules ?? [];
  const { capability } = normalizeCapability(raw);
  const rules = capability.rules ?? [];
  const isDead = GLOSSARY_LABELS.test(String(capability.label ?? ""));

  const bucket = isDead ? dead : tally;
  bucket.capabilities++;
  if (isDead) {
    dead.labels.set(capability.label, (dead.labels.get(capability.label) ?? 0) + 1);
  }

  for (const [index, rule] of rules.entries()) {
    bucket.rules++;
    const runs = isExecutable(rule);
    const standing = isStanding(rule);
    if (runs) bucket.runs++;
    if (standing) bucket.standing++;
    if (isDead) continue;

    // The guard fix's effect, measured rather than asserted: the same rule scored against the
    // pre-normalisation object. A rule that ran BEFORE and not after is a guard we have started
    // honouring, which is the Troll's regeneration and is the point of the whole exercise.
    if (isExecutable(before[index] ?? rule)) tally.runsBefore++;
    if ((rule.condition ?? []).length && !(before[index]?.condition ?? []).length) {
      guardsRecovered.add(`${capability.id}:${index}`);
      if (runs) guardsOnRunning.add(`${capability.label} — ${rule.effect?.kind}`);
    }

    if (rule.effect?.kind === "other") tally.other++;
    let named = false;
    for (const predicate of rule.condition ?? []) {
      const who = predicate?.who;
      if (who === undefined || SUBJECTS.has(String(who))) continue;
      tally.badSubject++;
      named = true;
      badSubjects.set(String(who), (badSubjects.get(String(who)) ?? 0) + 1);
    }
    if (named) tally.badSubjectRules++;

    if (runs || standing) continue;
    if (rule.adjudication === "gm") tally.gm++;
    else if (rule.adjudication === "narration") tally.narration++;
    else if (isTerminal(rule)) tally.terminal++;
    else if ((rule.condition ?? []).some((p) => p?.kind === "custom")) tally.inertGuard++;
    else if (rule.effect?.kind === "other") tally.inertEffect++;
    else {
      tally.inertTrigger++;
      const event = String(rule.trigger?.event ?? "?");
      inertTriggers.set(event, (inertTriggers.get(event) ?? 0) + 1);
    }
  }
}

// ---- report -------------------------------------------------------------------------------------

const pct = (n, of) => (of ? `${((n / of) * 100).toFixed(1)}%` : "n/a");
const live = tally.rules;
const active = tally.runs + tally.standing;

const lines = [
  `cache: ${dir}`,
  `capabilities: ${tally.capabilities + dead.capabilities} ` +
    `(${tally.capabilities} reachable, ${dead.capabilities} glossary — see the note below)`,
  `rules: ${live + dead.rules} (${live} reachable, ${dead.rules} glossary)`,
  "",
  "OF THE REACHABLE RULES:",
  `  runs (engine, wired trigger, executable effect and guards)  ${tally.runs} ${pct(tally.runs, live)}`,
  `  standing (a fact, answered by query)                        ${tally.standing} ${pct(tally.standing, live)}`,
  `  ACTIVE, either way                                          ${active} ${pct(active, live)}`,
  "",
  `  handed to a human (adjudication: gm)                        ${tally.gm} ${pct(tally.gm, live)}`,
  `  narration only                                              ${tally.narration} ${pct(tally.narration, live)}`,
  `  refused as terminal (a compiled rule may not kill)          ${tally.terminal}`,
  `  inert: effect kind "other"                                  ${tally.inertEffect}`,
  `  inert: a "custom" guard nothing can evaluate                ${tally.inertGuard}`,
  `  inert: trigger not wired in this build                      ${tally.inertTrigger}`,
  "",
  "PHASE 2 GO/NO-GO NUMBERS (counted independently of the buckets above):",
  `  effect kind "other" — the model declining to invent          ${tally.other} ${pct(tally.other, live)}`,
  `  predicates naming an unresolvable subject                    ${tally.badSubject} (in ${tally.badSubjectRules} rules)`,
  "",
  "WHAT THE GUARD NORMALISATION CHANGED:",
  `  rules whose guards were unread before it                     ${guardsRecovered.size}`,
  `  ...of those, rules that RUN, i.e. now genuinely gated        ${guardsOnRunning.size}`,
  `  scored executable before / after                             ${tally.runsBefore} / ${tally.runs}`,
  "  (the badge is unchanged BY DESIGN: an absent guard is vacuously true, so `isExecutable` scored",
  "   these as runnable all along. The recovery is at EVALUATION time, which no static count can see.)",
  ...[...guardsOnRunning].sort().map((s) => `    ${s}`),
];

if (inertTriggers.size) {
  lines.push(
    "",
    "THE PHASE 3 YIELD, by trigger (rules that would run the moment their hook is dispatched):",
    ...[...inertTriggers.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([event, n]) => `  ${event.padEnd(24)} ${n}`),
  );
}

if (badSubjects.size) {
  lines.push(
    "",
    "SUBJECTS NOTHING CAN RESOLVE (legal: self, target, attacker, trigger):",
    ...[...badSubjects.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([who, n]) => `  ${JSON.stringify(who)}${n > 1 ? ` x${n}` : ""}`),
  );
}

if (dead.capabilities) {
  lines.push(
    "",
    `GLOSSARY ENTRIES EXCLUDED (${dead.rules} rules, of which ${dead.runs + dead.standing} would have`,
    "counted as active). Every one is a general rule this module implements natively; the collector has",
    "declined them since v0.6.3, so they cannot bind whatever the cache says. Matched by LABEL here,",
    "which is a lower bound — api.surveyOrphans() is the authority. Names:",
    ...[...dead.labels.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([label, n]) => `  ${label}${n > 1 ? ` x${n}` : ""}`),
  );
}

const out = lines.join("\n");
console.log(out);
if (process.argv[3]) writeFileSync(process.argv[3], `${out}\n`, "utf8");
