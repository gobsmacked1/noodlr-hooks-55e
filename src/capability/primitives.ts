// The verbs a compiled capability can actually perform on the world.
//
// Everything hard already existed before this file: movement with a cost budget, attacks through midi
// or the activity path, the lazy turn stamp in the action ledger, chat, sheet reading. What was
// missing was the small, unglamorous set of world mutations that creature abilities keep asking for
// and that nothing in a rules-enforcement layer ever needed. Six of them, each useful on its own
// whether or not a descriptor ever calls it.
//
// The house rule applies throughout: **we never compute a rule the system can compute.** Damage goes
// through dnd5e's own `applyDamage` so resistance, immunity, vulnerability, damage modification and
// the dying layer all run exactly as they do for a hand-applied hit. Dice are rolled by Foundry.
// Nothing here reimplements arithmetic that lives in the system.

import { log, warn } from "../constants";
import { centerOf, insideScene, occupied, type Point } from "../core/positioning";
import { isDnd5e } from "../system/dnd5e-rewards";
import { hasStatus } from "../system/dnd5e-conditions";

/** Eight-point compass, matching the hazard search so placement behaves the way escaping does. */
const BEARINGS = [
  { dx: 0, dy: -1 },
  { dx: 1, dy: -1 },
  { dx: 1, dy: 0 },
  { dx: 1, dy: 1 },
  { dx: 0, dy: 1 },
  { dx: -1, dy: 1 },
  { dx: -1, dy: 0 },
  { dx: -1, dy: -1 },
];

function gridSize(): number {
  return Number((canvas as any)?.grid?.size) || 100;
}

// ---- 1 & 2. Damage and healing --------------------------------------------------------------

export interface DamageOptions {
  amount: number;
  /** A dnd5e damage type. Omitted means untyped, which bypasses resistance — see below. */
  damageType?: string;
  /** Where the damage came from, for the log and for anything watching. */
  origin?: unknown;
}

/**
 * Deal damage through the system's own pipeline.
 *
 * The parameter shape matters more than it looks. `applyDamage(15)` with a bare NUMBER sets
 * `options.ignore = true` inside dnd5e (actor.mjs:725-728), which skips resistance, immunity and
 * vulnerability entirely — so the convenient call is the one that silently ignores the target's
 * defences. A typed description is passed instead whenever a type is known.
 */
export async function dealDamage(actor: any, options: DamageOptions): Promise<boolean> {
  const amount = Math.max(0, Math.round(Number(options.amount) || 0));
  if (!actor?.applyDamage || amount <= 0) return false;
  try {
    const description = options.damageType
      ? [{ value: amount, type: String(options.damageType).toLowerCase() }]
      : [{ value: amount }];
    await actor.applyDamage(description, { origin: options.origin });
    return true;
  } catch (err) {
    warn(`could not apply ${amount} damage to ${actor?.name}:`, err);
    return false;
  }
}

export interface HealOptions {
  amount: number;
  /** Temporary hit points do not stack in 5e; the larger pool wins, which `applyTempHP` handles. */
  temporary?: boolean;
}

/**
 * Heal, or grant temporary hit points.
 *
 * Healing is a damage description of type `healing`, which dnd5e inverts automatically unless
 * `invertHealing` is explicitly false (actor.mjs:866). Going through the same path rather than
 * writing `hp.value` keeps the clamp at maximum, the `dnd5e.applyDamage` hook and every listener on
 * it — including our own dying layer — behaving identically to a healing spell.
 */
export async function healActor(actor: any, options: HealOptions): Promise<boolean> {
  const amount = Math.max(0, Math.round(Number(options.amount) || 0));
  if (!actor || amount <= 0) return false;
  try {
    if (options.temporary) {
      if (typeof actor.applyTempHP !== "function") return false;
      await actor.applyTempHP(amount);
      return true;
    }
    if (typeof actor.applyDamage !== "function") return false;
    await actor.applyDamage([{ value: amount, type: "healing" }], {});
    return true;
  } catch (err) {
    warn(`could not heal ${actor?.name} for ${amount}:`, err);
    return false;
  }
}

// ---- 3. Creating and removing tokens ----------------------------------------------------------

export interface SummonOptions {
  /** The creature's name, resolved against the world's actors and then every compendium. */
  creature: string;
  count?: number;
  /** `self_space` puts them where the summoner stands, as Loathsome Limbs requires. */
  placement?: "self_space" | "adjacent" | "nearby";
  disposition?: "hostile" | "neutral" | "friendly" | "same_as_summoner";
  /** Marks the tokens ours, so they can be cleaned up and counted against a cap. */
  tag?: string;
}

const DISPOSITION: Record<string, number> = { hostile: -1, neutral: 0, friendly: 1 };

/**
 * Find a creature by name: world actors first, then compendium packs.
 *
 * World first is deliberate. A GM who has imported and tweaked a Troll Limb means that one, and a
 * compendium copy would silently discard their edits.
 */
