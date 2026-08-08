// Hostile creatures noticing the party, and starting the fight themselves.
//
// Requiring a human to press "roll initiative" and then "begin combat" defeats the point of combat
// automation (user, 2026-08-04): the GM has already said they want the mechanical work offloaded, and
// the one thing standing between an unattended encounter and a running one is two clicks.
//
// Detection is deliberately ONE-WAY: only a hostile creature noticing a player starts anything. A party
// creeping past a sleeping warband can see every one of them without consequence, because a party that
// chose to sneak has chosen not to fight, and a system that opened combat on the players' own eyeballs
// would make stealth impossible (user, 2026-08-04). Nothing here ever tests a player as the spotter.
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
import { narrator, speakerFor } from "../../util/speaker";
import { readHp } from "../tracker";
import {
  getCombatAutomation,
  getEngageRadius,
  isAutoEngageEnabled,
  isStealthEnabled,
  isSurpriseEnabled,
} from "../config";
import { SURPRISED_STATUS } from "../systems/dnd5e-stealth";
import { initiativeSettled } from "./hooks";
import {
  describeSenses,
  describeStealth,
  evades,
  hidingState,
  passivePerception,
  reveal,
} from "./stealth";

/** Interval between sweeps: one combat round of real time (user's spec, 2026-08-04). */
const POLL_MS = 6000;

/**
 * How long after a fight ends before creatures may start another one.
 *
 * Without this, ending an encounter while a surviving goblin still has the party in view starts the
 * next encounter immediately, and the GM cannot get a word in.
 */
const PEACE_MS = 60_000;

/** How long the players are given to roll their own initiative before the fight starts without them. */
const INITIATIVE_WAIT_MS = 60_000;

/** Sight range assumed for a creature whose token has vision switched off and no stated senses. */
const ASSUMED_SIGHT = 60;

/** Senses that let a creature notice someone, whatever the light is doing. */
const SENSES = ["darkvision", "blindsight", "truesight", "tremorsense"];

/** Creatures already warned about having no way to perceive anything, so the log stays readable. */
const warnedBlind = new Set<string>();

/** Pairings already reported as "would have been spotted, but they are hidden". */
const announced = new Set<string>();

let timer: number | null = null;
let sweeping = false;
let quietUntil = 0;

export function registerPerceptionWatch(): void {
  Hooks.on("deleteCombat", () => {
    quietUntil = Date.now() + PEACE_MS;
    announced.clear();
    if (isPrimaryGM()) void clearSurprise();
  });

  watchForCasualties();

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
  // A combat that exists but has not begun is someone mid-setup, very likely our own initiative wait.
  // A combat under way is fine: we keep sweeping, but only for creatures not already in it.
  const combat = activeCombat();
  if (combat && !combat.started) return false;
  return Boolean((canvas as any)?.ready && (canvas as any)?.scene?.id);
}

/** The combat for this scene, by scene id — never `game.combat`, which is the tracker's selection. */
function activeCombat(): any {
  const scene: any = (canvas as any)?.scene;
  if (!scene?.id) return null;
  return (game.combats as any)?.find?.((c: any) => c?.scene?.id === scene.id) ?? null;
}

/** Token ids already in the fight. */
function enlisted(combat: any): Set<string> {
  const ids = new Set<string>();
  for (const combatant of combat?.combatants ?? []) {
    const id = String(combatant?.tokenId ?? combatant?.token?.id ?? "");
    if (id) ids.add(id);
  }
  return ids;
}

