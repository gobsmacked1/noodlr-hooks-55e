// The Damage button waits until somebody knows whether the attack hit.
//
// WHY THIS IS A RULES PROBLEM AND NOT A UI ONE. dnd5e draws Attack and Damage side by side on the usage
// card and leaves both live from the moment the card appears, because the system has no verdict to gate
// on — it decides whether an attack hit inside the card's RENDERER and stores the answer nowhere (see
// `cards.ts`). So the two commonest mistakes at a table are the two the interface invites: rolling damage
// on a miss, and rolling it twice because the first press produced no visible change.
//
// `rules/damage.ts` built the missing verdict, and this is what it buys at the other end. The button is
// held until the attack has been ROLLED, then held further until the reaction window has closed — because
// a Shield cast after the fact turns a hit into a miss, and a damage roll made in that gap is a roll for
// an attack that no longer landed. Only then does it turn green, and only for one press.
//
// FAIL OPEN, ALWAYS. A locked button that never unlocks is far worse than a player rolling damage on a
// miss: the first is indistinguishable from the module being broken and has no way out, the second is an
// ordinary table correction. So every uncertainty here resolves to "open": no active GM, no verdict the
// module could reach, an unreadable card, a GM who wants it open anyway, or simply nobody answering
// within `PATIENCE`. The lock is a convenience with teeth, not a permission system.
//
// THE HARD HALF IS THE VETO, not the disabled attribute. Disabling a button stops a mouse; it does not
// stop a macro, a keybind, or a second client whose render ran before the flag arrived. `dnd5e.preRollDamage`
// is where the refusal actually lives, and it runs on the client doing the rolling — which is the only
// client that can stop it.

import { COMBAT_SETTINGS, MODULE_ID, log } from "../constants";
import { enabledForEither, isDamageGateEnabled } from "../settings";
import { isDnd5e } from "../system/dnd5e-rewards";
import { midiOwnsDamage } from "../system/dnd5e-damage";
import { isPrimaryGM } from "../util/gm";
import { originatingId, rollType } from "./cards";

/** Our flag on the USAGE card — the one carrying both buttons. */
const GATE = "gate";

/**
 * What the module knows about an attack, from the button's point of view.
 *
 * `open` is not the same as `hit` and the distinction is the whole failure model: `hit` means a verdict
 * arrived and it was yes, `open` means no verdict is coming and the human decides. Both unlock; only one
 * of them is green.
 */
export type GateVerdict = "hit" | "miss" | "graze" | "open";

interface GateFlag {
  verdict: GateVerdict;
  /** Set once a damage roll has quoted this card. One press per attack. */
  spent?: boolean;
  /** A GM opened it by hand. Recorded so `surveyGate` can say the lock was overruled rather than absent. */
  override?: boolean;
}

/**
 * How long a client waits for a verdict before handing the button back.
 *
 * Sized to the reaction window rather than to patience: Silvery Barbs and Shield are six seconds each and
 * are asked in sequence, plus a roll dialog on top, so anything under about twenty seconds would unlock
 * during a legitimate decision. Thirty is long enough that it only ever fires when nothing is coming, and
 * short enough that a broken GM client costs one awkward pause rather than an unusable session.
 *
 * Unlocking early is not as dangerous as it looks: `rules/damage.ts` awaits the same window before it
 * APPLIES anything, so the worst case is a damage roll sitting in the log a moment before its verdict.
 */
const PATIENCE = 30_000;

/** Cards this client has locally released, because no verdict arrived in time. */
const relented = new Set<string>();

/** Timers already running, so a re-render does not start a second one. */
const waiting = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Cards this client has already rolled damage from.
 *
 * The flag is the durable record and is written by the GM, but it arrives over the wire and a determined
 * double-click does not wait for it. This is the same answer half a tick earlier, on the one client where
 * the second press is going to happen.
 */
const pressed = new Set<string>();

export function registerDamageGate(): void {
  const generation = Number((game as any)?.release?.generation ?? 13);
  Hooks.on(generation >= 13 ? "renderChatMessageHTML" : "renderChatMessage", decorate);

  // An attack has been rolled and a verdict is now owed. Everything before this point is a card nobody
  // has swung with yet, which is a lock with no time limit because there is nothing to be waiting for.
  Hooks.on("createChatMessage", (message: any) => {
    if (rollType(message) !== "attack") return;
    const id = originatingId(message);
    if (id) startWaiting(id);
  });

  // The refusal that actually holds. Registered on every client, because the client that must be stopped
  // is the one whose mouse is on the button.
  Hooks.on("dnd5e.preRollDamage", refuse);

  Hooks.on("deleteCombat", () => {
    for (const timer of waiting.values()) clearTimeout(timer);
    waiting.clear();
    relented.clear();
    pressed.clear();
  });
}

