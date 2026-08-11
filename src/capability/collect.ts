// Reading a scene's sheets, and asking for what is not already understood.
//
// This is the seam between the two halves of the compiler. It runs when a scene loads, walks every
// creature on it, reduces each written ability to a cache key, and hands the misses to `noodlr` in
// ONE batch. Everything it produces is then bound to the actor so `executor.ts` can run it without
// touching the network again.
//
// THE ECONOMICS ARE THE DESIGN. The corpus measured it: 4,661 features across 436 SRD creatures
// reduced to 1,387 distinct wordings, and one trait's text was shared by 270 creatures. Traits are
// templated (`[[lookup @name lowercase]]`) rather than naming their owner, so the same Pack Tactics
// is byte-identical everywhere. Dedup therefore happens twice here — within the scene before
// anything is sent, and against the cache — which is what turns a room of twenty goblins into one
// reading rather than twenty.
//
// STRUCTURED DATA IS SENT ALONGSIDE THE PROSE, AND OUTRANKS IT. This is the whole advantage of
// compiling from a live sheet over mining a book. Regeneration's amount mined out of the Monster
// Manual as the literal string `[[lookup @healing.formula activity=...]]` — the prose is an enricher
// pointing at data the miner could not follow. Here the activity is right there, resolved, so the
// compiler is handed 15 instead of having to parse a macro.
//
// WHO RUNS WHAT. Every client warms the cache and binds from it, because the action ledger consults
// compiled Multiattack on whichever client is enforcing the economy — usually a player's. Only the
// primary GM ever REQUESTS a compile or writes the cache: several clients hold `isGM`, and a batch
// billed once per assistant GM is the same class of bug as a troll summoning four limbs per GM.

import { MODULE_ID, debug, log, warn } from "../constants";
import { isPrimaryGM } from "../util/gm";
import { isCapabilityCompileEnabled } from "../settings";
import { pickNumber, pickString, systemPaths } from "../system/profiles";
import { validateCapability, type Capability } from "../integration/capability";
import { requestCompile, type CompileRequestItem } from "../integration/contract";
import * as cache from "./cache";
import { bindCapabilities, clearBindings, type Binding } from "./bindings";

/**
 * A scene of many creatures is still a bounded job, but a compendium browser left open on a folder
 * of two hundred monsters is not. This is the fuse: past it we compile what we can and log the rest,
 * rather than posting a bill nobody agreed to.
 */
const MAX_BATCH = 120;

/** Below this, a description is a flavour line rather than a rule. "It is a big rock." teaches nothing. */
const MIN_PROSE = 24;

/** Item types that can carry a rule. Everything else on a sheet is inventory. */
const RULE_BEARING = new Set(["feat", "spell", "weapon", "equipment", "consumable"]);

// ---- Reading a sheet ----------------------------------------------------------------------------

export interface Feature {
  /** The prose hash. Both the cache key and the id the compile answer comes back under. */
  id: string;
  label: string;
  prose: string;
  item: any;
  structured: Record<string, unknown>;
}

/**
 * Prose as a human reads it, with the block structure kept.
 *
 * Newlines matter more here than anywhere else in the module: a stat block's Multiattack and the
 * attacks it refers to are separate paragraphs, and collapsing them into one line is how "makes three
 * attacks" ends up attached to the wrong one.
 */
