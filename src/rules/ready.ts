// The Ready action, which nothing else automates because nothing else can read the trigger.
//
// Every module that has attempted this offered a dropdown of half a dozen canned conditions, and the
// reason nobody used it is that the interesting readied actions are exactly the ones the dropdown does
// not contain. "If the Cutpurse flees, I Dash after them" is not a distance or a status; it is a reading
// of what a movement meant. So the trigger is a SENTENCE, 140 characters, in the player's own words, and
// the module that reads sentences reads it (user, 2026-08-14).
//
// THE ARCHITECTURE, which is the same trade `noodlrHooks.compile` already makes. `integration/watch.ts`
// hands the sentence to whatever is listening — in practice noodlr's players-only bot — and gets back a
// descriptor. Deterministic code here then disposes of nearly every event in the round for nothing, and
// only what survives the predicates costs a model call. **The model compiles, and where it cannot, it
// judges one narrow question at a time. It never adjudicates**, and it never decides whether the reaction
// is legal, what it costs, or whether it hits.
//
// NOTHING HERE REQUIRES IT. With no listener, the sentence field is not offered and the player picks from
// `cannedTriggers()` instead — the same finite list NPCs use. A table with no AI module installed gets a
// working Ready action with a picker, which is the baseline rather than a failure mode.
//
// THE ECONOMY, and it is the half people get wrong. Readying costs the ACTION, on your own turn, at the
// moment you declare. Releasing costs the REACTION, on somebody else's turn. That is two slots in two
// turns for one effect, and it is why a readied Attack is ONE attack: Extra Attack says "when you take the
// Attack action on your turn", and this is neither. It also fixes a bug this module already had — a
// readied swing arrived at the ledger claiming an Action, so the player was asked to confirm going over
// budget for something that had been paid for a turn earlier. Now the release is waved through
// (`clearNextUse`) and the Reaction is billed here instead.
//
// WHAT THE CLOCK IS ALLOWED TO DO, because this is the one place the prompt layer's rule bends. That rule
// is that a timeout may spend a renewing resource and never a depleting one. A readied Fireball is a spell
// slot, so by the letter the clock should never fire it — except the player already said, in writing, on
// their own turn, that this is what they wanted to happen. **The declaration IS the answer, so the clock
// honours it**: the confirm prompt defaults to firing, and aborting is the deliberate act. Defaulting the
// other way would cost the player their Action AND the effect for being slow to click, which is worse than
// casting the spell they told the table they were casting.
//
// HELD SPELLS DIVERGE FROM RAW, DELIBERATELY. See `system/dnd5e-ready.ts` — Foundry cannot represent a
// cast whose slot is spent and whose template is not yet placed, so the slot is spent on release and a
// trigger that never comes costs the Action only. The generous direction, stated in the announcement.

import { MODULE_ID, log } from "../constants";
import { isPrimaryGM, rollerForActor } from "../util/gm";
import { FLAG_NAMESPACE } from "../util/flags";
import { promptChoice, type Choice } from "../util/prompt";
import { askUser, registerQuery } from "../util/queries";
import { narrator, speakerFor } from "../util/speaker";
import { readActions, type CreatureAction } from "../tactics/actions";
import { useActionAt } from "../tactics/execute";
import { isReadyEnabled } from "../settings";
import { affordable, payBill, turnBill } from "./economy/bill";
import { clearNextUse } from "./economy/enforce";
import { hasReaction, spend } from "./economy/ledger";
import { canReact, alive } from "./offer";
import {
  cannedTriggers,
  forcedReady,
  isReadyActivity,
  isSpellItem,
  mentalScores,
  readiableActivation,
  requiresConcentration,
  READY_MENTAL_MIN,
} from "../system/dnd5e-ready";
import {
  requestWatchCompile,
  watchAvailable,
  type WatchDescriptor,
} from "../integration/watch";

const FLAG = "readied";
const QUERY = "ready-release";

