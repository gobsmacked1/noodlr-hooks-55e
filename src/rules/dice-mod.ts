// One offer for every feature that changes a d20 after it has already been rolled.
//
// Checks, saves and missed attacks share the self window. Opposed after-success (Cutting
// Words) is a second pass on the same card, with its own pending/done so a miss that becomes
// a hit can still be subtracted. Already-on effects (Guidance, Bless, standing Advantage)
// stay off it — those are on the roll before it posts. Lucky is a different hook
// (`src/rules/lucky.ts`, with-roll veto + replay) and is not this table. Portent is
// before-roll (`src/rules/portent.ts`) and is not this table. Cutting Words on a
// damage roll is this table (`kinds` includes `damage`); the offer is raised
// from `damage-dice.ts` after the self rerolls, not from here.
//
// ASKED ON THE OWNER'S CLIENT, same as a reaction. The GM notices; whoever plays the creature
// answers; that client spends the resource and rewrites the card. Automated combatants are
// skipped this pass — the planner does not know these features.
//
// THE CLOCK MAY SPEND A FREE OPTION AND NEVER A DEPLETING ONE. Indomitable Might is free and
// always better, so the timeout takes it. Inspiration, a held BI die, Indomitable, Stroke of
// Luck, Focus, Sorcery and Cutting Words default to decline.
//
// TWO ROUNDS AT MOST on the self window. A fighter can stack Indomitable and Inspiration;
// they cannot be asked forever. After one apply the card is re-read; if it still failed, the
// remaining options are offered once more. Opposed is one ask (MAX_ASKED 1).

import { COMBAT_SETTINGS, MODULE_ID, log } from "../constants";
import { isPrimaryGM, rollerForActor } from "../util/gm";
import { promptChoice, type Choice } from "../util/prompt";
import { askUser, registerQuery } from "../util/queries";
import { speakerFor } from "../util/speaker";
import { enabledForEither, isAutoSavesEnabled, isDiceModsEnabled } from "../settings";
import { midiOwnsDamage, midiOwnsSaves } from "../system/dnd5e-damage";
import { isDnd5e } from "../system/dnd5e-rewards";
import { adjustUses } from "../capability/primitives";
import {
  addRoll,
  replaceD20,
  rerollKeepNew,
  setTotal,
  subtractRoll,
  type Reroll,
} from "../system/dnd5e-reroll";
import {
  bardicItem,
  diceModTimeoutId,
  fighterLevel,
  inspiredEffect,
  inspirationFormula,
  modsAgainst,
  modsOn,
  specApplies,
  strengthScore,
  type DiceContext,
  type DiceKind,
  type DiceModOffer,
  type DiceWhose,
} from "../system/dnd5e-dice-mods";
import {
  combinedDamageTotal,
  itemOf,
  readCheck,
  readHits,
  readSave,
  rollType,
  speakerToken,
} from "./cards";
import { combatantFor, reactorsAgainst, tokenOf } from "./candidates";
import { hasReaction, spend } from "./economy/ledger";
import { shouldAutomate } from "../tactics/registry";

const QUERY = "diceMod";
const MAX_ROUNDS = 2;
const TRANSPORT_MS = 30_000;

const pending = new Set<string>();
const done = new Set<string>();
const againstPending = new Set<string>();
const againstDone = new Set<string>();
const MAX_ASKED = 1;

export interface DiceModInput {
  kind: DiceKind;
  message: any;
  actor: any;
  token?: any;
}

export interface DiceModResult {
  changed: boolean;
  used: string[];
}

interface DiceModRequest {
  messageId: string;
  actorUuid: string;
  tokenUuid?: string;
  kind: DiceKind;
  success: boolean | null;
  missed: boolean;
  ability: string;
  isSpellAttack: boolean;
  total: number;
  dc: number | null;
  used: string[];
  whose?: DiceWhose;
  reactorUuid?: string;
  reactorTokenUuid?: string;
}

interface DiceModAnswer {
  taken: boolean;
  specId?: string;
  changed?: boolean;
}