export function plainText(html: unknown): string {
  return String(html ?? "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&(?:quot|#34);/gi, '"')
    .replace(/&(?:apos|#39);/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Every string a rule could be hiding in, on the item and on each of its activities. */
function proseOf(item: any): string {
  const parts: unknown[] = [
    item?.system?.description?.value,
    // Not `description.chatFlavor`, which exists nowhere: the item carries `description.chat` and the
    // ACTIVITY carries `description.chatFlavor`. Reading the wrong one is why the corpus's S5 signal
    // could never fire, and a chat flavour is where the content team writes down the rule the schema
    // could not hold ("On Hit: Target pushed 15 feet away.").
    item?.system?.description?.chat,
  ];
  for (const activity of activitiesOf(item)) {
    parts.push(activity?.description?.chatFlavor);
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of parts) {
    const text = plainText(part);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out.join("\n\n");
}

function activitiesOf(item: any): any[] {
  const collection: any = item?.system?.activities;
  if (!collection) return [];
  return collection.contents ?? (Array.isArray(collection) ? collection : []);
}

/**
 * The numbers, resolved.
 *
 * Everything here is read defensively and omitted when absent, because the shapes drift between dnd5e
 * versions and a half-read activity is still worth sending — the prose is the other half. What must
 * never happen is a throw: a sheet this cannot parse has to degrade to prose-only, not to no compile.
 */
function structuredOf(item: any): Record<string, unknown> {
  const P = systemPaths();
  const out: Record<string, unknown> = { type: String(item?.type ?? "") };

  const identifier = pickString(item, ["system.identifier"]);
  if (identifier) out.identifier = identifier;

  const usesMax = pickNumber(item, P.itemUsesMax);
  if (usesMax !== null && usesMax > 0) {
    out.uses = {
      max: usesMax,
      spent: pickNumber(item, P.itemUsesSpent) ?? undefined,
      recovery: recoveryOf(item?.system?.uses),
    };
  }
  const recharge = pickString(item, P.itemRechargeValue);
  if (recharge) out.recharge = recharge;

  if (item?.type === "spell") {
    const level = pickNumber(item, P.itemSpellLevel);
    if (level !== null) out.spellLevel = level;
    const method = String(item?.system?.method ?? "");
    if (method) out.castingMethod = method;
  }

  const activities = activitiesOf(item).map(activitySummary).filter(Boolean);
  if (activities.length) out.activities = activities;
  return out;
}

function recoveryOf(uses: any): unknown {
  const list = uses?.recovery;
  if (!Array.isArray(list) || list.length === 0) return undefined;
  return list.map((row: any) => ({
    period: String(row?.period ?? ""),
    type: String(row?.type ?? ""),
    formula: row?.formula === undefined ? undefined : String(row.formula),
  }));
}

function activitySummary(activity: any): Record<string, unknown> | null {
  try {
    const summary: Record<string, unknown> = {
      type: String(activity?.type ?? ""),
      activation: String(activity?.activation?.type ?? ""),
    };
    const value = Number(activity?.activation?.value);
    if (Number.isFinite(value) && value > 1) summary.activationCost = value;

    if (activity?.range?.units) {
      summary.range = { value: activity.range.value ?? null, units: String(activity.range.units) };
    }
    if (activity?.target?.affects?.type) {
      summary.target = {
        type: String(activity.target.affects.type),
        count: activity.target.affects.count ?? null,
      };
    }
    if (activity?.save?.ability) {
      summary.save = {
        ability: abilityList(activity.save.ability),
        dc: activity.save?.dc?.value ?? null,
      };
    }

    const damage = damageParts(activity?.damage?.parts);
    if (damage.length) summary.damage = damage;

    // The Regeneration case, and the reason this whole function exists. `healing` is a single part
    // rather than a list, and its resolved `formula` getter is the number the prose refuses to state.
    const healing = activity?.healing;
    if (healing) {
      const formula = String(healing.formula ?? "").trim();
      summary.healing = {
        formula: formula || undefined,
        number: healing.number ?? undefined,
        denomination: healing.denomination ?? undefined,
        bonus: healing.bonus ?? undefined,
        types: setToArray(healing.types),
      };
    }

    const uses = Number(activity?.uses?.max);
    if (Number.isFinite(uses) && uses > 0) {
      summary.uses = { max: uses, spent: Number(activity?.uses?.spent ?? 0) };
    }
    return summary;
  } catch (err) {
    debug("could not summarise an activity", err);
    return null;
  }
}

function damageParts(parts: unknown): Record<string, unknown>[] {
  if (!Array.isArray(parts)) return [];
  return parts
    .map((part: any) => {
      try {
        return {
          formula: String(part?.formula ?? "").trim() || undefined,
          number: part?.number ?? undefined,
          denomination: part?.denomination ?? undefined,
          bonus: part?.bonus ?? undefined,
          types: setToArray(part?.types),
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean) as Record<string, unknown>[];
}

/** dnd5e stores several of these as real `Set`s, which JSON serialises as `{}`. */
function setToArray(value: unknown): string[] | undefined {
  if (!value) return undefined;
  if (Array.isArray(value)) return value.map(String);
  if (typeof (value as any).values === "function") return [...(value as any)].map(String);
  return undefined;
}

function abilityList(value: unknown): string[] {
  return setToArray(value) ?? [String(value)];
}

/** Whose sheet this is, so the compiler can resolve "the creature" and "its Speed". */
function contextOf(actor: any): Record<string, unknown> {
  const P = systemPaths();
  const context: Record<string, unknown> = { name: String(actor?.name ?? "") };
  const type = pickString(actor, P.creatureType);
  if (type) context.creatureType = type;
  const cr = pickNumber(actor, P.challenge);
  if (cr !== null) context.challengeRating = cr;
  const size = String(actor?.system?.traits?.size ?? "");
  if (size) context.size = size;
  const hp = pickNumber(actor, P.hpMax);
  if (hp !== null) context.hitPointsMax = hp;
  const speed = pickNumber(actor, P.speed);
  if (speed !== null) context.speed = speed;
  return context;
}

/** Every written ability on one creature that is worth compiling. */
export function featuresOf(actor: any): Feature[] {
  const out: Feature[] = [];
  for (const item of actor?.items ?? []) {
    // The system's own clone of a spell, made to service a feat's "cast" activity. Reading it as well
    // as the feat compiles the same ability twice with the wrong resource attached to one of them.
    if (item?.flags?.dnd5e?.cachedFor) continue;
    if (!RULE_BEARING.has(String(item?.type ?? ""))) continue;

    const prose = proseOf(item);
    if (prose.length < MIN_PROSE) continue;

    out.push({
      id: cache.proseHash(prose),
      label: String(item?.name ?? "?").trim() || "?",
      prose,
      item,
      structured: structuredOf(item),
    });
  }
  return out;
}

// ---- Running a scene ----------------------------------------------------------------------------

export interface CollectReport {
  actors: number;
  features: number;
  /** Distinct wordings, after the within-scene dedup. The number that would ever cost anything. */
  distinct: number;
  hits: number;
  requested: number;
  compiled: number;
  rejected: number;
  /** True when nothing was listening — the ordinary state with no companion module installed. */
  noCompiler: boolean;
}

let running: Promise<CollectReport> | null = null;

/**
 * Read the scene, bind what is understood, and ask about the rest.
 *
 * Serialised through `running`, because `canvasReady` and a burst of `createToken` hooks arrive
 * together and two overlapping passes would send the same batch twice.
 */
export async function collectScene(scene?: any): Promise<CollectReport> {
  if (running) return running;
  running = collectSceneOnce(scene).finally(() => {
    running = null;
  });
  return running;
}

async function collectSceneOnce(scene?: any): Promise<CollectReport> {
  const report: CollectReport = {
    actors: 0,
    features: 0,
    distinct: 0,
    hits: 0,
    requested: 0,
    compiled: 0,
    rejected: 0,
    noCompiler: false,
  };

  await cache.warm();

  const actors = actorsOn(scene);
  report.actors = actors.length;
  if (actors.length === 0) return report;

  // Pass one: read every sheet, and note which wordings nobody has compiled yet.
  const perActor = new Map<any, Feature[]>();
  const misses = new Map<string, Feature>();
  for (const actor of actors) {
    const features = featuresOf(actor);
    perActor.set(actor, features);
    report.features += features.length;
    for (const feature of features) {
      if (cache.has(feature.id)) report.hits++;
      else if (!misses.has(feature.id)) misses.set(feature.id, feature);
    }
  }
  report.distinct = report.hits + misses.size;

  // Pass two: buy the misses, once, in one batch. Only the primary GM, and only if asked to.
  if (misses.size > 0 && isPrimaryGM() && isCapabilityCompileEnabled()) {
    const wanted = [...misses.values()];
    if (wanted.length > MAX_BATCH) {
      warn(
        `${wanted.length} uncompiled abilities on this scene; asking about the first ${MAX_BATCH}. ` +
          `Run api.compileScene() again for the rest.`,
      );
    }
    const batch = wanted.slice(0, MAX_BATCH);
    report.requested = batch.length;
    const answers = await ask(batch, actorOf(batch, perActor));
    report.noCompiler = answers === null;
    if (answers) {
      const accepted = absorb(answers, misses);
      report.compiled = accepted.compiled;
      report.rejected = accepted.rejected;
      if (accepted.compiled) await cache.flush();
    }
  }

  // Pass three: bind whatever the cache now holds. Runs whether or not anything was compiled, which
  // is what makes an offline client with a warm cache behave identically to the GM's.
  for (const [actor, features] of perActor) {
    const bindings: Binding[] = [];
    for (const feature of features) {
      const capability = cache.get(feature.id);
      if (capability) bindings.push({ capability, item: feature.item });
    }
    bindCapabilities(String(actor?.uuid ?? ""), bindings);
  }

  log(
    `capabilities: ${report.features} abilities on ${report.actors} creatures, ` +
      `${report.distinct} distinct, ${report.hits} already known` +
      (report.requested ? `, ${report.compiled}/${report.requested} newly compiled` : ""),
  );
  if (report.compiled) {
    ui.notifications?.info?.(
      game.i18n?.format?.("NOODLRHOOKS.Capabilities.Compiled", { count: report.compiled }) ??
        `Read ${report.compiled} new abilities off this scene.`,
    );
  }
  return report;
}

/** One representative owner per feature, for the "whose sheet is this" context. */
function actorOf(batch: Feature[], perActor: Map<any, Feature[]>): Map<string, any> {
  const owners = new Map<string, any>();
  const wanted = new Set(batch.map((f) => f.id));
  for (const [actor, features] of perActor) {
    for (const feature of features) {
      if (wanted.has(feature.id) && !owners.has(feature.id)) owners.set(feature.id, actor);
    }
  }
  return owners;
}

/**
 * Hand the batch over. Null means nobody was listening, which is a normal answer and not an error:
 * this module is not allowed to depend on the other one existing.
 */
async function ask(
  batch: Feature[],
  owners: Map<string, any>,
): Promise<Record<string, unknown> | null> {
  const items: CompileRequestItem[] = batch.map((feature) => ({
    id: feature.id,
    label: feature.label,
    prose: feature.prose,
    structured: feature.structured,
    context: contextOf(owners.get(feature.id)),
  }));
  log(`asking the companion module to compile ${items.length} ability wording(s)…`);
  const answers = await requestCompile(items);
  if (!answers || Object.keys(answers).length === 0) {
    log("nothing answered the compile request; the scene runs on structured data alone.");
    return null;
  }
  return answers;
}

/**
 * Validate and store. **Nothing that came back is trusted**: the listener is a language model at one
 * remove, so a descriptor reaches the cache only after it validates against the closed vocabulary,
 * and only under the id we asked about — a compile that renames itself would poison a key it was
 * never given.
 */
function absorb(
  answers: Record<string, unknown>,
  asked: Map<string, Feature>,
): { compiled: number; rejected: number } {
  let compiled = 0;
  let rejected = 0;
  for (const [id, raw] of Object.entries(answers)) {
    const feature = asked.get(id);
    if (!feature) {
      warn(`the compiler answered about "${id}", which was never asked about; ignored.`);
      rejected++;
      continue;
    }
    const candidate = {
      ...(raw as Capability),
      id,
      label: (raw as Capability)?.label || feature.label,
      // Kept locally so the capability sheet can show what a rule was read from, and stripped again on
      // export. The compiler has no business deciding this field.
      prose: feature.prose,
      status: "compiled" as const,
    };
    const check = validateCapability(candidate);
    if (!check.ok) {
      warn(`rejected a compiled "${feature.label}":`, check.errors);
      rejected++;
      continue;
    }
    if (cache.put(candidate)) compiled++;
    else debug(`kept the existing "${feature.label}" — a human has the last word on it`);
  }
  return { compiled, rejected };
}

// ---- One creature, on demand ---------------------------------------------------------------------

export interface RecompileReport {
  requested: number;
  compiled: number;
  rejected: number;
  /** Locked capabilities, which a recompile is never allowed to overwrite. */
  skipped: number;
  noCompiler: boolean;
  disabled: boolean;
}

/**
 * Read one creature again, for the capability sheet's Compile and Recompile buttons.
 *
 * Two things make this more than a one-actor `collectScene`. It is allowed to replace an entry the
 * cache would otherwise defend — a `rejected` compile is exactly what a GM presses Recompile to have
 * another go at — and it must never touch a `locked` one, which is the whole point of the lock.
 *
 * ORDER MATTERS: the old entry is removed only after a replacement has arrived and validated. The
 * obvious sequence (clear, then ask) loses a working descriptor to a provider outage.
 */
export async function recompileFeatures(actor: any, ids?: string[]): Promise<RecompileReport> {
  const report: RecompileReport = {
    requested: 0,
    compiled: 0,
    rejected: 0,
    skipped: 0,
    noCompiler: false,
    disabled: false,
  };
  if (!isPrimaryGM() || !isCapabilityCompileEnabled()) {
    report.disabled = true;
    return report;
  }

  await cache.warm();
  const wanted = ids ? new Set(ids) : null;
  const batch: Feature[] = [];
  const asked = new Map<string, Feature>();
  for (const feature of featuresOf(actor)) {
    if (wanted && !wanted.has(feature.id)) continue;
    if (asked.has(feature.id)) continue;
    if (cache.get(feature.id)?.status === "locked") {
      report.skipped++;
      continue;
    }
    asked.set(feature.id, feature);
    batch.push(feature);
  }
  if (batch.length === 0) return report;

  report.requested = batch.length;
  const owners = new Map<string, any>(batch.map((f) => [f.id, actor]));
  const answers = await ask(batch.slice(0, MAX_BATCH), owners);
  if (!answers) {
    report.noCompiler = true;
    return report;
  }

  // Now that a replacement exists, stand the old one down so `put` is not refused.
  for (const id of Object.keys(answers)) {
    if (cache.get(id)?.status !== "locked") cache.remove(id);
  }
  const accepted = absorb(answers, asked);
  report.compiled = accepted.compiled;
  report.rejected = accepted.rejected;
  if (accepted.compiled) await cache.flush();
  rebindActor(actor);
  return report;
}

/** Recompute one creature's bindings from whatever the cache now holds. */
export function rebindActor(actor: any): void {
  const bindings: Binding[] = [];
  for (const feature of featuresOf(actor)) {
    const capability = cache.get(feature.id);
    if (capability) bindings.push({ capability, item: feature.item });
  }
  bindCapabilities(String(actor?.uuid ?? ""), bindings);
}

/** Every distinct actor with a token on the scene. Unlinked tokens carry their own sheet, so the
 *  token's actor is the right one to read, and two copies of one goblin are one actor twice over. */
function actorsOn(scene?: any): any[] {
  const seen = new Map<string, any>();
  const documents: any[] =
    scene?.tokens?.contents ??
    (canvas as any)?.scene?.tokens?.contents ??
    (canvas as any)?.tokens?.placeables?.map((t: any) => t.document) ??
    [];
  for (const doc of documents) {
    const actor = doc?.actor;
    const uuid = String(actor?.uuid ?? "");
    if (actor && uuid && !seen.has(uuid)) seen.set(uuid, actor);
  }
  return [...seen.values()];
}

// ---- Wiring -------------------------------------------------------------------------------------

let registered = false;
let pending: ReturnType<typeof setTimeout> | null = null;

/** A scene load is a burst of hooks, not one. Settle before reading anything. */
function schedule(scene?: any, delay = 750): void {
  if (pending) clearTimeout(pending);
  pending = setTimeout(() => {
    pending = null;
    void collectScene(scene).catch((err) => warn("capability collection failed:", err));
  }, delay);
}

export function registerCapabilityCollector(): void {
  if (registered) return;
  registered = true;

  Hooks.on("canvasReady", (canvasRef: any) => {
    // Bindings are per-actor and the last scene's actors are not on this one. Clearing first means a
    // creature that failed to read cannot keep running the previous scene's rules.
    clearBindings();
    schedule(canvasRef?.scene);
  });

  // A creature dragged in mid-session gets the same treatment. Debounced, because dropping a
  // pack of six wolves is six hooks in a second and they should cost one batch.
  Hooks.on("createToken", (doc: any) => {
    if (doc?.parent?.id !== (canvas as any)?.scene?.id) return;
    schedule(doc.parent, 1500);
  });

  log("capability collector registered");
}

/** Diagnostics: what this scene would ask about, without asking. */
export function surveyScene(): Record<string, unknown> {
  const actors = actorsOn();
  const distinct = new Map<string, { label: string; cached: boolean; creatures: number }>();
  let features = 0;
  for (const actor of actors) {
    for (const feature of featuresOf(actor)) {
      features++;
      const row = distinct.get(feature.id);
      if (row) row.creatures++;
      else
        distinct.set(feature.id, {
          label: feature.label,
          cached: cache.has(feature.id),
          creatures: 1,
        });
    }
  }
  const rows = [...distinct.entries()].map(([id, row]) => ({ id, ...row }));
  const report = {
    module: MODULE_ID,
    actors: actors.length,
    features,
    distinct: rows.length,
    cached: rows.filter((r) => r.cached).length,
    wouldAsk: rows.filter((r) => !r.cached).length,
    compileEnabled: isCapabilityCompileEnabled(),
    rows,
  };
  log("scene capabilities:", report);
  return report;
}