/** What is being held, and what will let it go. Lives on the actor, so every client can read it. */
export interface ReadyRecord {
  /** The player's own words, or the canned trigger's summary. Shown when it fires. */
  prose: string;
  watch: WatchDescriptor;
  /** The held activity, by id. Null for a readied move. */
  itemId: string | null;
  activityId: string | null;
  label: string;
  move: boolean;
  spell: boolean;
  concentration: boolean;
  /**
   * Which turn this belongs to, or null out of combat.
   *
   * The action ledger's trick: nothing is ever cleared, because a stamp belonging to another turn reads
   * as absent. That is what makes expiry free and identical on every client, with no write and no race.
   */
  stamp: { combatId: string; round: number; turn: number } | null;
  /** How many judge calls this trigger may still spend. See `spendJudge`. */
  judges: number;
}

/**
 * A budget on model calls, per declaration.
 *
 * A `judge: true` descriptor asks a question per surviving candidate event, and a busy round on a crowded
 * map can produce dozens. Twelve is enough for any real trigger to fire and small enough that a badly
 * compiled one cannot bill somebody for a whole session; running out falls back to asking the human, which
 * is the same escalation an unanswered judge takes.
 */
const JUDGE_BUDGET = 12;

export function readiedOf(actor: any): ReadyRecord | null {
  const raw: any = actor?.flags?.[FLAG_NAMESPACE]?.[FLAG] ?? actor?.getFlag?.(FLAG_NAMESPACE, FLAG);
  if (!raw || typeof raw !== "object") return null;
  const record = raw as ReadyRecord;
  if (!record.watch || !Array.isArray(record.watch.events)) return null;
  return live(record) ? record : null;
}

/** The record as stored, expired or not. For the survey and for the expiry sweep. */
export function storedReady(actor: any): ReadyRecord | null {
  const raw: any = actor?.flags?.[FLAG_NAMESPACE]?.[FLAG] ?? actor?.getFlag?.(FLAG_NAMESPACE, FLAG);
  return raw && typeof raw === "object" ? (raw as ReadyRecord) : null;
}

/**
 * Is this declaration still good?
 *
 * "If the trigger does not occur before the start of your next turn, the readied action is lost." So it
 * survives the rest of the round it was declared in, and dies the moment the tracker comes back round to
 * the creature — which is `round + 1` at or past the declaring turn's index, or any later round.
 *
 * Out of combat there is no next turn to lose it at, so it stands until something clears it: a combat
 * starting, the scene changing, or its own release. A one-shot, which is the only honest reading when the
 * rule's expiry condition does not exist.
 */
function live(record: ReadyRecord): boolean {
  const stamp = record.stamp;
  if (!stamp) return true;
  const combat: any = (game.combats as any)?.get?.(stamp.combatId);
  if (!combat?.started) return false;
  const round = Number(combat.round ?? 0);
  if (round < stamp.round) return false;
  if (round === stamp.round) return true;
  if (round > stamp.round + 1) return false;
  return Number(combat.turn ?? 0) < stamp.turn;
}

function stampNow(): ReadyRecord["stamp"] {
  const combat: any = game.combat;
  if (!combat?.started) return null;
  return {
    combatId: String(combat.id ?? ""),
    round: Number(combat.round ?? 0),
    turn: Number(combat.turn ?? 0),
  };
}

async function write(actor: any, record: ReadyRecord | null): Promise<void> {
  try {
    if (record) await actor.setFlag(FLAG_NAMESPACE, FLAG, record);
    else await actor.unsetFlag(FLAG_NAMESPACE, FLAG);
  } catch (err) {
    log("ready: could not write the declaration:", err);
  }
}

// ---------------------------------------------------------------------------------------------------
// Declaration
// ---------------------------------------------------------------------------------------------------

/** Actors mid-declaration, waiting for the player to name what they are holding. */
const pending = new Map<string, { record: ReadyRecord; expires: number }>();

/**
 * The Ready button, caught on its way through the economy layer.
 *
 * Returns true to cancel the sheet's own activity, exactly as Hide, Stabilize and Influence do — the item
 * is a bare `utility` activity that produces a chat card and nothing else, so letting it through would
 * charge the Action and give the player no way to say what they were waiting for.
 */
export function interceptReadyActivity(activity: any): boolean {
  const actor = activity?.actor;
  if (!actor || !isReadyEnabled(actor) || !isReadyActivity(activity?.item, activity)) return false;
  const token = tokenFor(actor);
  void declare(actor, token).catch((err) => log("ready: the declaration failed:", err));
  return true;
}

