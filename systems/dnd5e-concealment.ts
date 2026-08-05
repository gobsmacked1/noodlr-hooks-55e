// What hides a creature in D&D 5e, and what sees through it. Names and all.
//
// THIS FILE IS DELIBERATELY GAME-SYSTEM SPECIFIC and is the second and last place in the module that
// knows 5e by name (the first is `dnd5e-rewards.ts`). Principle 1 says rules live in the RAG, not in
// code, and matching spell names against a list is exactly the hardcoding that principle forbids —
// but there is no generic way to know that "Pass Without Trace" is worth +10 and that "See Invisibility"
// beats a Potion of Invisibility. The user accepted the trade on 2026-08-04 in exchange for stealth
// working past the mundane Hide action, on the condition that the 5e-specific part be fenced where a
// future system can be swapped in rather than untangled.
//
// HOW TO PORT THIS TO ANOTHER SYSTEM. Write a sibling file exporting the same three functions —
// `concealmentsOn`, `detectorsOn`, `sheetSenses` — gated on its own `game.system.id`, and have
// `auto/stealth.ts` pick between them. Nothing in `auto/` knows a spell name; it only knows the
// capability vocabulary below, which is abstract on purpose. A system where invisibility does not exist
// simply never emits the `seeInvisible` tag and everything still works.
//
// THE CAPABILITY VOCABULARY is the whole interface. A concealment declares what it is `pierced` by and
// what it `negates`; a sense declares what it `grants`. They meet in the middle and neither side needs
// to know about the other:
//
//   truesight  seeInvisible  blindsight  tremorsense  devilsSight  etherealSight  detectMagic
//   divination  hearing
//
// WHY NAMES AND NOT MECHANICS. Foundry stores no machine-readable "this effect conceals" marker, and
// dnd5e's own conditions cover only `invisible`. Everything else a table actually uses — Pass Without
// Trace, Fog Cloud, Nature's Veil — arrives as an Active Effect whose only distinguishing feature is its
// name. Matching names is therefore not laziness; it is the only signal that exists. It fails safe: an
// unrecognised effect just does nothing, exactly as before this file was written.
//
// TRAIT VERSUS EFFECT is a correctness distinction, not a tidiness one. A passive trait (Mask of the
// Wild, Feral Senses, a monster's Keen Hearing) is always on and is matched against the creature's
// items. An activated ability (Nature's Veil, One with Shadows) is only real once someone used it, so it
// is matched against active effects only. Treating the second kind as always-on would make every ranger
// permanently invisible.

import { isDnd5e } from "./dnd5e-rewards";

/** Something making a creature hard to notice. */
export interface Concealment {
  label: string;
  /** Any one of these capabilities defeats it outright. */
  pierced: string[];
  /** Added to the hider's Stealth DC while it is up. */
  bonus: number;
  /** True when it hides the creature regardless of the Stealth contest, unless pierced. */
  absolute: boolean;
  /** Capabilities this strips from anyone looking — Nondetection's whole job. */
  negates: string[];
}

/** How an entry is recognised, and whether it must be active to count. */
interface Entry<T> {
  match: RegExp;
  /** Names that would otherwise match but must not — "See Invisibility" is not invisibility. */
  not?: RegExp;
  /** `trait` is always on and read off items; `effect` must be an active effect. */
  source: "trait" | "effect";
  value: T;
}

/**
 * Concealment, in rough order of how often a table reaches for it.
 *
 * Two abstractions worth naming. The illusion spells conceal nothing by RAW — they put a picture
 * somewhere — but they are what a party actually uses to avoid being noticed, so they are modelled as a
 * bonus rather than as a veil that must be pierced. And magical Darkness is deliberately NOT beaten by
 * darkvision, which is the rule people most often get wrong.
 */