export async function findCreature(name: string): Promise<any | null> {
  const wanted = String(name ?? "").trim();
  if (!wanted) return null;

  const local = (game as any)?.actors?.getName?.(wanted);
  if (local) return local;

  for (const pack of (game as any)?.packs ?? []) {
    if (pack?.documentName !== "Actor") continue;
    try {
      const index = await pack.getIndex();
      const entry = index.find((e: any) => String(e?.name).toLowerCase() === wanted.toLowerCase());
      if (entry) return await pack.getDocument(entry._id);
    } catch {
      // A pack that will not index is somebody else's problem; keep looking through the rest.
    }
  }
  return null;
}

/** The first free point at or near an origin, ringing outward the way the hazard search does. */
function placementNear(origin: Point, mode: SummonOptions["placement"], self: any): Point | null {
  if (mode === "self_space") return origin;
  const size = gridSize();
  const maxRadius = mode === "nearby" ? size * 3 : size;
  for (let radius = size; radius <= maxRadius; radius += size) {
    for (const bearing of BEARINGS) {
      const length = Math.hypot(bearing.dx, bearing.dy) || 1;
      const candidate: Point = {
        x: origin.x + (bearing.dx / length) * radius,
        y: origin.y + (bearing.dy / length) * radius,
      };
      if (!insideScene(candidate)) continue;
      if (occupied(candidate, self)) continue;
      return candidate;
    }
  }
  // Nowhere free. Stack them on the summoner rather than refusing: a creature that should have
  // appeared and did not is a rule that silently failed, which is the worse outcome.
  return origin;
}

/**
 * Place creatures on the scene beside a summoner. Returns the TokenDocuments created.
 *
 * Tagged with this module's flag so they can be counted and cleaned up. The cap that matters (the
 * Troll's four limbs) is enforced by the descriptor's `uses`, not here — this primitive does what it
 * is told, and the rule about how often lives with the rule.
 */
export async function summonCreature(summoner: any, options: SummonOptions): Promise<any[]> {
  const scene = (canvas as any)?.scene ?? (game as any)?.scenes?.current;
  const origin = centerOf(summoner);
  if (!scene || !origin) return [];

  const actor = await findCreature(options.creature);
  if (!actor) {
    warn(
      `cannot summon "${options.creature}" — no actor of that name in the world or any compendium`,
    );
    return [];
  }

  const summonerDoc = summoner?.document ?? summoner;
  const wanted =
    options.disposition === "same_as_summoner"
      ? Number(summonerDoc?.disposition ?? -1)
      : (DISPOSITION[options.disposition ?? "hostile"] ?? -1);

  const count = Math.max(1, Math.min(20, Math.round(Number(options.count) || 1)));
  const size = gridSize();
  const data: any[] = [];

  for (let i = 0; i < count; i++) {
    const spot = placementNear(origin, options.placement ?? "self_space", summonerDoc);
    if (!spot) continue;
    try {
      const token = await actor.getTokenDocument({
        // Foundry stores the top-left corner; every measurement in this module is from the centre.
        x: Math.round(spot.x - size / 2),
        y: Math.round(spot.y - size / 2),
        disposition: wanted,
      });
      const raw = token.toObject();
      raw.flags = {
        ...(raw.flags ?? {}),
        "noodlr-hooks-55e": { summonedBy: String(summonerDoc?.uuid ?? ""), tag: options.tag ?? "" },
      };
      data.push(raw);
    } catch (err) {
      warn(`could not build a token for "${options.creature}":`, err);
    }
  }

  if (data.length === 0) return [];
  try {
    return (await scene.createEmbeddedDocuments("Token", data)) ?? [];
  } catch (err) {
    warn(`could not place summoned "${options.creature}":`, err);
    return [];
  }
}

/** Remove tokens from the scene, and their combatants with them. */
export async function removeTokens(tokens: any[]): Promise<number> {
  const docs = tokens.map((t) => t?.document ?? t).filter((t) => t?.id);
  if (docs.length === 0) return 0;
  const scene = docs[0]?.parent ?? (canvas as any)?.scene;
  if (!scene) return 0;
  try {
    await scene.deleteEmbeddedDocuments(
      "Token",
      docs.map((d) => d.id),
    );
    return docs.length;
  } catch (err) {
    warn("could not remove tokens:", err);
    return 0;
  }
}

// ---- 4. Joining the turn order at a chosen place -----------------------------------------------

export interface CombatantPlacement {
  /** Act immediately after this combatant — the Troll's limbs join the order behind the Troll. */
  after?: any;
  /** An explicit initiative count, for abilities that name one. */
  initiative?: number;
}

/**
 * Add tokens to the current fight, optionally at a chosen point in the order.
 *
 * A fractional initiative is what places something "immediately after" another creature, and it works
 * because core sorts numerically descending and only breaks exact ties by id
 * (`Combat#_sortCombatants`), while `Combatant.initiative` is a plain `NumberField` with no integer
 * constraint. dnd5e defers to core whenever two initiatives differ, so its own tie-breaking never sees
 * these. Both facts were read from source; neither is safe to assume.
 */
