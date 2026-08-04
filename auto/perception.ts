// Hostile creatures noticing the party, and starting the fight themselves.
//
// Requiring a human to press "roll initiative" and then "begin combat" defeats the point of combat
// automation (user, 2026-08-04): the GM has already said they want the mechanical work offloaded, and
// the one thing standing between an unattended encounter and a running one is two clicks.
//
// The hard part is asking "can that monster see that player" at all. Three layers of trap, all verified:
//
//   1. `token.isVisible` and `canvas.visibility.testVisibility` both answer a DIFFERENT question —
//      whether the current user can see it. Core's method iterates the vision sources initialized on
//      this client, and short-circuits to `game.user.isGM` when there are none, so on an automation
//      client it is a very confident "yes" to everything. Neither can be scoped to an arbitrary token.
//   2. An uncontrolled NPC has no vision source on a GM's client at all: `Token#_isVisionSource()`
//      refuses for a GM unless the token is controlled. So one has to be built by hand — initialized
//      but deliberately never `add()`ed, because adding it would change what the GM's own screen shows.
//      `DetectionMode#testVisibility(visionSource, mode, config)` takes the source as a PARAMETER,
//      which is what makes per-creature perception possible at all.
//   3. dnd5e never maps a stat block's senses onto Foundry detection modes, and NPC tokens ship with
//      `sight.enabled` false (its character template sets it; its NPC template has no prototype token
//      block). A monster with "Darkvision 60 ft." therefore has NO detection modes whatsoever, and a
//      pure vision test silently returns false for the entire bestiary. This is the single most likely
//      way for the feature to look broken, so a creature with no usable modes falls back to its stated
//      senses plus a wall check, and one with no way to perceive anything at all says so in the console.
//
// Both the throwaway-source technique and the detection-mode loop are what Patrol and vision-5e do in
// production against Foundry 14. Behaviour was the reference; the code is ours.
//
// A quiet period after every fight guards the obvious way this turns hostile: survivors who can still
// see the party would otherwise restart the encounter the instant the GM ended it.

import { log, MODULE_ID } from "../../constants";
import { isPrimaryGM } from "../../util/gm";
import { readHp } from "../tracker";
import { getCombatAutomation, isAutoEngageEnabled } from "../config";

/** Interval between sweeps: one combat round of real time (user's spec, 2026-08-04). */
const POLL_MS = 6000;

/**
 * How long after a fight ends before creatures may start another one.
 *
 * Without this, ending an encounter while a surviving goblin still has the party in view starts the
 * next encounter immediately, and the GM cannot get a word in.
 */
const PEACE_MS = 60_000;

/** Sight range assumed for a creature whose token has vision switched off and no stated senses. */
const ASSUMED_SIGHT = 60;

/** Senses that let a creature notice someone, whatever the light is doing. */
const SENSES = ["darkvision", "blindsight", "truesight", "tremorsense"];

/** Creatures already warned about having no way to perceive anything, so the log stays readable. */
const warnedBlind = new Set<string>();

let timer: number | null = null;
let sweeping = false;
let quietUntil = 0;

export function registerPerceptionWatch(): void {
  Hooks.on("deleteCombat", () => {
    quietUntil = Date.now() + PEACE_MS;
  });

  // Started directly rather than on a `ready` hook: this is registered from inside `ready` already, so
  // waiting for another one would leave the timer permanently unstarted.
  if (timer === null) timer = window.setInterval(() => void sweep(), POLL_MS);
}

/** Everything that has to be true before a sweep is even worth the arithmetic. */
function shouldSweep(): boolean {
  if (sweeping || Date.now() < quietUntil) return false;
  if (!isPrimaryGM()) return false;
  if (getCombatAutomation() === "off" || !isAutoEngageEnabled()) return false;
  if (game.paused) return false;
  // A fight already in progress needs no starting. Late arrivals are the GM's call for now.
  if ((game.combat as any)?.started) return false;
  return Boolean((canvas as any)?.ready && (canvas as any)?.scene?.id);
}

