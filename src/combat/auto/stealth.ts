// Whether a creature that is trying not to be seen actually gets away with it.
//
// Foundry's vision pipeline answers "is there an unobstructed line to a lit token", which is a question
// about geometry. 5e's question is "did you beat their Perception", which is a question about dice, and
// nothing in core or dnd5e connects the two: the system ships a `hiding` status effect that is wired to
// absolutely nothing, and a Stealth roll's total is never persisted anywhere — it exists as a chat
// message and then it is gone. So a rogue who rolled 27 was spotted by a guard with passive Perception
// 10 the instant a wall stopped being in the way, which makes rogue-shaped play impossible against a
// module that starts fights automatically (user, 2026-08-04). This file is the missing half.
//
// WHERE THIS PLUGS IN, and why it is not a patch. Stealthy wraps every detection mode's `_canDetect`
// through libWrapper so that stealth affects what everyone's screen renders. We do not need to: our
// perception sweep builds its own throwaway vision source and calls `testVisibility` itself, so we own
// the call site and can simply refuse the result. That means no libWrapper, no ordering war with
// Stealthy or Vision 5e over the same prototype, and no risk of our automation query changing what the
// GM actually sees. It also means our answer is deliberately narrower than theirs: we decide whether a
// fight starts, not whether a token is drawn.
//
// WHAT COUNTS AS HIDING — and the bug that rewrote this paragraph (user, 2026-08-07). Until v0.4.43 any
// Stealth skill roll appearing in chat banked a hidden state, with no Hide action, no prerequisite, no DC
// and no expiry. A rogue who rolled Stealth once for any reason became permanently unnoticeable: hostiles
// never spotted them, never started a fight, and were stabbed to death without ever reacting. That is not
// a subtle bug, it is the wrong trigger, and it was inherited — Stealthy and Perceptive both bank on any
// `ste` roll on dnd5e, and neither clears on an attack. They get away with it because midi's
// `removeHiddenInvis` cleans up after them; it never knew about `flags.noodlr.stealth`, so nothing cleaned
// up after us.
//
// So the polarity is inverted. THE DECLARATION IS THE `hiding` STATUS, and a Stealth roll only supplies
// the number. Our own bank is not even read unless the status is present, which makes a stale flag
// structurally incapable of hiding anyone rather than something we have to remember to sweep up — and it
// means anything that removes the status ends the state, including midi, the GM, and the token HUD.
// dnd5e stamps that status itself from Cunning Action's Hide activity, Nimble Escape and Shadow Stealth,
// so for the creatures that can Hide as a bonus action the declaration is already machine-readable; for
// everyone else `auto/hide.ts` supplies the action the system never shipped.
//
// Stealthy and Perceptive are still consulted first and still win, because they own their own lifecycle
// and the GM can see their state in their own UI. That deference is the whole of our integration with
// them: no dependency, no patching.
//
// BEYOND MUNDANE HIDING. A rogue's Stealth roll is only the common case. Invisibility, Fog Cloud,
// Nondetection, Pass Without Trace and the rest are recognised by name from a table in
// `systems/dnd5e-concealment.ts`, and so are the things that see through them — truesight, See
// Invisibility, a wolf's keen senses. This file never learns a spell name: the table speaks a small
// abstract vocabulary of capabilities (`truesight`, `seeInvisible`, `blindsight`, `tremorsense`,
// `devilsSight`, `etherealSight`, `detectMagic`, `divination`, `hearing`) and the engine only matches
// tags against tags. Another game system is a sibling table, not a change here. See that file's header.
//
// THE CONTEST is passive Perception against the hider's Stealth total, and it is deliberately
// deterministic — no per-sweep roll. A poll that re-rolls every six seconds would eventually spot
// anyone by luck alone, which is a worse rule than either edition's. Ties go to the spotter, because
// the 2024 rules make the Stealth total the DC for a Perception check and a check meets its DC on equal.

import { LEGACY_MODULE_ID, log, MODULE_ID } from "../../constants";
import { hasFlag, readFlag } from "../../util/flags";
import { isPrimaryGM } from "../../util/gm";
import {
  concealmentsOn,
  detectorsOn,
  sheetSenses,
  type Concealment,
} from "../systems/dnd5e-concealment";
import { HIDING_STATUS, isVerbalSpell, keepsHiddenOnMiss } from "../systems/dnd5e-stealth";
import { screensBetween } from "./screens";

