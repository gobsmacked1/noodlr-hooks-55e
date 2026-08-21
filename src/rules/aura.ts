// Creature-emanation auras (Aura of Protection and its cousins).
//
// Learned from Aura Effects and Active Auras, depends on neither. Those modules copy a source
// Active Effect onto whoever is inside a moving radius; dnd5e itself never does. With them off,
// a Paladin's transferred save bonus stays on the Paladin and nearby allies get nothing, and
// clicking the feature posts the prose — empty activation, prompt false.
//
// Geometry is `measureBetween` plus elevation, not a Region. A circle around a token is a
// distance, and we already have one answer to that. Regions are the right primitive for
// `create_area` / Spirit Guardians (Phase 4); they are more machinery than a Paladin aura needs.
//
// Same identifier, two hosts → the stronger number, not both. Different identifiers
// (Protection + Courage, or a hostile field next to a Paladin aura) apply independently.
// A Paladin's transferred AE is their own instance: a stronger neighbour writes the delta
// so +3 and +5 become +5, never +8.
//
// Writes are primary-GM only. A player's aura is applied to other sheets, and only the GM can
// write those. Formulae are resolved against the source before the copy is written, so an ally
// gets the Paladin's Charisma, never their own.

import { GENERAL_SETTINGS, MODULE_ID, debug, log, warn } from "../constants";
import { centerOf, measureBetween } from "../core/positioning";
import { isAurasEnabled } from "../settings";
import { isIncapacitated } from "../system/dnd5e-conditions";
import { isDnd5e } from "../system/dnd5e-rewards";
import {
  type AuraSource,
  auraDominates,
  auraModuleOwns,
  auraSourcesOn,
  auraStrength,
  collapseOverlappingAuras,
  paladinClassLevel,
  resolveAuraRadius,
  resolveAuraValue,
  audienceMatches,
  receivesOwnAura,
  spellAuraIsActive,
} from "../system/dnd5e-auras";
import { isPrimaryGM } from "../util/gm";

const FLAG = "aura";
const SETTLE_MS = 150;

interface AuraFlag {
  sourceToken: string;
  sourceId: string;
}

interface Desired {
  identifier: string;
  source: AuraSource;
  sourceTokenId: string;
  sourceName: string;
  changes: Array<{ key: string; mode: number; value: string }>;
}

function ourAura(effect: any): AuraFlag | null {
  const flag = effect?.flags?.[MODULE_ID]?.[FLAG];
  if (!flag || typeof flag !== "object") return null;
  if (!flag.sourceToken || !flag.sourceId) return null;
  return { sourceToken: String(flag.sourceToken), sourceId: String(flag.sourceId) };
}

function tokensOnScene(): any[] {
  const layer: any = (globalThis as any).canvas?.tokens;
  const list = layer?.placeables ?? [];
  return list.filter((t: any) => t?.document && t.actor);
}

function dispositionOf(token: any): number {
  const d = Number(token?.document?.disposition ?? token?.disposition);
  return Number.isFinite(d) ? d : 0;
}

function elevationOf(token: any): number {
  return Number(token?.document?.elevation ?? token?.elevation) || 0;
}

function auraDistance(a: any, b: any): number {
  const pa = centerOf(a);
  const pb = centerOf(b);
  if (!pa || !pb) return Number.POSITIVE_INFINITY;
  const flat = measureBetween(pa, pb);
  const rise = Math.abs(elevationOf(a) - elevationOf(b));
  return rise ? Math.hypot(flat, rise) : flat;
}

function rollDataOf(actor: any): Record<string, unknown> {
  try {
    const data = typeof actor?.getRollData === "function" ? actor.getRollData() : null;
    if (data && typeof data === "object") return data;
  } catch {
    // fall through
  }
  return {
    abilities: actor?.system?.abilities ?? {},
    scale: actor?.system?.scale ?? {},
  };
}

function sourceIsSuppressed(actor: any): boolean {
  if (!actor) return true;
  if (isIncapacitated(actor)) return true;
  try {
    if (typeof actor.hasStatusEffect === "function" && actor.hasStatusEffect("dead")) return true;
  } catch {
    // continue
  }
  return false;
}

function shouldReceive(sourceToken: any, targetToken: any, source: AuraSource): boolean {
  const same = String(sourceToken?.id ?? sourceToken?.document?.id) === String(targetToken?.id ?? targetToken?.document?.id);
  if (same) return receivesOwnAura(source);
  return audienceMatches(dispositionOf(sourceToken), dispositionOf(targetToken), source.audience);
}

function resolveChanges(source: AuraSource, data: unknown): Desired["changes"] {
  return source.changes.map((ch) => ({
    key: ch.key,
    mode: ch.mode,
    value: resolveAuraValue(ch.value, data),
  }));
}

