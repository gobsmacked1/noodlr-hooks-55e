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
// The hard part — asking "can that monster see that player" at all, and the three silent traps in
// doing so — moved to `sight.ts` on 2026-08-16. This file is the policy that sits on top of it: when a
// yes starts a fight, who gets dragged in, who is surprised, and who is recorded as having found whom.
//
// A quiet period after every fight guards the obvious way this turns hostile: survivors who can still
// see the party would otherwise restart the encounter the instant the GM ended it.

import { log, MODULE_ID } from "../constants";
import { isFleeing } from "../tactics/flee";
import { isPrimaryGM } from "../util/gm";
import { narrator, speakerFor } from "../util/speaker";
import { announceRuling } from "../integration/contract";
import { readHp } from "../core/tracker";
import {
  getCombatAutomation,
  getEngageRadius,
  isAutoEngageEnabled,
  isStealthEnabled,
  isSurpriseEnabled,
} from "../settings";
import { SURPRISED_STATUS } from "../system/dnd5e-stealth";
import { forgetSightings } from "../tactics/awareness";
import { initiativeSettled } from "../tactics/hooks";
import {
  enabledModes,
  forgetEvasionNotices,
  perceives,
  releaseVision,
  separation,
  sightOf,
  type VisionCache,
} from "./sight";
import {
  describeSenses,
  describeStealth,
  evades,
  hidingState,
  noteLostSight,
  noteSpotted,
  passivePerception,
} from "./stealth";

export { observersWhoSee } from "./sight";

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

let timer: number | null = null;
let sweeping = false;
let quietUntil = 0;

export function registerPerceptionWatch(): void {
  Hooks.on("deleteCombat", () => {
    quietUntil = Date.now() + PEACE_MS;
    forgetEvasionNotices();
    forgetSightings();
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
  // One vision source per spotter, reused across the party and across both passes below. Building the
  // source runs a full wall sweep, which is the entire cost of this feature; testing an extra target
  // against an existing one is arithmetic. Never build inside an inner loop.
  const vision: VisionCache = new Map();
  try {
    const combat = activeCombat();
    const already = combat?.started ? enlisted(combat) : new Set<string>();
    const living = tokensOnScene().filter(isHostile);
    const party = tokensOnScene().filter(isPlayerToken);

    // Who-can-see-whom bookkeeping runs over EVERY hostile, including the ones already fighting, and it
    // runs before the engage check so that decision reads fresh state. The engage check below cannot do
    // this job: it deliberately ignores enlisted creatures, and breaking line of sight matters most in
    // the middle of a fight.
    await maintainSpotted(living, party, vision);

    // Creatures already fighting have nothing to notice. Everyone else keeps watching, so a warband
    // that was out of earshot when the fight started can still wander into it (user, 2026-08-05).
    const hostiles = living.filter((t) => !already.has(String(t.id)));
    if (hostiles.length === 0 || party.length === 0) return;

    // Closest pair first, so the creature that would plausibly notice first is the one that does.
    const pairs: Array<{ spotter: any; target: any; distance: number }> = [];
    for (const spotter of hostiles) {
      for (const target of party) {
        pairs.push({ spotter, target, distance: separation(spotter, target) });
      }
    }
    pairs.sort((a, b) => a.distance - b.distance);

    for (const { spotter, target } of pairs) {
      if (!perceives(spotter, target, vision)) continue;
      if (combat?.started) {
        await reinforce(combat, spotter, `${spotter.name} spots ${target.name}`);
      } else {
        await engage(spotter, target);
      }
      return;
    }
  } catch (err) {
    log("perception sweep failed:", err);
  } finally {
    // These are ours and were never registered with the canvas; leaving them would leak polygons.
    releaseVision(vision);
    sweeping = false;
  }
}

/**
 * Keep each hider's list of watchers-who-have-them current, in both directions.
 *
 * This is the whole of the per-observer stealth model's upkeep, and it replaced a much blunter rule: a
 * hidden creature that any one enemy found used to be revealed to EVERYBODY, status lifted and roll
 * discarded. That is right for invisibility ending and wrong for hiding, and the difference is the point
 * — a rogue sneaking past four guards who is clocked by one of them has been clocked by one of them.
 *
 * Only runs when somebody is actually hiding, which is nearly never, so the cost of building a vision
 * source per hostile is not paid by an ordinary fight.
 */
async function maintainSpotted(hostiles: any[], party: any[], cache: VisionCache): Promise<void> {
  if (!isStealthEnabled() || hostiles.length === 0) return;

  for (const target of party) {
    const hiding = hidingState(target);
    if (!hiding) continue;

    const found: string[] = [];
    const lost: string[] = [];
    const present = new Set<string>();

    for (const spotter of hostiles) {
      const id = String(spotter.id);
      present.add(id);
      const { seen, useModes } = sightOf(spotter, target, cache);
      if (!seen) {
        // Sight is the only test for LOSING somebody. Re-running the contest here would let a watcher
        // forget a creature it had already found and re-find it on alternate sweeps, which at the table
        // reads as the hide flickering on and off.
        if (hiding.spotted.has(id)) lost.push(id);
        continue;
      }
      if (hiding.spotted.has(id)) continue;
      if (!evades(spotter, target, separation(spotter, target), useModes)) found.push(id);
    }

    // A watcher that has left the scene or died keeps no claim on anybody.
    for (const id of hiding.spotted) if (!present.has(id)) lost.push(id);

    if (found.length > 0) await noteSpotted(target, found);
    if (lost.length > 0) await noteLostSight(target, lost);
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
  // A creature that is still running, or whose token is waiting to be taken off the scene,
  // must not start a new fight the moment the last one ended.
  if (isFleeing(token?.document ?? token)) return false;
  return alive(token);
}

function isPlayerToken(token: any): boolean {
  return Boolean(token?.actor?.hasPlayerOwner) && alive(token);
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
  const vision: VisionCache = new Map();
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
    releaseVision(vision);
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
    await announceRuling({
      kind: "encounter",
      summary: `${names} ${joining.length > 1 ? "join" : "joins"} the fight.`,
      detail: { reinforcements: joining.map((t) => String(t?.name ?? "")) },
      combat,
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

  const vision: VisionCache = new Map();
  const caught: any[] = [];
  try {
    for (const token of joining) {
      if (!isHostile(token)) continue;
      if (party.some((player) => perceives(token, player, vision))) continue;
      caught.push(token);
    }
  } finally {
    releaseVision(vision);
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
  const line = `${names} ${caught.length > 1 ? "are" : "is"} ${game.i18n.localize(
    "NOODLRHOOKS.Combat.AutoEngage.Surprised",
  )}`;
  await ChatMessage.create({
    content: `<p><strong>${names}</strong> ${caught.length > 1 ? "are" : "is"} ${game.i18n.localize(
      "NOODLRHOOKS.Combat.AutoEngage.Surprised",
    )}</p>`,
    speaker: narrator(),
    flags: { [MODULE_ID]: { autoEngage: true } },
  });
  await announceRuling({
    kind: "surprise",
    summary: line,
    detail: { surprised: caught.map((t) => String(t?.name ?? "")) },
    combat: game.combat,
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
    await announceRuling({
      kind: "encounter",
      summary: why
        ? `${why}. Roll for initiative!`
        : `${spotterName} spots ${targetName}. Roll for initiative!`,
      detail: { spotter: spotterName, spotted: targetName, cause: why ?? "perception" },
      token: spotter,
      combat,
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