/** What we store when a declared hider rolls Stealth. Never read unless the status is up. */
interface Banked {
  dc: number;
  ts: number;
}

/** A creature's hidden state, whoever is keeping track of it. */
export interface Hiding {
  dc: number;
  from: string;
}

/**
 * How long a Stealth roll and a Hide declaration may be apart and still belong to each other.
 *
 * They arrive in either order and from different places: Cunning Action's Hide activity stamps the status
 * without rolling anything, so the player rolls Stealth separately, before or after. Thirty seconds is
 * long enough to cover a player fumbling between two buttons and short enough that a roll from an earlier
 * scene cannot attach itself to a later hide.
 */
const PAIRING_MS = 30_000;

/** Stealth totals looking for a declaration to attach to, by token id. */
const looseRolls = new Map<string, Banked>();

/** Skulkers whose attack outcome we are still waiting on, by token id, with the time we started. */
const awaitingOutcome = new Map<string, number>();

/** How long to wait for an attack's hit-or-miss before giving up and revealing anyway. */
const OUTCOME_MS = 15_000;

/**
 * Watch for the events that start and end a hidden state.
 *
 * Two different kinds of hook, for two different reasons. The DECLARATION and the roll are read from
 * documents and chat, which every client sees, so the primary GM is the single writer — no races and no
 * permission failures. The REVEAL is read from `dnd5e.rollAttack` and `dnd5e.postUseActivity`, which fire
 * only on the client that acted; that client always has permission, because a creature giving itself away
 * is always acted by someone who owns it. Reading the reveal from chat instead is what broke before: midi
 * merges the attack roll into its own card and creates no separate attack message, so the listener sat
 * there waiting for something that never came.
 */
export function registerStealthWatch(): void {
  Hooks.on("createChatMessage", (message: any) => {
    if (!isPrimaryGM()) return;
    const roll: any = message?.flags?.dnd5e?.roll;
    if (String(roll?.type ?? "") !== "skill") return;
    if (String(roll?.skillId ?? "") !== "ste") return;
    const total = Number(message?.rolls?.[0]?.total);
    if (Number.isFinite(total)) void noteStealthRoll(message?.speaker, total);
  });

  // Every route to the status lands here: dnd5e's own Hide activities, the token HUD, another module, and
  // our own Hide action. One listener, so none of them can arrive unnoticed.
  Hooks.on("createActiveEffect", (effect: any) => {
    if (!isPrimaryGM() || !carriesHiding(effect)) return;
    void declare(ownerOf(effect));
  });

  Hooks.on("deleteActiveEffect", (effect: any) => {
    if (!isPrimaryGM() || !carriesHiding(effect)) return;
    void forget(ownerOf(effect));
  });

  Hooks.on("dnd5e.rollAttack", (_rolls: any[], data: any) => {
    // The enricher fires this with a null subject for a bare `[[/attack]]` roll, which belongs to nobody.
    const actor = data?.subject?.actor;
    if (actor) void onAttackRolled(actor);
  });

  Hooks.on("dnd5e.postUseActivity", (activity: any) => {
    if (isVerbalSpell(activity?.item)) {
      void revealActor(activity?.actor, "cast a spell with a verbal component");
    }
  });

  // Only a Skulker ever needs these, and only between its attack roll and the card resolving, so the
  // common case costs a Map size check.
  Hooks.on("createChatMessage", (message: any) => {
    if (awaitingOutcome.size > 0) readOutcome(message);
  });
  Hooks.on("updateChatMessage", (message: any, changes: any) => {
    if (awaitingOutcome.size > 0) readOutcome(message, changes);
  });

  Hooks.on("deleteCombat", () => {
    // A fight is loud. Whatever anyone was hiding behind, it is over now.
    void clearScene();
  });
}