export async function addCombatants(
  tokens: any[],
  placement: CombatantPlacement = {},
): Promise<any[]> {
  const combat = (game as any)?.combat;
  if (!combat) return [];

  let initiative = placement.initiative;
  if (initiative === undefined && placement.after) {
    const after = placement.after?.combatant ?? placement.after;
    const base = Number(after?.initiative);
    // A hundredth of a point: small enough that nothing else lands between, large enough to survive
    // being displayed rounded.
    if (Number.isFinite(base)) initiative = base - 0.01;
  }

  const docs = tokens.map((t) => t?.document ?? t).filter(Boolean);
  const data = docs
    .filter((doc) => !combat.combatants?.find((c: any) => c.tokenId === doc.id))
    .map((doc) => ({
      tokenId: doc.id,
      sceneId: doc.parent?.id ?? (canvas as any)?.scene?.id,
      actorId: doc.actorId ?? doc.actor?.id,
      ...(initiative === undefined ? {} : { initiative }),
    }));

  if (data.length === 0) return [];
  try {
    return (await combat.createEmbeddedDocuments("Combatant", data)) ?? [];
  } catch (err) {
    warn("could not add combatants:", err);
    return [];
  }
}

// ---- 5. Conditions --------------------------------------------------------------------------

/**
 * Apply or clear a condition, including the one that counts rather than toggles.
 *
 * Exhaustion is the exception in every system that has it: `toggleStatusEffect` would turn it on and
 * off while the rule is about levels, which dnd5e keeps at `system.attributes.exhaustion`. Everything
 * else is a plain status, and going through `toggleStatusEffect` means any module watching conditions
 * — Automated Conditions 5e included — sees it exactly as it sees a hand-applied one.
 */
export async function setCondition(
  actor: any,
  status: string,
  active: boolean,
  options: { levels?: number } = {},
): Promise<boolean> {
  const id = String(status ?? "").toLowerCase();
  if (!actor || !id) return false;

  if (id === "exhaustion" && isDnd5e()) {
    try {
      const current = Number(actor.system?.attributes?.exhaustion ?? 0);
      const delta = Math.round(Number(options.levels ?? 1));
      const next = active ? Math.min(6, current + delta) : Math.max(0, current - delta);
      if (next === current) return false;
      await actor.update({ "system.attributes.exhaustion": next });
      return true;
    } catch (err) {
      warn(`could not change exhaustion on ${actor?.name}:`, err);
      return false;
    }
  }

  try {
    if (active === hasStatus(actor, id)) return false;
    await actor.toggleStatusEffect(id, { active });
    return true;
  } catch (err) {
    warn(`could not set ${id}=${active} on ${actor?.name}:`, err);
    return false;
  }
}

// ---- 6. Limited uses ---------------------------------------------------------------------------

/**
 * Spend or restore uses on an item, outside `activity.use`.
 *
 * dnd5e stores what has been SPENT rather than what remains (`system.uses.spent`, with `max`
 * alongside) — read from `Actor5e#modifyTokenAttribute`, which does the same arithmetic at
 * actor.mjs:707. Writing `value` instead looks right and is a derived field: the change is discarded
 * on the next data preparation, with no error.
 */
export async function adjustUses(item: any, delta: number): Promise<number | null> {
  const uses = item?.system?.uses;
  if (!uses || !Number.isFinite(Number(uses.max))) return null;
  const max = Number(uses.max);
  const spent = Number(uses.spent ?? 0);
  const next = Math.max(0, Math.min(max, spent - Math.round(delta)));
  if (next === spent) return max - spent;
  try {
    await item.update({ "system.uses.spent": next });
    return max - next;
  } catch (err) {
    warn(`could not change uses on ${item?.name}:`, err);
    return null;
  }
}

/** How many uses are left, or null when the item is not limited. */
export function usesRemaining(item: any): number | null {
  const uses = item?.system?.uses;
  if (!uses || !Number.isFinite(Number(uses.max))) return null;
  return Math.max(0, Number(uses.max) - Number(uses.spent ?? 0));
}

/** Everything this module summoned onto the current scene, for cleanup and for counting. */
export function summonedTokens(summonerUuid?: string): any[] {
  const tokens: any[] = (canvas as any)?.scene?.tokens?.contents ?? [];
  return tokens.filter((doc: any) => {
    const flag = doc?.flags?.["noodlr-hooks-55e"];
    if (!flag?.summonedBy) return false;
    return !summonerUuid || flag.summonedBy === summonerUuid;
  });
}

/** Diagnostics: what the primitives can see right now. */
export function surveyPrimitives(): Record<string, unknown> {
  const report = {
    system: String((game as any)?.system?.id ?? ""),
    scene: String((canvas as any)?.scene?.name ?? ""),
    summoned: summonedTokens().map((t: any) => t.name),
    inCombat: Boolean((game as any)?.combat?.started),
  };
  log("primitives:", report);
  return report;
}
