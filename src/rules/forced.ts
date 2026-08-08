// Noticing that a rule just pushed somebody, so the engine can act on it.
//
// The moving is the easy half. This is the hard half, because dnd5e never writes down the two facts the
// rules hang on. Whether an attack hit is recomputed in the chat card's renderer and stored nowhere; a
// saving-throw message carries the DC, the ability and the result but has NO reference to the activity
// that demanded it. So both answers have to be reconstructed, and the reconstruction has to happen on
// the GM's client, because the per-roll hooks (`dnd5e.rollAttack`, `dnd5e.rollSavingThrow`) are ordinary
// local hooks that fire only on the client that rolled — a player's attack is invisible through them.
//
// WHAT IS LISTENED TO, therefore: chat messages, which every client receives. Two paths, because midi
// changes not the data but which event carries it.
//
//   NATIVE. `createChatMessage`. An attack message is `flags.dnd5e.roll.type === "attack"` and carries
//   `flags.dnd5e.targets` as `{name, img, uuid, ac}`; the verdict is dnd5e's own formula applied to
//   `rolls[0]`. A save message is `roll.type === "save"` with the DC at `rolls[0].options.target`, and is
//   tied back to its cause through `flags.dnd5e.originatingMessage` — the id of the usage card whose
//   button was clicked.
//
//   MIDI. `updateChatMessage`. Midi suppresses the separate roll messages (`message.create ??= false`)
//   and instead fills one card in, writing the verdicts into flags as it goes:
//   `flags["midi-qol"].hitTargetUuids` and `.failedSaveUuids`. Those are TOKEN uuids, which is strictly
//   better than dnd5e's actor uuids, and they are unconditional — not subject to midi's SaveToChatCard
//   setting. When they are present they are used in preference to anything recomputed, because they are
//   the real answer rather than a reconstruction of one.
//
// Presence of the flags is what selects the path, not presence of the module: midi has settings that
// turn its own automation off, and a card without those flags needs the native reading even in a world
// where midi is installed.
//
// THREE THINGS ARE HEURISTICS AND ARE LOGGED AS SUCH, never presented as certainties:
//   * A target whose recorded AC is null (total cover, or an AC we could not read — dnd5e conflates the
//     two) is skipped rather than guessed at. Note that this DIVERGES from dnd5e's own renderer, whose
//     formula scores a null AC as a hit through `total < null` coercing to `total < 0`.
//   * Anything rolled from a sheet rather than from a card button has no `originatingMessage`, so a save
//     made that way cannot be attributed to any activity at all.
//   * Concentration saves are byte-identical to ordinary saves on the message, so they are only excluded
//     by the activity correlation above rather than by anything intrinsic.

import { log } from "../constants";
import { isPrimaryGM } from "../util/gm";
import { isForcedMovementEnabled } from "../settings";
import { readHp } from "../core/tracker";
import {
  forcedDistance,
  forcedRules,
  grapplerUuidOf,
  sizeAllows,
  type ForcedRule,
  type Trigger,
} from "../system/dnd5e-forced-movement";
import {
  clearForcedHistory,
  dragAlong,
  isForcedMovement,
  pendingUndoCount,
  shove,
  undoForcedMovement,
} from "./shove";

/** Rule applications already performed, so neither path can repeat the other's work. */
const applied = new Set<string>();

/** Actor id + rule label -> the turn it was last used on, for the once-per-turn riders. */
const usedOn = new Map<string, string>();

export function registerForcedMovement(): void {
  Hooks.on("createChatMessage", (message: any) => {
    void examine(message, message?.flags).catch((err) => log("forced movement failed:", err));
  });

  // Midi fills one card in over several updates, so this fires repeatedly for the same message with
  // different flags each time. `changed` says which phase this update is, and `applied` stops any
  // overlap with the native path.
  Hooks.on("updateChatMessage", (message: any, changed: any) => {
    void examine(message, changed?.flags).catch((err) => log("forced movement failed:", err));
  });

  // A grappler that walks takes its captive with it. Nothing in dnd5e models this: `grappled` zeroes the
  // victim's own Speed and there it ends.
  Hooks.on("moveToken", (doc: any, movement: any, operation: any) => {
    if (!active()) return;
    // Our own displacements must not cascade, and a captive being dragged is itself a forced move.
    if (isForcedMovement(movement, operation)) return;
    void dragCaptives(doc, movement).catch((err) =>
      log("could not drag a grappled creature:", err),
    );
  });

  Hooks.on("deleteCombat", () => {
    applied.clear();
    usedOn.clear();
    clearForcedHistory();
  });

  const generation = Number((game as any)?.release?.generation ?? 13);
  Hooks.on(generation >= 13 ? "renderChatMessageHTML" : "renderChatMessage", wireUndoButton);
}