async function sweep(): Promise<void> {
  if (!shouldSweep()) return;
  sweeping = true;
  try {
    const hostiles = tokensOnScene().filter(isHostile);
    const party = tokensOnScene().filter(isPlayerToken);
    if (hostiles.length === 0 || party.length === 0) return;

    // Closest pair first, so the creature that would plausibly notice first is the one that does.
    const pairs: Array<{ spotter: any; target: any; distance: number }> = [];
    for (const spotter of hostiles) {
      for (const target of party) {
        pairs.push({ spotter, target, distance: separation(spotter, target) });
      }
    }
    pairs.sort((a, b) => a.distance - b.distance);

    // One vision source per spotter, reused across the party. Building the source runs a full wall
    // sweep, which is the entire cost of this feature; testing an extra target against an existing one
    // is arithmetic. Never build inside the inner loop.
    const vision = new Map<string, any>();
    try {
      for (const { spotter, target } of pairs) {
        if (!perceives(spotter, target, vision)) continue;
        await engage(spotter, target);
        return;
      }
    } finally {
      // These are ours and were never registered with the canvas; leaving them would leak polygons.
      for (const source of vision.values()) {
        try {
          source?.destroy?.();
        } catch {
          /* a source that will not tidy up is not worth failing a sweep over */
        }
      }
    }
  } catch (err) {
    log("perception sweep failed:", err);
  } finally {
    sweeping = false;
  }
}

function tokensOnScene(): any[] {
  return ((canvas as any)?.tokens?.placeables ?? []).filter(
    (t: any) => t?.actor && !t.document?.hidden,
  );
}

function alive(token: any): boolean {
  const defeated = (globalThis as any).CONFIG?.specialStatusEffects?.DEFEATED ?? "dead";
  try {
    if (token?.document?.hasStatusEffect?.(defeated)) return false;
  } catch {
    /* fall through to hit points */
  }
  // Belt and braces: a monster at 0 hit points that nobody flagged is still functionally dead.
  const hp = readHp(token.actor);
  return !hp || hp.value === null || hp.value > 0;
}

function isHostile(token: any): boolean {
  const hostile = (globalThis as any).CONST?.TOKEN_DISPOSITIONS?.HOSTILE ?? -1;
  if (Number(token?.document?.disposition) !== hostile) return false;
  if (token?.actor?.hasPlayerOwner) return false;
  return alive(token);
}

function isPlayerToken(token: any): boolean {
  return Boolean(token?.actor?.hasPlayerOwner) && alive(token);
}

function separation(a: any, b: any): number {
  const grid: any = (canvas as any)?.grid;
  try {
    const measured = grid?.measurePath?.([a.center, b.center]);
    if (measured?.distance !== undefined) return Number(measured.distance);
  } catch {
    /* gridless scenes and older shapes fall through to pixels */
  }
  return Math.hypot(b.center.x - a.center.x, b.center.y - a.center.y);
}

/**
 * Can `spotter` see `target` right now?
 *
 * Runs the creature's own detection modes — which is what gets darkness, darkvision, blindsight,
 * tremorsense and invisibility right without us reimplementing any of them. A creature whose token has
 * no usable modes (the common case, see the header) is judged on its stat block instead.
 *
 * Elevation is not considered beyond what core's own modes do: Foundry's vision is largely planar, and
 * modelling a creature's vertical arc of sight would be inventing precision we do not have.
 */
function perceives(spotter: any, target: any, cache: Map<string, any>): boolean {
  const id = String(spotter?.id ?? "");
  if (!cache.has(id)) cache.set(id, buildVision(spotter));
  const source = cache.get(id);

  const modes = source ? enabledModes(spotter) : [];
  if (source && modes.length > 0) {
    const config = testConfig(target);
    for (const [modeId, mode] of modes) {
      const detector: any = (globalThis as any).CONFIG?.Canvas?.detectionModes?.[modeId];
      if (typeof detector?.testVisibility !== "function") continue;
      try {
        if (detector.testVisibility(source, mode, config)) return true;
      } catch (err) {
        log(`detection mode ${modeId} threw for ${spotter?.name}:`, err);
      }
    }
    // Its senses are properly configured and none of them found the target. That is an answer, not a
    // gap — falling through to the stat block here would quietly undo darkness and invisibility.
    return false;
  }

  return withinSenses(spotter, target) && hasLineOfSight(spotter, target);
}

