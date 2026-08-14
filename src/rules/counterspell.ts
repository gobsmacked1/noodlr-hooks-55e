// Holding a cast open long enough for somebody to counter it.
//
// This was the one reaction the previous release refused to guess at, and the note explaining why said
// Counterspell "needs a window that holds up somebody else's cast". That was true and it was not a reason to
// stop: the window is buildable, and three separate things had to exist first, all of which now do.
//
//   1. A veto that fires BEFORE anything is spent. `dnd5e.preUseActivity` runs ahead of the configuration
//      dialog and ahead of consumption (`activity/mixin.mjs:222`), and hands over the exact usage, dialog
//      and message configs — so a cancelled cast can be replayed faithfully afterwards. The action economy
//      layer next door has used that pattern since v0.4.38; this is the same `cleared` replay.
//   2. Somebody to ask, on a clock. `rules/offer.ts` already routes a reaction to whoever owns the creature
//      and puts a six-second dialog in front of them.
//   3. A save to settle it with, and a boss's answer to it. `rules/legendary.ts` shipped in the same release
//      as this file's predecessor, which is what makes the user's last summary line — "bosses can now use
//      Legendary Resistance to beat it" — true here rather than aspirational.
//
// AND THE 2024 RULES DO MOST OF THE WORK. See `system/dnd5e-counterspell.ts` for the detail; the short of it
// is that the countered creature's slot "isn't expended", so stopping the cast before consumption is not a
// workaround but the literal rule, and the contest is an ordinary saving throw rather than a contest
// primitive Foundry does not have.
//
// WHAT A COUNTERED CASTER LOSES, and where each half comes from. The Action is charged by the economy layer
// on the way past, in the ordinary course of allowing the cast — so by the time the window opens it is
// already spent, which is exactly right. The slot is never touched, because the veto precedes consumption.
// Between them those two facts are the whole 2024 resource clause, and neither is implemented here.
//
// IN COMBAT ONLY, deliberately. Counterspell out of initiative is a real situation and it is not one this
// can adjudicate honestly: the reaction ledger is turn-stamped, so outside a fight there is nothing to stop
// one creature countering every spell in a scene. A rule that cannot count the resource it spends should not
// pretend to.
//
// THE CAST IS ANNOUNCED BEFORE ANYBODY IS ASKED. Without it the caster's client simply does nothing for six
// seconds, which reads as the button being broken — and announcing "X begins casting Y" is also the fiction
// the rule describes, so the honest fix and the good one are the same fix.

import { COMBAT_SETTINGS, MODULE_ID, log } from "../constants";
import { isPrimaryGM } from "../util/gm";
import { speakerFor } from "../util/speaker";
import { isCounterspellEnabled } from "../settings";
import { isDnd5e } from "../system/dnd5e-rewards";
import {
  counterableCast,
  counterspellReady,
  gambitsOwnsCounterspell,
  isCounterspell,
  type CounterableCast,
} from "../system/dnd5e-counterspell";
import { canResist } from "../system/dnd5e-legendary";
import { considerResistance } from "./legendary";
import { alive, canReact, offerReaction, offerable } from "./offer";
import { hasReaction } from "./economy/ledger";
import { observersWhoSee } from "./perception";

/**
 * How many creatures are asked before the spell is let through.
 *
 * RAW there is no limit — a second creature may counter after the first one's counter is beaten — but every
 * ask costs the caster six seconds of staring at a button that did nothing. Two is the compromise: it keeps
 * the counter-the-counterspell moment that tables love, and caps the delay at something a person will sit
 * through. Stated rather than silent, because a third eligible caster genuinely could have countered.
 */
const MAX_ASKED = 2;

/** How long the caster's own save is waited for before the spell is let through. */
const SAVE_TIMEOUT_MS = 20000;

/** Casts currently held open, by activity uuid, so a double-click cannot open two windows. */
const holding = new Set<string>();

/** Replay a cancelled cast without the economy charging for it twice. Supplied by `enforce.ts`. */
type Replay = (
  activity: any,
  usageConfig: any,
  dialogConfig: any,
  messageConfig: any,
) => Promise<void>;

let replayCast: Replay | null = null;

/** Wired from `enforce.ts`, which owns the `cleared` set a replay has to pass through. */
export function useReplay(replay: Replay): void {
  replayCast = replay;
}

/** Is the rule running at all? */
function active(actor: any): boolean {
  if (!isDnd5e()) return false;
  if (!isCounterspellEnabled(actor)) return false;
  // Gambit's Premades does this properly wherever midi is there to carry it. See that predicate for why
  // midi is part of the test rather than an aside.
  if (gambitsOwnsCounterspell()) return false;
  return true;
}

