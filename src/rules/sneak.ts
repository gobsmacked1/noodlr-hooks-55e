// Sneak Attack, offered to whoever plays the rogue, once per turn, on a clock.
//
// THE SYSTEM ALREADY ROLLS THIS AND NOBODY PRESSES IT. dnd5e ships Sneak Attack as a real feature with a
// real damage activity carrying `@scale.rogue.sneak-attack`, so the dice were never the problem. Two
// things are: the button is equally pressable on a turn where none of the conditions hold, and it is
// forgotten — which is the same finding as the damage tray, the concentration save and the legendary
// resistance, and the reason all four of those layers exist.
//
// So this owns the DECISION and nothing else: read the conditions off the swing
// (`system/dnd5e-sneak.ts`), ask the person, roll on their own client, and hand a total back to the
// damage layer, which applies it down the same path graze takes and brings the receipt and the undo with
// it. Returning the award rather than applying it keeps the dependency one-way — `damage.ts` calls in
// here, nothing here calls back — which is worth a few lines: a cycle between two files this size works
// under ESM and stops working the first time somebody moves an initialiser to module scope.
//
// WHY IT IS ASKED RATHER THAN APPLIED. 2024 Cunning Strike spends Sneak Attack dice on riders, and the
// Assassin, the Soulknife and half a dozen subclass features all hang off the same "when you deal Sneak
// Attack damage" moment. None of that is modelled here and none of it should be decided by us, so the
// answer belongs to the person holding the sheet. The clock defaults to YES because the resource renews
// every turn: a rogue who misses the dialog loses the damage for that turn and nothing that was being
// saved. That is the prompt layer's one rule, applied — a timeout may spend a renewing resource.
//
// ONCE PER TURN MEANS ONCE PER *ANY* TURN, which is why this does not use the action ledger's stamp.
// `stampFor` answers "which of this creature's own turns is the live one", and a rogue who has already
// used Sneak Attack on their turn may legitimately use it again on an opportunity attack during somebody
// else's. The stamp here is the current slot in the initiative order, whoever owns it.
//
// OUT OF COMBAT IT IS NOT LIMITED, deliberately. There is no turn, so there is nothing to clear a
// lockout, and a flag that never expires is the stale state this repo keeps paying for — a rogue who
// stabbed a sleeping guard in session two would still be locked out in session forty. dnd5e's own `turn`
// recovery period has the same scope for the same reason.
//
// WHERE IT STANDS DOWN, and it has to SAY so. Everything here is reached from `settleAttack`,
// which only runs when this module is applying damage — so with auto-damage off, the switch
// reads ON and no rogue is ever asked (`sneakAdvisories`). It also stands the COMPILER down
// the other way: a compiled damage rule on this feature is refused while we are dealing it,
// and the capability sheet says why (`sneakClaimedNatively`). A capability that switches
// itself off has to say so.

import { COMBAT_SETTINGS, MODULE_ID, log } from "../constants";
import { isSneakEnabled } from "../settings";
import { rollerForActor } from "../util/gm";
import { FLAG_NAMESPACE, readFlag } from "../util/flags";
import { promptChoice } from "../util/prompt";
import { speakerFor } from "../util/speaker";
import { askUser, registerQuery } from "../util/queries";
import { isDnd5e } from "../system/dnd5e-rewards";
import {
  isSneakFeature,
  qualifyingWeapon,
  readSneak,
  sneakFeature,
  sneakFormula,
} from "../system/dnd5e-sneak";
import { activityOf, itemOf, speakerToken, type HitReading } from "./cards";
import type { CapabilityRule } from "../integration/capability";

const QUERY = "sneak";

/** Where the turn stamp of the last Sneak Attack is kept, on the rogue. */
const FLAG = "sneak";

/** What crosses the wire. UUIDs, never objects — the answering client re-resolves everything. */
interface SneakRequest {
  actorUuid: string;
  tokenName: string;
  targetName: string;
  formula: string;
  /** Which clause qualified it, so the sentence can say why the dialog is there. */
  because: "advantage" | "ally" | "";
}

interface SneakAnswer {
  taken: boolean;
  total: number;
}

/** What the damage layer is handed when the rogue takes it. */
export interface SneakAward {
  /** The creature it lands on — the one named in the offer, re-read by nobody. */
  target: any;
  total: number;
  /** The weapon's damage type, or "" — which the system reads as untyped rather than as immune. */
  damageType: string;
}

