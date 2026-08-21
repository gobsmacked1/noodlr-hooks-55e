// Reading aura features off a sheet. Names and identifiers live here; who is in range does not.
//
// dnd5e does not emanate anything. 2024 Aura of Protection ships a transferred Active Effect that
// adds `@abilities.cha.mod` to the Paladin's own saves, and a Foundry Note that says allies must
// add that modifier by hand — because copying the effect would evaluate Charisma against the ally.
// DDB Importer stamps `flags.ActiveAuras` so Active Auras (or Aura Effects) can do the copy; with
// those modules off the stamp is inert and clicking the feature posts prose.
//
// This file answers four questions the executor needs: is this an aura, how far, who, and what
// numbers to write. Formulae are resolved against the SOURCE so an ally gets the Paladin's +5,
// never their own Charisma. A transferred effect already covers the carrier — applying a second
// copy there would double it.
//
// Two families of emanation, and they do not share an executor:
//   grant  — copy a resolved AE while a creature is in range (Protection, Courage, a
//            creature's frightful presence if it is only a standing penalty). Same identifier
//            from two hosts is ONE instance: the stronger number wins, weaker is dropped.
//            Different identifiers apply independently. A Paladin's own transferred AE counts
//            as their instance, so a stronger neighbour writes only the delta.
//   field  — enter / the emanation moves over you / end of turn, a save, damage, Speed while
//            inside, creatures the caster designated as unaffected. Spirit Guardians is the
//            specimen. That is `create_area` / `on_enter_area` (Phase 4), not a save-bonus
//            copy. Discovery refuses those items so a Half Speed AE with a radius template
//            cannot be mistaken for Aura of Protection.

import { effectModes } from "../capability/timed";
import { MODULE_ID } from "../constants";
import { moduleActive } from "../util/modules";

export type AuraAudience = "allies" | "enemies" | "all";

export interface AuraChange {
  key: string;
  value: string;
  mode: number;
}

export interface AuraSource {
  id: string;
  itemId: string;
  effectId: string;
  identifier: string;
  name: string;
  img: string;
  origin: string;
  radiusFormula: string;
  fallbackRadius: number;
  audience: AuraAudience;
  includeSelf: boolean;
  /** The item effect already transfers onto the carrier. Do not write a second copy there. */
  transferSelf: boolean;
  /** Spells emanate only while an AE from this item is live on the caster. Features always do. */
  requiresActive: boolean;
  changes: AuraChange[];
}

export interface KnownAura {
  identifier: string;
  radiusFormula: string;
  fallbackRadius: number;
  audience: AuraAudience;
  includeSelf: boolean;
  suppress: "incapacitated";
  fallbackChanges: Array<{ key: string; value: string }>;
}

/**
 * Features whose printed rule is an emanation, including those whose stock AE is empty
 * (Courage, Devotion — Foundry Notes say the AE is a tracker, not the immunity).
 */
export const KNOWN_AURAS: readonly KnownAura[] = [
  {
    identifier: "aura-of-protection",
    radiusFormula: "@scale.paladin.aura",
    fallbackRadius: 10,
    audience: "allies",
    includeSelf: true,
    suppress: "incapacitated",
    fallbackChanges: [{ key: "system.bonuses.abilities.save", value: "max(1,@abilities.cha.mod)" }],
  },
  {
    identifier: "aura-of-courage",
    radiusFormula: "@scale.paladin.aura",
    fallbackRadius: 10,
    audience: "allies",
    includeSelf: true,
    suppress: "incapacitated",
    fallbackChanges: [{ key: "system.traits.ci.value", value: "frightened" }],
  },
  {
    identifier: "aura-of-devotion",
    radiusFormula: "@scale.paladin.aura",
    fallbackRadius: 10,
    audience: "allies",
    includeSelf: true,
    suppress: "incapacitated",
    fallbackChanges: [{ key: "system.traits.ci.value", value: "charmed" }],
  },
  {
    identifier: "aura-of-warding",
    radiusFormula: "@scale.paladin.aura",
    fallbackRadius: 10,
    audience: "allies",
    includeSelf: true,
    suppress: "incapacitated",
    fallbackChanges: [
      { key: "system.traits.dr.value", value: "necrotic" },
      { key: "system.traits.dr.value", value: "psychic" },
      { key: "system.traits.dr.value", value: "radiant" },
    ],
  },
  {
    identifier: "aura-of-life",
    radiusFormula: "30",
    fallbackRadius: 30,
    audience: "allies",
    includeSelf: true,
    suppress: "incapacitated",
    fallbackChanges: [{ key: "system.traits.dr.value", value: "necrotic" }],
  },
];