/**
 * The hand-over from the economy layer: hold this cast, or let it go.
 *
 * Returns true when the window has been opened and the caller must cancel. Called from `police()` rather
 * than from a second `preUseActivity` listener, for the reason that file states at length: two listeners
 * make the outcome depend on which registered first, and getting it wrong here means the Action is charged
 * twice or not at all.
 *
 * Synchronous, because the veto is a return value. Everything that can be slow happens in `run`.
 */
export function holdForCounterspell(
  activity: any,
  usageConfig: any,
  dialogConfig: any,
  messageConfig: any,
): boolean {
  try {
    const actor = activity?.actor;
    if (!active(actor)) return false;
    if (!replayCast) return false;

    // A counter of a counter is legal and is one of the best moments in the game, so it is not excluded
    // here. It terminates by itself: every link spends a distinct creature's one reaction.
    const key = String(activity?.uuid ?? "");
    if (!key || holding.has(key)) return false;

    const cast = counterableCast(activity);
    if (!cast) return false;

    const combat: any = game.combat;
    if (!combat?.started) return false;

    const token = tokenOf(actor);
    if (!token) return false;

    const candidates = counterspellers(token, actor, combat, cast);
    if (!candidates.length) return false;

    holding.add(key);
    void run(activity, usageConfig, dialogConfig, messageConfig, cast, token, candidates).finally(
      () => holding.delete(key),
    );
    return true;
  } catch (err) {
    // A window that cannot be opened must let the spell through. Losing a cast to our own bug is far worse
    // than missing a counterspell.
    log("counterspell: could not open the window, so the cast stands:", err);
    return false;
  }
}

/** One creature that could counter, and what it would counter with. */
interface Candidate {
  actor: any;
  token: any;
  dc: number;
}

/**
 * Who could counter this cast?
 *
 * Four requirements, each of which removes far more candidates than it looks like it should, which is what
 * keeps an ordinary cast from ever being delayed: opposed to the caster, in range, holding Counterspell with
 * a slot for it, and able to both react and see.
 *
 * ONLY CREATURES OPPOSED TO THE CASTER ARE ASKED, and that is a deliberate narrowing rather than the rule.
 * RAW a wizard may counter their own party's spell, and occasionally should. But offering the whole table a
 * dialog every time a friend casts something is the "long chain of approvals" the brief rules out, and the
 * cost of the narrowing is one rare play the sheet can still perform by hand.
 */
function counterspellers(
  casterToken: any,
  casterActor: any,
  combat: any,
  cast: CounterableCast,
): Candidate[] {
  const casterSide = Number(casterToken?.document?.disposition ?? casterToken?.disposition ?? 0);
  const found: Candidate[] = [];
  const tokens: any[] = [];

  for (const combatant of combat?.combatants ?? []) {
    const token: any = combatant?.token?.object ?? combatant?.token;
    const actor: any = combatant?.actor;
    if (!token || !actor) continue;
    if (actor === casterActor) continue;

    const side = Number(token?.document?.disposition ?? token?.disposition ?? 0);
    if (side === casterSide) continue;

    if (!alive(actor) || !canReact(actor)) continue;
    if (!hasReaction(combatant)) continue;
    if (!offerable(actor, "casting")) continue;

    // A cast with nothing to see can only be heard, so a Deafened creature does not notice it.
    if (cast.vocalOnly && deafened(token)) continue;

    const ready = counterspellReady(actor);
    if (!ready) continue;

    if (!within(token, casterToken, ready.range)) continue;

    tokens.push(token);
    found.push({ actor, token, dc: ready.dc });
  }

  if (!found.length) return found;

  // "When you SEE a creature casting". Asked with the same machinery that decides whether a fight starts,
  // for the reason v0.4.1 records: two answers to "can X see Y" is a bug whichever of them is right.
  let sees: Set<string>;
  try {
    sees = observersWhoSee(tokens, casterToken);
  } catch (err) {
    // Unreadable vision offers the counterspell rather than withholding it: the alternative is a caster
    // silently immune to being countered, which nothing at the table would explain.
    log(
      "counterspell: could not work out who can see the caster, so all of them are offered:",
      err,
    );
    return found.slice(0, MAX_ASKED);
  }
  return found.filter((c) => sees.has(String(c.token?.id ?? ""))).slice(0, MAX_ASKED);
}

