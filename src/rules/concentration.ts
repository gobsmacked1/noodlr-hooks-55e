// Damage actually threatens a concentration spell, and losing the save actually ends it.
//
// The system posts a whispered card with a button on it and then waits forever. Nobody presses it
// mid-fight, and if they do, nothing reads the answer — `rollConcentration` fires its hooks and
// returns, and no code in dnd5e 5.3.3 ends concentration from a saving throw. The DC is right, the
// save is built right, and the verdict is discarded. See `system/dnd5e-concentration.ts` for the
// citations.
//
// Three connected behaviours live here:
//
//   1. On damage, roll the save — on the CLIENT THAT OWNS THE CREATURE, so a player's Constitution
//      save stays the player's roll. The stock prompt is suppressed first so there is never a stale
//      button sitting in the log that would produce a second save.
//   2. On a failed save, end concentration and say so out loud.
//   3. On Incapacitated, death, or 0 hit points, end it with no save at all. That clause is RAW in
//      both editions and is automated nowhere.
//
// WHY THERE IS NO UNDO, unlike the dying layer. Ending concentration deletes an Active Effect, and
// core cascades that deletion to everything registered as dependent on it — the Wall of Fire's
// template, the effects Bless put on four other actors. We can restore the one effect we deleted; we
// cannot faithfully rebuild the cascade, and a half-restored spell is worse than an honestly ended
// one. What we do instead is make every ending legible: the roll is public, the card names the spell
// and the reason, and the whole feature has an off switch.

import { COMBAT_SETTINGS, log, MODULE_ID } from "../constants";
import { announceRuling } from "../integration/contract";
import { enabledForEither, isConcentrationAutomationEnabled } from "../settings";
import { isRollerFor, rollerForActor } from "../util/gm";
import { speakerFor } from "../util/speaker";
import { isDnd5e } from "../system/dnd5e-rewards";
import {
  breaksConcentration,
  concentrationDC,
  concentrationLabels,
  isConcentrating,
  midiOwnsConcentration,
  readVerdict,
  systemTracksConcentration,
  type SaveVerdict,
} from "../system/dnd5e-concentration";

/** Actors whose concentration is being torn down right now, so two paths cannot both do it. */
const ending = new Set<string>();

/** Is this layer running for the creature holding the spell? Per audience. */
function enabled(subject: unknown): boolean {
  return (
    isDnd5e() &&
    isConcentrationAutomationEnabled(subject) &&
    systemTracksConcentration() &&
    !midiOwnsConcentration()
  );
}

/** For diagnostics, where there may be no creature selected. */
function enabledAtAll(): boolean {
  return (
    isDnd5e() &&
    enabledForEither(COMBAT_SETTINGS.concentration) &&
    systemTracksConcentration() &&
    !midiOwnsConcentration()
  );
}

function actorKey(actor: any): string {
  return String(actor?.uuid ?? actor?.id ?? "");
}

function reasonText(cause: "dead" | "incapacitated" | "zero"): string {
  const key =
    cause === "dead"
      ? "NOODLRHOOKS.Combat.Concentration.Reason.Dead"
      : cause === "incapacitated"
        ? "NOODLRHOOKS.Combat.Concentration.Reason.Incapacitated"
        : "NOODLRHOOKS.Combat.Concentration.Reason.Zero";
  return game.i18n.localize(key);
}

async function announce(actor: any, text: string): Promise<void> {
  try {
    const ChatMessage = (globalThis as any).ChatMessage;
    await ChatMessage.create({
      content: `<p>${foundry.utils.escapeHTML(text)}</p>`,
      speaker: speakerFor(actor),
      flags: { [MODULE_ID]: { concentration: true } },
    });
  } catch (err) {
    log("concentration: could not announce:", err);
  }
  // No `undo` offered on purpose: ending concentration cascades to every effect registered as
  // dependent on it, and a half-restored spell is worse than an honestly ended one.
  await announceRuling({ kind: "concentration", summary: text, actor });
}

/**
 * Drop everything this creature is concentrating on.
 *
 * The labels are read before the delete, because afterwards there is nothing left to name. The guard
 * set matters: damage that drops someone to 0 reaches this through the damage hook, and the
 * Unconscious that follows reaches it again through the effect hook a moment later.
 */
async function endAll(actor: any, reason: string): Promise<void> {
  const key = actorKey(actor);
  if (!key || ending.has(key)) return;
  const labels = concentrationLabels(actor);
  if (!labels.length) return;

  ending.add(key);
  try {
    await actor.endConcentration();
    await announce(
      actor,
      game.i18n.format("NOODLRHOOKS.Combat.Concentration.Lost", {
        name: String(actor?.name ?? "Someone"),
        spell: labels.join(", "),
        reason,
      }),
    );
    log(`concentration: ${String(actor?.name)} lost ${labels.join(", ")} — ${reason}`);
  } catch (err) {
    log(`concentration: could not end ${labels.join(", ")} on ${String(actor?.name)}:`, err);
  } finally {
    ending.delete(key);
  }
}

/**
 * Damage landed. Either the spell is already gone, or somebody owes a saving throw.
 *
 * `dnd5e.damageActor` fires on every connected client, which is exactly what makes routing possible:
 * each one asks whether it is the elected roller and only one says yes.
 */
