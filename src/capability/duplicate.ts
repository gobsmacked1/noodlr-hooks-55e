// Is this compiled rule restating damage the platform already rolls?
//
// WHY THIS EXISTS. A census of the live cache found that 45 of 71 `on_hit` rules were the ability's
// OWN printed damage line — Fire Bolt compiling to "on a hit, deal 1d10 fire" when dnd5e has rolled
// that 1d10 from `damage.parts` since before any of this existed. So wiring the `on_hit` trigger
// without this guard doubles the damage of every attack cantrip in the world, and the doubling is
// arithmetic rather than an error: nothing throws, nothing logs, and a table just sees a Troll take
// twenty from a ten-damage cantrip.
//
// The doctrine now states the platform boundary, which should stop the compiler emitting these at all.
// This is here because a PROMPT CANNOT BE RELIED ON NEVER TO RE-EMIT SOMETHING AND A GUARD CAN — the
// same instinct as failing closed on `other` and `custom`, and the same reason `RESERVED_STATUSES`
// exists beside a doctrine that already says a rule may not kill.
//
// WHAT IT DELIBERATELY DOES NOT DO: guess. An exact formula match is required, so a genuine rider —
// Flame Tongue's 2d6 fire beside a longsword's 1d8 slashing, a Sneak Attack's dice, any "extra damage
// of a different amount" — passes untouched. And an activity whose damage cannot be read is PERMISSION
// rather than suspicion: "I could not tell" is not evidence of duplication, and refusing on it would
// silently delete real riders whenever the shape changed under us. Same rule as `knownStatuses()`.

import type { CapabilityRule } from "../integration/capability";

/** One `damage.parts` entry, as much of `DamageData` as we read. */
export interface PartLike {
  formula?: unknown;
  number?: unknown;
  denomination?: unknown;
  bonus?: unknown;
  types?: unknown;
  custom?: { enabled?: unknown; formula?: unknown };
}

/** A formula and the damage types it is dealt as, both canonical. */
export interface DamageClaim {
  formula: string;
  types: string[];
}

/**
 * Compare two damage formulas by what they roll rather than by how they are typed.
 *
 * `1d10`, `1 d 10` and `1D10` are one formula; `1d10+2` and `1d10 + 2` are one formula. Terms are
 * sorted so `2 + 1d6` and `1d6 + 2` do not read as different dice — the compiler writes a sum in
 * whatever order the sentence did.
 */
export function canonicalFormula(raw: unknown): string {
  const text = String(raw ?? "")
    .toLowerCase()
    .replace(/\s+/g, "");
  if (!text) return "";
  return text
    .split("+")
    .map((term) => term.trim())
    .filter(Boolean)
    .sort()
    .join("+");
}

/** `types` is a Set on a prepared activity and an Array in raw source data. Read both. */
function typesOf(raw: unknown): string[] {
  const list =
    raw instanceof Set ? [...raw] : Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  return list.map((t) => String(t).toLowerCase()).filter(Boolean);
}

/**
 * Every damage formula the activity itself will roll.
 *
 * **The item's base damage needs no separate lookup, and adding one would double-count.** dnd5e's
 * `AttackActivityData#prepareFinalData` unshifts `item.system.damage.base` into `damage.parts` when
 * `includeBase` is set (`attack-data.mjs:200-205`), so a longsword's 1d8 is already in this list on
 * any activity that has been prepared — which is every activity reachable from a hook.
 */
export function activityDamage(activity: unknown): DamageClaim[] {
  const parts = (activity as { damage?: { parts?: unknown } })?.damage?.parts;
  if (!Array.isArray(parts)) return [];
  const claims: DamageClaim[] = [];
  for (const raw of parts as PartLike[]) {
    if (!raw || typeof raw !== "object") continue;
    const formula = canonicalFormula(partFormula(raw));
    if (!formula) continue;
    claims.push({ formula, types: typesOf(raw.types) });
  }
  return claims;
}

