/**
 * What does a trigger actually turn on in a real cache?
 *
 * Wiring a trigger is cheap; knowing whether anything in the world hangs off it — and, more to the
 * point, WHOSE ability it is and WHO the effect points at — is what decides whether the wiring is a
 * proof or a feature. Reads a directory of cache shards and prints every rule on the named events with
 * its adjudication, effect kind, effect target and predicate subjects.
 *
 *   node scripts/peek-trigger.mjs <cache-dir> on_hit on_miss
 *
 * The subject columns are the reason this is not just a tally. `on_hit` has two readings — "when I hit"
 * and "when something hits me" — and the vocabulary has one word for both, so the only way to find out
 * which one the model meant is to read what it pointed the effects at.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const [dir, ...events] = process.argv.slice(2);
if (!dir || events.length === 0) {
  console.error("usage: node scripts/peek-trigger.mjs <cache-dir> <event> [event...]");
  process.exit(1);
}

const wanted = new Set(events);
const rows = [];
let capabilities = 0;

/** Every `who`/`whom`/`of` a rule's guards name, so a defender-side reading shows up as `attacker`. */
function subjectsOf(rule) {
  const out = new Set();
  for (const p of rule.condition ?? rule.conditions ?? []) {
    for (const key of ["who", "whom", "of", "subject"]) {
      if (p?.[key]) out.add(String(p[key]));
    }
  }
  return [...out];
}

for (const name of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
  const shard = JSON.parse(readFileSync(join(dir, name), "utf8"));
  for (const cap of shard.capabilities ?? []) {
    capabilities += 1;
    for (const rule of cap.rules ?? []) {
      const event = rule?.trigger?.event;
      if (!wanted.has(event)) continue;
      rows.push({
        label: cap.label ?? "(unlabelled)",
        status: cap.status,
        event,
        adjudication: rule.adjudication,
        kind: rule.effect?.kind,
        detail: rule.effect?.resource ?? rule.effect?.status ?? rule.effect?.damageType ?? "",
        target: rule.effect?.target ?? "(unset)",
        guardSubjects: subjectsOf(rule),
        guards: (rule.condition ?? rule.conditions ?? []).length,
      });
    }
  }
}

console.log(`${capabilities} capabilities, ${rows.length} rules on ${events.join(" / ")}\n`);

for (const r of rows.sort(
  (a, b) => a.event.localeCompare(b.event) || a.label.localeCompare(b.label),
)) {
  const kind = r.detail ? `${r.kind} "${r.detail}"` : r.kind;
  const subs = r.guardSubjects.length ? ` via:${r.guardSubjects.join("+")}` : "";
  console.log(
    `${r.adjudication.padEnd(9)} ${r.event.padEnd(16)} ${String(kind).padEnd(26)} -> ${String(r.target).padEnd(9)} guards:${r.guards}${subs}  ${r.label}`,
  );
}

const tally = (pick) =>
  [...rows.reduce((m, r) => m.set(pick(r), (m.get(pick(r)) ?? 0) + 1), new Map())]
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k} ${n}`)
    .join(", ");

console.log(`\nby event:        ${tally((r) => r.event)}`);
console.log(`by adjudication: ${tally((r) => r.adjudication)}`);
console.log(`by effect kind:  ${tally((r) => r.kind)}`);
console.log(`by effect target:${tally((r) => r.target)}`);
console.log(
  `engine only, by effect target: ${tally0(
    rows.filter((r) => r.adjudication === "engine"),
    (r) => r.target,
  )}`,
);

function tally0(list, pick) {
  return (
    [...list.reduce((m, r) => m.set(pick(r), (m.get(pick(r)) ?? 0) + 1), new Map())]
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${k} ${n}`)
      .join(", ") || "none"
  );
}
