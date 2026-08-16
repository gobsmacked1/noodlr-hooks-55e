/**
 * One-off: what does a rest trigger actually turn on in a real cache?
 *
 * Wiring a trigger is cheap; knowing whether anything in the world hangs off it is the part that
 * decides whether the wiring is a proof or a feature. Reads a directory of cache shards and prints
 * every rest-triggered rule with its adjudication and effect kind.
 *
 *   node scripts/peek-rest-rules.mjs <cache-dir>
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: node scripts/peek-rest-rules.mjs <cache-dir>");
  process.exit(1);
}

const REST = new Set(["on_short_rest", "on_long_rest"]);
const rows = [];
let capabilities = 0;

for (const name of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
  const shard = JSON.parse(readFileSync(join(dir, name), "utf8"));
  for (const cap of shard.capabilities ?? []) {
    capabilities += 1;
    for (const rule of cap.rules ?? []) {
      const event = rule?.trigger?.event;
      if (!REST.has(event)) continue;
      rows.push({
        label: cap.label ?? "(unlabelled)",
        status: cap.status,
        event,
        adjudication: rule.adjudication,
        kind: rule.effect?.kind,
        resource: rule.effect?.resource ?? "",
        guards: (rule.condition ?? rule.conditions ?? []).length,
      });
    }
  }
}

console.log(`${capabilities} capabilities, ${rows.length} rest-triggered rules\n`);

const both = new Map();
for (const r of rows) both.set(r.label, (both.get(r.label) ?? new Set()).add(r.event));

for (const r of rows.sort((a, b) => a.label.localeCompare(b.label) || a.event.localeCompare(b.event))) {
  const kind = r.resource ? `${r.kind} "${r.resource}"` : r.kind;
  console.log(
    `${r.adjudication.padEnd(9)} ${r.event.padEnd(14)} ${String(kind).padEnd(28)} guards:${r.guards}  ${r.label}`,
  );
}

const tally = (key) =>
  [...rows.reduce((m, r) => m.set(r[key], (m.get(r[key]) ?? 0) + 1), new Map())]
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k} ${n}`)
    .join(", ");

console.log(`\nby event:        ${tally("event")}`);
console.log(`by adjudication: ${tally("adjudication")}`);
console.log(`by effect kind:  ${tally("kind")}`);

const doubles = [...both].filter(([, events]) => events.size > 1).map(([label]) => label);
console.log(
  `\ncapabilities carrying BOTH events (a long rest fires each once): ${doubles.length ? doubles.join(", ") : "none"}`,
);