/**
 * What one damage part rolls, verbatim.
 *
 * Uncanonicalised on purpose: this is the string that gets handed to `Roll`, so `@scale.rogue.sneak-attack`
 * has to survive intact. `canonicalFormula` is applied on top of it wherever two formulas are being
 * COMPARED, and never where one is about to be evaluated.
 *
 * The getter when the model is live, reconstructed when it is plain data — a descriptor may be compared
 * against an activity read from source, and `custom.formula` wins there as it does there.
 */
export function partFormula(part: PartLike): string {
  if (part?.custom?.enabled) return String(part.custom.formula ?? "");
  const live = part?.formula;
  if (live !== undefined && live !== null && String(live)) return String(live);
  return automaticFormula(part);
}

/** `DamageData#_automaticFormula`, for the plain-data case where the getter is absent. */
function automaticFormula(part: PartLike): string {
  const number = Number(part.number ?? 0);
  const denomination = Number(part.denomination ?? 0);
  const bonus = String(part.bonus ?? "").trim();
  let formula = number && denomination ? `${number}d${denomination}` : "";
  if (bonus) formula = formula ? `${formula} + ${bonus}` : bonus;
  return formula;
}

/** What a compiled `damage` effect claims to deal, in the same terms. */
function ruleDamage(rule: CapabilityRule): DamageClaim | null {
  if (rule.effect?.kind !== "damage") return null;
  const amount = rule.effect.amount as { dice?: unknown; value?: unknown } | undefined;
  const formula = canonicalFormula(amount?.dice ?? amount?.value);
  if (!formula) return null;
  return { formula, types: typesOf(rule.effect.damageType) };
}

/**
 * Could these two be the same damage?
 *
 * A type MISMATCH clears the rule: 1d8 piercing beside a weapon's 1d8 slashing is a rider that
 * happens to roll the same dice, and refusing it would delete real damage. An absence on either side
 * is not a mismatch — plenty of parts carry no type, and the exact formula match is already the
 * strong signal.
 */
function sameTypes(a: DamageClaim, b: DamageClaim): boolean {
  if (!a.types.length || !b.types.length) return true;
  return a.types.some((t) => b.types.includes(t));
}

/**
 * The reason to refuse, or null to let it run.
 *
 * A string rather than a boolean because every refusal in this layer has to be able to say why. A
 * rule that silently does nothing is the failure this whole file is trying not to become.
 */
export function duplicatesActivityDamage(rule: CapabilityRule, activity: unknown): string | null {
  const mine = ruleDamage(rule);
  if (!mine) return null;
  for (const claim of activityDamage(activity)) {
    if (claim.formula === mine.formula && sameTypes(claim, mine)) {
      const name = String((activity as { name?: unknown })?.name ?? "the ability");
      const typed = mine.types.length ? ` ${mine.types.join("/")}` : "";
      return `${name} already rolls ${mine.formula}${typed} itself; a second roll would double it`;
    }
  }
  return null;
}

/**
 * The same question asked of the FEATURE the prose came from, with no turn in progress.
 *
 * This is what the capability sheet and `surveyCapabilities()` can ask, and it is why the guard is
 * findable rather than merely correct: a refusal that only ever appears mid-combat, once, in a console,
 * is a rule that a reader will report as having stopped working. A binding carries its item, so the
 * doubling is visible the moment somebody looks at the compiled ability.
 */
export function duplicatesItemDamage(rule: CapabilityRule, item: unknown): string | null {
  const activities = (item as { system?: { activities?: unknown } })?.system?.activities;
  // A collection in Foundry, an object in raw source data, and neither is an Array.
  const list: unknown[] =
    activities && typeof (activities as { contents?: unknown }).contents !== "undefined"
      ? ((activities as { contents: unknown[] }).contents ?? [])
      : activities && typeof activities === "object"
        ? Object.values(activities as Record<string, unknown>)
        : [];
  for (const activity of list) {
    const doubled = duplicatesActivityDamage(rule, activity);
    if (doubled) return doubled;
  }
  return null;
}
