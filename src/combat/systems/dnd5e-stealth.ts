// The Hide action's numbers, and the feats that bend them. D&D 5e ONLY.
//
// This is the third quarantined system file, after `dnd5e-rewards.ts` and `dnd5e-concealment.ts`, and it
// exists for the same reason: `auto/stealth.ts` and `auto/hide.ts` must not learn a feat name or a DC.
// They ask questions in the abstract — may this creature stay hidden after a miss, does its Hide roll get
// advantage, what number must it beat — and this file answers them for 5e. Port by writing a sibling with
// the same exports gated on another `game.system.id`.
//
// WHY A FEAT LIST AT ALL. The user's instinct was that a missed attack should leave you hidden, and under
// the general rule that is wrong in both editions: 2024 ends the Invisible condition from Hide on "you
// make an attack roll", and 2014's Unseen Attackers already gave your location away "when the attack hits
// or misses". But there is a real rule that does exactly what they remembered, and it is Skulker's Sniper
// benefit. So the hit-only behaviour is not a house rule to be bolted on with a setting — it is RAW for
// the creatures that paid for it, and a general setting would have given it to everyone for free.
//
// Skulker (2024 PHB p. 208) grants three things, and this file is responsible for two of them:
//   * Sniper — a missed attack roll made while hidden does not reveal you.
//   * Fog of War — advantage on a Dexterity (Stealth) check made as part of the Hide action in combat.
//   * Blindsight 10 ft — nothing to do here. It arrives on the sheet as a real sense and
//     `dnd5e-concealment.ts::sheetSenses` already reads it with its range intact.
//
// HOW EACH IS RECOGNISED, in the order tried, matching `dnd5e-dash.ts`:
//   * `flags.noodlr.*` — the escape hatch, settable from an ordinary Active Effect, for homebrew and for
//     anything granting one benefit without the other.
//   * `system.identifier` on an owned item. Stable across versions and localisations.
//   * the item's name, last, for imported sheets that carry no identifier.
//
// Skulker ships in NO dnd5e compendium — it is PHB content, not SRD, so unlike Cunning Action there is no
// authored item to read an identifier off with any confidence. Whatever the table's importer produced is
// what we get, which is precisely why all three routes are tried and why the flag exists.

import { isDnd5e } from "./dnd5e-rewards";

/**
 * The status that means "this creature took the Hide action".
 *
 * dnd5e defines it (`config.mjs`) and stamps it from Cunning Action's Hide activity, Nimble Escape and
 * Shadow Stealth — but reads it from nowhere: it is an icon wired to nothing. That inertness is what makes
 * it safe to adopt as our declaration. Note the divergence from RAW: 2024 Hide grants the *Invisible*
 * condition, and we deliberately do not apply that. Perceptive does, and it makes mundane hiding look like
 * magical invisibility to every sense-aware module on the table; dnd5e's own content shares our instinct.
 */
export const HIDING_STATUS = "hiding";

/**
 * The status that means "this creature was caught unawares".
 *
 * Unlike `hiding`, this one is genuinely wired up: dnd5e lists it in
 * `CONFIG.DND5E.conditionEffects.initiativeDisadvantage` and initiative preparation reads that set, so
 * applying the status is all it takes to get 2024's Surprise rule. What the system never does is decide
 * who deserves it. Under legacy rules dnd5e deletes `surprised` from that set — 2014's Surprise is a lost
 * turn, not a modifier — so the status becomes inert and marking someone is merely a note for the GM.
 */
export const SURPRISED_STATUS = "surprised";

/** Which edition the world is running. `modern` is dnd5e's own default. */
export function rulesVersion(): "modern" | "legacy" {
  try {
    return game.settings.get("dnd5e", "rulesVersion") === "legacy" ? "legacy" : "modern";
  } catch {
    return "modern";
  }
}

/**
 * The number a Hide check must beat, or null when the edition leaves it to the GM.
 *
 * 2024 fixed it at 15 along with the cover and line-of-sight prerequisites. 2014 has none of that — the
 * Hide entry defers entirely to the GM — so under legacy rules any roll succeeds and becomes the DC.
 */
export function hideDc(): number | null {
  return rulesVersion() === "modern" ? 15 : null;
}

interface FeatSource {
  identifiers: string[];
  pattern: RegExp;
}

const SKULKER: FeatSource = {
  identifiers: ["skulker"],
  pattern: /\bskulker\b/i,
};

