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

export function resolveAuraRadius(formula: string, data: unknown, fallback: number): number {
  const resolved = resolveAuraValue(formula, data);
  const n = Number(resolved);
  if (Number.isFinite(n) && n > 0) return n;
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
    const ident = identifierOf(item);
    const known = knownAuraOf(ident);
    const activityRadius = radiusFromActivities(item);
    const effects = [...(item.effects ?? [])];
    let emitted = false;
    for (const effect of effects) {
      const aa = aaFlags(effect);
      const listed = changesOf(effect);
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
        fallbackRadius: known?.fallbackRadius ?? 10,
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
        fallbackRadius: known.fallbackRadius,
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