/**
 * Is a verdict going to arrive at all?
 *
 * Every term is a WORLD setting or a connected-user fact, so a player's client reaches the same answer as
 * the GM's without asking. That symmetry is what makes the lock safe to draw on a client that cannot see
 * the verdict machinery: where the machinery is not running, nothing is drawn.
 *
 * `game.users.activeGM` is the one people forget. The verdict is written by the primary GM, so with no GM
 * connected — a session where players are milling about before the GM logs in — every damage button in
 * the log would be dead with no explanation.
 */
export function gateActive(): boolean {
  try {
    if (!isDnd5e()) return false;
    if (!isDamageGateEnabled()) return false;
    if (!enabledForEither(COMBAT_SETTINGS.autoDamage)) return false;
    if (midiOwnsDamage()) return false;
    return Boolean((game.users as any)?.activeGM);
  } catch {
    return false;
  }
}

/** What the flag says, or nothing at all. */
function flagOf(message: any): GateFlag | null {
  try {
    const raw = message?.getFlag?.(MODULE_ID, GATE) ?? message?.flags?.[MODULE_ID]?.[GATE];
    return raw && typeof raw === "object" ? (raw as GateFlag) : null;
  } catch {
    return null;
  }
}

/**
 * Should this card's Damage button be pressable right now, and why?
 *
 * The age test is what keeps the chat LOG usable. A card with no flag is one whose verdict has not
 * arrived — which is true of a fresh attack and equally true of every card in the world from before
 * this feature existed, or from a session where the GM was offline. Without it, scrolling back and
 * re-rolling damage from an older card would be impossible on every client at once, which is exactly
 * the unrecoverable failure the fail-open rule exists to prevent. `relented` handles the same case
 * live, by forcing a re-render at the moment the wait runs out; this handles it for cards nobody was
 * watching when the clock ran.
 */
function judge(message: any): { open: boolean; state: string } {
  const id = String(message?.id ?? "");
  const flag = flagOf(message);
  if (flag?.spent || pressed.has(id)) return { open: false, state: "spent" };
  if (!flag) {
    if (relented.has(id) || stale(message)) return { open: true, state: "open" };
    return { open: false, state: "waiting" };
  }
  if (flag.verdict === "hit") return { open: true, state: "hit" };
  if (flag.verdict === "open") return { open: true, state: "open" };
  return { open: false, state: flag.verdict };
}

/** Older than anything could still be deciding about. */
function stale(message: any): boolean {
  const at = Number(message?.timestamp);
  if (!Number.isFinite(at)) return true;
  return Date.now() - at > PATIENCE;
}

// ── Drawing it ───────────────────────────────────────────────────────────────────────────────────────

/**
 * The card an element sits in, but ONLY when it is a card this gate governs.
 *
 * ONE PREDICATE, BOTH HALVES, and it is a rule rather than tidiness. `decorate` asked whether the card
 * also offers an attack roll; `refuse` asked nothing. So every card carrying a Damage button and no
 * Attack button — Sneak Attack, every Heal activity, every Damage activity, the damage half of a Save —
 * was judged `waiting` and vetoed, while nothing was drawn on it: no lock for a player to see, no
 * Unlock for a GM to press, and a warning that read as noise. **A veto must never be able to reach a
 * card the lock was not drawn on.**
 *
 * Read off the DOM rather than by resolving the activity: that would be a uuid lookup per card per
 * render, and midi renames activities without removing the system's buttons.
 */
function gatedCard(el: unknown): HTMLElement | null {
  const card = (el as Element | null | undefined)?.closest?.("[data-message-id]") as HTMLElement | null;
  if (!card) return null;
  if (!card.querySelector('button[data-action="rollDamage"]')) return null;
  if (!card.querySelector('button[data-action="rollAttack"]')) return null;
  return card;
}

function decorate(message: unknown, html: unknown): void {
  if (!gateActive()) return;
  const root: HTMLElement | undefined =
    html instanceof HTMLElement ? html : ((html as any)?.[0] as HTMLElement | undefined);
  const card = gatedCard(root);
  if (!card) return;
  const damage = card.querySelector<HTMLButtonElement>('button[data-action="rollDamage"]');
  if (!damage) return;

  const doc = message as any;
  const id = String(doc?.id ?? "");
  if (!id) return;

  const { open, state } = judge(doc);
  damage.classList.add("noodlr-gate", `noodlr-gate--${state}`);
  damage.disabled = !open;
  damage.title = game.i18n.localize(`NOODLRHOOKS.Combat.Gate.Title.${cap(state)}`);

  if (open) {
    // Half a tick ahead of the flag: the press that has to be caught is the second one, and it happens
    // on this client before any round trip could answer it.
    damage.addEventListener(
      "click",
      () => {
        pressed.add(id);
        damage.disabled = true;
        damage.classList.add("noodlr-gate--spent");
      },
      { capture: true, once: true },
    );
  }

  // Never blocked, only asked — the same doctrine the action economy follows. The lock reflects a reading
  // this module made, and a GM who disagrees with the reading needs a way past it that is not "turn the
  // feature off". A player gets no such control: for them the lock IS the feature.
  if (!open && state !== "spent" && game.user?.isGM) offerOverride(card, doc);
}

