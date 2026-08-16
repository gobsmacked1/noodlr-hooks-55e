// Read the capability-compile exchanges out of a browser HAR. `node scripts/dig-har.mjs <file> [needle]`.
//
// Exists because the console collapses a nested return value, so a HAR is the only place the descriptor a
// model ACTUALLY returned is recorded verbatim — which is the difference between "the compiler dropped the
// guard" and "the runtime ignored it", the two possibilities with opposite fixes. `surveyCapabilities()`
// now prints a flat block and answers the same question without a capture, so reach for that first; this
// stays for the case where what was SENT is in doubt rather than what was stored.
//
// With no needle it inventories the capture instead of searching it. That is not a convenience: a HAR is
// one page load, so the creature you care about may simply not be in there, and searching an absent
// exchange returns zero hits that read exactly like a negative finding.

import { readFileSync } from "node:fs";

const [file, needle] = process.argv.slice(2);
const har = JSON.parse(readFileSync(file, "utf8"));
const entries = har?.log?.entries ?? [];

if (!needle) {
  // Inventory first: what is even in here, and which entries carry a compile.
  const byHost = new Map();
  for (const e of entries) {
    let host = "?";
    try {
      host = new URL(e.request.url).host;
    } catch {
      // A data: or blob: URL. Counted under "?" rather than skipped, so the totals still add up.
    }
    byHost.set(host, (byHost.get(host) ?? 0) + 1);
  }
  console.log("entries:", entries.length);
  console.log("by host:", Object.fromEntries([...byHost].sort((a, b) => b[1] - a[1])));
  console.log("\nfirst/last:", entries[0]?.startedDateTime, "->", entries.at(-1)?.startedDateTime);
  console.log("\ncompletions with a request body:");
  for (const [i, e] of entries.entries()) {
    if (!String(e.request.url).includes("chat/completions")) continue;
    const sent = String(e?.request?.postData?.text ?? "");
    const got = String(e?.response?.content?.text ?? "");
    let labels = "";
    try {
      const body = JSON.parse(sent);
      const user = (body.messages ?? []).find((m) => m.role === "user");
      const text = typeof user?.content === "string" ? user.content : "";
      labels = [...text.matchAll(/"label"\s*:\s*"([^"]+)"/g)].map((m) => m[1]).join(", ");
      if (!labels) labels = text.slice(0, 160).replace(/\s+/g, " ");
    } catch {
      // Not a completion we recognise. The line is still worth printing for its size and status.
    }
    console.log(
      `  [${i}] ${e.request.method} sent=${sent.length} got=${got.length} status=${e.response?.status} :: ${labels.slice(0, 200)}`,
    );
  }
  process.exit(0);
}

let hits = 0;
for (const e of entries) {
  const sent = String(e?.request?.postData?.text ?? "");
  const got = String(e?.response?.content?.text ?? "");
  if (!sent.includes(needle) && !got.includes(needle)) continue;
  hits += 1;
  console.log(`\n===== ${e.request.method} ${e.request.url} =====`);
  const where = sent.includes(needle) ? sent : got;
  const at = where.indexOf(needle);
  console.log(where.slice(Math.max(0, at - 1500), at + 3000));
}
console.log(`\n(${hits} entr(ies) mentioning "${needle}" of ${entries.length})`);