function active(): boolean {
  return isPrimaryGM() && isForcedMovementEnabled();
}

/**
 * Which turn we are on, or null when there is no fight.
 *
 * Null rather than a placeholder because the once-per-turn riders are meaningless outside combat, and a
 * constant placeholder would make "once per turn" mean "once ever" for a GM testing a feature.
 */
function stamp(): string | null {
  const combat: any = game.combat;
  if (!combat?.started) return null;
  return `${combat.id}:${combat.round ?? 0}:${combat.turn ?? 0}`;
}

// ── Reading a message ─────────────────────────────────────────────────────────────────────────────────

/** The TokenDocument a chat message speaks for, or null when it does not name one. */
function speakerToken(speaker: any): any {
  const sceneId = String(speaker?.scene ?? "");
  const tokenId = String(speaker?.token ?? "");
  if (sceneId && tokenId) {
    const doc = (game.scenes as any)?.get(sceneId)?.tokens?.get(tokenId);
    if (doc) return doc;
  }
  // No token on the speaker: the actor's tokens on the current scene are the only remaining guess, and
  // it is only unambiguous when there is exactly one of them.
  const actor: any = speaker?.actor ? (game.actors as any)?.get(String(speaker.actor)) : null;
  const tokens = actor?.getActiveTokens?.() ?? [];
  return tokens.length === 1 ? (tokens[0]?.document ?? null) : null;
}

/**
 * The token behind an ACTOR uuid, which is what dnd5e records for each target.
 *
 * Unlinked tokens resolve exactly, because their synthetic actor knows its own token. Linked ones do
 * not: the uuid contains no token at all, and dnd5e additionally keys its target map by actor uuid, so
 * two copies of the same linked creature collapse into a single entry before we ever see it. That loss
 * is in the system's data and cannot be recovered here — only reported.
 */
function tokenFromActorUuid(uuid: string): any {
  try {
    const actor: any = (globalThis as any).fromUuidSync?.(uuid);
    if (!actor) return null;
    if (actor.token) return actor.token;
    const tokens = actor.getActiveTokens?.() ?? [];
    if (tokens.length === 1) return tokens[0]?.document ?? null;
    if (tokens.length > 1) {
      log(
        `forced movement: ${String(actor.name ?? uuid)} has ${tokens.length} tokens on this scene and ` +
          `the target record cannot say which was hit; skipping rather than guessing`,
      );
    }
    return null;
  } catch {
    return null;
  }
}

function tokenFromTokenUuid(uuid: string): any {
  try {
    const doc: any = (globalThis as any).fromUuidSync?.(uuid);
    return doc?.documentName === "Token" ? doc : (doc?.document ?? null);
  } catch {
    return null;
  }
}

function itemOf(message: any): any {
  const uuid = String(message?.flags?.dnd5e?.item?.uuid ?? "");
  if (!uuid) return null;
  try {
    return (globalThis as any).fromUuidSync?.(uuid) ?? null;
  } catch {
    return null;
  }
}

/** The activity that ran, looked up on its item — activity uuids do not resolve through `fromUuid`. */
function activityOf(message: any, item: any): any {
  const id = String(message?.flags?.dnd5e?.activity?.id ?? "");
  if (!id || !item) return null;
  try {
    return item.system?.activities?.get?.(id) ?? null;
  } catch {
    return null;
  }
}

/**
 * The weapon mastery in use, if any.
 *
 * dnd5e copies the chosen mastery onto its own attack message at `flags.dnd5e.roll.mastery`, which is
 * the authoritative reading. Under midi that separate message is never created, so the weapon's own
 * mastery property is the fallback — best-effort, and only trusted as far as being a string.
 */
function masteryOf(message: any, item: any): string {
  const flagged = String(message?.flags?.dnd5e?.roll?.mastery ?? "");
  if (flagged) return flagged;
  const declared = item?.system?.mastery;
  return typeof declared === "string" ? declared : "";
}