/** Register the answering half. EVERY client: the addressee is whoever owns the rogue. */
export function registerSneakOffers(): void {
  registerQuery(QUERY, async (data: any) => {
    const request = data?.request as SneakRequest | undefined;
    if (!request?.actorUuid) return { taken: false, total: 0 };
    return await resolveHere(request);
  });
}

/**
 * The current turn, as a string that changes when the initiative order moves on.
 *
 * `combat.turn` rather than the combatant's own place, because the rule is once per turn and not once
 * per round: a rogue gets a fresh Sneak Attack when the fight reaches anybody's turn, including one
 * where they only act through a reaction. Empty outside combat, which is read as unlimited.
 */
function turnStamp(): string {
  const combat: any = game.combat;
  if (!combat?.started) return "";
  return `${String(combat.id ?? "")}:${Number(combat.round ?? 0)}:${Number(combat.turn ?? 0)}`;
}

/** Has this creature already dealt Sneak Attack damage in the current turn? */
export function sneakSpent(actor: any): boolean {
  const stamp = turnStamp();
  if (!stamp) return false;
  return String(readFlag(actor, FLAG) ?? "") === stamp;
}

/**
 * Record that Sneak Attack has been dealt this turn.
 *
 * Exported because the ITEM'S OWN BUTTON has to record it too. A GM or player who presses the feature on
 * the sheet has taken their Sneak Attack for the turn, and a module that then offered them a second one
 * would be handing out double damage in the name of convenience. Observation rather than interception:
 * the activity resolves exactly as it always did, and we only note that it happened.
 *
 * Nothing is ever cleared. A stamp from another turn reads as absent, so every client computes the same
 * answer with no write and no race — the action ledger's trick, and the reason a reload cannot hand
 * somebody a fresh Sneak Attack.
 */
export async function noteSneakSpent(actor: any): Promise<void> {
  const stamp = turnStamp();
  if (!stamp || !actor) return;
  try {
    await actor.setFlag(FLAG_NAMESPACE, FLAG, stamp);
  } catch {
    // A creature whose flag this client cannot write is one we do not own, and the offer is only ever
    // made from the primary GM. Failing the damage over an unwritable stamp would be the worse trade.
  }
}

/** Watch for the feature being used from the sheet, so our offer stands aside for the rest of the turn. */
export function registerSneakWatch(): void {
  Hooks.on("dnd5e.postUseActivity", (activity: any) => {
    try {
      const item = activity?.item;
      if (!item || !isSneakFeature(item)) return;
      const actor = item.actor ?? activity?.actor;
      if (actor) void noteSneakSpent(actor);
    } catch {
      /* a sheet shape we cannot read is not a reason to break somebody's item use */
    }
  });
}

/**
 * Would a compiled rule deal Sneak Attack damage that something else is already dealing?
 *
 * THE COMPILER READS THIS FEATURE TOO, AND IT IS OUR OWN EXECUTOR THAT WOULD RUN THE RESULT. Two layers
 * of one module claiming one rule is exactly the duplication `duplicate.ts` exists to prevent, arriving
 * from a direction that guard cannot see: it compares a rule's dice against the ACTIVITY'S
 * `damage.parts`, and the case that produced this work is a feature hollowed out to a Utility with no
 * parts at all. So the descriptor's `2d6` matches nothing, is correctly allowed, and lands on top of the
 * offer above.
 *
 * Measured before building: all eleven compiled Sneak Attack wordings in the reference world came back
 * `adjudication: "gm"`, so nothing doubles today. The model reading "once per turn, if you have
 * Advantage" as a human's decision is the model being right. This is the guard for the release where a
 * better doctrine makes one of them `engine`, which would otherwise be silent — the arithmetic simply
 * comes out too high.
 *
 * Only `damage`. A `grant_capability` describing the feature costs nothing and feeds the prompt.
 *
 * Nothing is refused when we are not dealing it: a table that switched the offer off and
 * compiled the feature deliberately has exactly one thing dealing the dice, which is a
 * working configuration and not ours to overrule.
 */
export function sneakClaimedNatively(rule: CapabilityRule, item: any): string | null {
  if (rule?.effect?.kind !== "damage" || !isSneakFeature(item)) return null;
  const actor = item?.actor ?? item?.parent;
  if (!isSneakEnabled(actor)) return null;
  return "Sneak Attack is dealt natively, once per turn and only when the rule's conditions hold";
}

/**
 * Offer Sneak Attack on one hit. Returns what to deal, or null.
 *
 * Called from `settleAttack` AFTER the damage gate has opened, deliberately: the dialog can sit on
 * somebody's screen for several seconds and the damage button must not be held shut while it does.
 *
 * "One creature you hit" — so the first creature hit is the one offered, and with a single attack roll
 * that is the only one. A multi-target attack roll would be the rare exception and picking the first is
 * both the common answer and the one that cannot double-dip.
 */