/**
 * Did that attack connect? True, false, or null for "cannot tell".
 *
 * A near-twin of `forced.ts`'s `hitTargets`, and deliberately a separate function rather than a shared
 * one, because it answers a different question: that one lists which targets were hit, and an empty list
 * from it means "nobody", while here an empty list means "no idea". Conflating the two would turn an
 * untargeted swing into a miss and hand a Skulker permanent concealment — the exact failure this whole
 * release is about. Null therefore reveals.
 *
 * Midi is read from its own flags on `updateChatMessage`, because it merges everything into one card and
 * writes `hitTargetUuids` unconditionally; those are TOKEN uuids, and their presence is what selects this
 * path rather than the presence of the module, since midi can have its automation switched off.
 */
function attackConnected(message: any, changes?: any): boolean | null {
  const midi = (changes?.flags ?? message?.flags)?.["midi-qol"];
  const hitUuids = midi?.hitTargetUuids;
  if (Array.isArray(hitUuids)) return hitUuids.length > 0;

  if (String(message?.flags?.dnd5e?.roll?.type ?? "") !== "attack") return null;
  const roll: any = message?.rolls?.[0];
  const total = Number(roll?.total);
  if (!Number.isFinite(total)) return null;

  const targets = message?.flags?.dnd5e?.targets ?? [];
  if (targets.length === 0) return null;

  // Ahead of the AC comparison, because neither depends on it: a natural 20 hits whatever it was aimed
  // at, and a natural 1 misses. Inside the loop these would have been skipped whenever the only target's
  // AC was unreadable, which is precisely the case where the die is the only thing left to go on.
  if (roll?.isCritical) return true;
  if (roll?.isFumble) return false;

  let readable = 0;
  for (const target of targets) {
    const ac = (target as any)?.ac;
    // A null AC is total cover or an unreadable sheet, and dnd5e's own renderer scores it as a hit by
    // coercion. We decline to guess in either direction and simply do not count it.
    if (ac === null || ac === undefined) continue;
    readable += 1;
    if (total >= Number(ac)) return true;
  }
  return readable === 0 ? null : false;
}

/** Feed an attack card's outcome to whichever Skulker is waiting on it. */
function readOutcome(message: any, changes?: any): void {
  const hit = attackConnected(message, changes);
  if (hit === null) return;
  const speaker = message?.speaker;
  void resolveSniperOutcome(String(speaker?.actor ?? ""), String(speaker?.token ?? ""), hit);
}

/** The actor an effect belongs to. Conditions sit on the actor; a transferred one sits on an item. */
function ownerOf(effect: any): any {
  const parent = effect?.parent;
  if (!parent) return null;
  return parent.documentName === "Actor" ? parent : (parent.actor ?? null);
}

/** Does this effect carry the hiding status? */
function carriesHiding(effect: any): boolean {
  try {
    const statuses: any = effect?.statuses;
    return Boolean(statuses?.has?.(HIDING_STATUS) ?? statuses?.includes?.(HIDING_STATUS));
  } catch {
    return false;
  }
}

/** Is this creature currently declaring that it is hidden? */
function declaredHiding(doc: any): boolean {
  try {
    return Boolean(doc?.hasStatusEffect?.(HIDING_STATUS));
  } catch {
    return false;
  }
}

/** This creature's tokens on the current scene. */
function tokensOf(actor: any): any[] {
  const tokens: any[] = (canvas as any)?.tokens?.placeables ?? [];
  if (!actor) return [];
  // An unlinked token's synthetic actor knows its own token; that is the only exact answer available,
  // because every copy from one prototype reports the same base actor id.
  const own = actor?.token?.id ? String(actor.token.id) : "";
  if (own) return tokens.filter((t) => String(t?.id) === own);
  return tokens.filter((t) => String(t?.actor?.id ?? "") === String(actor?.id ?? ""));
}

/** Every token on the current scene the given chat speaker refers to. */
function spoken(speaker: any): any[] {
  const tokens: any[] = (canvas as any)?.tokens?.placeables ?? [];
  const tokenId = String(speaker?.token ?? "");
  if (tokenId) {
    const one = tokens.find((t) => String(t?.id) === tokenId);
    if (one) return [one];
  }
  // A linked character rolling from its sheet names only the actor. Unlinked tokens all share one actor
  // id, so this fallback is only safe once the token id has failed to match.
  const actorId = String(speaker?.actor ?? "");
  if (!actorId) return [];
  return tokens.filter((t) => String(t?.actor?.id ?? "") === actorId && t?.document?.actorLink);
}