/** Damage types on a message, one per roll — a DamageRoll carries exactly one. */
function damageTypesOf(message: any): string[] {
  const out: string[] = [];
  for (const roll of message?.rolls ?? []) {
    const type = String((roll as any)?.options?.type ?? "");
    if (type) out.push(type.toLowerCase());
  }
  // Midi summarises the same information in its own flags, which is the only reading available when the
  // rolls live on a card it assembled rather than on a dedicated damage message.
  for (const entry of message?.flags?.["midi-qol"]?.damageDetail ?? []) {
    const type = String(entry?.type ?? "");
    if (type) out.push(type.toLowerCase());
  }
  return out;
}

/** Did this attack roll beat that target's AC, by dnd5e's own arithmetic? */
function hitTargets(message: any): any[] {
  const roll: any = message?.rolls?.[0];
  if (!roll) return [];
  const total = Number(roll.total);
  if (!Number.isFinite(total)) return [];

  const out: any[] = [];
  for (const target of message?.flags?.dnd5e?.targets ?? []) {
    const ac = (target as any)?.ac;
    if (ac === null || ac === undefined) {
      log(
        `forced movement: no readable AC for ${String((target as any)?.name ?? "a target")} — total ` +
          `cover, or a sheet we cannot read. Not treating it as a hit either way.`,
      );
      continue;
    }
    const missed = !roll.isCritical && (total < Number(ac) || roll.isFumble);
    if (missed) continue;
    const doc = tokenFromActorUuid(String((target as any)?.uuid ?? ""));
    if (doc) out.push(doc);
  }
  return out;
}

// ── Deciding and applying ────────────────────────────────────────────────────────────────────────────

/**
 * One rule out of however many matched.
 *
 * A warlock may hold Repelling Blast and Grasp of Hadar at once, and the rules let them choose per beam.
 * Pushing is preferred, because a warlock who bought both is far likelier to be keeping something at
 * arm's length than reeling it in, and the GM can undo the one time that reading is wrong. Beyond that
 * the greater distance wins, and only ONE rule is ever applied per event: stacking a mastery push onto a
 * feat push automatically would be a rules interpretation, not an automation.
 */
function chooseRule(rules: ForcedRule[]): ForcedRule | null {
  if (rules.length === 0) return null;
  const ranked = [...rules].sort((a, b) => {
    if (a.direction !== b.direction) return a.direction === "away" ? -1 : 1;
    return b.distance - a.distance;
  });
  if (ranked.length > 1) {
    log(
      `forced movement: ${ranked.map((r) => r.label).join(" and ")} both apply; taking ` +
        `${ranked[0].label}`,
    );
  }
  return ranked[0];
}

/**
 * Has another package already automated this item?
 *
 * Both premades collections leave a marker on the documents they drive, and two modules pushing for one
 * hit is worse than neither doing it. A name check, not a dependency: with neither installed, nothing
 * here changes.
 */
function alreadyAutomated(item: any, activity: any): string | null {
  const modules: any = (game as any).modules;
  if (activity?.flags?.cat?.macros && modules?.get?.("chris-premades")?.active) {
    return "Chris's Premades";
  }
  if (item?.flags?.["gambits-premades"]?.gpsUuid && modules?.get?.("gambits-premades")?.active) {
    return "Gambit's Premades";
  }
  return null;
}

function movedThisTurn(doc: any): number {
  let total = 0;
  for (const waypoint of doc?.movementHistory ?? []) {
    const cost = Number(waypoint?.cost);
    if (Number.isFinite(cost)) total += cost;
  }
  return total;
}

function down(doc: any): boolean {
  if (doc?.combatant?.isDefeated) return true;
  const hp = readHp(doc?.actor);
  return hp?.value !== null && hp?.value !== undefined && hp.value <= 0;
}

function hasAnyStatus(actor: any, statuses: string[]): boolean {
  try {
    for (const status of statuses) if (actor?.statuses?.has?.(status)) return true;
  } catch {
    /* an unreadable status set is not evidence either way */
  }
  return false;
}