/**
 * The second half of a declaration: whatever the player presses next is what they are holding.
 *
 * Cancelled rather than used, which is the whole point — the activity is being NAMED, not resolved. Called
 * from the very top of `police()`, before the rider and Incapacitated rules, because none of those are
 * about to happen.
 */
export function captureReadied(activity: any): boolean {
  const actor = activity?.actor;
  const key = String(actor?.uuid ?? "");
  const waiting = key ? pending.get(key) : undefined;
  if (!waiting) return false;

  if (Date.now() > waiting.expires) {
    pending.delete(key);
    return false;
  }

  if (!readiableActivation(activity?.activation?.type)) {
    ui.notifications?.warn(
      game.i18n.format("NOODLRHOOKS.Ready.NotAnAction", {
        name: String(activity?.name ?? activity?.item?.name ?? ""),
      }),
    );
    // Still cancelled: the player is picking, and letting a bonus action resolve for real in the middle
    // of that would spend it for nothing. They can press something else.
    return true;
  }

  pending.delete(key);
  const item = activity?.item;
  const record: ReadyRecord = {
    ...waiting.record,
    itemId: String(item?.id ?? "") || null,
    activityId: String(activity?.id ?? "") || null,
    label: String(activity?.item?.name ?? activity?.name ?? ""),
    spell: isSpellItem(item),
    concentration: requiresConcentration(item, activity),
  };
  void commit(actor, record).catch((err) => log("ready: could not commit the declaration:", err));
  return true;
}

/** Ask for a trigger, then for the action. */
async function declare(actor: any, token: any): Promise<void> {
  if (!allowedToReady(actor)) {
    ui.notifications?.warn(
      game.i18n.format("NOODLRHOOKS.Ready.TooSimple", { name: String(actor?.name ?? "") }),
    );
    return;
  }

  // Priced before anything is asked, so a creature with no Action left is told at the button rather than
  // after composing a sentence. Refuses rather than offering the over-budget dialog, for the reason
  // `bill.ts` gives: that dialog exists for features which raise the allowance, and this is not one.
  const bill = turnBill(actor, "action");
  if (!affordable(bill)) {
    ui.notifications?.warn(
      game.i18n.format("NOODLRHOOKS.Ready.NoAction", { name: String(actor?.name ?? "") }),
    );
    return;
  }

  const chosen = await askForTrigger(actor, token);
  if (!chosen) return;

  const base: ReadyRecord = {
    prose: chosen.prose,
    watch: chosen.watch,
    itemId: null,
    activityId: null,
    label: "",
    move: chosen.move,
    spell: false,
    concentration: false,
    stamp: stampNow(),
    judges: chosen.watch.judge ? JUDGE_BUDGET : 0,
  };

  if (chosen.move) {
    base.label = game.i18n.localize("NOODLRHOOKS.Ready.Move");
    await commit(actor, base);
    return;
  }

  // A window rather than a modal picker: the readied action has to be chosen FROM THE SHEET, because the
  // sheet is the only place that knows which of a creature's forty activities are real, prepared, in
  // range and off cooldown. Reproducing that judgement in a dropdown is how a picker ends up offering a
  // spell nobody has prepared.
  pending.set(String(actor?.uuid ?? ""), { record: base, expires: Date.now() + 60000 });
  ui.notifications?.info(game.i18n.localize("NOODLRHOOKS.Ready.PickAction"));
}

interface Trigger {
  prose: string;
  watch: WatchDescriptor;
  move: boolean;
}

/**
 * The sentence, or the picker, or both.
 *
 * The text field is offered only when something is listening on `noodlrHooks.watch`: a field whose
 * contents nothing can read is worse than no field, because the player writes a careful trigger and gets
 * a shrug. Same doctrine as greying "Behavioral automation" when no rules module is installed.
 */