/**
 * A Stealth roll happened. It does NOT hide anybody.
 *
 * If the creature has already declared, the roll is its DC — a real number in place of the passive
 * estimate. If it has not, the total waits briefly in case a declaration follows, and is otherwise
 * forgotten. This is the whole of the fix for the reported bug: a rogue rolling Stealth in the open is
 * now exactly as visible afterwards as before.
 */
async function noteStealthRoll(speaker: any, dc: number): Promise<void> {
  for (const token of spoken(speaker)) {
    const doc = token.document;
    if (!declaredHiding(doc)) {
      looseRolls.set(String(token.id), { dc, ts: Date.now() });
      log(`stealth: noted ${token.name}'s Stealth ${dc}; not hiding, so it does nothing yet`);
      continue;
    }
    await write(token, dc, `rolled Stealth ${dc} while hidden`);
  }
}

/**
 * A creature declared that it is hiding. Give it a DC.
 *
 * A roll it made moments ago is preferred, because that is what the player intended. Failing that, passive
 * Stealth stands in: someone who ticked the icon in the token HUD has stated an intention, and refusing to
 * act on it would make the status useless again.
 */
async function declare(actor: any): Promise<void> {
  for (const token of tokensOf(actor)) {
    // `auto/hide.ts` writes the total itself, because it knows the roll it just made and does not depend
    // on which client happened to see the chat message. A fresh number already in place is better than
    // anything we could work out here, so it is left alone rather than overwritten with a passive guess.
    const existing = readFlag(token.document, "stealth") as Banked | undefined;
    if (existing && Date.now() - Number(existing.ts ?? 0) <= PAIRING_MS) continue;

    const loose = looseRolls.get(String(token.id));
    if (loose && Date.now() - loose.ts <= PAIRING_MS) {
      looseRolls.delete(String(token.id));
      await write(token, loose.dc, `took the Hide action on a Stealth roll of ${loose.dc}`);
      continue;
    }
    const passive = Number(token?.actor?.system?.skills?.ste?.passive);
    const base = Number((globalThis as any).CONFIG?.DND5E?.skillPassive?.base ?? 10);
    await write(token, Number.isFinite(passive) ? passive : base, "took the Hide action without rolling");
  }
}

/** The status went away, so nothing is banked any more. */
async function forget(actor: any): Promise<void> {
  for (const token of tokensOf(actor)) await erase(token);
}

async function write(token: any, dc: number, why: string): Promise<void> {
  try {
    await token.document.setFlag(MODULE_ID, "stealth", { dc, ts: Date.now() } satisfies Banked);
    log(`stealth: ${token.name} ${why} — DC ${dc} to notice`);
  } catch (err) {
    log(`could not record ${token?.name}'s stealth:`, err);
  }
}

/** Drop every trace of a banked hide. Takes a Token placeable or a TokenDocument, indifferently. */
async function erase(tokenOrDoc: any): Promise<void> {
  const doc = tokenOrDoc?.document ?? tokenOrDoc;
  // Both namespaces: a world that hid someone while the old module owned this still has a row under
  // `noodlr`, and a banked hide nobody can clear is this feature's worst failure — it would suppress
  // every encounter forever and look exactly like the module being broken.
  for (const ns of [MODULE_ID, LEGACY_MODULE_ID]) {
    try {
      if (doc?.getFlag?.(ns, "stealth")) await doc.unsetFlag(ns, "stealth");
    } catch {
      /* a flag that will not clear is not worth failing on */
    }
  }
  const id = String(doc?.id ?? "");
  looseRolls.delete(id);
  awaitingOutcome.delete(id);
}

/**
 * Stop hiding, and say why.
 *
 * Both layers go: the status, because it is the declaration and anything reading it must agree, and the
 * banked DC, because a number without a declaration is the stale flag this whole redesign exists to make
 * impossible. Removing the status is what also tells midi, AC5e and the GM's own screen.
 */