function offerOverride(root: HTMLElement, doc: any): void {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "noodlr-gate-unlock";
  button.textContent = game.i18n.localize("NOODLRHOOKS.Combat.Gate.Unlock");
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      await doc.setFlag(MODULE_ID, GATE, { verdict: "open", spent: false, override: true });
    } catch (err) {
      log("gate: could not unlock that card:", err);
    }
  });
  root.querySelector(".card-buttons")?.appendChild(button);
}

function cap(state: string): string {
  return state.charAt(0).toUpperCase() + state.slice(1);
}

// ── Refusing it ──────────────────────────────────────────────────────────────────────────────────────

/**
 * `dnd5e.preRollDamage` — the refusal with teeth. Returning false stops the roll before the dialog.
 *
 * The card is identified from the click event, which is the same reading dnd5e itself uses to stamp
 * `originatingMessage` (`basic-roll.mjs` `buildPost`). A damage roll with NO event came from somewhere
 * other than a card button — a macro, a sheet, our own graze — and has no gate to check, so it passes.
 * Guessing at an attribution here would refuse legitimate rolls with no way for anybody to see why.
 *
 * `gatedCard` is what keeps it to attack cards. Everything else that rolls through `rollDamage` — a
 * rogue's Sneak Attack, every heal, Magic Missile — must pass untouched.
 */
function refuse(config: any): boolean | void {
  if (!gateActive()) return;
  const id = String(gatedCard(config?.event?.target)?.dataset?.messageId ?? "");
  if (!id) return;

  const message = (game.messages as any)?.get?.(id);
  if (!message) return;
  const { open, state } = judge(message);
  if (open) {
    pressed.add(id);
    return;
  }

  ui.notifications?.warn(game.i18n.localize(`NOODLRHOOKS.Combat.Gate.Refused.${cap(state)}`));
  return false;
}

// ── The failsafe ─────────────────────────────────────────────────────────────────────────────────────

function startWaiting(id: string): void {
  if (waiting.has(id) || relented.has(id)) return;
  waiting.set(
    id,
    setTimeout(() => {
      waiting.delete(id);
      const message = (game.messages as any)?.get?.(id);
      if (flagOf(message)) return; // The verdict arrived; nothing to relent about.
      relented.add(id);
      log(`gate: no verdict for ${id} within ${PATIENCE / 1000}s — handing the button back`);
      try {
        (ui as any)?.chat?.updateMessage?.(message);
      } catch {
        /* the next render picks it up; the set is what matters */
      }
    }, PATIENCE),
  );
}

// ── Writing it (primary GM) ──────────────────────────────────────────────────────────────────────────

/**
 * File the verdict on the usage card, which is what releases the button on every client.
 *
 * Takes the ATTACK ROLL message and resolves the card from it, so callers never have to know that the
 * join is `flags.dnd5e.originatingMessage`. A roll with no originating card was made off a sheet: there
 * is no Damage button anywhere for it and nothing to write.
 */
export async function noteVerdict(attack: any, verdict: GateVerdict): Promise<void> {
  if (!isPrimaryGM()) return;
  const id = originatingId(attack);
  if (!id) return;
  const message = (game.messages as any)?.get?.(id);
  if (!message) return;
  const existing = flagOf(message);
  if (existing?.override) return; // A GM has already overruled this one; do not close it again.
  try {
    await message.setFlag(MODULE_ID, GATE, { verdict, spent: Boolean(existing?.spent) });
  } catch (err) {
    log("gate: could not record the verdict:", err);
  }
}

/** One press per attack, recorded where a reload and a second client can both see it. */
export async function noteSpent(damage: any): Promise<void> {
  if (!isPrimaryGM()) return;
  const id = originatingId(damage);
  if (!id) return;
  const message = (game.messages as any)?.get?.(id);
  const existing = flagOf(message);
  if (!existing || existing.spent) return;
  try {
    await message.setFlag(MODULE_ID, GATE, { ...existing, spent: true });
  } catch (err) {
    log("gate: could not mark that card spent:", err);
  }
}

/** What the gate can see, for the console. */
export function surveyGate(): unknown {
  const recent = ((game.messages as any)?.contents ?? []).slice(-20);
  return {
    running: gateActive(),
    enabled: isDamageGateEnabled(),
    midiOwns: midiOwnsDamage(),
    activeGM: String((game.users as any)?.activeGM?.name ?? "— nobody —"),
    patienceSeconds: PATIENCE / 1000,
    relentedHere: relented.size,
    pressedHere: pressed.size,
    cards: recent
      .filter((m: any) => flagOf(m))
      .map((m: any) => ({ id: m.id, ...flagOf(m), ...judge(m) })),
  };
}