/** The recipient's own transferred grant of each identifier — their instance of that aura. */
function ownTransferredStrengths(actor: any): Record<string, number> {
  const data = rollDataOf(actor);
  const out: Record<string, number> = {};
  for (const source of auraSourcesOn(actor)) {
    if (!source.transferSelf || !source.identifier) continue;
    const s = auraStrength(resolveChanges(source, data));
    const prev = out[source.identifier];
    if (prev == null || auraDominates(s, prev)) out[source.identifier] = s;
  }
  return out;
}

function desiredForScene(): Map<string, Desired[]> {
  const wanted = new Map<string, Desired[]>();
  if (!isAurasEnabled() || auraModuleOwns() || !isDnd5e()) return wanted;
  for (const token of tokensOnScene()) {
    const actor = token.actor;
    if (sourceIsSuppressed(actor)) continue;
    const data = rollDataOf(actor);
    for (const source of auraSourcesOn(actor)) {
      if (!spellAuraIsActive(actor, source)) continue;
      const radius = resolveAuraRadius(source.radiusFormula, data, source.fallbackRadius, {
        actor,
        identifier: source.identifier,
      });
      const changes = resolveChanges(source, data);
      if (!changes.length) continue;
      const sourceTokenId = String(token.id);
      for (const other of tokensOnScene()) {
        if (!shouldReceive(token, other, source)) continue;
        if (auraDistance(token, other) > radius + 1e-6) continue;
        const key = String(other.actor?.uuid ?? other.actor?.id ?? "");
        if (!key) continue;
        const list = wanted.get(key) ?? [];
        list.push({
          identifier: source.identifier,
          source,
          sourceTokenId,
          sourceName: String(token.document?.name ?? actor?.name ?? "?"),
          changes,
        });
        wanted.set(key, list);
      }
    }
  }
  return wanted;
}

function sameChanges(effect: any, changes: Desired["changes"]): boolean {
  const have = effect?.changes ?? [];
  if (have.length !== changes.length) return false;
  return changes.every((ch, i) => {
    const row = have[i];
    return String(row?.key) === ch.key && String(row?.value) === ch.value && Number(row?.mode || 2) === ch.mode;
  });
}

async function applyDesired(actor: any, desired: Desired[]): Promise<{ wrote: number; removed: number }> {
  let wrote = 0;
  let removed = 0;
  const keep = new Set(desired.map((d) => `${d.sourceTokenId}:${d.source.id}`));
  const existing = [...(actor.effects ?? [])].filter((e) => ourAura(e));
  for (const effect of existing) {
    const flag = ourAura(effect);
    if (!flag) continue;
    const key = `${flag.sourceToken}:${flag.sourceId}`;
    if (keep.has(key)) continue;
    try {
      await effect.delete();
      removed += 1;
    } catch (err) {
      warn(`aura: could not remove "${String(effect.name)}" from ${String(actor.name)}:`, err);
    }
  }
  for (const row of desired) {
    const key = `${row.sourceTokenId}:${row.source.id}`;
    const have = existing.find((e) => {
      const flag = ourAura(e);
      return flag && `${flag.sourceToken}:${flag.sourceId}` === key;
    });
    if (have) {
      if (sameChanges(have, row.changes) && !have.disabled) continue;
      try {
        await have.update({ disabled: false, changes: row.changes });
        wrote += 1;
      } catch (err) {
        warn(`aura: could not refresh "${row.source.name}" on ${String(actor.name)}:`, err);
      }
      continue;
    }
    try {
      await actor.createEmbeddedDocuments("ActiveEffect", [
        {
          name: row.source.name,
          img: row.source.img,
          origin: row.source.origin,
          transfer: false,
          disabled: false,
          changes: row.changes,
          flags: {
            [MODULE_ID]: {
              [FLAG]: { sourceToken: row.sourceTokenId, sourceId: row.source.id },
            },
          },
        },
      ]);
      wrote += 1;
    } catch (err) {
      warn(`aura: could not apply "${row.source.name}" to ${String(actor.name)}:`, err);
    }
  }
  return { wrote, removed };
}

async function stripActor(actor: any): Promise<number> {
  let n = 0;
  for (const effect of [...(actor?.effects ?? [])]) {
    if (!ourAura(effect)) continue;
    try {
      await effect.delete();
      n += 1;
    } catch (err) {
      warn(`aura: could not strip "${String(effect.name)}" from ${String(actor?.name)}:`, err);
    }
  }
  return n;
}

async function refreshAuras(): Promise<void> {
  if (!isPrimaryGM()) return;
  const wanted = desiredForScene();
  let wrote = 0;
  let removed = 0;
  const seen = new Set<string>();
  for (const token of tokensOnScene()) {
    const actor = token.actor;
    const id = String(actor?.uuid ?? actor?.id ?? "");
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const desired = collapseOverlappingAuras(wanted.get(id) ?? [], ownTransferredStrengths(actor));
    if (!desired.length) {
      removed += await stripActor(actor);
      continue;
    }
    const result = await applyDesired(actor, desired);
    wrote += result.wrote;
    removed += result.removed;
  }
  if (wrote || removed) {
    debug("aura", `refresh wrote ${wrote}, removed ${removed}`);
  }
}