export async function reveal(token: any, why: string): Promise<void> {
  const doc = token?.document ?? token;
  if (!doc) return;
  const hidden = declaredHiding(doc) || hasFlag(doc, "stealth");
  if (!hidden) return;

  // Status first, flag second. The other order leaves a window in which the status is still up and the
  // number is already gone, and `hidingState` reads that as hiding at passive Stealth — briefly hiding a
  // creature that just gave itself away. This order's window reads as not hiding at all, which is right.
  try {
    if (declaredHiding(doc)) {
      await doc.actor?.toggleStatusEffect?.(HIDING_STATUS, { active: false });
    }
  } catch (err) {
    log(`could not lift ${doc?.name}'s hiding status:`, err);
  }
  await erase(doc);
  log(`stealth: ${doc?.name ?? "someone"} is no longer hidden — ${why}`);
}

/** Reveal every token belonging to an actor. */
async function revealActor(actor: any, why: string): Promise<void> {
  for (const token of tokensOf(actor)) await reveal(token, why);
}

/**
 * An attack roll was made. Under the general rule that reveals you, hit or miss.
 *
 * Skulker's Sniper benefit is the exception the user was reaching for, and it is real RAW rather than a
 * house rule — but it costs us the ability to answer now, because "the roll misses" is not known at the
 * moment the dice land. So a Skulker's reveal is deferred until the outcome can be read, and a deadline
 * makes sure a card that never resolves cannot leave someone hidden forever. When in doubt we reveal:
 * a wrongly-revealed rogue is a bad turn, a wrongly-hidden one is the bug we are fixing.
 */
async function onAttackRolled(actor: any): Promise<void> {
  for (const token of tokensOf(actor)) {
    if (!declaredHiding(token.document)) continue;
    if (!keepsHiddenOnMiss(actor)) {
      await reveal(token, "made an attack roll");
      continue;
    }
    awaitingOutcome.set(String(token.id), Date.now());
    log(`stealth: ${token.name} has Skulker, so the reveal waits on whether the attack lands`);
    window.setTimeout(() => {
      if (!awaitingOutcome.has(String(token.id))) return;
      awaitingOutcome.delete(String(token.id));
      void reveal(token, "attacked, and the result never resolved");
    }, OUTCOME_MS);
  }
}

/**
 * The outcome of a Skulker's attack arrived. A hit reveals; a miss does not.
 *
 * Called from the same message readers `forced.ts` uses, because hit-or-miss is stored nowhere and has to
 * be recomputed the way the chat card renders it — or read out of midi's flags when midi is the one
 * deciding. Only the client that recorded the pending attack acts, which is the client that rolled it.
 */
export async function resolveSniperOutcome(actorId: string, tokenId: string, hit: boolean): Promise<void> {
  const tokens: any[] = (canvas as any)?.tokens?.placeables ?? [];
  for (const token of tokens) {
    const id = String(token.id);
    if (!awaitingOutcome.has(id)) continue;
    if (tokenId && id !== tokenId) continue;
    if (!tokenId && String(token?.actor?.id ?? "") !== actorId) continue;
    awaitingOutcome.delete(id);
    if (hit) await reveal(token, "attacked and hit");
    else log(`stealth: ${token.name} missed, and Skulker keeps them hidden`);
  }
}

/** Is anyone waiting on an attack outcome? Lets the readers skip the work when nobody is. */
export function sniperPending(): boolean {
  return awaitingOutcome.size > 0;
}

async function clearScene(): Promise<void> {
  looseRolls.clear();
  awaitingOutcome.clear();
  for (const token of (canvas as any)?.tokens?.placeables ?? []) {
    if (!hasFlag(token?.document, "stealth")) continue;
    await erase(token);
  }
}

/**
 * The DC to notice this creature, and who says so — or null when it is not hiding at all.
 *
 * Order matters: a module the GM installed and can see in their own UI outranks our invisible flag,
 * because when the two disagree the GM should be able to trust what is on their screen.
 */