async function askForTrigger(actor: any, token: any): Promise<Trigger | null> {
  const reach = reachOf(actor);
  const canned = cannedTriggers(reach);
  const DialogV2: any = (globalThis as any).foundry?.applications?.api?.DialogV2;
  const prose = watchAvailable();

  if (!DialogV2?.prompt) {
    // No dialog API at all: the first canned trigger is better than refusing outright.
    return { prose: canned[0].descriptor.summary, watch: canned[0].descriptor, move: false };
  }

  const options = canned
    .map(
      (trigger) =>
        `<option value="${trigger.id}">${game.i18n.localize(trigger.label)}</option>`,
    )
    .join("");
  const content =
    `<p>${game.i18n.localize("NOODLRHOOKS.Ready.Explain")}</p>` +
    (prose
      ? `<div class="form-group"><label>${game.i18n.localize("NOODLRHOOKS.Ready.Prose")}</label>` +
        `<input type="text" name="prose" maxlength="140" placeholder="${game.i18n.localize(
          "NOODLRHOOKS.Ready.ProseHint",
        )}"></div>`
      : "") +
    `<div class="form-group"><label>${game.i18n.localize("NOODLRHOOKS.Ready.Canned")}</label>` +
    `<select name="canned"><option value="">${game.i18n.localize(
      "NOODLRHOOKS.Ready.CannedNone",
    )}</option>${options}</select></div>` +
    `<div class="form-group"><label><input type="checkbox" name="move"> ${game.i18n.localize(
      "NOODLRHOOKS.Ready.MoveInstead",
    )}</label></div>`;

  let form: any = null;
  try {
    form = await DialogV2.prompt({
      window: { title: game.i18n.localize("NOODLRHOOKS.Ready.Title") },
      classes: ["noodlr-hooks"],
      content,
      ok: {
        label: game.i18n.localize("NOODLRHOOKS.Ready.Confirm"),
        callback: (_event: any, button: any) => {
          const el = button?.form ?? button?.closest?.("form");
          return {
            prose: String(el?.elements?.prose?.value ?? "").trim(),
            canned: String(el?.elements?.canned?.value ?? ""),
            move: Boolean(el?.elements?.move?.checked),
          };
        },
      },
      rejectClose: false,
      modal: true,
    });
  } catch {
    return null;
  }
  if (!form) return null;

  const move = Boolean(form.move);

  if (form.prose) {
    const descriptor = await requestWatchCompile(String(form.prose).slice(0, 140), {
      name: String(token?.name ?? actor?.name ?? ""),
      reach,
      inCombat: Boolean(game.combat?.started),
    });
    if (descriptor && !descriptor.problem && descriptor.events.length) {
      // Shown before anything is charged. A compiler that misread the sentence is a readied action that
      // fires on the wrong thing, and the player is the only one who can tell.
      const ok = await confirmSummary(descriptor.summary || String(form.prose));
      if (!ok) return null;
      return { prose: String(form.prose), watch: descriptor, move };
    }
    ui.notifications?.warn(
      game.i18n.format("NOODLRHOOKS.Ready.Unwatchable", {
        why:
          descriptor?.problem ??
          game.i18n.localize("NOODLRHOOKS.Ready.NoCompiler"),
      }),
    );
    if (!form.canned) return null;
  }

  const picked = canned.find((trigger) => trigger.id === form.canned) ?? null;
  if (!picked) {
    ui.notifications?.warn(game.i18n.localize("NOODLRHOOKS.Ready.NoTrigger"));
    return null;
  }
  return { prose: game.i18n.localize(picked.label), watch: picked.descriptor, move };
}

async function confirmSummary(summary: string): Promise<boolean> {
  const DialogV2: any = (globalThis as any).foundry?.applications?.api?.DialogV2;
  if (typeof DialogV2?.confirm !== "function") return true;
  try {
    return Boolean(
      await DialogV2.confirm({
        window: { title: game.i18n.localize("NOODLRHOOKS.Ready.Title") },
        content: `<p>${game.i18n.format("NOODLRHOOKS.Ready.Understood", { summary })}</p>`,
        rejectClose: false,
        modal: true,
      }),
    );
  } catch {
    return false;
  }
}

/**
 * Who is told about a declaration.
 *
 * A player's readied action is public: the table watched them announce it, and the trigger is theirs to
 * share. **A monster's is not.** "The archer is waiting for somebody to step into the doorway" is exactly
 * the sort of thing the party is supposed to find out by stepping into the doorway, so an NPC declaration
 * is whispered to GMs and the public card says only that the creature holds its ground — the same split
 * the planner already makes between its announcement and its GM-only reasoning.
 */
type Announce = "public" | "gm" | "none";