/** Register the answering half. Every client: the addressee is whoever owns the sheet. */
export function registerDiceMods(): void {
  registerQuery(QUERY, async (data: any) => {
    const request = data?.request as DiceModRequest | undefined;
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

/**
 * Offer after-fail / after-miss options for a roll whose verdict is already in hand.
 *
 * Saves and attacks call this from the layers that already hold those verdicts. Checks arrive
 * through the chat hooks above.
 */
export async function considerDiceMods(input: DiceModInput): Promise<DiceModResult> {
  const empty: DiceModResult = { changed: false, used: [] };
  const message = input.message;
  const id = String(message?.id ?? "");
  if (!id || done.has(id) || pending.has(id)) return empty;
  if (!isDnd5e() || !isPrimaryGM()) return empty;
  if (!input.actor || !isDiceModsEnabled(input.actor)) return empty;
  if (wePlay(input.token ?? input.actor)) return empty;

  const ctx = contextOf(input);
  if (!modsOn(input.actor, ctx).length) return empty;

  pending.add(id);
  try {
    return await offerRounds(input, ctx);
  } finally {
    pending.delete(id);
    done.add(id);
    while (done.size > 64) {
      const oldest = done.keys().next().value;
      if (oldest === undefined) break;
      done.delete(oldest);
    }
  }
}

async function considerPosted(message: any): Promise<void> {
  const kind = rollType(message);
  if (kind === "skill" || kind === "ability") {
    const before = readCheck(message);
    if (before.success === false) {
      await offerFor(message, "check");
    }
    const after = readCheck(message);
    if (after.success === true) await offerAgainst(message, "check");
    return;
  }
  if (kind === "attack") {
    let reading = readHits(message);
    if (reading.hits.length === 0 && reading.missed.length > 0) {
      await offerFor(message, "attack");
      reading = readHits(message);
    }
    // When auto-damage is on, reactionWindow does Barbs first, then Cutting Words.
    // Asking here would subtract a hit Barbs is about to spoil.
    if (reading.hits.length > 0 && !autoDamageLayerRuns()) {
      await offerAgainst(message, "attack");
    }
    return;
  }
  if (kind !== "save") return;
  // When auto-saves is on, spoilAndResist asks AFTER Barbs. Asking here would spend
  // Indomitable on a fail that Barbs then undoes. When that layer is off (or midi
  // owns it), we are the only offer — skip midi so two layers do not rewrite one card.
  // Cutting Words does not fire on saves (printed trigger is a damage roll or a made
  // check / attack).
  if (midiOwnsSaves() || isAutoSavesEnabled()) return;
  const reading = readSave(message);
  if (reading.success !== false || reading.forced) return;
  await offerFor(message, "save");
}

function autoDamageLayerRuns(): boolean {
  return !midiOwnsDamage() && enabledForEither(COMBAT_SETTINGS.autoDamage);
}

async function offerFor(message: any, kind: DiceKind): Promise<void> {
  const roll: any = message?.rolls?.[0];
  if (!roll || !Number.isFinite(Number(roll.total))) return;
  const token = speakerToken(message?.speaker);
  const actor = token?.actor ?? message?.speakerActor ?? null;
  if (!actor) return;
  await considerDiceMods({ kind, message, actor, token });
}

async function offerAgainst(message: any, kind: DiceKind): Promise<void> {
  const roll: any = message?.rolls?.[0];
  if (!roll || !Number.isFinite(Number(roll.total))) return;
  const token = speakerToken(message?.speaker);
  const actor = token?.actor ?? message?.speakerActor ?? null;
  if (!actor) return;
  await considerAgainstDiceMods({ kind, message, actor, token });
}

async function offerRounds(input: DiceModInput, ctx: DiceContext): Promise<DiceModResult> {
  const used: string[] = [];
  let changed = false;
  let live = ctx;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const options = modsOn(input.actor, live).filter((offer) => !used.includes(offer.spec.id));
    if (!options.length) break;

    const owner = rollerForActor(input.actor) ?? String((game.users as any)?.activeGM?.id ?? "");
    if (!owner) break;

    const request: DiceModRequest = {
      messageId: String(input.message.id),
      actorUuid: String(input.actor.uuid ?? ""),
      tokenUuid: input.token ? String(input.token.uuid ?? "") : undefined,
      kind: live.kind,
      success: live.success,
      missed: live.missed,
      ability: live.ability,
      isSpellAttack: live.isSpellAttack,
      total: live.total,
      dc: dcOf(input),
      used: [...used],
    };

    const answer = await askUser<DiceModAnswer>(
      owner,
      QUERY,
      { request },
      { timeout: TRANSPORT_MS },
    );
    if (!answer?.taken || !answer.specId) break;
    used.push(answer.specId);
    if (answer.changed) changed = true;

    live = reread(input);
    if (!stillNeedsHelp(live)) break;
  }

  return { changed, used };
}

/**
 * Opposed after-success (Cutting Words). Separate pending/done from the self window so a
 * miss that Inspiration turned into a hit can still be subtracted on the same message.
 *
 * Combat-only: the reaction ledger is turn-stamped, and out of a fight nothing stops one
 * Bard spoiling every roll in a scene.
 */
export async function considerAgainstDiceMods(input: DiceModInput): Promise<DiceModResult> {
  const empty: DiceModResult = { changed: false, used: [] };
  const message = input.message;
  const id = String(message?.id ?? "");
  if (!id || againstDone.has(id) || againstPending.has(id)) return empty;
  if (!isDnd5e() || !isPrimaryGM()) return empty;
  const combat = (game as any).combat;
  if (!combat?.started) return empty;
  if (!input.actor) return empty;

  const ctx = contextOf(input);
  const candidates = cutters(input, ctx, combat);
  if (!candidates.length) return empty;

  againstPending.add(id);
  try {
    const used: string[] = [];
    let changed = false;
    for (const candidate of candidates) {
      const owner =
        rollerForActor(candidate.actor) ?? String((game.users as any)?.activeGM?.id ?? "");
      if (!owner) continue;
      const request: DiceModRequest = {
        messageId: String(input.message.id),
        actorUuid: String(input.actor.uuid ?? ""),
        tokenUuid: input.token ? String(input.token.uuid ?? "") : undefined,
        kind: ctx.kind,
        success: ctx.success,
        missed: ctx.missed,
        ability: ctx.ability,
        isSpellAttack: ctx.isSpellAttack,
        total: ctx.total,
        dc: dcOf(input),
        used,
        whose: "opposed",
        reactorUuid: String(candidate.actor.uuid ?? ""),
        reactorTokenUuid: String(candidate.token?.document?.uuid ?? candidate.token?.uuid ?? ""),
      };
      const answer = await askUser<DiceModAnswer>(
        owner,
        QUERY,
        { request },
        { timeout: TRANSPORT_MS },
      );
      if (!answer?.taken || !answer.specId) continue;
      used.push(answer.specId);
      if (answer.changed) changed = true;
      break;
    }
    return { changed, used };
  } finally {
    againstPending.delete(id);
    againstDone.add(id);
    while (againstDone.size > 64) {
      const oldest = againstDone.keys().next().value;
      if (oldest === undefined) break;
      againstDone.delete(oldest);
    }
  }
}

function cutters(input: DiceModInput, ctx: DiceContext, combat: any) {
  const subjectToken = input.token ?? tokenOf(input.actor);
  return reactorsAgainst({
    subjectToken,
    subjectActor: input.actor,
    combat,
    trigger: "success",
    label: "cutting words",
    max: MAX_ASKED,
    ready: (actor) => {
      if (!isDiceModsEnabled(actor)) return null;
      if (wePlay(tokenOf(actor) ?? actor)) return null;
      const offers = modsAgainst(actor, ctx);
      return offers.length ? offers : null;
    },
    range: (offers) => Number(offers[0]?.spec.range ?? 60),
  });
}

async function resolveHere(request: DiceModRequest): Promise<DiceModAnswer> {
  const message = (game.messages as any)?.get?.(request.messageId);
  const roller = await resolveUuid(request.actorUuid);
  if (!message || !roller) return { taken: false };

  const opposed = request.whose === "opposed";
  const spender = opposed && request.reactorUuid ? await resolveUuid(request.reactorUuid) : roller;
  if (!spender) return { taken: false };
  if (!isDiceModsEnabled(spender)) return { taken: false };

  const rollerToken = request.tokenUuid
    ? await resolveUuid(request.tokenUuid)
    : speakerToken(message?.speaker);
  const spenderToken =
    opposed && request.reactorTokenUuid ? await resolveUuid(request.reactorTokenUuid) : rollerToken;
  const ctx = contextOf({
    kind: request.kind,
    message,
    actor: roller,
    token: rollerToken,
  });
  const options = (opposed ? modsAgainst(spender, ctx) : modsOn(spender, ctx)).filter(
    (offer) => !request.used.includes(offer.spec.id),
  );
  if (!options.length) return { taken: false };

  const combat = (game as any).combat;
  if (opposed) {
    if (!combat?.started) return { taken: false };
    const combatant = combatantFor(combat, spenderToken);
    if (options.some((offer) => offer.spec.needsReaction) && !hasReaction(combatant)) {
      return { taken: false };
    }
  }

  const choices: Choice[] = options.map((offer) => ({
    id: offer.spec.id,
    label: game.i18n.localize(offer.labelKey),
    hint: game.i18n.localize(offer.hintKey),
  }));
  choices.push({
    id: "decline",
    label: game.i18n.localize("NOODLRHOOKS.DiceMod.Decline"),
    hint: game.i18n.localize("NOODLRHOOKS.DiceMod.DeclineHint"),
  });

  const titleKey = opposed ? "NOODLRHOOKS.DiceMod.TitleAgainst" : "NOODLRHOOKS.DiceMod.Title";
  const picked = await promptChoice({
    title: game.i18n.format(titleKey, {
      name: String(spenderToken?.name ?? spender.name ?? ""),
    }),
    body: bodyOf(request, ctx),
    choices,
    defaultId: diceModTimeoutId(
      options.map((offer) => ({ id: offer.spec.id, depleting: offer.spec.depleting })),
    ),
  });
  if (picked === "decline" || !picked) return { taken: false };

  const offer = options.find((row) => row.spec.id === picked);
  if (!offer) return { taken: false };
  if (!specApplies(offer.spec, ctx)) return { taken: false };

  if (offer.spec.needsReaction) {
    const combatant = combatantFor(combat, spenderToken);
    if (!hasReaction(combatant)) return { taken: false };
  }

  const applied = await applyOffer(message, roller, offer);
  if (!applied.ok) return { taken: false, specId: offer.spec.id, changed: false };

  if (offer.spec.refundIfStillFails) {
    const after = contextOf({ kind: request.kind, message, actor: roller, token: rollerToken });
    if (stillNeedsHelp(after)) {
      await announce(spenderToken ?? spender, offer, applied);
      return { taken: true, specId: offer.spec.id, changed: applied.changed };
    }
  }

  await spendOffer(spender, offer);
  if (offer.spec.needsReaction) {
    spend(spender, combat, combatantFor(combat, spenderToken), "reaction", false);
  }
  await announce(spenderToken ?? spender, offer, applied);
  return { taken: true, specId: offer.spec.id, changed: applied.changed };
}

async function applyOffer(
  message: any,
  actor: any,
  offer: DiceModOffer,
): Promise<{ ok: boolean; changed: boolean; was?: number; rolled?: number; total?: number }> {
  const op = offer.spec.op;
  if (op === "reroll-keep-new") {
    const reroll = await rerollKeepNew(message);
    return fromReroll(reroll);
  }
  if (op === "replace-20") {
    const reroll = await replaceD20(message, 20);
    return fromReroll(reroll);
  }
  if (op === "reroll-plus-level") {
    const reroll = await rerollKeepNew(message);
    if (!reroll) return { ok: false, changed: false };
    const level = fighterLevel(actor);
    // Write from the reroll's arithmetic, not from `rolls[0].total` — a failed card update
    // would otherwise add the bonus to the original total and silently drop the new die.
    const total = reroll.total + (level > 0 ? level : 0);
    if (level > 0) await setTotal(message, total);
    return {
      ok: true,
      changed: reroll.changed || level > 0,
      was: reroll.was,
      rolled: reroll.rolled,
      total,
    };
  }
  if (op === "set-str") {
    const score = strengthScore(actor);
    if (!Number.isFinite(score)) return { ok: false, changed: false };
    const before = Number(message?.rolls?.[0]?.total);
    const total = await setTotal(message, score);
    return {
      ok: total !== null,
      changed: Number.isFinite(before) && total !== before,
      was: before,
      rolled: score,
      total: total ?? score,
    };
  }
  if (op === "add-die" || op === "subtract-die") {
    const formula = String(offer.formula ?? "").trim();
    if (!formula) return { ok: false, changed: false };
    const rollData = typeof actor?.getRollData === "function" ? actor.getRollData() : undefined;
    const result =
      op === "add-die"
        ? await addRoll(message, formula, rollData)
        : await subtractRoll(message, formula, rollData);
    if (!result) return { ok: false, changed: false };
    return {
      ok: true,
      changed: result.changed,
      was: result.was,
      rolled: result.rolled,
      total: result.total,
    };
  }
  return { ok: false, changed: false };
}

function fromReroll(reroll: Reroll | null): {
  ok: boolean;
  changed: boolean;
  was?: number;
  rolled?: number;
  total?: number;
} {
  if (!reroll) return { ok: false, changed: false };
  return {
    ok: true,
    changed: reroll.changed,
    was: reroll.was,
    rolled: reroll.rolled,
    total: reroll.total,
  };
}

async function spendOffer(actor: any, offer: DiceModOffer): Promise<void> {
  const resource = offer.spec.resource;
  if (resource === "none") return;
  if (resource === "inspiration") {
    try {
      await actor.update({ "system.attributes.inspiration": false });
    } catch (err) {
      log("dice-mod: could not clear inspiration:", err);
    }
    return;
  }
  if (resource === "inspired") {
    const effect = offer.effect ?? inspiredEffect(actor);
    if (!effect) {
      log(`dice-mod: no Inspired effect to spend on ${actor?.name}`);
      return;
    }
    try {
      await effect.delete();
    } catch (err) {
      log("dice-mod: could not delete Inspired:", err);
    }
    return;
  }
  if (resource === "bardic") {
    const pool = offer.spendItem ?? bardicItem(actor);
    if (!pool) {
      log(`dice-mod: no Bardic Inspiration uses on ${actor?.name}`);
      return;
    }
    const left = await adjustUses(pool, -1);
    if (left === null) log(`dice-mod: could not spend Bardic Inspiration on ${actor?.name}`);
    return;
  }
  if (!offer.item) return;
  const left = await adjustUses(offer.item, -1);
  if (left === null) log(`dice-mod: could not spend ${offer.spec.id} on ${actor?.name}`);
}

async function announce(
  subject: any,
  offer: DiceModOffer,
  applied: { was?: number; rolled?: number; total?: number },
): Promise<void> {
  try {
    await (globalThis as any).ChatMessage?.create?.({
      speaker: speakerFor(subject),
      flags: { [MODULE_ID]: { diceMod: offer.spec.id } },
      content: `<p><strong>${game.i18n.localize(offer.labelKey)}</strong> — ${game.i18n.format(
        "NOODLRHOOKS.DiceMod.Used",
        {
          name: String(subject?.name ?? ""),
          was: String(applied.was ?? "?"),
          rolled: String(applied.rolled ?? "?"),
          total: String(applied.total ?? "?"),
        },
      )}</p>`,
    });
  } catch (err) {
    log("dice-mod: could not announce:", err);
  }
}

export function contextOf(input: DiceModInput): DiceContext {
  const message = input.message;
  const actor = input.actor;
  if (input.kind === "damage") {
    return {
      kind: "damage",
      success: true,
      missed: false,
      ability: "",
      isSpellAttack: false,
      total: combinedDamageTotal(message),
      strScore: strengthScore(actor),
    };
  }
  if (input.kind === "attack") {
    const reading = readHits(message);
    return {
      kind: "attack",
      success: reading.hits.length > 0 ? true : reading.missed.length > 0 ? false : null,
      missed: reading.hits.length === 0 && reading.missed.length > 0,
      ability: "",
      isSpellAttack: isSpellAttack(message),
      total: Number(message?.rolls?.[0]?.total),
      strScore: strengthScore(actor),
    };
  }
  if (input.kind === "save") {
    const reading = readSave(message);
    return {
      kind: "save",
      success: reading.success,
      missed: false,
      ability: reading.ability,
      isSpellAttack: false,
      total: reading.total,
      strScore: strengthScore(actor),
    };
  }
  const reading = readCheck(message);
  return {
    kind: "check",
    success: reading.success,
    missed: false,
    ability: reading.ability,
    isSpellAttack: false,
    total: reading.total,
    strScore: strengthScore(actor),
  };
}

function reread(input: DiceModInput): DiceContext {
  return contextOf(input);
}

function stillNeedsHelp(ctx: DiceContext): boolean {
  if (ctx.kind === "damage") return false;
  if (ctx.kind === "attack") return ctx.missed;
  return ctx.success === false;
}

function isSpellAttack(message: any): boolean {
  if (String(message?.flags?.dnd5e?.item?.type ?? "") === "spell") return true;
  return String(itemOf(message)?.type ?? "") === "spell";
}

function dcOf(input: DiceModInput): number | null {
  if (input.kind === "save") return readSave(input.message).dc;
  if (input.kind === "check") return readCheck(input.message).dc;
  return null;
}

function bodyOf(request: DiceModRequest, ctx: DiceContext): string {
  const opposed = request.whose === "opposed";
  const key = opposed
    ? request.kind === "attack"
      ? "NOODLRHOOKS.DiceMod.BodySuccessAttack"
      : request.kind === "damage"
        ? "NOODLRHOOKS.DiceMod.BodySuccessDamage"
        : "NOODLRHOOKS.DiceMod.BodySuccessCheck"
    : request.kind === "attack"
      ? "NOODLRHOOKS.DiceMod.BodyMiss"
      : request.kind === "save"
        ? "NOODLRHOOKS.DiceMod.BodySave"
        : "NOODLRHOOKS.DiceMod.BodyCheck";
  return game.i18n.format(key, {
    total: String(Number.isFinite(ctx.total) ? ctx.total : request.total),
    dc: request.dc === null || request.dc === undefined ? "—" : String(request.dc),
  });
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
    if (sync) return sync.documentName === "Token" ? sync : sync;
    return (await (globalThis as any).fromUuid?.(uuid)) ?? null;
  } catch {
    return null;
  }
}

export function surveyDiceMods(): unknown {
  const token: any = (canvas as any)?.tokens?.controlled?.[0];
  const actor = token?.actor;
  const lines: string[] = ["dice-mod"];
  lines.push(
    `setting ${COMBAT_SETTINGS.diceMods}  enabled ${actor ? isDiceModsEnabled(actor) : "select a token"}`,
  );
  if (actor) {
    const fake: DiceContext = {
      kind: "save",
      success: false,
      missed: false,
      ability: "str",
      isSpellAttack: false,
      total: 1,
      strScore: strengthScore(actor),
    };
    const offers = modsOn(actor, fake);
    const inspired = inspiredEffect(actor);
    const against = modsAgainst(actor, {
      kind: "attack",
      success: true,
      missed: false,
      ability: "",
      isSpellAttack: false,
      total: 18,
      strScore: fake.strScore,
    });
    lines.push(`inspiration ${actor.system?.attributes?.inspiration === true ? "yes" : "no"}`);
    lines.push(
      `inspired ${inspired ? "yes" : "no"}  bi-die ${inspirationFormula(actor) ?? "unreadable"}`,
    );
    lines.push(
      `str ${Number.isFinite(fake.strScore) ? fake.strScore : "unreadable"}  fighter ${fighterLevel(actor)}`,
    );
    if (!offers.length) lines.push("offers NONE — a failed save would raise nothing");
    for (const offer of offers) {
      lines.push(
        `offer ${offer.spec.id}  ${offer.spec.op}  ${offer.spec.depleting ? "depleting" : "free"}  ${offer.formula ?? offer.item?.name ?? "no item"}`,
      );
    }
    if (!against.length) lines.push("against NONE — a made attack would raise no Cutting Words");
    for (const offer of against) {
      lines.push(
        `against ${offer.spec.id}  ${offer.spec.op}  ${offer.formula ?? "no die"}  ${offer.spendItem?.name ?? "no pool"}`,
      );
    }
  }
  const block = lines.join("\n");
  log(`dice-mod — copy everything below this line:\n${block}`);
  return { selected: actor ? 1 : 0, lines };
}