/** Give effects from the same activation time to land before reading the target's conditions. */
function breathe(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function applyRule(
  rule: ForcedRule,
  pusherDoc: any,
  targetDoc: any,
  activationId: string,
): Promise<void> {
  if (!targetDoc) return;
  if (pusherDoc && String(pusherDoc.id) === String(targetDoc.id)) return;
  if (down(targetDoc)) return;

  const pusher = pusherDoc?.actor;
  const target = targetDoc?.actor;

  if (!sizeAllows(rule, pusher, target)) {
    log(`forced movement: ${String(targetDoc.name)} is too large for ${rule.label} to move`);
    return;
  }
  if (rule.afterMoving !== undefined && movedThisTurn(pusherDoc) < rule.afterMoving) {
    log(
      `forced movement: ${rule.label} needs a ${rule.afterMoving}-unit run-up and ` +
        `${String(pusherDoc?.name ?? "the attacker")} has covered ${movedThisTurn(pusherDoc)}`,
    );
    return;
  }

  const turn = stamp();
  const onceKey = `${String(pusher?.id ?? "?")}|${rule.label}`;
  if (rule.oncePerTurn && turn && usedOn.get(onceKey) === turn) {
    log(`forced movement: ${rule.label} is once per turn and has already been used`);
    return;
  }

  // Keyed on the ACTIVATION rather than on the turn, so a card midi revises several times cannot push
  // twice for one hit while a spell used twice in a turn still pushes twice.
  const key = `${activationId}|${String(targetDoc.uuid)}|${rule.label}`;
  if (applied.has(key)) return;
  // Bounded purely so a long session cannot grow this without limit. Losing the oldest entries costs
  // nothing: their chat cards are far out of scroll by then.
  if (applied.size > 500) applied.clear();
  applied.add(key);

  // Shove is the one rule whose own data cannot say what the attacker chose: 2024 folds grapple and
  // shove into a single save activity, and the difference only becomes visible once the effects land.
  if (rule.unlessStatus) {
    await breathe(700);
    if (hasAnyStatus(target, rule.unlessStatus)) {
      log(
        `forced movement: ${String(targetDoc.name)} came away ` +
          `${rule.unlessStatus.join(" or ")}, so ${rule.label} was not the 5-unit push`,
      );
      return;
    }
  }

  const result = await shove({
    token: targetDoc,
    by: pusherDoc,
    direction: rule.direction,
    distance: forcedDistance(rule, pusher),
    label: rule.label,
  });

  if (result.moved > 0) {
    if (rule.oncePerTurn && turn) usedOn.set(onceKey, turn);
  } else {
    log(
      `forced movement: ${rule.label} moved ${String(targetDoc.name)} nowhere — ${result.reason}`,
    );
  }
}

// ── The two reading paths ────────────────────────────────────────────────────────────────────────────

async function examine(message: any, changedFlags: any): Promise<void> {
  if (!active()) return;

  const midi = changedFlags?.["midi-qol"];
  if (midi?.hitTargetUuids || midi?.failedSaveUuids) {
    await fromMidi(message, midi);
    return;
  }

  const rollType = String(message?.flags?.dnd5e?.roll?.type ?? "");
  // Only act on a change that actually brought this information with it, or a midi card would be
  // re-examined on every unrelated update it receives.
  if (changedFlags && !changedFlags?.dnd5e) return;

  if (rollType === "attack") await fromAttack(message);
  else if (rollType === "save") await fromSave(message);
  else if (rollType === "damage") await fromDamage(message);
}

/** Midi has already decided who was hit and who failed; both lists are token uuids. */
async function fromMidi(message: any, midi: any): Promise<void> {
  const item = itemOf(message);
  const activity = activityOf(message, item);
  const conflict = alreadyAutomated(item, activity);
  if (conflict) {
    log(`forced movement: leaving ${String(item?.name ?? "this item")} to ${conflict}`);
    return;
  }

  const pusherDoc =
    speakerToken(message?.speaker) ?? tokenFromActorUuid(String(midi?.sourceActorUuid ?? ""));
  // Midi assembles one card per activation, so the card IS the activation identity.
  const activationId = String(message?.id ?? "");
  const query = {
    itemName: String(item?.name ?? ""),
    activityName: String(activity?.name ?? ""),
    pusher: pusherDoc?.actor,
  };

  const tokensFor = (uuids: unknown): any[] =>
    (Array.isArray(uuids) ? uuids : []).map((u) => tokenFromTokenUuid(String(u))).filter(Boolean);

  // A hit can satisfy a mastery, a plain on-hit rider and a damage-type rider all at once. Exactly one
  // is taken, in that order of authority, for the same reason as the native path: applying two at once
  // would be a rules interpretation rather than an automation.
  const hits = tokensFor(midi?.hitTargetUuids);
  if (hits.length > 0) {
    const rule =
      chooseRule(
        forcedRules({ ...query, trigger: "mastery", mastery: masteryOf(message, item) }),
      ) ??
      chooseRule(forcedRules({ ...query, trigger: "hit" })) ??
      chooseRule(forcedRules({ ...query, trigger: "damage", damageTypes: damageTypesOf(message) }));
    if (rule) {
      for (const targetDoc of hits) await applyRule(rule, pusherDoc, targetDoc, activationId);
    }
  }

  // Saves are a separate question with a separate answer: a spell can push everyone who failed without
  // any attack roll being involved at all.
  const failures = tokensFor(midi?.failedSaveUuids);
  if (failures.length > 0) {
    const rule = chooseRule(forcedRules({ ...query, trigger: "save" }));
    if (rule) {
      for (const targetDoc of failures) await applyRule(rule, pusherDoc, targetDoc, activationId);
    }
  }
}

/** An attack roll, with the hit recomputed the way the chat card would render it. */
async function fromAttack(message: any): Promise<void> {
  const item = itemOf(message);
  const activity = activityOf(message, item);
  const conflict = alreadyAutomated(item, activity);
  if (conflict) return;

  const targets = hitTargets(message);
  if (targets.length === 0) return;

  const pusherDoc = speakerToken(message?.speaker);
  // One attack roll, one message — which is what makes Repelling Blast push once per beam rather than
  // once per cantrip, since dnd5e emits a separate attack message for each.
  const activationId = String(message?.id ?? "");
  const query = {
    itemName: String(item?.name ?? ""),
    activityName: String(activity?.name ?? ""),
    pusher: pusherDoc?.actor,
  };

  // Mastery is checked first because it is data rather than a name match, and a weapon whose mastery
  // pushes should not also fire a name-matched rule for the same swing.
  const rule =
    chooseRule(forcedRules({ ...query, trigger: "mastery", mastery: masteryOf(message, item) })) ??
    chooseRule(forcedRules({ ...query, trigger: "hit" }));
  if (!rule) return;

  for (const targetDoc of targets) await applyRule(rule, pusherDoc, targetDoc, activationId);
}

/**
 * A failed saving throw, attributed to whatever activity demanded it.
 *
 * The attribution is the whole difficulty: a save message names its own roller and nothing else. What
 * makes it possible is `flags.dnd5e.originatingMessage`, the id of the card whose save button was
 * pressed — set only when the roll carried the click event, which means only from a card. A save rolled
 * off the sheet is genuinely unattributable and is left alone.
 */
async function fromSave(message: any): Promise<void> {
  const roll: any = message?.rolls?.[0];
  const dc = Number(roll?.options?.target);
  if (!Number.isFinite(dc)) return; // No DC means no verdict; `isFailure` would read false regardless.
  if (!roll.isFailure) return;

  const originId = String(message?.flags?.dnd5e?.originatingMessage ?? "");
  if (!originId) return;
  const origin: any = (game.messages as any)?.get?.(originId);
  if (!origin) return;

  const item = itemOf(origin);
  const activity = activityOf(origin, item);
  if (alreadyAutomated(item, activity)) return;

  const targetDoc = speakerToken(message?.speaker);
  if (!targetDoc) return;
  const pusherDoc = speakerToken(origin?.speaker);

  const rule = chooseRule(
    forcedRules({
      trigger: "save",
      itemName: String(item?.name ?? ""),
      activityName: String(activity?.name ?? ""),
      ability: String(message?.flags?.dnd5e?.roll?.ability ?? ""),
      pusher: pusherDoc?.actor,
    }),
  );
  if (!rule) return;

  // The usage card is the activation: every target's save button click points back at the same one.
  await applyRule(rule, pusherDoc, targetDoc, originId);
}

/**
 * Damage of a particular type landing, for the riders that key off one.
 *
 * That damage was rolled at all is taken as evidence the attack hit — dnd5e only offers the damage
 * button once, and a player who missed does not press it. A heuristic, and a mild one.
 */
async function fromDamage(message: any): Promise<void> {
  const types = damageTypesOf(message);
  if (types.length === 0) return;

  const item = itemOf(message);
  const activity = activityOf(message, item);
  if (alreadyAutomated(item, activity)) return;

  const pusherDoc = speakerToken(message?.speaker);
  const rule = chooseRule(
    forcedRules({
      trigger: "damage",
      itemName: String(item?.name ?? ""),
      activityName: String(activity?.name ?? ""),
      damageTypes: types,
      pusher: pusherDoc?.actor,
    }),
  );
  if (!rule) return;

  const activationId = String(message?.id ?? "");
  for (const target of message?.flags?.dnd5e?.targets ?? []) {
    const targetDoc = tokenFromActorUuid(String((target as any)?.uuid ?? ""));
    if (targetDoc) await applyRule(rule, pusherDoc, targetDoc, activationId);
  }
}

// ── Grappling ────────────────────────────────────────────────────────────────────────────────────────

/**
 * Take anyone this creature is holding along with it.
 *
 * Who holds whom is read from the `grappled` effect's `origin`, the only link dnd5e records between a
 * captive and its captor. Not modelled: the grappler's own halved Speed, which belongs to the movement
 * budget rather than here.
 */
async function dragCaptives(moverDoc: any, movement: any): Promise<void> {
  const moverActor = moverDoc?.actor;
  const origin = movement?.origin;
  if (!moverActor || !origin) return;

  const dx = Number(moverDoc?._source?.x ?? moverDoc?.x) - Number(origin.x);
  const dy = Number(moverDoc?._source?.y ?? moverDoc?.y) - Number(origin.y);
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || Math.hypot(dx, dy) < 1) return;

  const actorId = String(moverActor.id ?? "");
  for (const placeable of (canvas as any)?.tokens?.placeables ?? []) {
    const captive = placeable?.document;
    if (!captive || String(captive.id) === String(moverDoc.id)) continue;
    const holder = grapplerUuidOf(captive.actor);
    // The origin is usually the grappling ITEM's uuid, which contains the grappler's actor id.
    if (!holder || !actorId || !holder.includes(actorId)) continue;

    const result = await dragAlong(
      placeable,
      dx,
      dy,
      moverDoc,
      game.i18n.localize("NOODLRHOOKS.Combat.Forced.Grappled"),
    );
    if (result.moved > 0) {
      log(`forced movement: ${String(moverDoc.name)} dragged ${String(captive.name)} along`);
    }
  }
}