/** Charge the Action, store the declaration, and tell whoever is entitled to know. */
async function commit(
  actor: any,
  record: ReadyRecord,
  announce: Announce = "public",
): Promise<void> {
  payBill(turnBill(actor, "action"));
  await write(actor, record);

  if (announce !== "none") {
    const note = record.spell && record.concentration ? "NOODLRHOOKS.Ready.SpellNote" : "";
    await post(
      actor,
      game.i18n.format("NOODLRHOOKS.Ready.Declared", {
        name: String(actor?.name ?? ""),
        action: record.label,
        trigger: record.prose,
      }) + (note ? ` <em>${game.i18n.localize(note)}</em>` : ""),
      announce === "gm",
    );
  }
  log(`ready: ${actor?.name} is holding ${record.label} for "${record.prose}"`);
}

/**
 * Declare a readied action without going through the dialogs. True when it was stored.
 *
 * The entry point the planner uses, and the reason it exists rather than the planner reaching in: a
 * declaration is a payment plus a write plus an announcement, and the alternative is a second copy of that
 * sequence which will eventually disagree with this one about who is billed and when.
 *
 * It re-checks the gate and the budget rather than trusting the caller, for the same reason `offer.ts`
 * re-resolves everything on arrival: the planner's view of the board is a moment old by the time the turn
 * executes, and by then the creature may have spent its Action on something else.
 */
export async function declareReadied(
  actor: any,
  trigger: { prose: string; watch: WatchDescriptor },
  action: { item: any; activity: any } | null,
  options: { announce?: Announce } = {},
): Promise<boolean> {
  if (!actor || !isReadyEnabled(actor) || !allowedToReady(actor)) return false;
  if (!affordable(turnBill(actor, "action"))) return false;

  const record: ReadyRecord = {
    prose: trigger.prose,
    watch: trigger.watch,
    itemId: action ? String(action.item?.id ?? "") || null : null,
    activityId: action ? String(action.activity?.id ?? "") || null : null,
    label: action
      ? String(action.item?.name ?? action.activity?.name ?? "")
      : game.i18n.localize("NOODLRHOOKS.Ready.Move"),
    move: !action,
    spell: action ? isSpellItem(action.item) : false,
    concentration: action ? requiresConcentration(action.item, action.activity) : false,
    stamp: stampNow(),
    judges: trigger.watch.judge ? JUDGE_BUDGET : 0,
  };
  await commit(actor, record, options.announce ?? "public");
  return true;
}

/**
 * The tier gate, from the user's own pseudocode: `(INT + WIS) / 2 > 5`.
 *
 * Player characters are never gated — a player who wants to hold a shot has decided to. An unreadable
 * sheet is allowed for the same reason the planner lands an unreadable creature mid-ladder: a missing
 * number should not turn a lich into a beetle.
 */
export function allowedToReady(actor: any): boolean {
  if (actor?.hasPlayerOwner || forcedReady(actor)) return true;
  const { int, wis } = mentalScores(actor);
  if (int === null || wis === null) return true;
  return (int + wis) / 2 > READY_MENTAL_MIN;
}

// ---------------------------------------------------------------------------------------------------
// Release
// ---------------------------------------------------------------------------------------------------

/** Registered on every client: the addressee is whoever owns the creature. */
export function registerReady(): void {
  registerQuery(QUERY, async (data: any) => {
    return await releaseHere(String(data?.actorUuid ?? ""), String(data?.why ?? ""), data?.target);
  });
}

/**
 * Put the release to whoever plays the creature. True when it actually went off.
 *
 * Routed rather than resolved here for the reason `offer.ts` gives at length: the dice, the resources and
 * the decision all belong to the same person, and detection runs on the primary GM.
 */
export async function releaseReady(
  actor: any,
  why: string,
  targetUuid?: string,
): Promise<boolean> {
  const owner = rollerForActor(actor) ?? String((game.users as any)?.activeGM?.id ?? "");
  if (!owner) return false;
  const answer = await askUser<{ fired: boolean }>(
    owner,
    QUERY,
    { actorUuid: String(actor?.uuid ?? ""), why, target: targetUuid ?? null },
    { timeout: 30000 },
  );
  return Boolean(answer?.fired);
}

