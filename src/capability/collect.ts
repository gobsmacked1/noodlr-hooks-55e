// Reading a scene's sheets, and asking for what is not already understood.
//
// This is the seam between the two halves of the compiler. It runs when a scene loads, walks every
// creature on it, reduces each written ability to a cache key, and hands every miss to `noodlr`
// in chunks of `MAX_BATCH`. Everything it produces is then bound to the actor so `executor.ts`
// can run it without touching the network again. A failed chunk leaves earlier ones stored;
// the scene itself is not capped.
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
import { generalRuleOf } from "../system/dnd5e-glossary";
import { validateCapability, type Capability } from "../integration/capability";
import { requestCompile, type CompileRequestItem } from "../integration/contract";
import * as cache from "./cache";
import { plainText, scrubMeta } from "./prose";
import { readableActors } from "./sheets";
import { bindCapabilities, clearBindings, type Binding } from "./bindings";

/**
 * How many wordings ride on one `noodlrHooks.compile` request — a save-point, not a scene ceiling.
 *
 * Stopping after the first chunk is what left a party of thirteen level-20 characters at 120 of 992
 * distinct wordings (noodlr-test, 2026-08-20). Keep the chunk small so a failed request leaves
 * earlier ones stored. The scene itself is capped at `ASK_CAP`.
 */
const MAX_BATCH = 120;

/**
 * Runaway brake on how many distinct unread wordings one pass will buy.
 *
 * Thirteen level-20 PCs on one scene measured 992 distinct (noodlr-test, 2026-08-20) — the high
 * side of a real table, not a ceiling. A future world can squeeze far more onto a map, so this is
 * set well above any honest scene and still finite: past it we compile the first 32,768 and tell
 * the GM, rather than posting an unbounded bill.
 */
export const ASK_CAP = 32_768;

let askCap = ASK_CAP;

/** Test-only. `null` restores the shipped ceiling. */
export function __setAskCap(n: number | null): void {
  askCap = n == null ? ASK_CAP : Math.max(0, Math.floor(n));
}

export function applyAskCap<T>(items: readonly T[]): { kept: T[]; remaining: number } {
  if (items.length <= askCap) return { kept: items.slice(), remaining: 0 };
  return { kept: items.slice(0, askCap), remaining: items.length - askCap };
}

function chunksOf<T>(items: readonly T[]): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += MAX_BATCH) chunks.push(items.slice(i, i + MAX_BATCH));
  return chunks;
}

function announceAskCap(place: "scene" | "world", total: number, remaining: number): void {
  const cap = askCap;
  warn(
    `${total} unread ability wordings on this ${place} exceeds the ${cap} ceiling; ` +
      `asking about the first ${cap}. ${remaining} skipped.`,
  );
  const text =
    game.i18n?.format?.("NOODLRHOOKS.Capabilities.AskCap", { place, total, cap, remaining }) ??
    `${total} unread abilities on this ${place} is over the ${cap} limit. ` +
      `The first ${cap} will be read now; ${remaining} were skipped. ` +
      `Remove some tokens and load again for the rest.`;
  ui.notifications?.error?.(text);
}

function takeAskable(
  items: Feature[],
  place: "scene" | "world",
): { kept: Feature[]; remaining: number } {
  const { kept, remaining } = applyAskCap(items);
  if (remaining) announceAskCap(place, items.length, remaining);
  return { kept, remaining };
}

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
  /**
   * Instructions to a human that were taken out of the prose before it was hashed.
   *
   * Carried rather than discarded because a silent strip is the same failure as a silent
   * stand-aside: prose talking about Foundry in the OPEN means an importer or a homebrew author
   * wrote tooling into the rule text, and the GM is the only person who can decide whether the
   * sentence mattered. Empty for every sheet dnd5e ships (measured — see `prose.ts`), so this is
   * quiet until it is interesting.
   */
  removed: string[];
}

/** An ability that was deliberately not read, and why. Reported rather than silently absent. */
export interface Declined {
  label: string;
  why: string;
  /**
   * The prose hash this item WOULD have had.
   *
   * Present so `hygiene.ts` can tell a cached descriptor that can never bind again from one whose
   * creature merely is not on this scene — the two look identical from the cache and want opposite
   * treatment. Computed only on the report path, because it costs a `proseOf` on an item the hot path
   * has already decided to skip.
   */
  id?: string;
}

