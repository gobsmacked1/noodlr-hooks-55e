// Features that reroll, replace or overwrite a d20 after it has already been rolled.
//
// D&D 5e (2024) ONLY. Discovery lives here so the executor never learns a creature or spell name.
// Identifier first, name only when the item has no identifier, `flags.<ns>.diceMod` as the hatch.
//
// HALFLING LUCK IS NOT HERE. dnd5e already rerolls a natural 1 via `D20Die#applyFlag("halflingLucky")`
// (`r1=1`). Offering it again would double-reroll. The 2014 race trait is identifier `lucky`; the
// Lucky *feat* is also `lucky`. Matching that identifier as Halfling would silently steal the feat.
//
// LUCKY FEAT IS NOT HERE. With-roll lives in `dnd5e-lucky.ts` / `rules/lucky.ts`. Keep
// identifier `lucky` out of this table — matching it here would offer the 2014 "see the
// roll" moment against a 2024 sheet. PORTENT is before-roll (`dnd5e-portent.ts`).
// Keep identifier `portent` out of this table too.
// FLASH OF GENIUS IS NOT HERE: no identifier in the shipped dnd5e packs (Tasha's Artificer).
// DAMAGE-DIE REROLLS ARE NOT HERE. Piercer, Empowered Spell, and Inspiration on a
// damage card live in `dnd5e-damage-dice.ts` — a different card, and `rerollKeepNew`
// refuses anything that is not a d20. Cutting Words on a damage roll IS this table
// (`kinds` includes `damage`); the subtract still hits `rolls[0].total`.

import { hasFlag, readFlag } from "../util/flags";
import { usesRemaining } from "../capability/primitives";
import { isDnd5e } from "./dnd5e-rewards";

export type DiceKind = "attack" | "save" | "check" | "damage";
export type DiceOp =
  "reroll-keep-new" | "replace-20" | "set-str" | "reroll-plus-level" | "add-die" | "subtract-die";
export type DiceResource =
  "inspiration" | "item" | "focus" | "sorcery" | "inspired" | "bardic" | "none";
export type DiceWhose = "self" | "opposed";

/** What a live roll looks like, once a card has been read. */
export interface DiceContext {
  kind: DiceKind;
  success: boolean | null;
  missed: boolean;
  ability: string;
  isSpellAttack: boolean;
  total: number;
  strScore: number;
}

export interface DiceModSpec {
  id: string;
  /** Item identifier. Absent for Inspiration, which is an actor flag. */
  identifier?: string;
  name?: RegExp;
  /** Name is believed only on these types, so "Indomitable" on a weapon stays a weapon. */
  types?: string[];
  op: DiceOp;
  depleting: boolean;
  resource: DiceResource;
  kinds: readonly DiceKind[];
  /** Who is asked. Default `self` — the creature that rolled. `opposed` is Cutting Words. */
  whose?: DiceWhose;
  /** Failed save / check (`success === false`). A miss is not this. */
  afterFail?: boolean;
  /** Attack that named targets and hit none of them. */
  afterMiss?: boolean;
  /** A made save / check, or an attack that hit someone. */
  afterSuccess?: boolean;
  /** Strength check or save whose total is below the Strength score. */
  whenStrBelow?: boolean;
  spellAttackOnly?: boolean;
  /** Scene units. Only `opposed` reads it. */
  range?: number;
  /** Combat reaction. Only `opposed` spends it. */
  needsReaction?: boolean;
  /** Peerless Skill: the BI use is kept if the roll still fails. */
  refundIfStillFails?: boolean;
}

export interface DiceModOffer {
  spec: DiceModSpec;
  /** The feature (or the resource pool) we would spend. Inspiration has none. */
  item: any | null;
  /** Inspired AE to delete, when the resource is the held die. */
  effect?: any;
  /** The BI item to debit, when the feature itself has no uses (CW, Peerless). */
  spendItem?: any;
  /** Already-resolved die, e.g. `1d8`. Absent means we cannot honour the offer. */
  formula?: string;
  labelKey: string;
  hintKey: string;
}