/** Everything from here down runs on the client that owns the creature. */
async function releaseHere(
  actorUuid: string,
  why: string,
  targetUuid: string | null,
): Promise<{ fired: boolean }> {
  const actor: any = await resolve(actorUuid);
  if (!actor) return { fired: false };

  const record = readiedOf(actor);
  if (!record) return { fired: false };

  // "If you are incapacitated or killed before the trigger occurs, you cannot take your reaction." The
  // declaration is discarded rather than left lying about, because a stale one would fire on the next
  // trigger after the creature was healed, a round later, with no explanation.
  if (!alive(actor) || !canReact(actor)) {
    await write(actor, null);
    await post(
      actor,
      game.i18n.format("NOODLRHOOKS.Ready.Lost", { name: String(actor?.name ?? "") }),
    );
    return { fired: false };
  }

  const token = tokenFor(actor);
  const combatant = combatantFor(token);
  if (combatant && !hasReaction(combatant)) {
    log(`ready: ${actor?.name} has no reaction left, so the readied action stands`);
    return { fired: false };
  }

  const go = "go";
  const abort = "abort";
  const choices: Choice[] = [
    {
      id: go,
      label: game.i18n.localize("NOODLRHOOKS.Ready.Release"),
      hint: record.label,
    },
    {
      id: abort,
      label: game.i18n.localize("NOODLRHOOKS.Ready.Abort"),
      hint: game.i18n.localize("NOODLRHOOKS.Ready.AbortHint"),
    },
  ];
  const picked = await promptChoice({
    title: game.i18n.format("NOODLRHOOKS.Ready.Fired", { name: String(actor?.name ?? "") }),
    body: game.i18n.format("NOODLRHOOKS.Ready.Because", {
      trigger: record.prose,
      why: why || record.prose,
      action: record.label,
    }),
    choices,
    // Defaults to firing. The declaration IS the answer — see the header.
    defaultId: go,
  });

  // Cleared before anything is used, in both directions: an abort loses the readied action ("losing the
  // past action but nothing else", user), and a release must not be able to fire twice if a second
  // trigger arrives while a targeting dialog is open.
  await write(actor, null);

  if (picked === abort) {
    await post(
      actor,
      game.i18n.format("NOODLRHOOKS.Ready.Aborted", { name: String(actor?.name ?? "") }),
    );
    return { fired: false };
  }

  if (combatant) {
    spend(actor, game.combat, combatant, "reaction", false);
  }

  if (record.move) {
    // Nothing to execute: a readied move has no destination until somebody drags the token. The Speed cap
    // already exempts anyone moving outside their own turn, so the move is simply unbudgeted and legal.
    await post(
      actor,
      game.i18n.format("NOODLRHOOKS.Ready.Moves", { name: String(actor?.name ?? "") }),
    );
    return { fired: true };
  }

  const action = actionFor(actor, record);
  if (!action) {
    await post(
      actor,
      game.i18n.format("NOODLRHOOKS.Ready.Gone", {
        name: String(actor?.name ?? ""),
        action: record.label,
      }),
    );
    return { fired: false };
  }

  await post(
    actor,
    game.i18n.format("NOODLRHOOKS.Ready.Releases", {
      name: String(actor?.name ?? ""),
      action: record.label,
      why: why || record.prose,
    }),
  );

  const target: any = targetUuid ? await resolve(targetUuid) : null;
  try {
    // The Reaction has been billed here, so the activity's own claim on an Action must not be charged
    // again — on somebody else's turn that would be checked against the tally from the turn the creature
    // spent readying, and refused as over budget.
    clearNextUse(action.activity);
    await useActionAt(action, target ?? token, { asReaction: true });
  } catch (err) {
    log(`ready: ${actor?.name} could not use ${record.label}:`, err);
  }
  return { fired: true };
}

/**
 * Find the held activity again, on the sheet, now.
 *
 * By id through `readActions`, which is the only thing that knows whether an activity is still usable —
 * the slot may have been spent, the charge burned, the item dropped between the declaration and the
 * trigger. A missing one is reported rather than substituted: firing a different activity than the one
 * the player named is worse than not firing.
 */
function actionFor(actor: any, record: ReadyRecord): CreatureAction | null {
  const actions = readActions(actor);
  const match = actions.find(
    (action) =>
      String(action.item?.id ?? "") === String(record.itemId ?? "") &&
      String(action.activity?.id ?? "") === String(record.activityId ?? ""),
  );
  return match?.available ? match : null;
}