// ── GM controls and diagnostics ──────────────────────────────────────────────────────────────────────

/** The undo control on a forced-movement card. GM only: nobody else may move a hostile token. */
function wireUndoButton(_message: unknown, html: unknown): void {
  if (!game.user?.isGM) return;
  const root: HTMLElement | undefined =
    html instanceof HTMLElement ? html : ((html as any)?.[0] as HTMLElement | undefined);
  const button = root?.querySelector<HTMLButtonElement>('[data-action="noodlr-undo-shove"]');
  if (!button) return;
  button.addEventListener("click", async () => {
    button.disabled = true;
    const restored = await undoForcedMovement();
    ui.notifications?.info(
      game.i18n.format("NOODLRHOOKS.Combat.Forced.Restored", { count: String(restored) }),
    );
  });
}

/**
 * What the forced-movement layer can see, for the console.
 *
 * Reports which rules the SELECTED token could currently trigger, which is the question a GM actually
 * has when a feat did not fire: whether the feature was recognised at all.
 */
export function surveyForced(): unknown {
  const token: any = (canvas as any)?.tokens?.controlled?.[0];
  const actor = token?.actor;
  const triggers: Trigger[] = ["hit", "mastery", "save", "damage"];
  const recognised: Record<string, string[]> = {};

  for (const trigger of triggers) {
    recognised[trigger] = forcedRules({ trigger, pusher: actor })
      // Rules gated on a specific item or mastery cannot be judged without one, so only the
      // actor-gated ones (the feats and invocations) are meaningful here.
      .filter((rule) => Boolean(rule.requires))
      .map((rule) => `${rule.label} (${rule.direction} ${rule.distance})`);
  }

  return {
    enabled: isForcedMovementEnabled(),
    selected: String(token?.document?.name ?? "— select a token —"),
    forceActionRegistered: Boolean(
      (globalThis as any).CONFIG?.Token?.movement?.actions?.noodlrForce,
    ),
    ownFeaturesRecognised: recognised,
    grappledBy: actor ? (grapplerUuidOf(actor) ?? "— nobody —") : "—",
    undoableDisplacements: pendingUndoCount(),
    appliedThisFight: applied.size,
    midiPresent: Boolean((game as any).modules?.get?.("midi-qol")?.active),
  };
}