const CONCEALMENT: Array<Entry<Concealment>> = [
  {
    match: /invisib/i,
    not: /see invisib|greater invisibility \(see\)/i,
    source: "effect",
    value: {
      label: "invisible",
      pierced: ["truesight", "seeInvisible", "blindsight", "tremorsense"],
      bonus: 0,
      absolute: true,
      negates: [],
    },
  },
  {
    match: /dust of disappearance|mislead|umbral shroud|nature'?s veil|one with shadows/i,
    source: "effect",
    value: {
      label: "magically unseen",
      pierced: ["truesight", "seeInvisible", "blindsight", "tremorsense"],
      bonus: 0,
      absolute: true,
      negates: [],
    },
  },
  {
    match: /ethereal/i,
    source: "effect",
    value: {
      label: "on the Ethereal Plane",
      pierced: ["truesight", "etherealSight"],
      bonus: 0,
      absolute: true,
      negates: [],
    },
  },
  {
    match: /\bdarkness\b/i,
    not: /devil'?s sight/i,
    source: "effect",
    value: {
      // Magical darkness, which darkvision does not beat — that is the point of the spell.
      label: "in magical darkness",
      pierced: ["truesight", "blindsight", "tremorsense", "devilsSight"],
      bonus: 0,
      absolute: true,
      negates: [],
    },
  },
  {
    match: /fog cloud/i,
    source: "effect",
    value: {
      label: "lost in fog",
      pierced: ["truesight", "blindsight", "tremorsense"],
      bonus: 0,
      absolute: true,
      negates: [],
    },
  },
  {
    match: /nondetection/i,
    source: "effect",
    value: {
      // Hides from divination, not from eyes. It never conceals on its own; it takes magical detection
      // away from whoever is looking, which is why it has a `negates` list and no `pierced` one.
      label: "warded against divination",
      pierced: [],
      bonus: 0,
      absolute: false,
      negates: ["divination", "detectMagic", "truesight"],
    },
  },
  {
    match: /pass without trace/i,
    source: "effect",
    value: { label: "passing without trace", pierced: [], bonus: 10, absolute: false, negates: [] },
  },
  {
    match: /\bsilence\b/i,
    source: "effect",
    value: {
      label: "silenced",
      pierced: [],
      bonus: 0,
      absolute: false,
      negates: ["hearing"],
    },
  },
  {
    match: /major image|silent image|minor illusion|seeming/i,
    source: "effect",
    value: {
      label: "behind an illusion",
      pierced: ["truesight", "detectMagic"],
      bonus: 5,
      absolute: false,
      negates: [],
    },
  },
  {
    match: /mask of the wild/i,
    source: "trait",
    value: { label: "masked by the wild", pierced: [], bonus: 5, absolute: false, negates: [] },
  },
];

/** What a creature can bring to bear on someone trying not to be seen. */
interface Detector {
  label: string;
  grants: string[];
  /** Added to passive Perception. Advantage on Perception is +5 passive, which is how Keen senses work. */
  bonus: number;
}

const DETECTION: Array<Entry<Detector>> = [
  {
    match: /truesight|true seeing/i,
    source: "trait",
    value: {
      label: "truesight",
      grants: ["truesight", "seeInvisible", "etherealSight", "detectMagic"],
      bonus: 0,
    },
  },
  {
    match: /see invisib|glitterdust|faerie fire/i,
    source: "effect",
    value: { label: "sees the invisible", grants: ["seeInvisible"], bonus: 0 },
  },
  {
    match: /detect magic/i,
    source: "effect",
    value: { label: "detecting magic", grants: ["detectMagic"], bonus: 0 },
  },
  {
    match: /locate creature|gaze of two minds/i,
    source: "effect",
    value: { label: "scrying", grants: ["divination"], bonus: 0 },
  },
  {
    match: /feral senses|blindsight|blindsense/i,
    source: "trait",
    value: { label: "blindsight", grants: ["blindsight"], bonus: 0 },
  },
  {
    match: /witch sight/i,
    source: "trait",
    value: { label: "witch sight", grants: ["truesight"], bonus: 0 },
  },
  {
    match: /tremorsense/i,
    source: "trait",
    value: { label: "tremorsense", grants: ["tremorsense"], bonus: 0 },
  },
  {
    match: /devil'?s sight/i,
    source: "trait",
    value: { label: "devil's sight", grants: ["devilsSight"], bonus: 0 },
  },
  {
    // Not on the user's list, but it is the reason a wolf notices anything and the reason a rogue fears
    // one: advantage on Perception is +5 passive, and half the bestiary has some flavour of it.
    match: /keen (hearing|smell|sight|senses)|keen hearing and smell|observant/i,
    source: "trait",
    value: { label: "keen senses", grants: [], bonus: 5 },
  },
];