// ---------------------------------------------------------------------------------------------------
// Housekeeping
// ---------------------------------------------------------------------------------------------------

/**
 * Sweep expired declarations and say so.
 *
 * The stamp already makes an expired record inert, so this is only about legibility: a readied action that
 * silently stops existing is indistinguishable from one that never fired, and the player will report the
 * second when they saw the first. Primary GM only — one announcement per table.
 */
export function registerReadyExpiry(): void {
  const sweep = (): void => {
    if (!isPrimaryGM()) return;
    const combat: any = game.combat;
    for (const combatant of combat?.combatants ?? []) {
      const actor = combatant?.actor;
      const stored = storedReady(actor);
      if (!stored || live(stored)) continue;
      void write(actor, null);
      void post(
        actor,
        game.i18n.format("NOODLRHOOKS.Ready.Expired", {
          name: String(actor?.name ?? ""),
          action: stored.label,
        }),
        // Whispered for a monster, for the reason `Announce` gives: what a creature was waiting for is
        // GM information, and it stays so when the waiting comes to nothing.
        !actor?.hasPlayerOwner,
      );
    }
  };
  Hooks.on("updateCombat", () => sweep());
  // A fight starting invalidates every out-of-combat declaration: those are one-shots with no turn to
  // expire at, and carrying one into initiative would give its owner a free reaction before round one.
  Hooks.on("combatStart", () => {
    if (!isPrimaryGM()) return;
    for (const combatant of (game.combat as any)?.combatants ?? []) {
      const stored = storedReady(combatant?.actor);
      if (stored && !stored.stamp) void write(combatant.actor, null);
    }
  });
}

/**
 * Spend one judge call from a declaration's budget. False when it is exhausted.
 *
 * Written by whoever is doing the detection, which is the primary GM, so the write is always permitted.
 */
export async function spendJudge(actor: any): Promise<boolean> {
  const stored = storedReady(actor);
  if (!stored) return false;
  if (stored.judges <= 0) return false;
  await write(actor, { ...stored, judges: stored.judges - 1 });
  return true;
}

async function post(actor: any, html: string, gmOnly = false): Promise<void> {
  const ChatMessage = (globalThis as any).ChatMessage;
  try {
    const data: any = {
      content: `<p>${html}</p>`,
      speaker: actor ? speakerFor(actor, String(actor?.name ?? "")) : narrator(),
    };
    if (gmOnly) {
      data.whisper = ChatMessage.getWhisperRecipients("GM").map((u: any) => u.id);
    }
    await ChatMessage.create(data);
  } catch (err) {
    log("ready: could not post to chat:", err);
  }
}

function tokenFor(actor: any): any {
  const active = actor?.getActiveTokens?.(true, true)?.[0];
  return active?.object ?? active ?? actor?.token ?? null;
}

function combatantFor(token: any): any {
  const id = String(token?.id ?? token?.document?.id ?? "");
  return (game.combat as any)?.combatants?.find?.(
    (c: any) => String(c?.tokenId ?? c?.token?.id ?? "") === id,
  );
}

async function resolve(uuid: string): Promise<any> {
  try {
    return await (globalThis as any).fromUuid?.(uuid);
  } catch {
    return null;
  }
}

/** The creature's own melee reach, for `where.inReach`. One grid step when nothing says otherwise. */
export function reachOf(actor: any): number {
  const step = Number((canvas as any)?.dimensions?.distance ?? 5) || 5;
  let best = step;
  for (const action of readActions(actor)) {
    if (action.melee && action.range > best) best = action.range;
  }
  return best;
}

export function surveyReady(): unknown {
  const token: any = (canvas as any)?.tokens?.controlled?.[0];
  const actor = token?.actor;
  if (!actor) return { note: "select a token" };
  const stored = storedReady(actor);
  return {
    module: MODULE_ID,
    creature: String(token?.name ?? ""),
    enabled: isReadyEnabled(actor),
    allowed: allowedToReady(actor),
    mental: mentalScores(actor),
    compiler: watchAvailable(),
    readied: stored
      ? {
          trigger: stored.prose,
          action: stored.label,
          move: stored.move,
          events: stored.watch.events,
          judge: stored.watch.judge,
          judgesLeft: stored.judges,
          live: live(stored),
        }
      : null,
  };
}