/** Everything slow. Runs after the veto has already been returned. */
async function run(
  activity: any,
  usageConfig: any,
  dialogConfig: any,
  messageConfig: any,
  cast: CounterableCast,
  casterToken: any,
  candidates: Candidate[],
): Promise<void> {
  const actor = activity?.actor;
  await announceCast(casterToken, cast, candidates.length);

  for (const candidate of candidates) {
    const answer = await offerReaction(candidate.actor, {
      actorUuid: String(candidate.actor?.uuid ?? ""),
      tokenUuid: String(candidate.token?.document?.uuid ?? candidate.token?.uuid ?? ""),
      targetUuid: String(casterToken?.document?.uuid ?? casterToken?.uuid ?? ""),
      targetName: String(casterToken?.name ?? actor?.name ?? ""),
      trigger: "casting",
      spell: cast.name,
    });
    if (!answer.taken) continue;

    // The DC the far client actually read off its own Counterspell, which may differ from what we saw if
    // something changed in between. Ours is the fallback rather than the answer.
    const dc = Number.isFinite(Number(answer.dc)) ? Number(answer.dc) : candidate.dc;
    const countered = await contest(actor, casterToken, dc, cast);
    if (countered) {
      await announceOutcome(casterToken, cast, candidate, true);
      return;
    }
    await announceOutcome(casterToken, cast, candidate, false);
  }

  // Nobody countered, or every counter was beaten. The spell happens, and must not be charged again.
  try {
    await replayCast?.(activity, usageConfig, dialogConfig, messageConfig);
  } catch (err) {
    log("counterspell: the cast could not be resumed:", err);
  }
}

/**
 * Roll the countered creature's Constitution save and decide whether the spell dissipates.
 *
 * RESOLVED ENTIRELY ON THIS CLIENT, which is the one holding the cast — and therefore, by construction, the
 * one that owns the caster and can roll for it. That is what keeps the contest out of `rules/saves.ts`: that
 * layer runs on the primary GM only, and a player's held spell would need its verdict shipped back across a
 * wire before it could be resumed. It also means the legendary resistance offer lands in the right place
 * without any routing, because the only creature that has one is an NPC, and an NPC's cast was pressed by
 * the GM.
 *
 * A save that cannot be rolled or read lets the spell through. The counterspeller has still spent their slot
 * and their reaction, which is the correct half to lose: a resource spent on a contest nobody could judge is
 * a bad outcome, and a cast that vanishes with no explanation is a worse one.
 */
async function contest(
  actor: any,
  casterToken: any,
  dc: number,
  cast: CounterableCast,
): Promise<boolean> {
  const message = await rollConSave(actor, casterToken, dc);
  if (!message) return false;

  const total = Number(message?.rolls?.[0]?.total);
  if (!Number.isFinite(total)) {
    log("counterspell: the save produced no readable total, so the spell stands");
    return false;
  }
  if (total >= dc) return false;

  // Failed — unless the creature is the sort that refuses to fail. Exactly the case the user's rules
  // summary names, and it works here because the caster is an NPC whenever it is possible at all.
  if (canResist(actor)) {
    const resisted = await considerResistance({
      actor,
      message,
      name: String(casterToken?.name ?? actor?.name ?? ""),
      spell: `${game.i18n.localize("NOODLRHOOKS.Counterspell.Name")} (${cast.name})`,
      // Never a number: what is at stake is the spell itself, which is the null-stake case
      // `worthAsking` treats as always worth asking about.
      avoided: null,
    });
    if (resisted) return false;
  } else if (alreadyForced(message)) {
    // A GM who pressed dnd5e's own Resist button in the gap. Read rather than overridden — the same
    // reasoning as the save layer's `updateChatMessage` listener: somebody paid for that success.
    return false;
  }

  return true;
}

/** dnd5e stamps a hand-pressed resistance on the message rather than posting a new one. */
function alreadyForced(message: any): boolean {
  return message?.flags?.dnd5e?.roll?.forceSuccess === true;
}

/**
 * Roll the save and hand back the MESSAGE, which is what a legendary resistance is stamped on.
 *
 * `rollSavingThrow` resolves with the rolls and not the message, so the message is caught off
 * `createChatMessage` — matched on the marker we put in its flags rather than on the speaker, because a
 * scene can hold several tokens of one actor and the alternative is settling the wrong creature's save.
 */
async function rollConSave(actor: any, token: any, dc: number): Promise<any> {
  const randomID: any = (globalThis as any).foundry?.utils?.randomID;
  const marker = `counterspell-${randomID ? randomID() : String(Date.now())}`;
  const ChatMessage: any = (globalThis as any).ChatMessage;

  let seen: any = null;
  let resolveSeen: ((message: any) => void) | null = null;
  const waited = new Promise<any>((resolve) => {
    resolveSeen = resolve;
  });
  const hook = Hooks.on("createChatMessage", (message: any) => {
    if (message?.flags?.[MODULE_ID]?.counterspellSave !== marker) return;
    seen = message;
    resolveSeen?.(message);
  });

  try {
    await actor.rollSavingThrow(
      { ability: "con", target: dc },
      // Configured, unlike the save layer's automatic rolls: this one is the caster's own save against
      // having their spell taken away, and whoever owns them is sitting right there having just cast it.
      { configure: true },
      {
        data: {
          speaker: ChatMessage.getSpeaker({ actor, token }),
          flags: { [MODULE_ID]: { counterspellSave: marker } },
        },
      },
    );
  } catch (err) {
    log(`counterspell: could not roll ${actor?.name}'s Constitution save:`, err);
    Hooks.off("createChatMessage", hook);
    return null;
  }

  // The message is normally already in hand by the time the roll resolves; the race is only lost when the
  // save dialog was cancelled, in which case nothing is coming and the spell should go off.
  const settled = await Promise.race([
    waited,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), SAVE_TIMEOUT_MS)),
  ]);
  Hooks.off("createChatMessage", hook);
  return settled ?? seen;
}