/**
 * The spotter's enabled detection modes as [id, mode] pairs.
 *
 * v14 keeps `detectionModes` as a Record keyed by id; v13 and earlier keep an Array of objects carrying
 * their own `id`. Both shapes are handled because the difference is silent — the wrong one yields an
 * empty list rather than an error, and an empty list looks exactly like a blind monster.
 */
function enabledModes(spotter: any): Array<[string, any]> {
  const raw: any = spotter?.document?.detectionModes;
  const pairs: Array<[string, any]> = Array.isArray(raw)
    ? raw.map((m: any) => [String(m?.id ?? ""), m])
    : Object.entries(raw ?? {});
  return pairs.filter(([id, mode]) => id && mode?.enabled);
}

/**
 * The visibility test config a detection mode expects: a set of points, each with its own LOS memo.
 *
 * Core builds this in `_createVisibilityTestConfig`, which is internal, so it is used when present and
 * hand-rolled when not — the shape is small and stable enough that a fallback is cheaper than a
 * hard dependency on a protected method. v14 takes an array of points and offers the token's own test
 * points; earlier versions take one point and jitter it by a tolerance.
 */
function testConfig(target: any): any {
  const v14 = Number((game as any)?.release?.generation ?? 13) >= 14;
  const doc = target?.document;
  const points =
    v14 && typeof doc?.getVisibilityTestPoints === "function"
      ? doc.getVisibilityTestPoints()
      : target.center;

  const visibility: any = (canvas as any)?.visibility;
  if (typeof visibility?._createVisibilityTestConfig === "function") {
    try {
      return visibility._createVisibilityTestConfig(points, {
        object: target,
        tolerance: v14 ? 0 : 2,
      });
    } catch (err) {
      log("core's visibility test config threw; using our own:", err);
    }
  }

  const elevation = Number(doc?.elevation ?? 0) || 0;
  const list = Array.isArray(points) ? points : [points];
  return {
    object: target,
    tests: list.map((p: any) => ({
      point: { x: p.x, y: p.y, elevation: Number(p.elevation ?? elevation) || 0 },
      los: new Map(),
    })),
  };
}

/**
 * A vision source for a token nobody is controlling.
 *
 * `initialize()` computes the polygons; `add()` would register the source with the canvas and change
 * what the GM actually sees on screen, so it is never called. Built even when `sight.enabled` is false,
 * because the detection-mode loop is what decides whether it is useful.
 */
function buildVision(token: any): any {
  try {
    const cls: any = (globalThis as any).CONFIG?.Canvas?.visionSourceClass;
    if (!cls || typeof token?.document?._getVisionSourceData !== "function") return null;
    const source = new cls({ sourceId: token.sourceId, object: token });
    source.initialize(token.document._getVisionSourceData());
    return source;
  } catch (err) {
    log("could not build a vision source:", err);
    return null;
  }
}

/**
 * Fallback for creatures with no detection modes: the senses their stat block claims.
 *
 * dnd5e 5.3 moved these under `senses.ranges`; the flat path still resolves through a deprecation shim,
 * so both are read. A creature with neither modes nor stated senses is assumed to have ordinary sight,
 * and is named in the console once — an empty capability read is a misconfiguration until proven
 * otherwise, and silence here is what would make the whole feature look dead.
 */
