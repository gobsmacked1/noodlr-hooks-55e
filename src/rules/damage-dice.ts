// After a damage (or healing) card posts: offer Piercer, Empowered Spell, and
// Heroic Inspiration on the roller's client, then Cutting Words on an opposed
// Bard. The rewrite has to finish before anyone reads `damageParts` — that is
// what applyDamage subtracts.
//
// TWO CALLERS, ONE PROMISE. Auto-damage (`damage.ts` / `saves.ts`) awaits this
// so the HP write sees the new totals. The chat hook offers the same window
// when that layer is off (or midi owns damage) so a human Apply sees the new
// number. `inflight` / `done` make the two one offer.
//
// ORDER ON THE CARD: self first (reroll), then Cutting Words (subtract).
// A subtracted die that is then rerolled would spend a Reaction to change a
// face nobody reads. Two self rounds at most — Piercer + Empowered on Ice Knife.
//
// THE CLOCK MAY TAKE PIERCER (free, once per turn) AND NEVER EMPOWERED,
// INSPIRATION, OR CUTTING WORDS. Automated combatants are skipped.

import { COMBAT_SETTINGS, MODULE_ID, log } from "../constants";
import { adjustUses } from "../capability/primitives";
import { enabledForEither, isDiceModsEnabled } from "../settings";
import { midiOwnsDamage } from "../system/dnd5e-damage";
import { isDnd5e } from "../system/dnd5e-rewards";
import { rerollDamageDice } from "../system/dnd5e-reroll";
import {
  damageDieTimeoutId,
  empoweredReady,
  piercerItem,
  piercerSpent,
  piercerStamp,
  selfDamageOffers,
  type DamageDieId,
  type DamageDieOffer,
} from "../system/dnd5e-damage-dice";
import { shouldAutomate } from "../tactics/registry";
import { FLAG_NAMESPACE } from "../util/flags";
import { isPrimaryGM, rollerForActor } from "../util/gm";
import { promptChoice, type Choice } from "../util/prompt";
import { askUser, registerQuery } from "../util/queries";
import { speakerFor } from "../util/speaker";
import { attackHitForDamage, combinedDamageTotal, rollType, speakerToken } from "./cards";
import { considerAgainstDiceMods } from "./dice-mod";

const QUERY = "damageDie";
const TRANSPORT_MS = 30_000;
const MAX_ROUNDS = 2;

export interface DamageDieHint {
  /** Filed attack verdict. `undefined` means scan chat; `null` means filed but unknown — fail closed. */
  hit?: boolean | null;
}

export interface DamageDieResult {
  changed: boolean;
  used: string[];
}

interface DamageDieRequest {
  messageId: string;
  actorUuid: string;
  tokenUuid?: string;
  hit: boolean | null;
  used: string[];
  total: number;
}

interface DamageDieAnswer {
  taken: boolean;
  specId?: DamageDieId;
  changed?: boolean;
}

const inflight = new Map<string, Promise<DamageDieResult>>();
const done = new Set<string>();

export function registerDamageDice(): void {
  registerQuery(QUERY, async (data: any) => {
    const request = data?.request as DamageDieRequest | undefined;
    if (!request?.messageId || !request.actorUuid) return { taken: false };
    return await resolveHere(request);
  });

  if (!isDnd5e()) return;
  Hooks.on("createChatMessage", (message: any) => {
    void considerPosted(message);
  });
  Hooks.on("updateChatMessage", (message: any) => {
    void considerPosted(message);
  });
}

async function considerPosted(message: any): Promise<void> {
  const kind = rollType(message);
  if (kind !== "damage" && kind !== "healing") return;
  // When auto-damage is on, `damage.ts` / `saves.ts` await this so Apply sees
  // the new totals. Asking here too would start a second window on the same id
  // (inflight joins it, but the apply path is the one that must finish first).
  if (autoDamageLayerRuns()) return;
  await considerDamageDice(message);
}

function autoDamageLayerRuns(): boolean {
  return !midiOwnsDamage() && enabledForEither(COMBAT_SETTINGS.autoDamage);
}