export function hidingState(token: any): Hiding | null {
  const doc = token?.document ?? token;

  // Stealthy. `getBankedStealth` returns undefined when the creature is not hiding, which is exactly
  // the signal we want, and its author documented it as the integration surface.
  try {
    const stealthy: any = (window as any).stealthy;
    if (
      game.modules?.get?.("stealthy")?.active &&
      typeof stealthy?.getBankedStealth === "function"
    ) {
      const dc = Number(stealthy.getBankedStealth(token));
      if (Number.isFinite(dc)) return { dc, from: "Stealthy" };
    }
  } catch {
    /* their internals are not our contract; a throw means "no opinion" */
  }

  // Perceptive stores a passive DC per token, with -1 meaning "cannot be found".
  try {
    if (game.modules?.get?.("perceptive")?.active) {
      const raw = Number(doc?.getFlag?.("perceptive", "PPDCFlag"));
      if (Number.isFinite(raw) && raw !== 0) {
        return { dc: raw < 0 ? Number.POSITIVE_INFINITY : raw, from: "Perceptive" };
      }
    }
  } catch {
    /* same */
  }

  // OUR OWN STATE, AND THE ONE INVARIANT THAT MATTERS: no declaration, no hiding. The banked DC is not
  // consulted — not even looked at — unless the creature is currently carrying the status. That is what
  // makes a stale flag harmless instead of a permanent cloak, and it means every way of removing the
  // status (the token HUD, midi's `removeHiddenInvis`, an effect expiring, our own reveal) ends the state
  // without having to know we exist. Do not "optimise" this by reading the flag first.
  if (!hasStatus(doc, HIDING_STATUS)) return null;

  const own = readFlag(doc, "stealth") as Banked | undefined;
  if (Number.isFinite(Number(own?.dc))) return { dc: Number(own?.dc), from: "a Stealth roll" };

  // Declared but with no number of its own — the status arrived from somewhere that never rolled. Passive
  // Stealth is the honest stand-in, and it keeps the token HUD icon working as a declaration.
  const passive = Number(token?.actor?.system?.skills?.ste?.passive);
  const base = Number((globalThis as any).CONFIG?.DND5E?.skillPassive?.base ?? 10);
  return { dc: Number.isFinite(passive) ? passive : base, from: "the Hiding condition" };
}

/** Passive Perception, or the score of a creature with average Wisdom and no training. */
export function passivePerception(token: any): number {
  const passive = Number(token?.actor?.system?.skills?.prc?.passive);
  if (Number.isFinite(passive)) return passive;
  return Number((globalThis as any).CONFIG?.DND5E?.skillPassive?.base ?? 10);
}

function hasStatus(doc: any, id: string): boolean {
  try {
    return Boolean(doc?.hasStatusEffect?.(id));
  } catch {
    return false;
  }
}

/**
 * Everything this creature can bring to bear on someone trying not to be seen, at this distance.
 *
 * Senses are range-limited, because blindsight 30 is not blindsight. Capabilities that come from a spell
 * or a feature by name are not: their real ranges vary, and guessing wrongly in either direction is worse
 * than taking "I cast See Invisibility" to mean what it says.
 */
function capabilities(
  spotter: any,
  distance: number,
): { tags: Set<string>; divined: Set<string>; bonus: number } {
  const tags = new Set<string>();
  for (const [tag, range] of Object.entries(sheetSenses(spotter?.actor))) {
    if (distance <= range) tags.add(tag);
  }
  const named = detectorsOn(spotter?.actor);
  for (const tag of named.tags) tags.add(tag);
  // Only what a Divination spell granted. A creature's own senses are never in here, which is what lets
  // Nondetection stop a Locate Creature without blinding a demon.
  return { tags, divined: new Set(named.divined), bonus: named.bonus };
}

/** Concealment that carries no name we would match: the plain status effects. */
function statusVeils(target: any): Concealment[] {
  const doc = target?.document ?? target;
  const special: any = (globalThis as any).CONFIG?.specialStatusEffects ?? {};
  const found: Concealment[] = [];

  // Folded in here so a token made invisible by any route — a spell, a module, the GM ticking the icon —
  // reaches the same code as one carrying an effect named "Greater Invisibility".
  if (hasStatus(doc, String(special.INVISIBLE ?? "invisible"))) {
    found.push({
      label: "invisible",
      pierced: ["truesight", "seeInvisible", "blindsight", "tremorsense"],
      bonus: 0,
      absolute: true,
      negates: [],
      blocksDivination: false,
    });
  }
  if (hasStatus(doc, "ethereal")) {
    found.push({
      label: "on the Ethereal Plane",
      pierced: ["truesight", "etherealSight"],
      bonus: 0,
      absolute: true,
      negates: [],
      blocksDivination: false,
    });
  }
  return found;
}