export const DICE_MOD_SPECS: readonly DiceModSpec[] = [
  {
    id: "inspiration",
    op: "reroll-keep-new",
    depleting: true,
    resource: "inspiration",
    kinds: ["attack", "save", "check"],
    afterFail: true,
    afterMiss: true,
  },
  {
    id: "indomitable",
    identifier: "indomitable",
    name: /^\s*indomitable\s*$/i,
    types: ["feat"],
    op: "reroll-plus-level",
    depleting: true,
    resource: "item",
    kinds: ["save"],
    afterFail: true,
  },
  {
    id: "stroke-of-luck",
    identifier: "stroke-of-luck",
    name: /stroke\s+of\s+luck/i,
    types: ["feat"],
    op: "replace-20",
    depleting: true,
    resource: "item",
    kinds: ["attack", "save", "check"],
    afterFail: true,
    afterMiss: true,
  },
  {
    id: "disciplined-survivor",
    identifier: "disciplined-survivor",
    name: /disciplined\s+survivor/i,
    types: ["feat"],
    op: "reroll-keep-new",
    depleting: true,
    resource: "focus",
    kinds: ["save"],
    afterFail: true,
  },
  {
    id: "seeking-spell",
    identifier: "seeking-spell",
    name: /seeking\s+spell/i,
    types: ["feat"],
    op: "reroll-keep-new",
    depleting: true,
    resource: "sorcery",
    kinds: ["attack"],
    afterMiss: true,
    spellAttackOnly: true,
  },
  {
    id: "indomitable-might",
    identifier: "indomitable-might",
    name: /indomitable\s+might/i,
    types: ["feat"],
    op: "set-str",
    depleting: false,
    resource: "none",
    kinds: ["save", "check"],
    whenStrBelow: true,
  },
  {
    id: "bardic-inspiration",
    // Not matched as an item on the roller — the Bard's feat grants the die. The
    // holder wears an Inspired AE. Identifier is used to recognise that AE's origin.
    identifier: "bardic-inspiration",
    name: /bardic\s+inspiration/i,
    types: ["feat"],
    op: "add-die",
    depleting: true,
    resource: "inspired",
    whose: "self",
    kinds: ["attack", "save", "check"],
    afterFail: true,
    afterMiss: true,
  },
  {
    id: "peerless-skill",
    identifier: "peerless-skill",
    name: /peerless\s+skill/i,
    types: ["feat"],
    op: "add-die",
    depleting: true,
    resource: "bardic",
    whose: "self",
    kinds: ["attack", "check"],
    afterFail: true,
    afterMiss: true,
    refundIfStillFails: true,
  },
  {
    id: "cutting-words",
    identifier: "cutting-words",
    name: /cutting\s+words/i,
    types: ["feat"],
    op: "subtract-die",
    depleting: true,
    resource: "bardic",
    whose: "opposed",
    kinds: ["attack", "check", "damage"],
    afterSuccess: true,
    range: 60,
    needsReaction: true,
  },
];

const FOCUS_IDS = new Set(["monks-focus", "ki"]);
const SORCERY_IDS = new Set(["font-of-magic"]);

/** Does this spec apply to this roll, ignoring whether the creature still has the resource? */
export function specApplies(spec: DiceModSpec, ctx: DiceContext): boolean {
  if (!spec.kinds.includes(ctx.kind)) return false;
  if (spec.spellAttackOnly && !ctx.isSpellAttack) return false;
  if (spec.afterFail && ctx.success === false) return true;
  if (spec.afterMiss && ctx.kind === "attack" && ctx.missed) return true;
  if (spec.afterSuccess && ctx.success === true) return true;
  // A success that is still below the score is RAW-legal to replace and never worth a dialog.
  if (spec.whenStrBelow && ctx.success !== true && isStrBelow(ctx)) return true;
  return false;
}

export function isStrBelow(ctx: Pick<DiceContext, "ability" | "total" | "strScore">): boolean {
  return (
    ctx.ability === "str" &&
    Number.isFinite(ctx.total) &&
    Number.isFinite(ctx.strScore) &&
    ctx.total < ctx.strScore
  );
}