/** Say that the cast is in the air, so six seconds of silence is legible. */
async function announceCast(token: any, cast: CounterableCast, asked: number): Promise<void> {
  const ChatMessage: any = (globalThis as any).ChatMessage;
  try {
    await ChatMessage.create({
      speaker: speakerFor(token),
      flags: { [MODULE_ID]: { counterspell: "cast" } },
      content: `<p>${game.i18n.format("NOODLRHOOKS.Counterspell.Casting", {
        name: String(token?.name ?? ""),
        spell: cast.name,
        count: String(asked),
      })}</p>`,
    });
  } catch (err) {
    log("counterspell: could not announce the cast:", err);
  }
}

/** Say what happened. Public, because everybody at the table saw the spell fizzle or not. */
async function announceOutcome(
  token: any,
  cast: CounterableCast,
  candidate: Candidate,
  countered: boolean,
): Promise<void> {
  const ChatMessage: any = (globalThis as any).ChatMessage;
  try {
    await ChatMessage.create({
      speaker: speakerFor(candidate.token),
      flags: { [MODULE_ID]: { counterspell: countered ? "countered" : "held" } },
      content: `<p><strong>${game.i18n.localize("NOODLRHOOKS.Counterspell.Name")}</strong> — ${game.i18n.format(
        countered ? "NOODLRHOOKS.Counterspell.Countered" : "NOODLRHOOKS.Counterspell.Resisted",
        {
          counter: String(candidate.token?.name ?? candidate.actor?.name ?? ""),
          name: String(token?.name ?? ""),
          spell: cast.name,
        },
      )}</p>`,
    });
  } catch (err) {
    log("counterspell: could not announce the outcome:", err);
  }
}

function deafened(token: any): boolean {
  const doc = token?.document ?? token;
  try {
    return Boolean(doc?.hasStatusEffect?.("deafened"));
  } catch {
    return false;
  }
}

function tokenOf(actor: any): any {
  const active = actor?.getActiveTokens?.(true, false)?.[0];
  if (active) return active;
  const doc = actor?.token;
  return doc?.object ?? doc ?? null;
}

/** Straight-line separation in scene units, elevation included, as every measurement here does it. */
function within(from: any, to: any, feet: number): boolean {
  const a = from?.center ?? from?.object?.center;
  const b = to?.center ?? to?.object?.center;
  if (!a || !b) return true;
  try {
    const measured: any = (canvas as any)?.grid?.measurePath?.([a, b]);
    if (measured?.distance !== undefined) return Number(measured.distance) <= feet;
  } catch {
    /* gridless and older grid shapes fall through to the pixel reading */
  }
  const scale = Number((canvas as any)?.dimensions?.distance ?? 5);
  const size = Number((canvas as any)?.dimensions?.size ?? 100);
  return (Math.hypot(b.x - a.x, b.y - a.y) / size) * scale <= feet;
}

/**
 * Should `rules/saves.ts` leave a Counterspell alone?
 *
 * It must: the window above owns the contest, and it needs the verdict in hand to decide whether to resume
 * the cast. Two layers settling one save would race, and the visible symptom would be two legendary
 * resistance prompts for one counter.
 */
export function savesSkip(item: any): boolean {
  return isCounterspell(item);
}

export function surveyCounterspell(): unknown {
  const token: any = (canvas as any)?.tokens?.controlled?.[0];
  const actor = token?.actor;
  const combat: any = game.combat;
  return {
    setting: COMBAT_SETTINGS.counterspell,
    enabled: actor ? isCounterspellEnabled(actor) : null,
    holding: holding.size,
    primaryGm: isPrimaryGM(),
    selected: actor
      ? {
          name: String(token?.name ?? ""),
          ready: counterspellReady(actor),
          reaction: combat ? hasReaction(combatantFor(combat, token)) : null,
        }
      : "select a token",
  };
}

function combatantFor(combat: any, token: any): any {
  const id = String(token?.id ?? token?.document?.id ?? "");
  return (combat?.combatants ?? []).find?.(
    (c: any) => String(c?.tokenId ?? c?.token?.id ?? "") === id,
  );
}
