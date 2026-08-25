// Pointers in a legendary (or Multiattack) utility: prose that names another item.
//
// 2024 DDB / MM sheets model "Glare" and "Chomp" as legendary utilities whose only job is to
// spend `legact` and tell you to use something else. The real save or attack lives on "Eye Rays"
// or "Bite". `activity.use()` on the utility posts flavour and consumes the pool; it never
// follows the pointer. Same hole as keeping legendary utilities visible so a picker can be seen,
// then executing the picker.
//
// Two source shapes, measured on a live Beholder (2026-08-25) and stock Mummy Lord:
//   - Secret prose: "The beholder uses Eye Rays." / "makes two Bite attacks."
//   - Chat enricher: `[[/item Eye Rays]]` / `[[/item .mmDreadfulGlare0]]`
// The public line is often `[[lookup @item.name]]` — a self-reference. Ignore lookups.
// Prefer whatever names a *different* item; never treat the pointer as its own payload.

export interface ItemPointer {
  token: string;
  activity?: string;
  times: number;
}

const TIMES_WORD: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  once: 1,
  two: 2,
  twice: 2,
  three: 3,
  thrice: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

export function timesWord(raw: string): number | null {
  const w = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (TIMES_WORD[w]) return TIMES_WORD[w];
  const n = Number(w);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function stripLookups(html: string): string {
  return String(html ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\[\[lookup[^\]]*\]\]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseEnricherBody(body: string): { token: string; activity?: string } {
  const activity = body.match(/\bactivity=([^\s\]]+)/i)?.[1];
  const token = body
    .replace(/\bactivity=[^\s\]]+/gi, "")
    .replace(/\{[^}]*\}$/, "")
    .trim()
    .replace(/^\./, "");
  return { token, activity };
}

function addPointer(out: ItemPointer[], next: ItemPointer): void {
  const token = next.token.trim();
  if (!token) return;
  const key = `${token.toLowerCase()}|${(next.activity ?? "").toLowerCase()}`;
  const prev = out.find((p) => `${p.token.toLowerCase()}|${(p.activity ?? "").toLowerCase()}` === key);
  if (prev) {
    prev.times = Math.max(prev.times, next.times);
    return;
  }
  out.push({ token, activity: next.activity, times: next.times });
}

/**
 * What another item this text is asking us to use, and how many times.
 *
 * Self-lookups are stripped first so "The Beholder uses Glare" from the public template is not a
 * pointer. A name that later matches the source item is the caller's to drop.
 */
export function parseItemPointers(html: string): ItemPointer[] {
  const raw = String(html ?? "");
  const out: ItemPointer[] = [];

  const enricher = /\[\[\/item\s+([^\]]+?)\]\]/gi;
  let m: RegExpExecArray | null;
  while ((m = enricher.exec(raw))) {
    const parsed = parseEnricherBody(m[1] ?? "");
    if (!parsed.token) continue;
    const after = raw.slice(m.index + m[0].length, m.index + m[0].length + 48);
    const tm = after.match(/^\s*[.,]?\s*(?:for\s+)?(\w+)\s+times/i);
    addPointer(out, {
      token: parsed.token,
      activity: parsed.activity,
      times: tm ? (timesWord(tm[1] ?? "") ?? 1) : 1,
    });
  }

  const plain = stripLookups(raw);
  const uses = /\buses(?:\s+the)?\s+([A-Z][\w'-]+(?:\s+[A-Z][\w'-]+)*)(?:\s+(\w+)\s+times)?/g;
  let u: RegExpExecArray | null;
  while ((u = uses.exec(plain))) {
    addPointer(out, { token: (u[1] ?? "").trim(), times: timesWord(u[2] ?? "") ?? 1 });
  }

  const makes = /\bmakes\s+(\w+)\s+([A-Z][\w'-]+(?:\s+[A-Z][\w'-]+)*)\s+attacks?\b/gi;
  let k: RegExpExecArray | null;
  while ((k = makes.exec(plain))) {
    addPointer(out, { token: (k[2] ?? "").trim(), times: timesWord(k[1] ?? "") ?? 1 });
  }

  return out;
}

export function matchPointerItem(
  token: string,
  items: { id?: unknown; name?: unknown; system?: { identifier?: unknown } }[],
  exceptId?: string,
): (typeof items)[number] | null {
  const t = String(token ?? "")
    .replace(/^\./, "")
    .trim()
    .toLowerCase();
  if (!t) return null;
  return (
    items.find((item) => {
      const id = String(item?.id ?? "");
      if (exceptId && id === exceptId) return false;
      if (id.toLowerCase() === t) return true;
      if (String(item?.system?.identifier ?? "").toLowerCase() === t) return true;
      return String(item?.name ?? "").trim().toLowerCase() === t;
    }) ?? null
  );
}

/** "7: Sleep Ray" → 7. The Roll-1d10 utility has no number and is not a ray. */
export function numberedIndex(name: string): number | null {
  const m = String(name ?? "")
    .trim()
    .match(/^(\d+)\s*:\s*\S/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Pick among numbered activities, honouring a "already used this turn" set.
 *
 * A roll that names a spent row is skipped; after a few misses we take the first unused.
 * Empty `used` is the common case (one Glare, one ray).
 */
export function pickNumbered<T>(
  rows: { n: number; value: T }[],
  rolls: number[],
  used: Set<number>,
): T[] {
  const out: T[] = [];
  if (!rows.length) return out;
  for (const roll of rolls) {
    const available = rows.filter((r) => !used.has(r.n));
    const pool = available.length ? available : rows;
    const hit = pool.find((r) => r.n === roll) ?? pool[0];
    if (!hit) continue;
    used.add(hit.n);
    out.push(hit.value);
  }
  return out;
}

/** Prepared range on the activity, then the item. `override: false` still carries a real `value`. */
export function pointerRangeOf(activity: any, item: any): number {
  const fromAct = Number(activity?.range?.value ?? activity?.range?.reach);
  if (Number.isFinite(fromAct) && fromAct > 0) return fromAct;
  const fromItem = Number(item?.system?.range?.value ?? item?.system?.range?.reach);
  if (Number.isFinite(fromItem) && fromItem > 0) return fromItem;
  return 5;
}