/**
 * Which of the listed specs this creature can actually spend right now.
 *
 * Order is the table order. The dialog shows all of them; the clock picks the first
 * non-depleting one, or decline.
 */
export function modsOn(actor: any, ctx: DiceContext): DiceModOffer[] {
  return locateWhose(actor, ctx, "self");
}

/**
 * Features on THIS creature that fire against somebody else's roll (Cutting Words).
 *
 * The roller is `ctx`; `actor` is the Bard being asked. Range, sight and the
 * reaction are the caller's job — this is only "does the sheet still have it".
 */
export function modsAgainst(actor: any, ctx: DiceContext): DiceModOffer[] {
  return locateWhose(actor, ctx, "opposed");
}

function locateWhose(actor: any, ctx: DiceContext, whose: DiceWhose): DiceModOffer[] {
  if (!actor || !isDnd5e()) return [];
  const out: DiceModOffer[] = [];
  for (const spec of DICE_MOD_SPECS) {
    if ((spec.whose ?? "self") !== whose) continue;
    if (!specApplies(spec, ctx)) continue;
    const found = locate(actor, spec);
    if (!found) continue;
    out.push(found);
  }
  return out;
}

/** Strength score, or NaN when the sheet cannot be read. */
export function strengthScore(actor: any): number {
  const value = Number(actor?.system?.abilities?.str?.value);
  return Number.isFinite(value) ? value : NaN;
}