/**
 * Every string a rule could be hiding in, on the item and on each of its activities — with anything
 * addressed to the reader rather than to the game taken out of it.
 *
 * The scrubbing is `prose.ts`'s and the reasoning lives there. What matters at THIS call site is the
 * ordering: it happens before `cache.proseHash`, so a note is gone before the wording is keyed, and
 * editing one correctly invalidates the entry rather than leaving a poisoned descriptor cached
 * against text that no longer exists.
 */
function proseOf(item: any): { prose: string; removed: string[] } {
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
  const removed: string[] = [];
  for (const part of parts) {
    const scrubbed = scrubMeta(plainText(part));
    for (const note of scrubbed.removed) if (!removed.includes(note)) removed.push(note);
    const text = scrubbed.prose;
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return { prose: out.join("\n\n"), removed };
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

/**
 * Every written ability on one creature that is worth compiling.
 *
 * `declined` is an optional out-parameter rather than a second return value because every caller but
 * the report wants only the features, and the alternative was three call sites destructuring a tuple
 * to throw half of it away.
 */
export function featuresOf(actor: any, declined?: Declined[]): Feature[] {
  const out: Feature[] = [];
  for (const item of actor?.items ?? []) {
    // The system's own clone of a spell, made to service a feat's "cast" activity. Reading it as well
    // as the feat compiles the same ability twice with the wrong resource attached to one of them.
    if (item?.flags?.dnd5e?.cachedFor) continue;
    if (!RULE_BEARING.has(String(item?.type ?? ""))) continue;

    // A general rule is not this creature's ability, and compiling one is either a duplicate of code
    // we shipped or a re-litigation of a refusal. See `dnd5e-glossary.ts` for the whole argument.
    const general = generalRuleOf(item);
    if (general) {
      if (declined) {
        const text = proseOf(item).prose;
        declined.push({
          label: String(item?.name ?? "?").trim() || "?",
          why: general,
          id: text.length >= MIN_PROSE ? cache.proseHash(text) : undefined,
        });
      }
      continue;
    }

    const { prose, removed } = proseOf(item);
    if (prose.length < MIN_PROSE) continue;

    out.push({
      id: cache.proseHash(prose),
      label: String(item?.name ?? "?").trim() || "?",
      prose,
      item,
      structured: structuredOf(item),
      removed,
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
  /**
   * Distinct wordings the cache already answers — NOT how many features hit it.
   *
   * Counted through a Set because the whole economy of this layer is that 270 creatures share one
   * wording, so a per-occurrence tally reports twenty goblins as twenty and makes `distinct` twenty
   * as well. That read as a cache covering 35% of a scene when it covered 100% of it, and the number
   * is quoted straight into a log line.
   */
  hits: number;
  requested: number;
  compiled: number;
  rejected: number;
  /** Unread wordings past `ASK_CAP`, or left unasked because nobody answered a chunk. */
  remaining: number;
  /** True when nothing was listening — the ordinary state with no companion module installed. */
  noCompiler: boolean;
  /** Tooling instructions found in open rule text, as `label` → the sentences taken out. */
  scrubbed: Record<string, string[]>;
  /** General rules that ship as items and were deliberately not read, as `label` → why. */
  declined: Record<string, string>;
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
    remaining: 0,
    noCompiler: false,
    scrubbed: {},
    declined: {},
  };

  await cache.warm();

  const actors = actorsOn(scene);
  report.actors = actors.length;
  if (actors.length === 0) return report;

  // Pass one: read every sheet, and note which wordings nobody has compiled yet.
  const perActor = new Map<any, Feature[]>();
  const misses = new Map<string, Feature>();
  const known = new Set<string>();
  const declined: Declined[] = [];
  for (const actor of actors) {
    const features = featuresOf(actor, declined);
    perActor.set(actor, features);
    report.features += features.length;
    for (const feature of features) {
      if (feature.removed.length) report.scrubbed[feature.label] = feature.removed;
      if (cache.has(feature.id)) known.add(feature.id);
      else if (!misses.has(feature.id)) misses.set(feature.id, feature);
    }
  }
  report.hits = known.size;
  report.distinct = known.size + misses.size;
  for (const row of declined) report.declined[row.label] = row.why;

  // Debug rather than a warning, and the severity is the decision: on a 2024 character sheet this is
  // a dozen entries EVERY scene load, and a toast a GM sees every time teaches them to ignore the
  // channel. Same doctrine as the hidden-note strip, which is silent for the same reason. What makes
  // it safe to be quiet is that `api.surveyScene()` reports the same list on demand.
  if (declined.length) {
    debug(
      `did not compile ${declined.length} general rule(s) that ship as items on these sheets`,
      report.declined,
    );
  }

  // Said once, to GMs, naming the ability rather than quoting the note — the sentences are on the
  // report and in the log for whoever wants them. A strip is not an error and must not read as one:
  // the rule still compiled, and what the GM needs to know is that a sentence of it was addressed to
  // them rather than to the game.
  const scrubbed = Object.keys(report.scrubbed);
  if (scrubbed.length) {
    warn(
      `stripped instructions meant for a person out of ${scrubbed.length} ability description(s) ` +
        `before compiling: ${scrubbed.join(", ")}`,
      report.scrubbed,
    );
  }

  // Pass two: buy the misses. Only the primary GM, and only if asked to. Chunked at MAX_BATCH so a
  // failed request leaves earlier chunks stored. Capped at ASK_CAP so a packed map cannot post an
  // unbounded bill; the overflow is a toast, not a silent drop.
  if (misses.size > 0 && isPrimaryGM() && isCapabilityCompileEnabled()) {
    const wanted = [...misses.values()];
    const { kept, remaining } = takeAskable(wanted, "scene");
    report.remaining = remaining;
    const chunks = chunksOf(kept);
    if (chunks.length > 1) {
      log(
        `${kept.length} uncompiled abilities on this scene; asking in ${chunks.length} ` +
          `request(s) of up to ${MAX_BATCH}.`,
      );
    }
    for (const [index, chunk] of chunks.entries()) {
      const answers = await ask(chunk, actorOf(chunk, perActor));
      report.noCompiler = answers === null;
      if (!answers) {
        report.remaining += kept.length - report.requested;
        break;
      }
      report.requested += chunk.length;
      const accepted = absorb(answers, misses);
      report.compiled += accepted.compiled;
      report.rejected += accepted.rejected;
      if (accepted.compiled) await cache.flush();
      if (chunks.length > 1) {
        log(
          `collectScene: request ${index + 1}/${chunks.length} — ` +
            `${accepted.compiled} compiled, ${accepted.rejected} rejected.`,
        );
      }
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
    // Reported, never fatal — see `validateCapability`. An unrecognised key here is how the next
    // silently-unread field gets noticed on the day it appears; `conditions` went two releases without.
    if (check.warnings.length) debug(`compiled "${feature.label}" needed repair:`, check.warnings);
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
  /** Unread wordings past `ASK_CAP`. */
  remaining: number;
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
    remaining: 0,
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

  const { kept, remaining } = takeAskable(batch, "scene");
  report.remaining = remaining;
  const owners = new Map<string, any>(kept.map((f) => [f.id, actor]));
  for (const chunk of chunksOf(kept)) {
    const answers = await ask(chunk, owners);
    if (!answers) {
      report.noCompiler = true;
      break;
    }
    report.requested += chunk.length;
    // Now that a replacement exists, stand the old one down so `put` is not refused.
    for (const id of Object.keys(answers)) {
      if (cache.get(id)?.status !== "locked") cache.remove(id);
    }
    const accepted = absorb(answers, asked);
    report.compiled += accepted.compiled;
    report.rejected += accepted.rejected;
    if (accepted.compiled) await cache.flush();
  }
  rebindActor(actor);
  return report;
}

// ---- The whole world, on demand ------------------------------------------------------------------

export interface WorldRecompileReport {
  actors: number;
  /** Distinct wordings found across every readable sheet. The bill, before locks are taken out. */
  distinct: number;
  /** Left alone because a human has the last word on them. */
  locked: number;
  /** Skipped by `since` — already re-read, so already paid for. */
  fresh: number;
  requested: number;
  compiled: number;
  rejected: number;
  /** Unread wordings past `ASK_CAP`, or left unasked because nobody answered a chunk. */
  remaining: number;
  noCompiler: boolean;
  disabled: boolean;
}

export interface WorldRecompileOptions {
  /**
   * Skip any wording the cache already answered at or after this time (epoch ms).
   *
   * THIS IS HOW A PARTIAL RECOMPILE IS FINISHED, and it exists because one is not a hypothetical: on
   * 2026-08-16 a run of 1,022 lost its last 62 to provider refusals, and the only tool for the
   * remainder was to buy all 1,022 again. Pass the time the run STARTED and what is left is exactly
   * what it failed to answer.
   *
   * A wording with no cached entry, or one holding no `compiledBy.at`, always asks — which is the
   * half that matters, because a FIRST-time compile that failed left nothing behind to be stale. So
   * this is idempotent: run it repeatedly and it converges on the gap, spending nothing on what has
   * already landed.
   *
   * It can only ever SHRINK the batch, so it cannot cost more than a bare `recompileWorld()`.
   *
   *     noodlrHooks.recompileWorld({ since: Date.now() - 6 * 3600_000 })
   */
  since?: number;
}

/**
 * Ask about every wording in the world again, whatever the cache holds.
 *
 * THE REASON THIS HAS TO EXIST AT ALL, and it is not obvious: the cache key is the PROSE, so
 * improving the doctrine or the vocabulary changes nothing a GM can observe. Every sheet still hashes
 * to the same key, `collectScene` still reports a hit, and the descriptors go on being the ones the
 * old prompt produced. There was no route to a better answer for text that had already been read
 * once — `compileScene()` is cache-first by construction and the capability sheet's Recompile button
 * is one creature at a time.
 *
 * **This spends real credit, once per distinct wording, and is never called by a hook.** It is a
 * deliberate act after a compiler change, which is why it reports the bill in the log before sending
 * anything and why `MAX_BATCH` still bounds each request rather than being lifted for this caller.
 *
 * Two rules inherited from `recompileFeatures`, both load-bearing:
 *   * ORDER — an old descriptor is stood down only after a replacement has arrived AND validated.
 *     Clear-then-ask loses a working cache to a provider outage.
 *   * `locked` is never touched. A GM who has fixed a bad compile does not lose that to a model
 *     upgrade. `rejected` IS re-asked, because another go is exactly what a recompile is for.
 */
export async function recompileWorld(
  options: WorldRecompileOptions = {},
): Promise<WorldRecompileReport> {
  const report: WorldRecompileReport = {
    actors: 0,
    distinct: 0,
    locked: 0,
    fresh: 0,
    requested: 0,
    compiled: 0,
    rejected: 0,
    remaining: 0,
    noCompiler: false,
    disabled: false,
  };
  const since = Number(options.since) || 0;
  if (!isPrimaryGM() || !isCapabilityCompileEnabled()) {
    report.disabled = true;
    warn(
      "recompileWorld needs the primary GM and the capability compiler switched on; nothing was sent.",
    );
    return report;
  }

  await cache.warm();

  // Dedup across every sheet first, for the same reason `collectScene` does: a world with twenty
  // goblins holds one Pack Tactics, and asking per creature would multiply the bill by the bestiary.
  const actors = readableActors();
  report.actors = actors.length;
  const wordings = new Map<string, Feature>();
  const owners = new Map<string, any>();
  for (const actor of actors) {
    for (const feature of featuresOf(actor)) {
      if (wordings.has(feature.id)) continue;
      wordings.set(feature.id, feature);
      owners.set(feature.id, actor);
    }
  }
  report.distinct = wordings.size;

  const batch: Feature[] = [];
  for (const feature of wordings.values()) {
    const held = cache.get(feature.id);
    if (held?.status === "locked") {
      report.locked++;
      continue;
    }
    // Absent, or answered before the cutoff, means unanswered as far as this run is concerned. A
    // missing `compiledBy.at` reads as 0 deliberately: an entry that cannot say when it was written
    // cannot claim to be fresh.
    if (since && Number(held?.compiledBy?.at ?? 0) >= since) {
      report.fresh++;
      continue;
    }
    batch.push(feature);
  }
  if (batch.length === 0) {
    log(
      `recompileWorld: nothing to ask about (${report.locked} locked, ${report.fresh} already re-read).`,
    );
    return report;
  }

  const { kept, remaining } = takeAskable(batch, "world");
  report.remaining = remaining;

  // Chunked rather than sent whole: a single request carrying every wording in a large world is one
  // failure away from having bought nothing, whereas a chunk that fails leaves the earlier ones stored.
  const chunks = chunksOf(kept);
  log(
    `recompileWorld: ${report.distinct} distinct wording(s) on ${report.actors} sheet(s), ` +
      `${report.locked} locked` +
      (since ? `, ${report.fresh} already re-read since ${new Date(since).toISOString()}` : "") +
      `, asking about ${kept.length} in ${chunks.length} request(s). ` +
      `This spends one compile per wording.`,
  );

  for (const [index, chunk] of chunks.entries()) {
    const asked = new Map(chunk.map((f) => [f.id, f]));
    const answers = await ask(chunk, owners);
    if (!answers) {
      // Nobody is listening. Every later chunk would answer the same way, so stop rather than
      // logging the same nothing a dozen times.
      report.noCompiler = true;
      report.remaining += kept.length - report.requested;
      break;
    }
    report.requested += chunk.length;
    for (const id of Object.keys(answers)) {
      if (cache.get(id)?.status !== "locked") cache.remove(id);
    }
    const accepted = absorb(answers, asked);
    report.compiled += accepted.compiled;
    report.rejected += accepted.rejected;
    if (accepted.compiled) await cache.flush();
    log(
      `recompileWorld: request ${index + 1}/${chunks.length} — ` +
        `${accepted.compiled} compiled, ${accepted.rejected} rejected.`,
    );
  }

  // Whatever is on the canvas now should be running the new descriptors without a scene reload.
  for (const actor of actorsOn()) rebindActor(actor);

  log("recompileWorld:", report);
  ui.notifications?.info?.(
    `Recompiled ${report.compiled} of ${report.requested} ability wording(s).` +
      (report.rejected ? ` ${report.rejected} were rejected — see the capability sheet.` : ""),
  );
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

  // THE CANVAS IS ALREADY DRAWN BY THE TIME WE GET HERE, so the hook above has missed the only
  // `canvasReady` of this page load and would not fire again until the GM changed scene or dropped a
  // token. Core awaits `initializeCanvas()` at `game.mjs:784` and calls `ready` at `:787`; this module
  // registers from `ready`, so on every fresh load the listener is one moment too late.
  //
  // Without this, NOTHING COMPILED IS BOUND: no `cache.warm()`, no bindings, so every descriptor is
  // inert and the action ledger cannot see a compiled Multiattack. It is silent, it reads exactly like
  // the compiler having been paid for nothing, and it survived because the usual way to notice a
  // capability is to drop the creature that carries it — which fires `createToken` and warms the cache
  // as a side effect. A GM who loads a world onto a scene already populated gets none of it.
  if ((canvas as any)?.ready) schedule((canvas as any).scene);

  log("capability collector registered");
}

/**
 * Diagnostics: what this scene would ask about, without asking.
 *
 * WARMS THE CACHE FIRST, because reading `cache.has` against a cache nobody has loaded reports every
 * wording as uncached — which is an instrument answering the opposite of the truth, and the answer it
 * gives is the alarming one. It cost a day: a full cache of 1,099 descriptors read as empty and was
 * diagnosed as a data loss. Warming is idempotent and costs nothing once the collector has run.
 */
export async function surveyScene(): Promise<Record<string, unknown>> {
  await cache.warm();
  const actors = actorsOn();
  const distinct = new Map<
    string,
    { label: string; cached: boolean; creatures: number; removed: string[] }
  >();
  let features = 0;
  const declined: Declined[] = [];
  for (const actor of actors) {
    for (const feature of featuresOf(actor, declined)) {
      features++;
      const row = distinct.get(feature.id);
      if (row) row.creatures++;
      else
        distinct.set(feature.id, {
          label: feature.label,
          cached: cache.has(feature.id),
          creatures: 1,
          removed: feature.removed,
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
    // Abilities whose description told the reader to do something by hand. Empty on stock content.
    scrubbed: rows
      .filter((r) => r.removed.length)
      .map((r) => ({ label: r.label, notes: r.removed })),
    // General rules that ship as items and were deliberately skipped. A dozen on a 2024 sheet.
    declined,
    rows,
  };
  log("scene capabilities:", report);
  return report;
}