/**
 * Offer damage-die rerolls, then Cutting Words, on this card.
 *
 * Safe to call from the apply path and from the chat hook: the second waiter
 * joins the first promise, and a finished id is a no-op.
 */
export async function considerDamageDice(
  message: any,
  hint?: DamageDieHint,
): Promise<DamageDieResult> {
  const empty: DamageDieResult = { changed: false, used: [] };
  const id = String(message?.id ?? "");
  if (!id) return empty;
  if (done.has(id)) return empty;
  const existing = inflight.get(id);
  if (existing) return existing;

  const run = runConsider(message, hint).finally(() => {
    inflight.delete(id);
    done.add(id);
    while (done.size > 64) {
      const oldest = done.keys().next().value;
      if (oldest === undefined) break;
      done.delete(oldest);
    }
  });
  inflight.set(id, run);
  return run;
}

async function runConsider(message: any, hint?: DamageDieHint): Promise<DamageDieResult> {
  const empty: DamageDieResult = { changed: false, used: [] };
  if (!isDnd5e() || !isPrimaryGM()) return empty;

  const token = speakerToken(message?.speaker);
  const actor = token?.actor ?? message?.speakerActor ?? null;
  if (!actor || !isDiceModsEnabled(actor)) return empty;
  if (wePlay(token ?? actor)) return empty;

  const hit = resolveHit(message, hint);
  const used: string[] = [];
  let changed = false;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const options = selfDamageOffers(actor, message, (game as any).combat, hit).filter(
      (offer) => !used.includes(offer.id),
    );
    if (!options.length) break;

    const owner = rollerForActor(actor) ?? String((game.users as any)?.activeGM?.id ?? "");
    if (!owner) break;

    const request: DamageDieRequest = {
      messageId: String(message.id),
      actorUuid: String(actor.uuid ?? ""),
      tokenUuid: token ? String(token.uuid ?? "") : undefined,
      hit,
      used: [...used],
      total: combinedDamageTotal(message),
    };
    const answer = await askUser<DamageDieAnswer>(
      owner,
      QUERY,
      { request },
      { timeout: TRANSPORT_MS },
    );
    if (!answer?.taken || !answer.specId) break;
    used.push(answer.specId);
    if (answer.changed) changed = true;
  }

  if (rollType(message) === "damage") {
    const against = await considerAgainstDiceMods({
      kind: "damage",
      message,
      actor,
      token,
    });
    if (against.changed) changed = true;
    used.push(...against.used);
  }

  return { changed, used };
}

function resolveHit(message: any, hint?: DamageDieHint): boolean | null {
  if (hint && "hit" in hint) {
    if (hint.hit === true || hint.hit === false) return hint.hit;
    if (hint.hit === null) return null;
  }
  return attackHitForDamage(message);
}

async function resolveHere(request: DamageDieRequest): Promise<DamageDieAnswer> {
  const message = (game.messages as any)?.get?.(request.messageId);
  const actor = await resolveUuid(request.actorUuid);
  if (!message || !actor) return { taken: false };
  if (!isDiceModsEnabled(actor)) return { taken: false };

  const token = request.tokenUuid ? await resolveUuid(request.tokenUuid) : speakerToken(message?.speaker);
  const options = selfDamageOffers(actor, message, (game as any).combat, request.hit).filter(
    (offer) => !request.used.includes(offer.id),
  );
  if (!options.length) return { taken: false };

  const choices: Choice[] = options.map((offer) => ({
    id: offer.id,
    label: game.i18n.localize(offer.labelKey),
    hint: game.i18n.localize(offer.hintKey),
  }));
  choices.push({
    id: "decline",
    label: game.i18n.localize("NOODLRHOOKS.DiceMod.Decline"),
    hint: game.i18n.localize("NOODLRHOOKS.DiceMod.DeclineHint"),
  });

  const picked = await promptChoice({
    title: game.i18n.format("NOODLRHOOKS.DiceMod.TitleDamage", {
      name: String(token?.name ?? actor.name ?? ""),
    }),
    body: game.i18n.format("NOODLRHOOKS.DiceMod.BodyDamage", {
      total: String(Number.isFinite(request.total) ? request.total : combinedDamageTotal(message)),
    }),
    choices,
    defaultId: damageDieTimeoutId(options.map((offer) => ({ id: offer.id, depleting: offer.depleting }))),
  });
  if (picked === "decline" || !picked) return { taken: false };

  const offer = options.find((row) => row.id === picked);
  if (!offer) return { taken: false };

  const applied = await rerollDamageDice(message, offer.picks);
  if (!applied) return { taken: false, specId: offer.id, changed: false };

  await spendOffer(actor, offer);
  await announce(token ?? actor, offer, applied);
  return { taken: true, specId: offer.id, changed: applied.changed };
}

