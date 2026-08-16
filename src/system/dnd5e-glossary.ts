// General rules that ship as pressable items, and must never reach the capability compiler. D&D 5e ONLY.
//
// Found in a HAR of one scene load (user's capture, 2026-08-15). The compiler was asked to read 123
// "abilities" off a single wizard and spent 292 seconds and real credit doing it. Among them: `Dash`,
// `Dodge`, `Hide`, `Ready`, `Disengage`, `Stabilize`, `Magic`, `Check Cover`, `Fall`, `Underwater`,
// `Long Rest` and `Dagger`. None of those is a creature's own ability. They are the 2024 PHB's rules
// glossary, which ddb-importer and the PHB content module put on every character sheet as `feat` items.
//
// THE COST IS THE LESSER PROBLEM. A compiled descriptor for `Hide` is a rule that fires beside
// `rules/hide.ts`; one for `Fall` applies damage nobody asked for; one for `Long Rest` mutates a ledger
// `noteRest()` already owns. The compiler's whole premise is that a creature's OWN prose is the thing
// nobody has automated — and a general rule is the opposite of that by definition: identical for every
// creature, which is exactly why `rules/general.ts` hard-codes the ten worth having and refuses the rest
// with reasons. Compiling one is either a duplicate of code we shipped or a re-litigation of a refusal.
//
// So this is the same boundary `rules/general.ts` draws, enforced one layer earlier. If a rule in here
// ever deserves automating, it gets a deterministic implementation beside Jump and Influence — not a
// model reading it off a sheet twelve times a session.
//
// DELIBERATELY NOT HANDLED: mundane gear. `Dagger` in that capture looked like the same class of waste
// and is not — the stock item's description is EMPTY (equipment24/weapons/simple-melee/dagger.yml), so
// `MIN_PROSE` already skips it and stock content needs nothing here. What got compiled was an imported
// or premade dagger carrying a pasted SRD blurb, which means any skip would be a guess at what
// ddb-importer writes rather than a reading of the system. The obvious rule — skip a weapon or piece of
// equipment with `rarity: ''` and no `mgc` property — is genuinely tempting, since that is exactly how
// dnd5e separates a Dagger from a Dagger of Venom (`rarity: rare`). It is not written because a homebrew
// magic item that never set a rarity would be skipped silently, and nothing in the capture proves the
// case is common. Measure it in a real world before building it.

import { isDnd5e } from "./dnd5e-rewards";
import { phbActionOf } from "./dnd5e-actions";
import { hasFlag } from "../util/flags";

/**
 * Force a compile of something this file would skip: `flags.<ns>.compileAnyway` on the item.
 *
 * Here because the judgement below is a name match, and a homebrew feature legitimately called "Fall"
 * would otherwise be unreachable with no way for a GM to say otherwise.
 */
const OVERRIDE = "compileAnyway";

/**
 * Rules-glossary entries beyond the thirteen action buttons.
 *
 * Deliberately matched on `system.identifier` FIRST and the name only in its absence, the same order
 * and the same reasoning as every other table here: a world that re-identified a feature has said
 * something, and what it happens to be called should not overrule that.
 *
 * Each of these was seen in the capture. Every one is a rule about the world rather than about the
 * creature holding it, and `rules/general.ts` is where a decision about any of them belongs.
 */
const GLOSSARY: { id: string; name: RegExp; why: string }[] = [
  { id: "check-cover", name: /^\s*check\s+cover\s*$/i, why: "simplecover5e owns cover; see pages.ts" },
  { id: "fall", name: /^\s*fall(ing)?\s*$/i, why: "core models no falling; refused in general.ts" },
  { id: "underwater", name: /^\s*underwater\s*$/i, why: "environmental; refused in general.ts" },
  { id: "long-rest", name: /^\s*long\s+rest\s*$/i, why: "the system owns rests; noteRest reads the hook" },
  { id: "short-rest", name: /^\s*short\s+rest\s*$/i, why: "the system owns rests; noteRest reads the hook" },
  { id: "jump", name: /^\s*jump(ing)?\s*$/i, why: "built deterministically in rules/jump.ts" },
  {
    id: "difficult-terrain",
    name: /^\s*difficult\s+terrain\s*$/i,
    why: "core prices terrain; economy/speed.ts budgets it",
  },
  {
    id: "opportunity-attack",
    name: /^\s*opportunity\s+attack\s*$/i,
    why: "built deterministically in rules/reactions.ts",
  },
  {
    id: "two-weapon-fighting",
    name: /^\s*two[-\s]weapon\s+fighting\s*$/i,
    why: "built deterministically in system/dnd5e-two-weapon.ts",
  },
  // Ships as `type: weapon` (equipment24/weapons/unarmed-strike.yml), so it is reachable only by
  // identifier — see the asymmetry in generalRuleOf. Every creature in the game has one, its Grapple and
  // Shove halves are `rules/forced.ts`'s already, and in the capture it was one of only two features the
  // model could not compile at all: it read the contest as needing a human, which is correct and is a
  // repair round spent to be told so.
  {
    id: "unarmed-strike",
    name: /^\s*unarmed\s+strike\s*$/i,
    why: "every creature has one; the shove and grapple are rules/forced.ts's",
  },
];

/**
 * Is this item a general rule rather than this creature's own ability?
 *
 * Returns why, for the collector's report, or null. **A null here is the ordinary answer** — the
 * overwhelming majority of a sheet is genuinely the creature's, and this only ever catches the
 * glossary furniture.
 */
export function generalRuleOf(item: any): string | null {
  if (!isDnd5e()) return null;
  if (!item) return null;
  if (hasFlag(item, OVERRIDE)) return null;

  // THE TWO SIGNALS ARE GUARDED DIFFERENTLY, AND THE ASYMMETRY IS THE WHOLE SAFETY ARGUMENT.
  //
  // A stock `system.identifier` is an assertion by whoever authored the content, so it is trusted on any
  // item type — which is the only way `unarmed-strike` is reachable at all, since it ships as a weapon.
  // A NAME is a coincidence waiting to happen: "Jump" and "Fall" are plausible titles for a homebrew
  // spell or a magic weapon, and skipping one of those would silently withhold a real ability rather
  // than merely save a call. So a bare name is believed only on a `feat`, the type the PHB glossary
  // actually uses. Same reasoning and same order as the rider table.
  const type = String(item?.type ?? "");
  const identifier = String(item?.system?.identifier ?? "")
    .trim()
    .toLowerCase();

  // The thirteen buttons first, because `dnd5e-actions.ts` is already the authority on what they are and
  // on how each is recognised. A second copy of that matching here is the divergence the v0.4.1 vision
  // bug was about. It carries its own `featOnly` guard, so it needs no help.
  const action = phbActionOf(item, null);
  if (action) return `the ${action.spec.id} action — ${action.note}`;

  const name = String(item?.name ?? "").trim();
  for (const rule of GLOSSARY) {
    if (identifier) {
      if (identifier === rule.id) return `a general rule — ${rule.why}`;
      continue; // A re-identified item has said it is not this rule; its name does not overrule that.
    }
    if (type === "feat" && name && rule.name.test(name)) return `a general rule — ${rule.why}`;
  }
  return null;
}