async function onDamaged(actor: any, changes: { total?: number }): Promise<void> {
  if (!enabled(actor) || !isConcentrating(actor)) return;

  const damage = -Number(changes?.total ?? 0);
  if (!(damage > 0)) return;

  // Already over: at 0 hit points, Incapacitated, or dead. No save is owed for a spell that has
  // ended, and putting a dialog in front of an unconscious character is how automation loses trust.
  const broken = breaksConcentration(actor);
  if (broken) {
    if (isRollerFor(actor)) await endAll(actor, reasonText(broken));
    return;
  }

  if (!isRollerFor(actor)) return;

  const dc = concentrationDC(actor, damage);
  // A monster's save is bookkeeping; a character's is a decision (Bless, Inspiration, a reroll), so
  // the dialog follows who the creature belongs to rather than who is clicking.
  const configure = Boolean(actor?.hasPlayerOwner);

  try {
    const rolls = await actor.rollConcentration({ target: dc }, { configure });
    if (!rolls?.length) {
      // Cancelled, or refused because this client turned out not to own the actor after all. Hand
      // the table back the prompt we suppressed rather than letting the save vanish silently.
      await actor.challengeConcentration?.({ dc });
    }
  } catch (err) {
    log(`concentration: save for ${String(actor?.name)} failed to roll:`, err);
    try {
      await actor.challengeConcentration?.({ dc });
    } catch {
      // nothing further to try
    }
  }
}

/**
 * The save resolved. This hook only fires on the client that rolled, which is the client that owns
 * the actor, so it can delete the effect without a relay and no election is needed.
 */
function onConcentrationRolled(rolls: any, data: { subject?: any }): void {
  const actor = data?.subject;
  if (!actor || !enabled(actor) || !isConcentrating(actor)) return;

  const verdict: SaveVerdict = readVerdict(rolls);
  if (!verdict.failed) return;

  const reason =
    verdict.total !== null && verdict.dc !== null
      ? game.i18n.format("NOODLRHOOKS.Combat.Concentration.Reason.FailedRoll", {
          total: String(verdict.total),
          dc: String(verdict.dc),
        })
      : game.i18n.localize("NOODLRHOOKS.Combat.Concentration.Reason.Failed");

  void endAll(actor, reason);
}

/** Does this newly created effect put the creature out of the fight, and how? */
function carriesBreak(effect: any): "dead" | "incapacitated" | null {
  try {
    const statuses: any = effect?.statuses;
    for (const id of ["dead", "incapacitated"] as const) {
      if (statuses?.has?.(id) ?? statuses?.includes?.(id)) return id;
    }
  } catch {
    return null;
  }
  return null;
}

function ownerOf(effect: any): any {
  const parent = effect?.parent;
  if (!parent) return null;
  return parent.documentName === "Actor" ? parent : (parent.actor ?? null);
}

/**
 * Hold Person, Stunning Strike, Sleep — Incapacitated arriving with no damage attached.
 *
 * The actor is asked first because a status can arrive nested inside another (Unconscious carries
 * Incapacitated), but the effect is the fallback: `actor.statuses` is rebuilt during data preparation
 * and may not have caught up at creation time, whereas the document in hand always knows what it
 * carries.
 */
async function onEffectCreated(effect: any): Promise<void> {
  const actor = ownerOf(effect);
  if (!actor || !enabled(actor) || !isConcentrating(actor)) return;
  const cause = breaksConcentration(actor) ?? carriesBreak(effect);
  if (!cause) return;
  if (!isRollerFor(actor)) return;
  await endAll(actor, reasonText(cause));
}

export function registerConcentrationHooks(): void {
  // Suppress the stock roll-request card, but only when we can name someone to roll instead. If the
  // election comes back empty the button is better than nothing, so it stays.
  Hooks.on("preUpdateActor", (actor: any, changed: any, options: any) => {
    try {
      if (!enabled(actor)) return;
      if (!changed?.system?.attributes?.hp) return;
      if (!isConcentrating(actor)) return;
      if (options?.dnd5e?.concentrationCheck === false) return;
      if (!rollerForActor(actor)) return;
      foundry.utils.setProperty(options, "dnd5e.concentrationCheck", false);
    } catch (err) {
      log("concentration: preUpdateActor failed:", err);
    }
  });

  Hooks.on("dnd5e.damageActor", (actor: any, changes: any) => {
    try {
      void onDamaged(actor, changes);
    } catch (err) {
      log("concentration: damageActor failed:", err);
    }
  });

  // Only the unversioned hook. `rollConcentration` calls this one AND `...V2` with the same rolls, so
  // listening to both would judge every save twice.
  Hooks.on("dnd5e.rollConcentration", (rolls: any, data: any) => {
    try {
      onConcentrationRolled(rolls, data);
    } catch (err) {
      log("concentration: rollConcentration failed:", err);
    }
  });

  Hooks.on("createActiveEffect", (effect: any) => {
    try {
      void onEffectCreated(effect);
    } catch (err) {
      log("concentration: createActiveEffect failed:", err);
    }
  });
}

export function surveyConcentration(): unknown {
  const token = (canvas as any)?.tokens?.controlled?.[0];
  const actor = token?.actor;
  const rollerId = actor ? rollerForActor(actor) : null;
  return {
    enabled: actor ? enabled(actor) : enabledAtAll(),
    settingOn: {
      npc: isConcentrationAutomationEnabled({ type: "npc" }),
      pc: isConcentrationAutomationEnabled({ type: "character" }),
    },
    systemTracking: systemTracksConcentration(),
    midiOwns: midiOwnsConcentration(),
    selected: actor?.name ?? null,
    concentrating: actor ? isConcentrating(actor) : null,
    on: actor ? concentrationLabels(actor) : [],
    alreadyBroken: actor ? breaksConcentration(actor) : null,
    roller: rollerId ? ((game.users as any)?.get?.(rollerId)?.name ?? rollerId) : null,
    rollerIsMe: actor ? isRollerFor(actor) : null,
    dcFor: actor
      ? {
          d10: concentrationDC(actor, 10),
          d22: concentrationDC(actor, 22),
          d80: concentrationDC(actor, 80),
        }
      : null,
  };
}
