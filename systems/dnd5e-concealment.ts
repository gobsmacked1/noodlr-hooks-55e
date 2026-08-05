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
  /** Capabilities this strips from anyone looking. Silence takes hearing away. */
  negates: string[];
  /** Nondetection's whole job: everything the watcher was getting from a Divination spell stops working. */
  blocksDivination: boolean;
  /** True when this is a thing placed in the world, and only counts when it stands in the way. */
  interposed?: boolean;
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
 * Concealment worn by the creature itself.
 *
 * Magical Darkness is deliberately NOT beaten by darkvision, which is the rule people most often get
 * wrong. Note also what is missing from every `pierced` list here: `detectMagic`. Detect Magic senses an
 * aura "around any visible creature", so by the letter of the spell it does not out someone you cannot
 * already see — it reveals what a creature is carrying, not where the creature is.
 */
const CONCEALMENT: Array<Entry<Concealment>> = [
  {
    match: /invisib/i,
    not: /see invisib/i,
    source: "effect",
    value: {
      label: "invisible",
      pierced: ["truesight", "seeInvisible", "blindsight", "tremorsense"],
      bonus: 0,
      absolute: true,
      negates: [],
      blocksDivination: false,
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
      blocksDivination: false,
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
      blocksDivination: false,
    },
  },
  {
    match: /nondetection/i,
    source: "effect",
    value: {
      // "The target can't be targeted by any Divination spell or perceived through magical scrying
      // sensors." It conceals nobody by itself — a warded rogue in plain view is plainly seen. What it
      // does is take the watcher's Divination magic away, which is why it is a layer and not a veil:
      // Stealth beats the guard's eyes, and this beats the Locate Creature that would have found them
      // anyway. Innate truesight is untouched, because a demon's eyes are not a Divination spell.
      label: "warded against divination",
      pierced: [],
      bonus: 0,
      absolute: false,
      negates: [],
      blocksDivination: true,
    },
  },
  {
    match: /pass without trace/i,
    source: "effect",
    value: {
      label: "passing without trace",
      pierced: [],
      bonus: 10,
      absolute: false,
      negates: [],
      blocksDivination: false,
    },
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
      blocksDivination: false,
    },
  },
  {
    match: /mask of the wild/i,
    source: "trait",
    value: {
      label: "masked by the wild",
      pierced: [],
      bonus: 5,
      absolute: false,
      negates: [],
      blocksDivination: false,
    },
  },
  {
    // An abstraction, and knowingly a rough one: a druid as a rat is unremarkable and a druid as a
    // giant ape is not, but Foundry gives us no size-aware notion of "this shape draws no attention".
    // A flat bonus is the honest middle, and it only ever applies to a creature that is already hiding,
    // so the giant ape has to have rolled Stealth before the +5 does anything at all.
    match: /wild shape|wild form|polymorph|transformed/i,
    source: "effect",
    value: {
      label: "wearing another shape",
      pierced: ["truesight"],
      bonus: 5,
      absolute: false,
      negates: [],
      blocksDivination: false,
    },
  },
];

/**
 * Concealment placed in the world rather than worn: the ball of fog, the illusory hedge, the sphere of
 * magical darkness a party drops between themselves and the guard.
 *
 * These only count when they physically stand in the way — see `auto/screens.ts` for the geometry. The
 * user's framing on 2026-08-04 is the rule being encoded: a watcher has to get past the interposed thing
 * before it has any chance at the creature behind it, so each one is absolute until pierced.
 *
 * The illusions carry `detectMagic` in their `pierced` list where the solid obscurements do not, because
 * an illusion is a magical aura in plain sight and fog is just fog. What is NOT modelled is the Study
 * action: a creature that spends an action examining an image and beats the save DC on an Intelligence
 * (Investigation) check disbelieves it. That is a deliberate choice made by a player at the table, not
 * something a six-second poll should perform on an NPC's behalf; when it happens, delete the template.
 */
const SCREENS: Array<Entry<Concealment>> = [
  {
    match: /\bdarkness\b/i,
    not: /devil'?s sight/i,
    source: "effect",
    value: {
      label: "behind magical darkness",
      pierced: ["truesight", "blindsight", "tremorsense", "devilsSight"],
      bonus: 0,
      absolute: true,
      negates: [],
      blocksDivination: false,
      interposed: true,
    },
  },
  {
    match: /fog cloud|stinking cloud|cloudkill|incendiary cloud|sleet storm/i,
    source: "effect",
    value: {
      label: "behind a cloud",
      pierced: ["truesight", "blindsight", "tremorsense"],
      bonus: 0,
      absolute: true,
      negates: [],
      blocksDivination: false,
      interposed: true,
    },
  },
  {
    match: /major image|silent image|minor illusion|seeming|programmed illusion|mirage arcane/i,
    source: "effect",
    value: {
      label: "behind an illusion",
      pierced: ["truesight", "detectMagic"],
      bonus: 0,
      absolute: true,
      negates: [],
      blocksDivination: false,
      interposed: true,
    },
  },
];