/** Names of the active effects on an actor, lowercased. */
function effectNames(actor: any): string[] {
  const out: string[] = [];
  try {
    for (const effect of actor?.appliedEffects ?? actor?.effects ?? []) {
      if (effect?.disabled) continue;
      const name = String(effect?.name ?? effect?.label ?? "").toLowerCase();
      if (name) out.push(name);
    }
  } catch {
    /* an actor whose effects will not enumerate simply has none we can read */
  }
  return out;
}

/** Names of the items on an actor, lowercased — features, feats, and carried gear alike. */
function itemNames(actor: any): string[] {
  const out: string[] = [];
  try {
    for (const item of actor?.items ?? []) {
      const name = String(item?.name ?? "").toLowerCase();
      if (name) out.push(name);
    }
  } catch {
    /* same */
  }
  return out;
}

function matches<T>(entry: Entry<T>, effects: string[], traits: string[]): boolean {
  const names = entry.source === "trait" ? [...traits, ...effects] : effects;
  return names.some((name) => entry.match.test(name) && !(entry.not?.test(name) ?? false));
}

/**
 * Every concealment currently on this creature.
 *
 * A trait can also arrive as an effect (some modules apply racial features that way), so traits are
 * matched against both lists; an activated ability is only ever matched against effects.
 */
export function concealmentsOn(actor: any): Concealment[] {
  if (!isDnd5e() || !actor) return [];
  const effects = effectNames(actor);
  const traits = itemNames(actor);
  const found: Concealment[] = [];
  for (const entry of CONCEALMENT) {
    if (matches(entry, effects, traits)) found.push(entry.value);
  }
  return found;
}

/** Everything this creature brings to seeing through concealment, by name. */
export function detectorsOn(actor: any): { tags: string[]; bonus: number; labels: string[] } {
  if (!isDnd5e() || !actor) return { tags: [], bonus: 0, labels: [] };
  const effects = effectNames(actor);
  const traits = itemNames(actor);
  const tags: string[] = [];
  const labels: string[] = [];
  let bonus = 0;
  for (const entry of DETECTION) {
    if (!matches(entry, effects, traits)) continue;
    tags.push(...entry.value.grants);
    labels.push(entry.value.label);
    bonus += entry.value.bonus;
  }
  return { tags, bonus, labels };
}

/**
 * The senses printed on the stat block, as capabilities with the ranges they reach.
 *
 * Darkvision is deliberately absent: it beats darkness, not concealment, and core's own detection modes
 * already apply it. Nothing here would be true of a system without a senses block, which is why it lives
 * in this file rather than in the engine.
 */
export function sheetSenses(actor: any): Record<string, number> {
  const out: Record<string, number> = {};
  if (!actor) return out;

  // Vision 5e computes this for every actor whether or not the token has sight switched on, which makes
  // it strictly better than reading the sheet. Keys are Foundry detection mode ids.
  const derived: any = actor?.detectionModes;
  if (derived && typeof derived === "object" && !Array.isArray(derived)) {
    const map: Record<string, string> = {
      seeAll: "truesight",
      seeInvisibility: "seeInvisible",
      blindsight: "blindsight",
      feelTremor: "tremorsense",
      etherealSight: "etherealSight",
      devilsSight: "devilsSight",
      hearing: "hearing",
    };
    for (const [mode, tag] of Object.entries(map)) {
      const range = Number(derived[mode]);
      if (Number.isFinite(range) && range !== 0) out[tag] = range < 0 ? Infinity : range;
    }
    if (Object.keys(out).length > 0) return out;
  }

  if (!isDnd5e()) return out;
  const senses: any = actor?.system?.attributes?.senses ?? {};
  const ranges: any = senses?.ranges ?? senses;
  for (const [sense, tag] of Object.entries({
    truesight: "truesight",
    blindsight: "blindsight",
    tremorsense: "tremorsense",
  })) {
    const range = Number(ranges?.[sense]);
    if (Number.isFinite(range) && range > 0) out[tag] = range;
  }
  return out;
}