/** Fighter class levels, or 0 when there is no fighter. Never invent a bonus. */
export function fighterLevel(actor: any): number {
  const raw = actor?.classes?.fighter?.system?.levels ?? actor?.classes?.fighter?.levels;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export function hasInspiration(actor: any): boolean {
  return actor?.system?.attributes?.inspiration === true;
}

/** Clock default: a free option may fire; a depleting one never does. */
export function diceModTimeoutId(options: Array<{ id: string; depleting: boolean }>): string {
  return options.find((option) => !option.depleting)?.id ?? "decline";
}

function locate(actor: any, spec: DiceModSpec): DiceModOffer | null {
  if (spec.resource === "inspiration") {
    if (!hasInspiration(actor)) return null;
    return offerOf(spec, null);
  }

  if (spec.resource === "inspired") {
    const effect = inspiredEffect(actor);
    if (!effect) return null;
    const formula = formulaFromInspired(effect, actor);
    if (!formula) return null;
    return offerOf(spec, null, { effect, formula });
  }

  const feature = findFeature(actor, spec);
  if (!feature) return null;

  if (spec.resource === "none") return offerOf(spec, feature);

  if (spec.resource === "item") {
    const left = usesRemaining(feature);
    if (left !== null && left <= 0) return null;
    return offerOf(spec, feature);
  }

  if (spec.resource === "bardic") {
    const pool = bardicItem(actor);
    if (!pool) return null;
    const left = usesRemaining(pool);
    if (left !== null && left <= 0) return null;
    const formula = inspirationFormula(actor);
    if (!formula) return null;
    return offerOf(spec, feature, { spendItem: pool, formula });
  }

  if (spec.resource !== "focus" && spec.resource !== "sorcery") return null;
  const pool = findPool(actor, spec.resource);
  if (!pool) return null;
  const left = usesRemaining(pool);
  if (left !== null && left <= 0) return null;
  return offerOf(spec, pool);
}

function offerOf(
  spec: DiceModSpec,
  item: any | null,
  extra: Pick<DiceModOffer, "effect" | "spendItem" | "formula"> = {},
): DiceModOffer {
  return {
    spec,
    item,
    ...extra,
    labelKey: `NOODLRHOOKS.DiceMod.${labelId(spec.id)}`,
    hintKey: `NOODLRHOOKS.DiceMod.${labelId(spec.id)}Hint`,
  };
}

/** The Bardic Inspiration item that holds the uses, or null. */
export function bardicItem(actor: any): any {
  const spec = DICE_MOD_SPECS.find((row) => row.id === "bardic-inspiration");
  if (!spec) return null;
  return findFeature(actor, spec);
}

/**
 * The live Inspired AE on this creature, or null.
 *
 * Origin identifier `bardic-inspiration` wins. A name of "Inspired" is believed only
 * with Bardic prose (or our flag) — the word is too common to trust alone.
 */
export function inspiredEffect(actor: any): any {
  const list = actor?.appliedEffects ?? actor?.effects ?? [];
  for (const effect of list) {
    if (isInspiredEffect(effect)) return effect;
  }
  return null;
}

export function isInspiredEffect(effect: any): boolean {
  if (!effect || effect.disabled) return false;
  const flagged = String(readFlag(effect, "diceMod") ?? "");
  if (flagged === "bardic-inspiration") return true;
  if (hasFlag(effect, "diceMod") && flagged !== "bardic-inspiration") return false;

  const origin = resolveOrigin(effect.origin);
  if (String(origin?.system?.identifier ?? "") === "bardic-inspiration") return true;

  const name = String(effect.name ?? "");
  const desc = String(effect.description ?? "");
  if (/bardic\s+inspiration/i.test(name)) return true;
  return /^\s*inspired\s*$/i.test(name) && /bardic\s+inspiration/i.test(desc);
}

function formulaFromInspired(effect: any, holder: any): string | null {
  const origin = resolveOrigin(effect.origin);
  const source = origin?.actor ?? origin?.parent ?? null;
  return inspirationFormula(source) ?? inspirationFormula(holder);
}

function resolveOrigin(uuid: unknown): any {
  const id = String(uuid ?? "");
  if (!id) return null;
  try {
    return (globalThis as any).fromUuidSync?.(id) ?? null;
  } catch {
    return null;
  }
}

/**
 * The Bardic Inspiration die as a rollable formula (`1d8`), or null.
 *
 * Read off `system.scale.bard.inspiration`. An unreadable scale is a refusal —
 * guessing d6 would silently underspend a level-15 Bard.
 */
export function inspirationFormula(actor: any): string | null {
  const scale = actor?.system?.scale?.bard?.inspiration;
  if (scale == null) return null;
  if (typeof scale === "string") return normalizeDie(scale);
  const faces = Number(scale.faces);
  if (Number.isFinite(faces) && faces >= 2) {
    const n = Number(scale.number);
    const number = Number.isFinite(n) && n > 0 ? n : 1;
    return `${number}d${faces}`;
  }
  return normalizeDie(String(scale.formula ?? scale.die ?? ""));
}

function normalizeDie(text: string): string | null {
  const trimmed = text.trim();
  if (/^\d+d\d+/.test(trimmed)) return trimmed.match(/^\d+d\d+/)?.[0] ?? null;
  if (/^d\d+/.test(trimmed)) return `1${trimmed.match(/^d\d+/)?.[0]}`;
  return null;
}

function labelId(id: string): string {
  return id
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

function findFeature(actor: any, spec: DiceModSpec): any {
  for (const item of actor.items ?? []) {
    const flagged = String(readFlag(item, "diceMod") ?? "");
    if (flagged) {
      if (flagged === spec.id) return item;
      continue;
    }
    if (hasFlag(item, "diceMod") && !flagged) continue;
    if (matchesItem(item, spec)) return item;
  }
  return null;
}

/**
 * Identifier wins. `indomitable` must never match `indomitable-might`.
 * A name is consulted only when there is no identifier, and only on the declared types.
 */
export function matchesItem(item: any, spec: DiceModSpec): boolean {
  if (!item || (!spec.identifier && !spec.name)) return false;
  const identifier = String(item.system?.identifier ?? "");
  if (identifier) return Boolean(spec.identifier) && identifier === spec.identifier;
  if (spec.types && !spec.types.includes(String(item.type ?? ""))) return false;
  return spec.name ? spec.name.test(String(item.name ?? "")) : false;
}

function findPool(actor: any, resource: "focus" | "sorcery"): any {
  const ids = resource === "focus" ? FOCUS_IDS : SORCERY_IDS;
  for (const item of actor.items ?? []) {
    const identifier = String(item.system?.identifier ?? "");
    if (ids.has(identifier)) return item;
  }
  return null;
}

/** Font of Magic (or any item whose identifier is in the sorcery set). */
export function sorceryItem(actor: any): any {
  return findPool(actor, "sorcery");
}