/** What a creature can bring to bear on someone trying not to be seen. */
interface Detector {
  label: string;
  grants: string[];
  /** Added to passive Perception. Advantage on Perception is +5 passive, which is how Keen senses work. */
  bonus: number;
  /** True when this comes from a Divination spell, and therefore stops working against Nondetection. */
  divination?: boolean;
}

const DETECTION: Array<Entry<Detector>> = [
  {
    // Innate truesight: a creature's own eyes, and no spell, so Nondetection does not touch it.
    match: /truesight/i,
    source: "trait",
    value: {
      label: "truesight",
      grants: ["truesight", "seeInvisible", "etherealSight", "detectMagic"],
      bonus: 0,
    },
  },
  {
    // The spell, which is Divination and therefore is exactly what Nondetection was prepared for.
    match: /true seeing/i,
    source: "effect",
    value: {
      label: "True Seeing",
      grants: ["truesight", "seeInvisible", "etherealSight", "detectMagic"],
      bonus: 0,
      divination: true,
    },
  },
  {
    match: /see invisib/i,
    source: "effect",
    value: { label: "See Invisibility", grants: ["seeInvisible"], bonus: 0, divination: true },
  },
  {
    // Not Divination — Glitterdust and Faerie Fire coat a creature in light rather than scry for it, so
    // Nondetection is no help at all against either. Worth the separate entry for exactly that reason.
    match: /glitterdust|faerie fire/i,
    source: "effect",
    value: { label: "outlined in light", grants: ["seeInvisible"], bonus: 0 },
  },
  {
    match: /detect magic/i,
    source: "effect",
    value: { label: "Detect Magic", grants: ["detectMagic"], bonus: 0, divination: true },
  },
  {
    match: /locate creature|gaze of two minds|clairvoyance|scrying/i,
    source: "effect",
    value: { label: "scrying", grants: ["divination"], bonus: 0, divination: true },
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

  // The screens are checked here too, and that is not redundancy. A Darkness or a fog bank is usually a
  // template on the ground, but it is just as often a spell someone cast on themselves and carries
  // around — the warlock with Devil's Sight walking the battlefield inside their own Darkness is the
  // canonical build (user, 2026-08-05). When a module applies that as an effect rather than a placed
  // template, the geometry finds nothing and only the worn check catches it.
  for (const entry of [...CONCEALMENT, ...SCREENS]) {
    if (matches(entry, effects, traits)) found.push(entry.value);
  }
  return found;
}

/**
 * Everything this creature brings to seeing through concealment, by name.
 *
 * `divined` is the subset that came from a Divination spell, reported separately so a Nondetection ward
 * can remove precisely those and leave a creature's own senses alone.
 */
export function detectorsOn(actor: any): {
  tags: string[];
  divined: string[];
  bonus: number;
  labels: string[];
} {
  if (!isDnd5e() || !actor) return { tags: [], divined: [], bonus: 0, labels: [] };
  const effects = effectNames(actor);
  const traits = itemNames(actor);
  const tags: string[] = [];
  const divined: string[] = [];
  const labels: string[] = [];
  let bonus = 0;
  for (const entry of DETECTION) {
    if (!matches(entry, effects, traits)) continue;
    tags.push(...entry.value.grants);
    if (entry.value.divination) divined.push(...entry.value.grants);
    labels.push(entry.value.label);
    bonus += entry.value.bonus;
  }
  return { tags, divined, bonus, labels };
}

/**
 * Is this thing standing in the world a concealing screen, and if so which one?
 *
 * Called by `auto/screens.ts` with whatever name it managed to resolve for a template, a region or a
 * darkness source. Name matching is the only signal available: Foundry stores a measured template with
 * no indication of what spell put it there beyond a link back to the originating item.
 */
export function screenFor(name: string): Concealment | null {
  if (!isDnd5e() || !name) return null;
  const lowered = name.toLowerCase();
  for (const entry of SCREENS) {
    if (entry.match.test(lowered) && !(entry.not?.test(lowered) ?? false)) return entry.value;
  }
  return null;
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