const KNOWN_BY_ID = new Map(KNOWN_AURAS.map((row) => [row.identifier, row]));

/** Occupying fields. Not grants. Do not add every MM aura here — the save+damage heuristic does. */
export const OCCUPYING_IDENTIFIERS = new Set(["spirit-guardians"]);

export function knownAuraOf(identifier: string): KnownAura | null {
  return KNOWN_BY_ID.get(String(identifier ?? "").toLowerCase()) ?? null;
}

/** Another module is already copying aura AEs. Two copies is a stacked bonus, not a fallback. */
export function auraModuleOwns(): { by: string; note: string } | null {
  if (moduleActive("auraeffects")) {
    return {
      by: "Aura Effects",
      note:
        "It writes real Active Effects onto anyone who enters its Regions. Standing aside so a " +
        "Paladin's save bonus is not applied twice.",
    };
  }
  if (moduleActive("ActiveAuras")) {
    return {
      by: "Active Auras",
      note:
        "DDB-imported auras carry its flags. It already copies those effects onto nearby tokens.",
    };
  }
  return null;
}

export function getPath(data: unknown, path: string): unknown {
  let cur: unknown = data;
  for (const part of String(path ?? "").split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

export function interpolateAtRefs(value: string, data: unknown): string {
  return String(value ?? "").replace(/@([a-zA-Z0-9._-]+)/g, (_, path: string) => {
    const got = getPath(data, path);
    if (got == null || got === "") return "0";
    if (typeof got === "object" && got !== null && "value" in got) {
      const inner = Number((got as { value: unknown }).value);
      if (Number.isFinite(inner)) return String(inner);
    }
    return String(got);
  });
}

/** "30", "30-ft", "30 ft.", "10-foot" — DDB writes units onto a number we then Number() to NaN. */
export function parseAuraLength(raw: string): number | null {
  const s = String(raw ?? "").trim().replace(/\s+/g, " ");
  if (!s) return null;
  const m = /^(-?\d+(?:\.\d+)?)\s*-?\s*(?:ft|feet|foot)?\.?$/i.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * 2024 Paladin auras are a flat jump, not a curve: 10 ft at 6–17, 30 ft at 18–20.
 * dnd5e's ScaleValue on the class item is that table (`identifier: aura`, type distance).
 */
export function paladinAuraRadiusAtLevel(level: number): number {
  const n = Number(level);
  if (!Number.isFinite(n) || n < 1) return 10;
  return n >= 18 ? 30 : 10;
}

/** Paladin class levels from roll data or the class item. Multiclass uses the Paladin item, not total level. */
export function paladinClassLevel(data: unknown, actor?: any): number | null {
  const fromData = Number(
    getPath(data, "classes.paladin.levels") ?? getPath(data, "class.paladin.levels"),
  );
  if (Number.isFinite(fromData) && fromData > 0) return fromData;
  for (const item of actor?.items ?? []) {
    if (String(item?.type ?? "") !== "class") continue;
    if (String(item?.system?.identifier ?? "").toLowerCase() !== "paladin") continue;
    const n = Number(item?.system?.levels);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

function ddbStatedRadius(item: any): number | null {
  const n = Number(item?.flags?.ddbimporter?.dndbeyond?.levelScale?.fixedValue);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function auraFallbackRadius(item: any, known: KnownAura | null, actor: any): number {
  const stated = ddbStatedRadius(item);
  if (stated != null) return stated;
  if (known?.radiusFormula.includes("@scale.paladin.aura")) {
    const level = paladinClassLevel(null, actor);
    if (level != null) return paladinAuraRadiusAtLevel(level);
  }
  return known?.fallbackRadius ?? 10;
}

function usesPaladinAuraScale(formula: string, identifier: string): boolean {
  if (/@scale\.paladin\.aura/i.test(formula)) return true;
  if (/\[\[\s*scalevalue\s*\]\]/i.test(formula)) return true;
  return Boolean(knownAuraOf(identifier)?.radiusFormula.includes("@scale.paladin.aura"));
}

/** DDB leaves `[[scalevalue]]-ft` in prose and sometimes in the AA radius field. */
export function normalizeRadiusFormula(formula: string): string {
  return String(formula ?? "")
    .trim()
    .replace(/\[\[\s*scalevalue\s*\]\]/gi, "@scale.paladin.aura")
    .replace(/\s*-?\s*(?:ft|feet|foot)\.?$/i, "");
}

/**
 * Turn a sheet formula into a number string against the source's roll data.
 *
 * `max(1,@abilities.cha.mod)` becomes `"5"` on a Charisma-20 Paladin. An unreadable expression
 * is left as the interpolated text rather than guessed — writing "max(1,5)" onto a save bonus
 * is visible; writing 0 is a silent wrong aura.
 */
export function resolveAuraValue(value: string, data: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) return raw;
  const filled = interpolateAtRefs(raw, data).replace(/\s+/g, "");
  const n = evalSimple(filled);
  return n == null ? filled : String(n);
}

export interface AuraRadiusHint {
  actor?: any;
  identifier?: string;
}

export function resolveAuraRadius(
  formula: string,
  data: unknown,
  fallback: number,
  hint: AuraRadiusHint = {},
): number {
  const ident = String(hint.identifier ?? "");
  const normalized = normalizeRadiusFormula(formula);
  const candidates = [normalized];
  if (usesPaladinAuraScale(formula, ident) || usesPaladinAuraScale(normalized, ident)) {
    if (!candidates.includes("@scale.paladin.aura")) candidates.push("@scale.paladin.aura");
    if (!candidates.includes("@scale.paladin.aura-of-protection")) {
      candidates.push("@scale.paladin.aura-of-protection");
    }
  }
  for (const candidate of candidates) {
    const resolved = resolveAuraValue(candidate, data);
    const n = parseAuraLength(resolved) ?? (Number.isFinite(Number(resolved)) ? Number(resolved) : null);
    if (n != null && n > 0) return n;
  }
  if (usesPaladinAuraScale(formula, ident) || usesPaladinAuraScale(normalized, ident)) {
    const level = paladinClassLevel(data, hint.actor);
    if (level != null) return paladinAuraRadiusAtLevel(level);
  }
  return fallback > 0 ? fallback : 10;
}

function evalSimple(expr: string): number | null {
  if (/^-?\d+(?:\.\d+)?$/.test(expr)) return Math.floor(Number(expr));
  const max = /^max\((-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)\)$/i.exec(expr);
  if (max) return Math.floor(Math.max(Number(max[1]), Number(max[2])));
  const min = /^min\((-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)\)$/i.exec(expr);
  if (min) return Math.floor(Math.min(Number(min[1]), Number(min[2])));
  return null;
}

/**
 * Token-icon status for a copied aura. Foundry only draws `temporaryEffects` on the token
 * (duration or a status). A canned condition id would overlay Paralyzed / Frightened.
 *
 * The id is registered on `CONFIG.statusEffects` with `hud: false`: Token HUD skips those
 * (`token-hud.mjs` `_getStatusEffectChoices`), so there is no click-toggle, but
 * `isTemporary` and Visual Active Effects still see a real status. An unregistered id was
 * not enough — the Paladin's transferred AE has no status at all, and an unknown id is
 * easy for another module's icon pass to skip.
 */
export const AURA_STATUS_PREFIX = "noodlr-aura-";
export const AURA_STATUS_IMG = "icons/svg/aura.svg";

/**
 * Automated Animations' aefx menu matches an AE by rinsed name. "Aura of Protection" is in
 * that menu and is persistent, so creating our copy played a Sequencer effect and posted
 * "Use the Sequencer Effect Manager to remove the Animation." `killAnim` is AA's own off
 * switch (`handleItem`); `version` 99 so its migrator treats the flags as current and does
 * not rewrite the document.
 */
export const AURA_AA_FLAGS = { killAnim: true, isEnabled: false, version: 99 } as const;

export function auraStatusId(identifier: string, fallback = "aura"): string {
  const raw = String(identifier || fallback || "aura").toLowerCase();
  const slug = raw.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "aura";
  return slug.startsWith("aura-") ? `noodlr-${slug}` : `${AURA_STATUS_PREFIX}${slug}`;
}

export function auraStatusEntry(
  identifier: string,
  name: string,
  img = AURA_STATUS_IMG,
): { id: string; name: string; img: string; hud: false } {
  return {
    id: auraStatusId(identifier),
    name: name || identifier,
    img: img || AURA_STATUS_IMG,
    hud: false,
  };
}

/** Idempotent. Safe to call per apply — unknown homebrew auras register on first copy. */
export function registerAuraStatus(identifier: string, name: string, img?: string): string {
  const id = auraStatusId(identifier);
  const list = (globalThis as any).CONFIG?.statusEffects;
  if (!Array.isArray(list)) return id;
  if (list.some((s: any) => s?.id === id)) return id;
  list.push(auraStatusEntry(identifier, name, img));
  return id;
}

export function registerKnownAuraStatuses(): void {
  for (const row of KNOWN_AURAS) {
    registerAuraStatus(row.identifier, row.identifier.replace(/-/g, " "));
  }
}

/**
 * v14 `CONST.ACTIVE_EFFECT_SHOW_ICON.ALWAYS`. Default is CONDITIONAL (icon only while
 * the effect has a temporary duration). A Paladin aura is permanent. The flag
 * `flags.dnd5e.isTemporary` is dnd5e's "this is a timed effect" marker — it files
 * the row under Temporary and, with CONDITIONAL, ties the token icon to duration.
 * Do not set it. v13 has no showIcon and drops the key.
 */
export const AURA_SHOW_ICON_ALWAYS = 2;

/** Presentation-only badge on the carrier. Not `aura` — apply/strip must not delete it. */
export const AURA_HOST_FLAG = "auraHost";

export function auraWriteFlags(sourceToken: string, sourceId: string): Record<string, unknown> {
  return {
    [MODULE_ID]: { aura: { sourceToken, sourceId } },
    autoanimations: { ...AURA_AA_FLAGS },
  };
}

export function auraHostWriteFlags(sourceId: string): Record<string, unknown> {
  return {
    [MODULE_ID]: { [AURA_HOST_FLAG]: { sourceId } },
    autoanimations: { ...AURA_AA_FLAGS },
  };
}

export function isOurAuraHost(effect: any): boolean {
  const flag = effect?.flags?.[MODULE_ID]?.[AURA_HOST_FLAG];
  return Boolean(flag && typeof flag === "object" && flag.sourceId);
}

/** Dotted paths so an update cannot replace `flags.dnd5e` and wipe dependents. */
export function auraPresentationPatch(statusId: string, img: string): Record<string, unknown> {
  return {
    statuses: [statusId],
    img,
    showIcon: AURA_SHOW_ICON_ALWAYS,
    "flags.dnd5e.-=isTemporary": null,
    "flags.autoanimations.killAnim": true,
    "flags.autoanimations.isEnabled": false,
    "flags.autoanimations.version": 99,
  };
}

function effectHasStatus(effect: any, status: string): boolean {
  const statuses = effect?.statuses;
  if (statuses instanceof Set) return statuses.has(status);
  if (Array.isArray(statuses)) return statuses.includes(status);
  return false;
}

export function hostNeedsPresentation(effect: any, statusId: string, img: string): boolean {
  if (!effectHasStatus(effect, statusId)) return true;
  const aa = effect?.flags?.autoanimations;
  if (!aa?.killAnim && aa?.isEnabled !== false) return true;
  if (effect?.flags?.dnd5e?.isTemporary === true) return true;
  if (effect?.disabled || effect?.duration?.expired) return true;
  return Boolean(img) && String(effect?.img ?? "") !== img;
}

export function withoutAuraStatuses(effect: any): string[] {
  const raw = effect?.statuses;
  const list = raw instanceof Set ? [...raw] : Array.isArray(raw) ? [...raw] : [];
  return list.filter((id) => !String(id).startsWith(AURA_STATUS_PREFIX) && !String(id).startsWith("noodlr-aura-"));
}

export function transferredNeedsRepair(effect: any): boolean {
  if (!effect) return false;
  if (effect.disabled || effect.duration?.expired) return true;
  if (effect.flags?.dnd5e?.isTemporary === true) return true;
  if (effect.flags?.[MODULE_ID]?.aura) return true;
  return withoutAuraStatuses(effect).length !== (
    effect.statuses instanceof Set ? effect.statuses.size : Array.isArray(effect.statuses) ? effect.statuses.length : 0
  );
}

/** Undo a v0.7.19–v0.7.20 stamp on the item-transferred AE (statuses / isTemporary). */
export function transferredRepairPatch(effect: any): Record<string, unknown> {
  const patch: Record<string, unknown> = {
    disabled: false,
    "flags.dnd5e.-=isTemporary": null,
    [`flags.${MODULE_ID}.-=aura`]: null,
  };
  const kept = withoutAuraStatuses(effect);
  const before = effect?.statuses instanceof Set
    ? effect.statuses.size
    : Array.isArray(effect?.statuses)
      ? effect.statuses.length
      : 0;
  if (kept.length !== before) patch.statuses = kept;
  return patch;
}

/**
 * Transferred item AEs live on `item.effects`, not `actor.effects`. Walking only the
 * actor collection is why Aura of Protection never got a host icon (Courage is
 * `transfer: false` and already has an actor copy).
 */
export function applicableAuraEffects(actor: any): any[] {
  if (!actor) return [];
  if (typeof actor.allApplicableEffects === "function") {
    try {
      return [...actor.allApplicableEffects()];
    } catch {
      // fall through
    }
  }
  const out: any[] = [...(actor.effects ?? [])];
  const seen = new Set(out);
  for (const item of actor.items ?? []) {
    for (const effect of item.effects ?? []) {
      if (!effect?.transfer || seen.has(effect)) continue;
      seen.add(effect);
      out.push(effect);
    }
  }
  return out;
}

/**
 * The sheet-transferred AE, including a disabled one we have to revive.
 * Origin is the item; name is a fallback when an importer dropped origin.
 */
export function looksLikeHostItemAura(effect: any, source: AuraSource): boolean {
  if (!effect) return false;
  if (effect.flags?.[MODULE_ID]?.aura) return false;
  if (isOurAuraHost(effect)) return false;
  const origin = String(effect.origin ?? "");
  if (source.itemId && origin.includes(source.itemId)) return true;
  const named = String(effect.name ?? "").toLowerCase() === source.name.toLowerCase();
  return named && Array.isArray(effect.changes) && effect.changes.length > 0;
}

/** Live (not disabled) transferred AE — the Paladin's own mechanical grant. */
export function looksLikeTransferredAura(effect: any, source: AuraSource): boolean {
  if (effect?.disabled) return false;
  return looksLikeHostItemAura(effect, source);
}

/**
 * v0.7.20 recreate wrote a full-changes AE onto the actor when it could not see
 * the item-transferred one. That doubles +Cha. Only delete if it still carries
 * our stamp — a legacy-transferred actor copy has neither.
 */
export function looksLikeStrayHostCopy(effect: any, source: AuraSource): boolean {
  if (!effect || effect.transfer) return false;
  if (effect.flags?.[MODULE_ID]?.aura) return false;
  if (isOurAuraHost(effect)) return false;
  if (!looksLikeHostItemAura(effect, source)) return false;
  if (effect.flags?.dnd5e?.isTemporary === true) return true;
  const raw = effect.statuses;
  const n = raw instanceof Set ? raw.size : Array.isArray(raw) ? raw.length : 0;
  return n > 0 && withoutAuraStatuses(effect).length !== n;
}

export function hostTransferredEffect(actor: any, source: AuraSource): any | null {
  if (!actor || !source) return null;
  for (const item of actor.items ?? []) {
    if (source.itemId && String(item.id) !== source.itemId) continue;
    for (const effect of item.effects ?? []) {
      if (!effect?.transfer) continue;
      if (source.effectId && String(effect.id) === source.effectId) return effect;
      if (looksLikeHostItemAura(effect, source)) return effect;
    }
  }
  for (const effect of applicableAuraEffects(actor)) {
    if (looksLikeHostItemAura(effect, source)) return effect;
  }
  return null;
}

/**
 * v0.7.19 wrote a hollow badge with the transferred AE's name and origin. Same-origin
 * create can land that on the sheet AE: empty changes, our delete flag. Allies still
 * receive copies (those are read off the item). The Paladin has lost their own bonus.
 */
export function looksLikeGuttedHostAura(effect: any, source: AuraSource): boolean {
  if (isOurAuraHost(effect)) return false;
  const flag = effect?.flags?.[MODULE_ID]?.aura;
  if (!flag || typeof flag !== "object") return false;
  if (Array.isArray(effect?.changes) && effect.changes.length > 0) return false;
  const origin = String(effect.origin ?? "");
  if (source.itemId && origin.includes(source.itemId)) return true;
  if (String(flag.sourceId ?? "") === source.id) return true;
  return String(effect.name ?? "").toLowerCase() === source.name.toLowerCase();
}

export function audienceOfFlag(raw: unknown): AuraAudience {
  const s = String(raw ?? "").toLowerCase();
  if (s === "enemy" || s === "enemies" || s === "hostile") return "enemies";
  if (s === "all" || s === "everyone") return "all";
  return "allies";
}

/**
 * Same disposition is an ally. Opposite signs are enemies. Neutral (0) is nobody's enemy.
 * SECRET (−2) is never a recipient — it is GM bookkeeping.
 */
export function audienceMatches(
  sourceDisp: number,
  targetDisp: number,
  audience: AuraAudience,
): boolean {
  if (targetDisp === -2 || sourceDisp === -2) return false;
  if (audience === "all") return true;
  if (audience === "allies") return sourceDisp === targetDisp;
  return sourceDisp * targetDisp < 0;
}

export function auraStrength(changes: Array<{ value: string }>): number {
  let sum = 0;
  let numeric = false;
  for (const ch of changes) {
    const n = Number(ch.value);
    if (Number.isFinite(n)) {
      sum += n;
      numeric = true;
    }
  }
  return numeric ? sum : 0;
}

export function changesAreNumeric(changes: Array<{ value: string }>): boolean {
  return changes.some((ch) => Number.isFinite(Number(ch.value)));
}

/** Same-signed: larger magnitude wins. Mixed: the bonus wins. Two −4 and −2 keep −4. */
export function auraDominates(a: number, b: number): boolean {
  if (a >= 0 && b >= 0) return a > b;
  if (a <= 0 && b <= 0) return a < b;
  return a > b;
}

export function netAuraChanges<T extends { key: string; mode: number; value: string }>(
  changes: T[],
  ownStrength: number,
  bestStrength: number,
): T[] {
  const delta = bestStrength - ownStrength;
  let used = false;
  return changes.map((ch) => {
    if (used || !Number.isFinite(Number(ch.value))) return ch;
    used = true;
    return { ...ch, value: String(delta) };
  });
}

/**
 * Same identifier → one instance. Different identifiers stay.
 * `ownByIdent` is the recipient's transferred grant of that identifier (the Paladin's own +3).
 */
export function collapseOverlappingAuras<
  T extends { identifier: string; changes: Array<{ key: string; mode: number; value: string }> },
>(rows: T[], ownByIdent: Record<string, number> = {}): T[] {
  const groups = new Map<string, T[]>();
  const unkeyed: T[] = [];
  for (const row of rows) {
    const key = String(row.identifier ?? "").toLowerCase();
    if (!key) {
      unkeyed.push(row);
      continue;
    }
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }
  const out: T[] = [...unkeyed];
  for (const [ident, list] of groups) {
    let best = list[0];
    let bestStr = auraStrength(best.changes);
    for (const row of list.slice(1)) {
      const s = auraStrength(row.changes);
      if (auraDominates(s, bestStr)) {
        best = row;
        bestStr = s;
      }
    }
    const own = Number(ownByIdent[ident] ?? 0);
    if (changesAreNumeric(best.changes)) {
      if (!auraDominates(bestStr, own)) continue;
      if (own !== 0) {
        out.push({ ...best, changes: netAuraChanges(best.changes, own, bestStr) });
        continue;
      }
    }
    out.push(best);
  }
  return out;
}

function itemHasEmanationSave(item: any): boolean {
  const sys = item?.system ?? {};
  const itemIsSelfRadius =
    String(sys.range?.units ?? "") === "self" && String(sys.target?.template?.type ?? "") === "radius";
  for (const act of activitiesOf(item)) {
    const save = String(act?.type ?? "") === "save" || Boolean(act?.save?.ability);
    const parts = act?.damage?.parts;
    const dmg = Array.isArray(parts) && parts.length > 0;
    if (!save || !dmg) continue;
    if (itemIsSelfRadius) return true;
    if (
      String(act?.range?.units ?? "") === "self" &&
      String(act?.target?.template?.type ?? "") === "radius"
    ) {
      return true;
    }
  }
  return false;
}

/** Spirit Guardians and anything else that saves-and-hurts inside a self emanation. */
export function isOccupyingField(item: any): boolean {
  if (OCCUPYING_IDENTIFIERS.has(identifierOf(item))) return true;
  return itemHasEmanationSave(item);
}

/**
 * Half Speed on Spirit Guardians is all movement multipliers. A grant that ADDs walk speed
 * is not this — mode and a value in (0, 1) are what make it a field residue.
 */
export function changesAreOccupyingResidue(
  changes: Array<{ key: string; value: string; mode?: number }>,
): boolean {
  if (!changes.length) return false;
  const mul = effectModes().multiply;
  return changes.every((ch) => {
    if (!/^system\.attributes\.movement\./.test(String(ch.key ?? ""))) return false;
    const mode = Number(ch.mode);
    const n = Number(ch.value);
    if (Number.isFinite(mode) && mode === mul) return true;
    return Number.isFinite(n) && n > 0 && n < 1;
  });
}

function aaFlags(effect: any): Record<string, unknown> | null {
  const flags = effect?.flags?.ActiveAuras ?? effect?.flags?.activeauras;
  return flags && typeof flags === "object" ? flags : null;
}

function identifierOf(item: any): string {
  return String(item?.system?.identifier ?? "").toLowerCase();
}

function activitiesOf(item: any): any[] {
  const raw = item?.system?.activities;
  if (!raw) return [];
  if (typeof raw[Symbol.iterator] === "function") return [...raw];
  return Object.values(raw);
}

function radiusFromActivities(item: any): string | null {
  for (const act of activitiesOf(item)) {
    if (String(act?.range?.units ?? "") !== "self") continue;
    if (String(act?.target?.template?.type ?? "") !== "radius") continue;
    const size = act?.target?.template?.size;
    if (size != null && String(size) !== "") return String(size);
  }
  return null;
}

function changesOf(effect: any): AuraChange[] {
  const add = effectModes().add;
  const out: AuraChange[] = [];
  for (const ch of effect?.changes ?? []) {
    const key = String(ch?.key ?? "");
    if (!key) continue;
    const mode = Number(ch?.mode) || (String(ch?.type ?? "") === "add" ? add : add);
    out.push({ key, value: String(ch?.value ?? ""), mode });
  }
  return out;
}

function fallbackChanges(known: KnownAura): AuraChange[] {
  const add = effectModes().add;
  return known.fallbackChanges.map((ch) => ({ key: ch.key, value: ch.value, mode: add }));
}

function itemIsSpell(item: any): boolean {
  return String(item?.type ?? "") === "spell";
}

/**
 * Aura definitions on this actor's items. One row per effect (or per known identifier with no
 * effect — 2014 Aura of Protection is an empty feat).
 */
export function auraSourcesOn(actor: any): AuraSource[] {
  const out: AuraSource[] = [];
  if (!actor) return out;
  for (const item of actor.items ?? []) {
    if (isOccupyingField(item)) continue;
    const ident = identifierOf(item);
    const known = knownAuraOf(ident);
    const activityRadius = radiusFromActivities(item);
    const effects = [...(item.effects ?? [])];
    let emitted = false;
    for (const effect of effects) {
      const aa = aaFlags(effect);
      const listed = changesOf(effect);
      if (changesAreOccupyingResidue(listed) && !known) continue;
      const isAura = Boolean(aa?.isAura) || Boolean(known) || (Boolean(activityRadius) && listed.length > 0);
      if (!isAura) continue;
      const changes = listed.length > 0 ? listed : known ? fallbackChanges(known) : [];
      if (!changes.length) continue;
      const radiusFormula =
        String(aa?.radius ?? "") || activityRadius || known?.radiusFormula || String(known?.fallbackRadius ?? 10);
      out.push({
        id: `${String(item.id)}:${String(effect.id ?? effect.name)}`,
        itemId: String(item.id ?? ""),
        effectId: String(effect.id ?? ""),
        identifier: ident || known?.identifier || "",
        name: String(effect.name || item.name || "Aura"),
        img: String(effect.img || item.img || "icons/svg/aura.svg"),
        origin: String(item.uuid ?? effect.uuid ?? ""),
        radiusFormula,
        fallbackRadius: auraFallbackRadius(item, known, actor),
        audience: audienceOfFlag(aa?.aura ?? known?.audience ?? "allies"),
        includeSelf: aa ? aa.ignoreSelf !== true : (known?.includeSelf ?? true),
        transferSelf: Boolean(effect.transfer),
        requiresActive: itemIsSpell(item),
        changes,
      });
      emitted = true;
    }
    if (!emitted && known) {
      out.push({
        id: `${String(item.id)}:known`,
        itemId: String(item.id ?? ""),
        effectId: "",
        identifier: known.identifier,
        name: String(item.name || known.identifier),
        img: String(item.img || "icons/svg/aura.svg"),
        origin: String(item.uuid ?? ""),
        radiusFormula: activityRadius || known.radiusFormula,
        fallbackRadius: auraFallbackRadius(item, known, actor),
        audience: known.audience,
        includeSelf: known.includeSelf,
        transferSelf: false,
        requiresActive: itemIsSpell(item),
        changes: fallbackChanges(known),
      });
    }
  }
  return out;
}

/** A transferred item AE already covers the carrier. A second copy there would double the bonus. */
export function receivesOwnAura(source: AuraSource): boolean {
  return source.includeSelf && !source.transferSelf;
}

/** A spell-gated aura is live when the caster is carrying an AE that came from that item. */
export function spellAuraIsActive(actor: any, source: AuraSource): boolean {
  if (!source.requiresActive) return true;
  const itemId = source.itemId;
  const name = source.name.toLowerCase();
  for (const effect of actor?.effects ?? []) {
    if (effect?.disabled) continue;
    if (effect?.flags?.[MODULE_ID]?.aura) continue;
    const origin = String(effect?.origin ?? "");
    if (itemId && origin.includes(itemId)) return true;
    if (String(effect?.name ?? "").toLowerCase() === name) return true;
  }
  return false;
}
