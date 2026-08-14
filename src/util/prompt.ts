// A question with a countdown on it, answered by whoever is looking at it.
//
// The brief this exists to satisfy (user, 2026-08-14): a GM does not want a chain of approvals for every
// mundane trigger, and the decisions that ARE worth surfacing should sit on a very short timer that picks
// the sensible option by itself. So every prompt here has a default, a visible countdown, and an answer
// either way — a caller never has to handle "nobody replied", because the default IS the reply.
//
// THE ONE RULE ABOUT DEFAULTS, and it is a rule rather than a preference: A TIMEOUT MAY SPEND A RENEWING
// RESOURCE AND NEVER A DEPLETING ONE. A reaction that goes unused is gone at the end of the round, so
// taking a free opportunity attack by default costs nothing anybody was saving; a fourth-level spell slot
// spent because somebody was refilling their drink is unrecoverable and unforgivable. `CreatureAction`
// carries `depleting` for exactly this, computed where the sheet is read rather than guessed at here.
//
// LOCAL BY DESIGN. This draws a dialog on the client it is called from and nothing else. Getting the
// question in front of the right person is the caller's job, because the caller is also the thing that has
// to act on the answer, and the person who owns the creature is the person who should be rolling its dice.
// `rules/offer.ts` is the routing half.
//
// WHY A DIALOG AND NOT A CHAT CARD WITH BUTTONS. A card cannot be addressed to one person without a
// whisper, a whisper scrolls away under the next roll, and neither can expire. The countdown is the whole
// point: it has to be in front of the person deciding, and it has to end on its own.

import { log } from "../constants";

/** One thing the person being asked can pick. */
export interface Choice {
  id: string;
  label: string;
  /** A clause under the label: what it costs, or why it is the sensible answer. */
  hint?: string;
}

export interface ChoiceRequest {
  title: string;
  /** A sentence naming the trigger, e.g. "The goblin is stepping out of your reach." */
  body: string;
  choices: Choice[];
  /** Picked when the countdown runs out, or when there is nothing to draw a dialog with. */
  defaultId: string;
  seconds?: number;
}

/** Six seconds, which is the number the brief asked for and also one round of combat. */
export const DEFAULT_SECONDS = 6;

/**
 * Draw the dialog and resolve with whatever was pressed, or the default when the clock runs out.
 *
 * Built on a constructed `DialogV2` rather than `DialogV2.wait` because the clock has to be able to close
 * it and `wait` hands back only a promise. Everything goes through `settle`, which resolves exactly once:
 * somebody pressing a button on the last tick of the countdown is a race that happens in practice, and
 * resolving twice would take the reaction twice.
 */
export async function promptChoice(request: ChoiceRequest): Promise<string> {
  const DialogV2: any = (globalThis as any).foundry?.applications?.api?.DialogV2;
  const seconds = Math.max(1, Math.round(request.seconds ?? DEFAULT_SECONDS));
  if (!DialogV2 || !request.choices.length) {
    log("prompt: nothing to draw a dialog with, so the default stands");
    return request.defaultId;
  }

  return await new Promise<string>((resolve) => {
    let done = false;
    let timer: any = null;
    let ticker: any = null;
    let dialog: any = null;

    const settle = (id: string): void => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      if (ticker) clearInterval(ticker);
      resolve(id);
      try {
        dialog?.close();
      } catch {
        /* already closing */
      }
    };

    try {
      dialog = new DialogV2({
        window: { title: request.title },
        classes: ["noodlr-hooks", "noodlr-hooks-prompt"],
        content: body(request, seconds),
        buttons: request.choices.map((choice) => ({
          action: choice.id,
          label: choice.label,
          default: choice.id === request.defaultId,
          callback: () => settle(choice.id),
        })),
        // Dismissing the window by hand is a deliberate "leave it alone", and the default is what that
        // means. It is also what a `close()` from our own timer runs into, which `settle` absorbs.
        close: () => settle(request.defaultId),
      });
    } catch (err) {
      log("prompt: could not build the dialog:", err);
      settle(request.defaultId);
      return;
    }

    timer = setTimeout(() => settle(request.defaultId), seconds * 1000);

    void Promise.resolve(dialog.render({ force: true }))
      .then(() => {
        let left = seconds;
        ticker = setInterval(() => {
          left -= 1;
          const node = dialog?.element?.querySelector?.(".noodlr-hooks-countdown");
          if (!node) return;
          node.textContent = countdown(request, Math.max(0, left));
        }, 1000);
      })
      .catch((err) => {
        log("prompt: the dialog would not render:", err);
        settle(request.defaultId);
      });
  });
}

function body(request: ChoiceRequest, seconds: number): string {
  const options = request.choices
    .filter((choice) => choice.hint)
    .map((choice) => `<li><strong>${escape(choice.label)}</strong> — ${escape(choice.hint!)}</li>`)
    .join("");
  const list = options ? `<ul class="noodlr-hooks-choices">${options}</ul>` : "";
  return (
    `<p>${escape(request.body)}</p>${list}` +
    `<p class="noodlr-hooks-countdown">${escape(countdown(request, seconds))}</p>`
  );
}

function countdown(request: ChoiceRequest, seconds: number): string {
  return game.i18n.format("NOODLRHOOKS.Prompt.Countdown", {
    seconds: String(seconds),
    choice: request.choices.find((choice) => choice.id === request.defaultId)?.label ?? "",
  });
}

/** Everything in a prompt is a creature or item name, so it is escaped rather than trusted. */
function escape(text: string): string {
  return String(text).replace(
    /[&<>"']/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] ?? ch,
  );
}