let timer: ReturnType<typeof setTimeout> | null = null;
let running = false;
let again = false;

export function scheduleAuraRefresh(): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void runRefresh();
  }, SETTLE_MS);
}

async function runRefresh(): Promise<void> {
  if (running) {
    again = true;
    return;
  }
  running = true;
  try {
    await refreshAuras();
  } catch (err) {
    warn("aura: refresh failed:", err);
  } finally {
    running = false;
    if (again) {
      again = false;
      scheduleAuraRefresh();
    }
  }
}

function tokenMoved(changed: Record<string, unknown> | undefined): boolean {
  if (!changed) return true;
  // v13+ TokenDocument#move often diffs `movement` and not a top-level x/y. Opportunity
  // attacks already listen on `moveToken` for that reason; a walk that we never hear
  // leaves yesterday's copies on allies at any distance.
  return (
    "x" in changed ||
    "y" in changed ||
    "elevation" in changed ||
    "disposition" in changed ||
    "movement" in changed
  );
}

export function registerAuraWatch(): void {
  const schedule = () => scheduleAuraRefresh();
  Hooks.on("updateToken", (_doc, changed) => {
    if (tokenMoved(changed as Record<string, unknown>)) schedule();
  });
  Hooks.on("moveToken", schedule);
  Hooks.on("createToken", schedule);
  Hooks.on("deleteToken", schedule);
  Hooks.on("updateActor", (_actor, changed) => {
    const diff = (changed ?? {}) as Record<string, any>;
    if (diff.system?.attributes?.hp || diff.items) schedule();
  });
  Hooks.on("createItem", schedule);
  Hooks.on("deleteItem", schedule);
  Hooks.on("updateItem", schedule);
  Hooks.on("createActiveEffect", schedule);
  Hooks.on("deleteActiveEffect", schedule);
  Hooks.on("updateActiveEffect", schedule);
  Hooks.on("canvasReady", schedule);
  Hooks.on("updateSetting", (setting: any) => {
    const key = String(setting?.key ?? "");
    if (key === `${MODULE_ID}.${GENERAL_SETTINGS.auras}` || key.endsWith(`.${GENERAL_SETTINGS.auras}`)) {
      schedule();
    }
  });
  // Same catch-up as the capability collector: `ready` is after the page-load `canvasReady`.
  try {
    if ((globalThis as any).canvas?.ready) schedule();
  } catch {
    // no canvas yet
  }
}

export function surveyAuras(): unknown {
  const tokens = tokensOnScene();
  const lines: string[] = [];
  const owned = auraModuleOwns();
  lines.push(
    `auras: ${isAurasEnabled() ? "on" : "off"}` +
      (owned ? ` — standing aside for ${owned.by}` : "") +
      ` — ${tokens.length} token(s)`,
  );
  for (const token of tokens) {
    const actor = token.actor;
    const sources = auraSourcesOn(actor);
    const applied = [...(actor?.effects ?? [])].filter((e) => ourAura(e));
    if (!sources.length && !applied.length) continue;
    const data = rollDataOf(actor);
    const suppressed = sourceIsSuppressed(actor) ? " SUPPRESSED" : "";
    for (const source of sources) {
      const radius = resolveAuraRadius(source.radiusFormula, data, source.fallbackRadius, {
        actor,
        identifier: source.identifier,
      });
      const level = paladinClassLevel(data, actor);
      const reach = tokens
        .filter((other) => shouldReceive(token, other, source))
        .map((other) => {
          const feet = auraDistance(token, other);
          const inRange = feet <= radius + 1e-6;
          return `${String(other.document?.name ?? "?")} ${Math.round(feet)}ft ${inRange ? "IN" : "out"}`;
        });
      const active = spellAuraIsActive(actor, source) ? "on" : "waiting (spell not up)";
      const scale = level != null ? ` paladin ${level}` : "";
      lines.push(
        `  ${String(token.document?.name)} ${source.name} ${radius} ft` +
          ` (${source.radiusFormula}${scale}) ${source.audience}` +
          `${source.transferSelf ? " (self via transfer)" : ""} [${active}]${suppressed}` +
          (reach.length ? `\n    ${reach.join(" | ")}` : " → nobody"),
      );
    }
    for (const effect of applied) {
      const flag = ourAura(effect);
      const bonus = (effect.changes ?? []).map((c: any) => `${c.key}=${c.value}`).join("; ");
      lines.push(`    on ${String(actor.name)}: ${effect.name} from ${flag?.sourceToken} (${bonus})`);
    }
  }
  const block = lines.join("\n");
  log(block);
  return { text: block, tokens: tokens.length };
}