async function sweep(): Promise<void> {
  if (!shouldSweep()) return;
  sweeping = true;
  try {
    // Creatures already fighting have nothing to notice. Everyone else keeps watching, so a warband
    // that was out of earshot when the fight started can still wander into it (user, 2026-08-05).
    const combat = activeCombat();
    const already = combat?.started ? enlisted(combat) : new Set<string>();
    const hostiles = tokensOnScene().filter((t) => isHostile(t) && !already.has(String(t.id)));
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
        if (!perceives(spotter, target, vision, true)) continue;
        if (combat?.started) {
          await reinforce(combat, spotter, `${spotter.name} spots ${target.name}`);
        } else {
          await engage(spotter, target);
        }
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
function perceives(spotter: any, target: any, cache: Map<string, any>, live = false): boolean {
  const id = String(spotter?.id ?? "");
  if (!cache.has(id)) cache.set(id, buildVision(spotter));
  const source = cache.get(id);

  const modes = source ? enabledModes(spotter) : [];
  const useModes = Boolean(source) && modes.length > 0;
  let seen = false;

  if (useModes) {
    const config = testConfig(target);
    for (const [modeId, mode] of modes) {
      const detector: any = (globalThis as any).CONFIG?.Canvas?.detectionModes?.[modeId];
      if (typeof detector?.testVisibility !== "function") continue;
      try {
        if (detector.testVisibility(source, mode, config)) {
          seen = true;
          break;
        }
      } catch (err) {
        log(`detection mode ${modeId} threw for ${spotter?.name}:`, err);
      }
    }
    // Its senses are properly configured and none of them found the target. That is an answer, not a
    // gap — falling through to the stat block here would quietly undo darkness and invisibility.
  } else {
    seen = withinSenses(spotter, target) && hasLineOfSight(spotter, target);
  }

  if (!seen) return false;
  if (!isStealthEnabled()) return true;

  // A clear line of sight is Foundry's answer, not 5e's. Ask the dice too.
  const wasHiding = live && Boolean(hidingState(target));
  const evaded = evades(spotter, target, separation(spotter, target), useModes);
  if (evaded) {
    announceEvasion(spotter, target, evaded);
    return false;
  }

  // "An enemy finds you" is one of the four things that end the 2024 Hide, and this is that moment. Only
  // on a real sweep: the diagnostic survey asks the same question about every pairing on the map and must
  // not change the world by being run.
  if (live && wasHiding) {
    void reveal(target, `${String(spotter?.name ?? "an enemy")} found them`);
  }
  return true;
}

/**
 * Say once, per pair, that a fight did not start because someone was hidden.
 *
 * The failure this guards against is silence: a stale hidden state suppressing every encounter forever
 * while the GM wonders why automatic engagement stopped working. Repeating it every six seconds would
 * be its own kind of useless, so each pairing is announced once and reset when a fight ends.
 */
function announceEvasion(spotter: any, target: any, why: string): void {
  const key = `${spotter?.id}:${target?.id}`;
  if (announced.has(key)) return;
  announced.add(key);
  log(`perception: ${spotter?.name} would have spotted ${target?.name}, but they are ${why}`);
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
 * Report, for every hostile-and-player pairing on this scene, who can see whom and why.
 *
 * Perception failures are invisible by nature — the feature declining to start a fight looks exactly
 * like the feature being broken — so this exists to make the numbers inspectable from the console
 * before anyone starts guessing.
 */
export async function surveyPerception(): Promise<Record<string, unknown>> {
  const hostiles = tokensOnScene().filter(isHostile);
  const party = tokensOnScene().filter(isPlayerToken);
  const vision = new Map<string, any>();
  const rows: Array<Record<string, unknown>> = [];

  try {
    for (const spotter of hostiles) {
      const modes = enabledModes(spotter).map(([id]) => id);
      for (const target of party) {
        const distance = separation(spotter, target);
        rows.push({
          spotter: spotter.name,
          target: target.name,
          distance: Math.round(distance * 10) / 10,
          detectionModes: modes.length > 0 ? modes.join(", ") : "none (falling back to stat block)",
          passivePerception: passivePerception(spotter),
          spotterSenses: describeSenses(spotter),
          targetState: describeStealth(target, spotter),
          verdict: perceives(spotter, target, vision) ? "SPOTTED" : "unnoticed",
        });
      }
    }
  } finally {
    for (const source of vision.values()) {
      try {
        source?.destroy?.();
      } catch {
        /* nothing worth failing a report over */
      }
    }
  }

  const report = {
    scene: String((canvas as any)?.scene?.name ?? "?"),
    units: String((canvas as any)?.scene?.grid?.units ?? "?"),
    stealthContest: isStealthEnabled(),
    engageRadius: getEngageRadius(),
    pairs: rows,
  };
  console.log(`[${MODULE_ID}] perception survey\n${JSON.stringify(report, null, 2)}`);
  return report;
}

/**
 * Hold until everyone has an initiative, or until the table has clearly stopped rolling.
 *
 * The wait is bounded because an absent player must not be able to freeze an encounter indefinitely; a
 * minute is long enough for someone to notice the tracker and short enough that nobody is left staring.
 * When it expires, the stragglers are rolled for and the fight begins — announced, because a roll made
 * on a player's behalf is something they are entitled to know about.
 *
 * Returns false when the encounter went away while we waited, in which case there is nothing to start.
 */
async function waitForInitiative(combat: any): Promise<boolean> {
  const deadline = Date.now() + INITIATIVE_WAIT_MS;
  while (Date.now() < deadline) {
    if (!combat?.id || !(game.combats as any)?.get?.(combat.id)) return false;
    if (initiativeSettled(combat)) return true;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!combat?.id || !(game.combats as any)?.get?.(combat.id)) return false;
  if (initiativeSettled(combat)) return true;

  log("perception: nobody rolled in time; rolling the stragglers so the fight can start");
  const ChatMessage = (globalThis as any).ChatMessage;
  await ChatMessage.create({
    content: `<p><em>${game.i18n.localize("NOODLRHOOKS.Combat.AutoEngage.RolledFor")}</em></p>`,
    speaker: narrator(),
  });
  try {
    await combat.rollAll();
  } catch (err) {
    log("could not roll the remaining initiatives:", err);
  }
  return true;
}

/**
 * Everything that joins the fight the spotter just started.
 *
 * The spotter's side is limited to what it can shout to — see `getEngageRadius`. The party is not:
 * adventurers arrive together and a scout who is spotted 60 ft ahead of the marching order is not
 * fighting alone, so every living player-owned token on the scene rolls. The asymmetry is deliberate.
 */
function combatants(spotter: any): any[] {
  const radius = getEngageRadius();
  const heard = (t: any) => String(t?.id) === String(spotter?.id) || reach(spotter, t) <= radius;
  return tokensOnScene().filter((t) => (isHostile(t) ? heard(t) : isPlayerToken(t)));
}

/** Distance between two tokens with height counted, so a sentry on a balcony is as far as it looks. */
function reach(a: any, b: any): number {
  const rise = Number(b?.document?.elevation ?? 0) - Number(a?.document?.elevation ?? 0);
  return Math.hypot(separation(a, b), rise || 0);
}

/**
 * Bring a creature, and whoever it can shout to, into a fight that is already running.
 *
 * Two ways in. It noticed someone — the ordinary sweep, still running for everyone not already in the
 * tracker. Or someone hurt it, which needs no perception at all: an arrow out of the dark does not
 * require you to have seen the archer to know you are in a fight. The second case is the one that
 * prompted this (user, 2026-08-05): a hostile outside the original shout radius was deliberately shot at
 * over several rounds and never joined, because sweeping stopped the moment combat began.
 */
async function reinforce(combat: any, spotter: any, why: string): Promise<void> {
  const already = enlisted(combat);
  const radius = getEngageRadius();
  const joining = tokensOnScene().filter(
    (t) =>
      isHostile(t) &&
      !already.has(String(t.id)) &&
      (String(t.id) === String(spotter?.id) || reach(spotter, t) <= radius),
  );
  if (joining.length === 0) return;

  if (Hooks.call("noodlrPreReinforcement", combat, spotter, joining) === false) {
    log("perception: something vetoed the reinforcements");
    return;
  }

  log(`perception: ${why}; ${joining.length} joining the fight late`);
  try {
    const documents = joining.map((t) => t.document ?? t);
    const TokenDocument: any = (foundry as any).utils.getDocumentClass("Token");
    if (typeof TokenDocument?.createCombatants === "function") {
      await TokenDocument.createCombatants(documents, { combat });
    } else {
      await combat.createEmbeddedDocuments(
        "Combatant",
        documents.map((d: any) => ({
          tokenId: d.id,
          sceneId: (canvas as any)?.scene?.id,
          actorId: d.actor?.id,
          hidden: Boolean(d.hidden),
        })),
      );
    }
    // Rolls only combatants who have not rolled, so the creatures already fighting keep their places.
    // It matters that this happens promptly: turn automation holds while anyone is unrolled.
    await combat.rollNPC();

    const ChatMessage = (globalThis as any).ChatMessage;
    const names = joining.map((t) => foundry.utils.escapeHTML(String(t.name ?? "?"))).join(", ");
    await ChatMessage.create({
      content: `<p><strong>${names}</strong> ${joining.length > 1 ? "join" : "joins"} the fight.</p>`,
      speaker: narrator(),
      flags: { [MODULE_ID]: { autoEngage: true } },
    });
    Hooks.callAll("noodlrReinforced", combat, joining);
  } catch (err) {
    log("could not bring reinforcements into the fight:", err);
  }
}

/**
 * Being hurt puts you in the fight, seen or unseen.
 *
 * Deliberately separate from perception: the creature may have no idea where the attack came from, and
 * a bystander being picked off from across the room while the tracker ignores it is the exact behaviour
 * that was reported. Only creatures that are hostile, alive, and not already fighting are considered.
 */
function watchForCasualties(): void {
  // `preUpdateActor`, not `updateActor`, because only a DROP in hit points counts and the old value is
  // gone by the time the update has landed. Being healed is not being attacked.
  Hooks.on("preUpdateActor", (actor: any, changes: any) => {
    if (!isPrimaryGM()) return;
    if (getCombatAutomation() === "off" || !isAutoEngageEnabled()) return;
    const next = Number(foundry.utils.getProperty(changes ?? {}, "system.attributes.hp.value"));
    const before = Number(actor?.system?.attributes?.hp?.value);
    if (!Number.isFinite(next) || !Number.isFinite(before) || next >= before) return;

    const combat = activeCombat();
    // A combat that exists but has not started is someone mid-setup, very likely our own initiative wait.
    if (combat && !combat.started) return;
    if (Date.now() < quietUntil) return;
    const already = combat ? enlisted(combat) : new Set<string>();

    // An unlinked token's actor is synthetic and reports the BASE actor's id, which every goblin from
    // the same prototype shares. Its `token` is the only thing that identifies which goblin was hit.
    const hurt = String(actor?.token?.id ?? "");
    for (const token of tokensOnScene()) {
      const isTheOne = hurt
        ? String(token.id) === hurt
        : String(token?.actor?.id ?? "") === String(actor?.id ?? "");
      if (!isTheOne) continue;
      if (!isHostile(token) || already.has(String(token.id))) continue;

      // The half of this that was missing until v0.4.43, and the reason a rogue could kill a whole camp
      // one sleeping guard at a time: with no combat running at all, being stabbed did nothing whatsoever.
      // Perception was never involved — an arrow out of the dark does not need to be seen to start a
      // fight, which is exactly why this path exists separately from the sweep.
      if (!combat?.started) {
        // The same guard the poll uses, and for a sharper reason here: `engage` holds for up to a minute
        // waiting on initiative, so without it a second creature taking damage during that wait would
        // start a second Combat on the same scene.
        if (sweeping) return;
        sweeping = true;
        void engage(token, nearestPlayer(token), `${token.name} was attacked`).finally(() => {
          sweeping = false;
        });
      } else {
        void reinforce(combat, token, `${token.name} was attacked`);
      }
      return;
    }
  });
}

/** The player-owned token closest to a creature, for naming who it is presumably fighting. */
function nearestPlayer(token: any): any {
  let best: any = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of tokensOnScene()) {
    if (!isPlayerToken(candidate)) continue;
    const distance = reach(token, candidate);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return best;
}

/**
 * Everyone joining who cannot see a single member of the party is caught unawares.
 *
 * 2024 made Surprise a Disadvantage on the Initiative roll rather than a lost turn, and dnd5e already
 * implements that half — `conditionEffects.initiativeDisadvantage` contains `surprised` and initiative
 * preparation reads it. What the system never does is decide WHO is surprised, so the status is applied by
 * hand or not at all. We are the one part of the stack that already knows, because we just asked every
 * hostile whether it can perceive anybody.
 *
 * The test is deliberately the literal definition and nothing cleverer: a guard punched in the open can
 * see who punched it and is not surprised, while one shot out of the dark by a hidden rogue cannot see a
 * soul and is. It has to run BEFORE any initiative is rolled, which is why it sits above `rollNPC`.
 *
 * Players are never marked. Perception is one-way by design — nothing here ever tests a player as the
 * spotter — so we have no honest basis for saying a character was unaware, and inventing one would hand
 * out Disadvantage on a guess. Ambushing the party stays the GM's call.
 */
async function applySurprise(joining: any[]): Promise<void> {
  if (!isSurpriseEnabled()) return;
  const party = tokensOnScene().filter(isPlayerToken);
  if (party.length === 0) return;

  const vision = new Map<string, any>();
  const caught: any[] = [];
  try {
    for (const token of joining) {
      if (!isHostile(token)) continue;
      if (party.some((player) => perceives(token, player, vision))) continue;
      caught.push(token);
    }
  } finally {
    for (const source of vision.values()) {
      try {
        source?.destroy?.();
      } catch {
        /* nothing worth failing an engagement over */
      }
    }
  }
  if (caught.length === 0) return;

  for (const token of caught) {
    try {
      await token.actor?.toggleStatusEffect?.(SURPRISED_STATUS, { active: true });
    } catch (err) {
      log(`could not mark ${token?.name} as surprised:`, err);
    }
  }

  const names = caught.map((t) => foundry.utils.escapeHTML(String(t.name ?? "?"))).join(", ");
  log(`perception: ${caught.length} caught unawares — ${names}`);
  const ChatMessage = (globalThis as any).ChatMessage;
  await ChatMessage.create({
    content: `<p><strong>${names}</strong> ${caught.length > 1 ? "are" : "is"} ${game.i18n.localize(
      "NOODLRHOOKS.Combat.AutoEngage.Surprised",
    )}</p>`,
    speaker: narrator(),
    flags: { [MODULE_ID]: { autoEngage: true } },
  });
}

/** Lift the surprise once the fight it applied to is over. */
async function clearSurprise(): Promise<void> {
  for (const token of tokensOnScene()) {
    try {
      if (token?.document?.hasStatusEffect?.(SURPRISED_STATUS)) {
        await token.actor?.toggleStatusEffect?.(SURPRISED_STATUS, { active: false });
      }
    } catch {
      /* a status that will not lift is not worth failing on */
    }
  }
}

/**
 * Start the fight.
 */
async function engage(spotter: any, target: any, why?: string): Promise<void> {
  const scene: any = (canvas as any)?.scene;
  const spotterName = String(spotter?.name ?? "Something");
  const targetName = String(target?.name ?? "someone");
  log(`perception: ${why ?? `${spotterName} spots ${targetName}`}; starting combat`);

  const joining = combatants(spotter);
  const allies = joining.filter((t) => isHostile(t)).length - 1;
  if (allies > 0)
    log(`perception: ${spotterName} calls in ${allies} other hostile(s) within earshot`);

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

    // Before any die is cast, because Surprise in 2024 is a modifier ON the initiative roll. Marking a
    // creature after it has rolled would be decoration.
    await applySurprise(joining);

    // NPCs only. Rolling a player's initiative for them takes away the one die roll they expect to make
    // at the start of a fight, and it is not the work the GM asked to be relieved of — they asked not to
    // have to roll for a dozen monsters and press "begin". The players' own buttons are waiting for them.
    await combat.rollNPC();

    const ChatMessage = (globalThis as any).ChatMessage;
    const opening = why
      ? `<strong>${foundry.utils.escapeHTML(String(why))}</strong>.`
      : `<strong>${foundry.utils.escapeHTML(spotterName)}</strong> spots ` +
        `<strong>${foundry.utils.escapeHTML(targetName)}</strong>.`;
    await ChatMessage.create({
      content: `<p>${opening} Roll for initiative!</p>`,
      // The spotter when there is one; a fight opened by damage has no spotter to speak for it.
      speaker: why ? narrator() : speakerFor(spotter, spotterName),
      flags: { [MODULE_ID]: { autoEngage: true } },
    });

    // Ask before beginning, not after. Starting a fight in which only the monsters have rolled puts a
    // monster at the top of a provisional order, and the round that follows is not the round the dice
    // would have given (user's test, 2026-08-04: every hostile acted and the player was unconscious
    // before ever rolling). The encounter is visible and everyone's roll button is live while we wait.
    if (!(await waitForInitiative(combat))) return;
    await combat.startCombat();
    Hooks.callAll("noodlrCombatInitiated", spotter, target);
  } catch (err) {
    log("could not start combat automatically:", err);
    // Loud, because the alternative is a GM who thinks the feature is on and is not being told it broke.
    ui.notifications?.warn(game.i18n.localize("NOODLRHOOKS.Combat.AutoEngage.Failed"));
    quietUntil = Date.now() + PEACE_MS;
  }
}