function hasFlag(actor: any, key: string): boolean {
  try {
    return Boolean(actor?.getFlag?.("noodlr", key));
  } catch {
    return false;
  }
}

function owns(actor: any, feat: FeatSource): boolean {
  try {
    for (const item of actor?.items ?? []) {
      const id = String(item?.system?.identifier ?? "")
        .trim()
        .toLowerCase();
      if (id && feat.identifiers.includes(id)) return true;
      if (feat.pattern.test(String(item?.name ?? ""))) return true;
    }
  } catch {
    /* an actor whose items will not enumerate simply has no feats we can read */
  }
  return false;
}

/**
 * Does a missed attack roll leave this creature hidden?
 *
 * False for almost everybody, and that is the point — this is the narrow exception, not the general rule.
 * Answering true costs us the ability to reveal on the attack roll itself, because we then have to wait
 * for the hit to be determined, so it is worth being sure before saying yes.
 */
export function keepsHiddenOnMiss(actor: any): boolean {
  if (!isDnd5e() || !actor) return false;
  return hasFlag(actor, "sniper") || owns(actor, SKULKER);
}

/**
 * Does this creature's Hide check get advantage?
 *
 * Skulker's Fog of War is explicitly limited to the Hide action *during combat* — it is about exploiting
 * the distractions of a fight — so the caller has to say whether a fight is on. The flag escape hatch is
 * deliberately unconditional: someone setting it has said what they mean.
 */
export function hidesWithAdvantage(actor: any, inCombat: boolean): boolean {
  if (!isDnd5e() || !actor) return false;
  if (hasFlag(actor, "hideAdvantage")) return true;
  return inCombat && owns(actor, SKULKER);
}

/**
 * What lets this creature Hide for a bonus action, or null when Hide costs its Action.
 *
 * The mirror of `bonusDashSource`, and needed for the same reason: `auto/hide.ts` is the only way most of
 * the party can take the Hide action at all, and until now it charged nothing — so the button was free
 * while the 2024 PHB's own Hide item costs an Action. Unlike Dash, no spell grants this, so there is no
 * effect-only case to handle.
 */
const BONUS_HIDE: Array<FeatSource & { label: string }> = [
  { label: "Cunning Action", identifiers: ["cunning-action"], pattern: /cunning\s*action/i },
  { label: "Nimble Escape", identifiers: ["nimble-escape"], pattern: /nimble\s*escape/i },
  { label: "Shadow Stealth", identifiers: ["shadow-stealth"], pattern: /shadow\s*stealth/i },
];

export function bonusHideSource(actor: any): string | null {
  if (!isDnd5e() || !actor) return null;
  if (hasFlag(actor, "bonusHide")) return "a feature";
  for (const source of BONUS_HIDE) if (owns(actor, source)) return source.label;
  return null;
}

/** Is this a spell that gives you away by being cast — one with a Verbal component? */
export function isVerbalSpell(item: any): boolean {
  if (!isDnd5e() || item?.type !== "spell") return false;
  const props: any = item?.system?.properties;
  try {
    return Boolean(props?.has?.("vocal") ?? props?.includes?.("vocal"));
  } catch {
    return false;
  }
}

/** What ends a magical invisibility, if anything does. */
export interface InvisibilityBreak {
  label: string;
  /** Any one of these ends it. An empty list means nothing short of the duration will. */
  breaksOn: Array<"attack" | "damage" | "cast">;
}

/**
 * Whether an effect by this name is the kind of invisibility that attacking ends.
 *
 * Order matters and the first match wins: Greater Invisibility has to be tested before Invisibility or the
 * substring swallows it. That single distinction is the whole reason this exists — midi clears magical
 * invisibility on any attack under the same rule that clears hiding, which quietly deletes the fourth-level
 * spell whose entire selling point over the second-level one is that attacking does not end it.
 *
 * The 2024 spell adds "deals damage" to 2014's "attacks or casts a spell"; charging both under modern rules
 * is deliberate and harmless under legacy, since damage you dealt without an attack roll or a spell is
 * vanishingly rare and revealing yourself for it is the lesser error.
 */
export function invisibilityBreak(name: string): InvisibilityBreak | null {
  if (!isDnd5e() || !name) return null;
  const lowered = name.toLowerCase();
  if (!/invisib/i.test(lowered) || /see invisib/i.test(lowered)) return null;
  if (/greater\s+invisib/i.test(lowered)) return { label: "Greater Invisibility", breaksOn: [] };
  return { label: "Invisibility", breaksOn: ["attack", "damage", "cast"] };
}