/**
 * Every layer between a watcher and a creature: what it wears, what it is, and what stands in the way.
 *
 * Concealment is layered, and each layer is judged on its own. A watcher with See Invisibility gets past
 * the Invisibility but not the fog bank; only something like truesight, which appears in nearly every
 * `pierced` list, gets through everything at once. That is the intended shape — one capability that
 * beats all layers exists, but it has to be that good.
 */
function veils(spotter: any, target: any): Concealment[] {
  const found = concealmentsOn(target?.actor);
  for (const veil of [...statusVeils(target), ...screensBetween(spotter, target)]) {
    if (!found.some((seen) => seen.label === veil.label)) found.push(veil);
  }
  return found;
}

/**
 * Does `target` evade `spotter` this sweep? Returns why, or null when the creature is plainly seen.
 *
 * Order of resolution, and each step earns its place:
 *   1. Work out what the spotter can do, then let the hider's wards take capabilities away. Nondetection
 *      conceals nobody — it blinds the diviner — so it is applied to the watcher, and only to what the
 *      watcher was getting out of a Divination spell. Innate truesight is a creature's own eyes.
 *   2. Any unpierced absolute layer hides the creature outright, roll or no roll: an invisible bard who
 *      never touched the Stealth skill is still invisible, and a guard has to get past the interposed
 *      fog bank before it has any chance at the people behind it.
 *   3. Otherwise contest, with every layer's bonus added to the Stealth DC. This is where Pass Without
 *      Trace earns its +10 and a wolf's keen senses earn their +5 the other way.
 *
 * `useModes` says whether core's own detection modes already ran. When they did, core has enforced plain
 * invisibility itself and we must not judge it twice, or we would disagree with what is on screen.
 * Everything core knows nothing about — which is every layer bar invisibility — still applies.
 *
 * Distance reaches only the senses. The contest itself is rangeless: 5e gives no distance penalty to
 * Perception, and inventing one would be house-ruling in code.
 */
export function evades(
  spotter: any,
  target: any,
  distance: number,
  useModes: boolean,
): string | null {
  const present = veils(spotter, target);
  const { tags, divined, bonus } = capabilities(spotter, distance);
  for (const veil of present) {
    for (const lost of veil.negates) tags.delete(lost);
    if (veil.blocksDivination) for (const lost of divined) tags.delete(lost);
  }

  for (const veil of present) {
    if (!veil.absolute) continue;
    if (useModes && veil.label === "invisible") continue;
    if (veil.pierced.some((tag) => tags.has(tag))) continue;
    return veil.label;
  }

  const hiding = hidingState(target);
  if (!hiding) return null;

  const dc = hiding.dc + present.reduce((sum, veil) => sum + veil.bonus, 0);
  const perception = passivePerception(spotter) + bonus;
  if (perception >= dc) return null;

  const shown = Number.isFinite(dc) ? String(dc) : "unreachable";
  return `hidden — ${hiding.from} says DC ${shown} against passive Perception ${perception}`;
}

/** What a creature is doing to stay unseen from a given watcher, for diagnostics. */
export function describeStealth(token: any, spotter?: any): string {
  const parts: string[] = [];
  const hiding = hidingState(token);
  if (hiding) parts.push(`hiding at DC ${hiding.dc} (${hiding.from})`);
  for (const veil of veils(spotter, token)) parts.push(veil.label);
  return parts.length > 0 ? parts.join("; ") : "not hiding";
}

/** What a creature brings to spotting people, for diagnostics. */
export function describeSenses(token: any): string {
  const senses = Object.entries(sheetSenses(token?.actor)).map(
    ([tag, range]) => `${tag} ${Number.isFinite(range) ? range : "unlimited"}`,
  );
  const named = detectorsOn(token?.actor);
  const all = [...senses, ...named.labels];
  if (named.bonus) all.push(`+${named.bonus} passive Perception`);
  return all.length > 0 ? all.join(", ") : "nothing special";
}
