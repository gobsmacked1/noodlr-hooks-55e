// Turning a posted attack roll into `on_attack_roll`.
//
// WHY THIS IS A FILE AND NOT FOUR LINES NEXT TO `on_hit`. The two events are not the same moment.
// `on_hit` waits for a verdict and therefore rides on auto-damage. This one fires when the roll
// lands in chat, before anyone knows whether it connected — Reckless Attack, Pack Tactics, Faerie
// Fire, Lucky. Coupling it to auto-damage would make those inert on every table that switched
// damage off, for no reason.
//
// WHY CHAT AND NOT `dnd5e.rollAttack`. That hook fires only on the rolling client, so a player's
// attack is invisible to the GM through it. `createChatMessage` fires everywhere, which is the
// same reason Ready and Stealth read attacks off the card (`rules/ready-events.ts`).
//
// THE DIRECTION is the attacker's, on the same evidence as `on_hit`. A census of the live cache
// (`npm run census:trigger -- <cache> on_attack_roll`) found 34 rules; Reckless Attack, Zephyr
// Strike and Pack Tactics read "when I roll". Warding Flare, Shadowy Dodge and Soul of Vengeance
// are the defender's or a third party's reading and are NOT implemented — they need
// `on_attack_roll_by`. Until then they compile, bind, and never fire usefully.
//
// ONE EVENT PER MESSAGE, not per target. Zephyr Strike's speed bump is one change, not one per
// creature the attack named.
//
// Almost every engine rule on this event is `grant_advantage` / `impose_disadvantage` /
// `modify_speed`. Those now write a timed Active Effect (Phase 4 duration). Advantage on the
// roll that just posted is a turn too late from this hook alone — `grants.ts` applies it on
// `preRollAttack` as well, and must never call `fireTrigger` or the card posts twice.

import { log } from "../constants";
import {
  activityOf,
  itemOf,
  rollType,
  speakerToken,
  targetsOf,
  tokenFromActorUuid,
  tokenFromTokenUuid,
} from "../rules/cards";
import { fireTrigger, type TriggerContext } from "./executor";
import type { Subject } from "./predicates";

const dispatched = new Set<string>();
const DISPATCH_LIMIT = 64;

export function isAttackRollMessage(message: any): boolean {
  if (rollType(message) === "attack") return true;
  // Midi merges the attack into its workflow card. The native type is often still stamped; when it
  // is not, the presence of hit-target uuids on a card that also names an item is the same event.
  const midi = message?.flags?.["midi-qol"];
  if (midi && (midi.hitTargetUuids || midi.hitTargets) && message?.flags?.dnd5e?.item) return true;
  return false;
}

export function firstTargetOf(message: any): Subject | undefined {
  for (const t of targetsOf(message)) {
    const doc = tokenFromActorUuid(t.uuid) ?? tokenFromTokenUuid(t.uuid);
    if (doc?.actor) return { actor: doc.actor, token: doc.object ?? doc };
  }
  return undefined;
}

export async function fireAttackRollTriggers(message: any): Promise<void> {
  if (!isAttackRollMessage(message)) return;

  const id = String(message?.id ?? "");
  if (!id || dispatched.has(id)) return;
  dispatched.add(id);
  while (dispatched.size > DISPATCH_LIMIT) {
    const oldest = dispatched.values().next().value;
    if (oldest === undefined) break;
    dispatched.delete(oldest);
  }

  const token = speakerToken(message?.speaker);
  const attacker: Subject | null = token?.actor
    ? { actor: token.actor, token: token.object ?? token }
    : null;
  if (!attacker) return;

  const item = itemOf(message);
  const activity = activityOf(message, item);
  const target = firstTargetOf(message);
  const ctx: TriggerContext = {
    self: attacker,
    attacker,
    target,
    trigger: attacker,
    activity,
    spellLevel: Number(item?.system?.level) || undefined,
  };
  try {
    await fireTrigger("on_attack_roll", ctx);
  } catch (err) {
    log(`attack-roll triggers: on_attack_roll for ${String(token?.name ?? "?")} failed:`, err);
  }
}

export function registerAttackRollTriggers(): void {
  // `updateChatMessage` as well as `create`: midi fills the roll onto an existing workflow card.
  const consider = (message: any) => {
    void fireAttackRollTriggers(message);
  };
  Hooks.on("createChatMessage", consider);
  Hooks.on("updateChatMessage", consider);
}

export function resetAttackRollDispatch(): void {
  dispatched.clear();
}