export async function offerSneakAttack(
  message: any,
  reading: HitReading,
): Promise<SneakAward | null> {
  if (!isDnd5e()) return null;
  const target = reading.hits[0];
  if (!target) return null;

  const attacker = speakerToken(message?.speaker);
  const actor = attacker?.actor;
  if (!actor || !isSneakEnabled(actor)) return null;
  if (sneakSpent(actor)) return null;

  const feature = sneakFeature(actor);
  if (!feature) return null;

  const item = itemOf(message);
  const sneak = readSneak({
    attackerToken: attacker?.object ?? attacker,
    targetToken: target?.object ?? target,
    item,
    activity: activityOf(message, item),
    message,
  });
  if (!sneak.eligible) {
    log(`sneak attack: not offered to ${actor.name} — ${sneak.reason}`);
    return null;
  }

  const owner = rollerForActor(actor) ?? String((game.users as any)?.activeGM?.id ?? "");
  if (!owner) return null;

  const request: SneakRequest = {
    actorUuid: String(actor.uuid ?? ""),
    tokenName: String(attacker?.name ?? actor.name ?? ""),
    targetName: String(target?.name ?? ""),
    formula: sneak.formula,
    because: sneak.because,
  };

  // Comfortably longer than the countdown the far client enforces, for the same reason `offer.ts` gives:
  // a transport that gave up first would report "declined" while somebody was still reading.
  const answer = await askUser<SneakAnswer>(owner, QUERY, { request }, { timeout: 30000 });
  if (!answer?.taken || !(answer.total > 0)) return null;

  // Stamped BEFORE the caller applies it. Applying awaits an actor update and posts a card, and a second
  // attack resolving in that window would otherwise find the turn unspent and offer again.
  await noteSneakSpent(actor);

  return { target, total: answer.total, damageType: sneak.damageType };
}

/**
 * Everything from here down runs on the client that owns the rogue.
 *
 * THE DICE ARE ROLLED HERE AND NOT ON THE GM'S CLIENT, which is the whole reason this crosses a wire at
 * all. `@scale.rogue.sneak-attack` resolves through the actor's own roll data; the player sees their own
 * dice animate; and the roll is posted under their name rather than appearing as something the GM did to
 * them. Only the total comes back, because the total is all the damage layer needs.
 */
async function resolveHere(request: SneakRequest): Promise<SneakAnswer> {
  const actor: any = await resolveUuid(request.actorUuid);
  if (!actor) return { taken: false, total: 0 };

  const yes = "yes";
  const no = "no";
  const picked = await promptChoice({
    title: game.i18n.format("NOODLRHOOKS.Combat.Sneak.Title", { name: request.tokenName }),
    body: game.i18n.format(
      request.because === "advantage"
        ? "NOODLRHOOKS.Combat.Sneak.Advantage"
        : "NOODLRHOOKS.Combat.Sneak.Ally",
      { target: request.targetName },
    ),
    choices: [
      {
        id: yes,
        label: game.i18n.format("NOODLRHOOKS.Combat.Sneak.Deal", { formula: request.formula }),
        hint: game.i18n.localize("NOODLRHOOKS.Combat.Sneak.DealHint"),
      },
      {
        id: no,
        label: game.i18n.localize("NOODLRHOOKS.Combat.Sneak.Hold"),
        hint: game.i18n.localize("NOODLRHOOKS.Combat.Sneak.HoldHint"),
      },
    ],
    defaultId: yes,
  });
  if (picked !== yes) return { taken: false, total: 0 };

  try {
    const Roll: any = (globalThis as any).Roll;
    const roll = new Roll(request.formula, actor.getRollData?.() ?? {});
    await roll.evaluate();
    const total = Number(roll.total);
    if (!Number.isFinite(total) || total <= 0) return { taken: false, total: 0 };
    await roll.toMessage({
      flavor: game.i18n.format("NOODLRHOOKS.Combat.Sneak.Flavor", { target: request.targetName }),
      speaker: speakerFor(actor, request.tokenName),
    });
    return { taken: true, total };
  } catch (err) {
    log(`sneak attack: could not roll "${request.formula}" for ${actor?.name}:`, err);
    return { taken: false, total: 0 };
  }
}

async function resolveUuid(uuid: string): Promise<any> {
  try {
    return await (globalThis as any).fromUuid?.(uuid);
  } catch {
    return null;
  }
}