function withinSenses(spotter: any, target: any): boolean {
  const attributes: any = spotter?.actor?.system?.attributes?.senses ?? {};
  const ranges: any = attributes?.ranges ?? attributes;
  let radius = Number(spotter?.document?.sight?.range) || 0;
  for (const sense of SENSES) radius = Math.max(radius, Number(ranges?.[sense]) || 0);

  if (radius <= 0) {
    radius = ASSUMED_SIGHT;
    const id = String(spotter?.id ?? "");
    if (!warnedBlind.has(id)) {
      warnedBlind.add(id);
      log(
        `perception: ${spotter?.name} has no detection modes and no stated senses — assuming ${ASSUMED_SIGHT} ft of ordinary sight. Enable vision on the token, or install a senses module, for anything better.`,
      );
    }
  }
  return separation(spotter, target) <= radius;
}

function hasLineOfSight(spotter: any, target: any): boolean {
  try {
    if (typeof spotter?.checkCollision === "function") {
      return !spotter.checkCollision(target.center, { type: "sight", mode: "any" });
    }
  } catch (err) {
    log("line-of-sight test threw; assuming the view is clear:", err);
  }
  return true;
}

/**
 * Start the fight.
 *
 * Everything hostile and everything player-owned on the scene joins, not just the pair that noticed
 * each other — a lookout spotting the party does not fight them single-handed while the rest of its
 * warband stands idle one room away.
 */
async function engage(spotter: any, target: any): Promise<void> {
  const scene: any = (canvas as any)?.scene;
  const spotterName = String(spotter?.name ?? "Something");
  const targetName = String(target?.name ?? "someone");
  log(`perception: ${spotterName} spots ${targetName}; starting combat`);

  const joining = tokensOnScene().filter((t) => isHostile(t) || isPlayerToken(t));

  // Vetoable, so a GM or another module can call off an engagement it knows better about.
  if (Hooks.call("noodlrPreCombatInitiated", spotter, target) === false) {
    log("perception: something vetoed the engagement");
    return;
  }

  try {
    // By SCENE, not `game.combats.viewed` or `game.combat` — those are the tracker's current selection,
    // which is UI state and means nothing on the client running automation.
    let combat: any = (game.combats as any)?.find?.((c: any) => c?.scene?.id === scene.id);
    if (!combat) {
      const Combat: any = (foundry as any).utils.getDocumentClass("Combat");
      combat = await Combat.create({ scene: scene.id, active: true });
    }
    if (!combat) throw new Error("no combat document could be created");

    const documents = joining.map((t) => t.document ?? t);
    const TokenDocument: any = (foundry as any).utils.getDocumentClass("Token");
    if (typeof TokenDocument?.createCombatants === "function") {
      await TokenDocument.createCombatants(documents, { combat });
    } else {
      const already = new Set(
        (combat.combatants ?? []).map((c: any) => String(c?.tokenId ?? c?.token?.id ?? "")),
      );
      const additions = documents
        .filter((d: any) => !already.has(String(d.id)))
        .map((d: any) => ({
          tokenId: d.id,
          sceneId: scene.id,
          actorId: d.actor?.id,
          hidden: Boolean(d.hidden),
        }));
      if (additions.length > 0) await combat.createEmbeddedDocuments("Combatant", additions);
    }

    // NPCs only. Rolling a player's initiative for them takes away the one die roll they expect to make
    // at the start of a fight, and it is not the work the GM asked to be relieved of — they asked not to
    // have to roll for a dozen monsters and press "begin". The players' own buttons are waiting for them.
    await combat.rollNPC();
    await combat.startCombat();

    const ChatMessage = (globalThis as any).ChatMessage;
    await ChatMessage.create({
      content:
        `<p><strong>${foundry.utils.escapeHTML(spotterName)}</strong> spots ` +
        `<strong>${foundry.utils.escapeHTML(targetName)}</strong>. Roll for initiative!</p>`,
      flags: { [MODULE_ID]: { autoEngage: true } },
    });
    Hooks.callAll("noodlrCombatInitiated", spotter, target);
  } catch (err) {
    log("could not start combat automatically:", err);
    // Loud, because the alternative is a GM who thinks the feature is on and is not being told it broke.
    ui.notifications?.warn(game.i18n.localize("NOODLR.Combat.AutoEngage.Failed"));
    quietUntil = Date.now() + PEACE_MS;
  }
}