async function spendOffer(actor: any, offer: DamageDieOffer): Promise<void> {
  if (offer.id === "piercer") {
    const stamp = piercerStamp((game as any).combat);
    if (!stamp) return;
    try {
      await actor.setFlag(FLAG_NAMESPACE, "piercerTurn", stamp);
    } catch (err) {
      log("damage-dice: could not stamp Piercer:", err);
    }
    return;
  }
  if (offer.id === "inspiration") {
    try {
      await actor.update({ "system.attributes.inspiration": false });
    } catch (err) {
      log("damage-dice: could not clear inspiration:", err);
    }
    return;
  }
  if (offer.id === "empowered-spell") {
    const pool = offer.pool;
    if (!pool) {
      log(`damage-dice: no Font of Magic on ${actor?.name}`);
      return;
    }
    const left = await adjustUses(pool, -1);
    if (left === null) log(`damage-dice: could not spend a Sorcery Point on ${actor?.name}`);
  }
}

async function announce(
  subject: any,
  offer: DamageDieOffer,
  applied: { was: number; rolled: number; total: number },
): Promise<void> {
  try {
    await (globalThis as any).ChatMessage?.create?.({
      speaker: speakerFor(subject),
      flags: { [MODULE_ID]: { damageDie: offer.id } },
      content: `<p><strong>${game.i18n.localize(offer.labelKey)}</strong> — ${game.i18n.format(
        "NOODLRHOOKS.DiceMod.Used",
        {
          name: String(subject?.name ?? ""),
          was: String(applied.was),
          rolled: String(applied.rolled),
          total: String(applied.total),
        },
      )}</p>`,
    });
  } catch (err) {
    log("damage-dice: could not announce:", err);
  }
}

function wePlay(subject: any): boolean {
  const combat = (game as any).combat;
  if (!combat?.started) return false;
  const tokenId = String(subject?.id ?? subject?.document?.id ?? "");
  if (!tokenId) return false;
  const combatant = combat.combatants?.find(
    (c: any) => String(c.tokenId ?? c.token?.id ?? "") === tokenId,
  );
  return shouldAutomate(combatant);
}

async function resolveUuid(uuid: string): Promise<any> {
  if (!uuid) return null;
  try {
    const sync = (globalThis as any).fromUuidSync?.(uuid);
    if (sync) return sync;
    return (await (globalThis as any).fromUuid?.(uuid)) ?? null;
  } catch {
    return null;
  }
}

export function surveyDamageDice(): unknown {
  const token: any = (canvas as any)?.tokens?.controlled?.[0];
  const actor = token?.actor;
  const lines: string[] = ["damage-dice"];
  lines.push(
    `setting ${COMBAT_SETTINGS.diceMods}  enabled ${actor ? isDiceModsEnabled(actor) : "select a token"}`,
  );
  if (actor) {
    lines.push(`piercer ${piercerItem(actor) ? "yes" : "no"}  spent ${piercerSpent(actor, (game as any).combat)}`);
    lines.push(`empowered-spell ${empoweredReady(actor) ? "ready" : "no"}`);
  }
  const text = lines.join("\n");
  console.log(text);
  return { selected: actor ? 1 : 0, text };
}