/**
 * Everything that decides whether this creature will ever be offered Sneak Attack.
 *
 * THE TWO LINES THAT MATTER MOST ARE THE DICE AND THE WEAPONS, and neither was here. Both gaps failed in
 * the same silent direction: `sneakFormula` returns "" for a feature hollowed out to a Utility on an actor
 * whose class scale is named something other than `sneak-attack`, and `qualifyingWeapon` demands a POSITIVE
 * reading of Finesse or Ranged — so a rogue with the feature present, the setting on, nobody else
 * automating and nothing spent would read as perfectly healthy and never be asked. `spent: false` is
 * indistinguishable from a working rogue who has not hit anything yet.
 *
 * The weapon line also settles a promise the code had already made: `qualifyingWeapon`'s own doc says its
 * refusal "is quiet and is reported by `api.surveySneak()`", and it was not. Same class of fault as
 * `WIRED_TRIGGERS` badging an unwired rule active — the intent written down, believed, never implemented.
 *
 * Flat, one fact per line, per the rule that a diagnostic returning an object has reported nothing.
 */
export function surveySneak(): unknown {
  const token: any = (canvas as any)?.tokens?.controlled?.[0];
  const actor = token?.actor;
  if (!actor) return { note: "select a token" };
  const feature = sneakFeature(actor);
  const formula = feature ? sneakFormula(actor, feature) : "";
  const weapons = qualifyingWeapons(actor);
  const lines = [
    `module: ${MODULE_ID}`,
    `creature: ${String(token?.name ?? "")}`,
    `setting (${COMBAT_SETTINGS.sneak}): ${isSneakEnabled(actor) ? "on" : "off"}`,
    `feature: ${feature ? String(feature.name) : "NONE — nothing to offer"}`,
    `dice: ${formula ? `${formula}${describeFormula(actor, formula)}` : "NONE — no damage part and no class scale named sneak-attack, so nothing would be rolled"}`,
    `qualifying weapons: ${weapons.length ? weapons.join(" | ") : "NONE — needs a Finesse or Ranged weapon, and the test requires a positive reading"}`,
    `turn stamp: ${turnStamp() || "(out of combat — unlimited)"}`,
    `spent this turn: ${sneakSpent(actor) ? "yes" : "no"}`,
    `asked of: ${nameOf(rollerForActor(actor))}`,
  ];
  console.log(lines.join("\n"));
  return { creature: String(token?.name ?? ""), spent: sneakSpent(actor) };
}

/**
 * What the dice come out as right now, appended to the formula so a scale reference is legible.
 *
 * `@scale.rogue.sneak-attack` tells a reader nothing about whether the actor is level 3 or 17, and the
 * failure this line exists to catch is a reference that resolves to nothing at all.
 */
function describeFormula(actor: any, formula: string): string {
  if (!formula.includes("@")) return "";
  try {
    const resolved = (globalThis as any).Roll?.replaceFormulaData?.(
      formula,
      actor?.getRollData?.() ?? {},
    );
    const text = String(resolved ?? "").trim();
    return text && text !== formula
      ? ` (resolves to ${text})`
      : " (UNRESOLVED — the reference is dead)";
  } catch {
    return " (UNRESOLVED — the reference could not be read)";
  }
}

/**
 * The equipped weapons this creature could Sneak Attack with, named so a strict refusal is diagnosable.
 *
 * JOINED WITH A PIPE, NOT A COMMA, because dnd5e weapon names contain commas: two hand crossbows render
 * as "Crossbow, Hand, Crossbow, Hand" and read as four weapons. A diagnostic whose list cannot be
 * counted has not reported a list — the same rule as the flat-output doctrine one line up.
 *
 * IT FILTERS ON `equipped` AND `qualifyingWeapon` DOES NOT, so this is narrower than the runtime answer:
 * a stowed dagger would qualify on a swing and is not listed here. Deliberate, and the safe direction —
 * the survey exists to explain "I am never offered this", so under-reporting raises a false alarm that
 * gets investigated while over-reporting would answer the question wrongly and close it.
 */
function qualifyingWeapons(actor: any): string[] {
  const found: string[] = [];
  for (const item of actor?.items ?? []) {
    if (String(item?.type) !== "weapon" || item?.system?.equipped === false) continue;
    for (const activity of item?.system?.activities ?? []) {
      if (!qualifyingWeapon(item, activity)) continue;
      found.push(String(item.name));
      break;
    }
  }
  return found;
}

function nameOf(userId: string | null): string {
  if (!userId) return "the GM";
  return String((game.users as any)?.get?.(userId)?.name ?? userId);
}
