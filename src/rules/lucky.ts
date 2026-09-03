// Lucky feat (2024): spend a Luck Point with the roll.
//
// `dnd5e.preRoll*` is `Hooks.call` — synchronous — so a six-second prompt cannot
// live inside it. Same shape as Counterspell: veto first, ask after, then resume.
// Returning false from `buildConfigure` yields `[]` and `rollAttack` returns null;
// without a replay the button does nothing.
//
// Listen on `preRollD20Test` (fires once, after the specific Attack / SavingThrow /
// Skill hooks that `grants.ts` already mutates) plus `preRollDeathSave` (death has
// no `d20Test`). One of each V1/V2 pair — both fire for the same roll.
//
// Self Advantage is asked of the roller. Incoming Disadvantage is asked of the
// target's owner, then the *attacker's* roll is replayed. Automated combatants
// are skipped — the planner does not know this feat. The clock never spends a
// Luck Point.

import { COMBAT_SETTINGS, MODULE_ID, log } from "../constants";
import { adjustUses } from "../capability/primitives";
import { isDiceModsEnabled } from "../settings";
import { isDnd5e } from "../system/dnd5e-rewards";
import {
  alreadyHasAdvantage,
  alreadyHasDisadvantage,
  luckyItem,
  luckyRollKind,
  luckyTimeoutId,
  shouldOfferIncoming,
  shouldOfferSelf,
  type LuckyMode,
  type LuckyRollKind,
} from "../system/dnd5e-lucky";
import { shouldAutomate } from "../tactics/registry";
import { rollerForActor } from "../util/gm";
import { promptChoice } from "../util/prompt";
import { askUser, registerQuery } from "../util/queries";
import { speakerFor } from "../util/speaker";

const QUERY = "lucky";
const TRANSPORT_MS = 30_000;
const MAX_INCOMING = 1;

interface LuckyRequest {
  actorUuid: string;
  itemUuid: string;
  mode: LuckyMode;
  kind: LuckyRollKind;
  otherName: string;
}

interface LuckyAnswer {
  taken: boolean;
}

let holding = false;

export function registerLucky(): void {
  registerQuery(QUERY, async (data: any) => {
    const request = data?.request as LuckyRequest | undefined;
    if (!request?.actorUuid || !request.itemUuid) return { taken: false };
    return await resolveHere(request);
  });

  if (!isDnd5e()) return;
  const Hooks = (globalThis as any).Hooks;
  if (!Hooks?.on) return;

  // V1 only. basic-roll.mjs calls V1 then V2 per hookName; a false from V1 never reaches V2.
  // Listening to both would let V2 through while V1 is holding — the button would roll twice.
  Hooks.on("dnd5e.preRollD20Test", (config: any, dialog: any, message: any) => {
    try {
      return hold(config, dialog, message);
    } catch (err) {
      log("lucky: preRollD20Test failed:", err);
      return undefined;
    }
  });
  Hooks.on("dnd5e.preRollDeathSave", (config: any, dialog: any, message: any) => {
    try {
      if (!Array.isArray(config.hookNames)) config.hookNames = ["deathSave"];
      else if (!config.hookNames.includes("deathSave")) config.hookNames = ["deathSave", ...config.hookNames];
      return hold(config, dialog, message);
    } catch (err) {
      log("lucky: preRollDeathSave failed:", err);
      return undefined;
    }
  });
}

function hold(config: any, dialog: any, message: any): boolean | void {
  if (config?.noodlrLucky) return;
  if (holding) return;
  const kind = luckyRollKind(config?.hookNames);
  if (!kind) return;

  const roller = actorOf(config);
  const self = selfCandidate(roller, config);
  const incoming = kind === "attack" && shouldOfferIncoming(config) ? incomingCandidates(config) : [];
  if (!self && !incoming.length) return;

  holding = true;
  void finish(config, dialog, message, kind, self, incoming).finally(() => {
    holding = false;
  });
  return false;
}

async function finish(
  config: any,
  dialog: any,
  message: any,
  kind: LuckyRollKind,
  self: { actor: any; item: any } | null,
  incoming: Array<{ actor: any; item: any }>,
): Promise<void> {
  let advantage = alreadyHasAdvantage(config);
  let disadvantage = alreadyHasDisadvantage(config);
  const roller = actorOf(config);

  try {
    if (self && shouldOfferSelf(config)) {
      const taken = await askLucky({
        actor: self.actor,
        item: self.item,
        mode: "self",
        kind,
        otherName: String(roller?.name ?? ""),
      });
      if (taken) advantage = true;
    }

    for (const candidate of incoming.slice(0, MAX_INCOMING)) {
      if (disadvantage) break;
      const taken = await askLucky({
        actor: candidate.actor,
        item: candidate.item,
        mode: "incoming",
        kind,
        otherName: String(roller?.name ?? ""),
      });
      if (taken) disadvantage = true;
    }
  } catch (err) {
    log("lucky: ask failed; replaying the roll as it was:", err);
  }

  try {
    await replay(kind, config, dialog, message, advantage, disadvantage);
  } catch (err) {
    log("lucky: replay failed — the cancelled roll was not put back:", err);
    try {
      (globalThis as any).ui?.notifications?.error?.("Lucky could not resume the roll. Try it again.");
    } catch {
      /* a toast is courtesy */
    }
  }
}

async function askLucky(input: {
  actor: any;
  item: any;
  mode: LuckyMode;
  kind: LuckyRollKind;
  otherName: string;
}): Promise<boolean> {
  const owner = rollerForActor(input.actor) ?? String((game.users as any)?.activeGM?.id ?? "");
  if (!owner) return false;
  const request: LuckyRequest = {
    actorUuid: String(input.actor.uuid ?? ""),
    itemUuid: String(input.item.uuid ?? ""),
    mode: input.mode,
    kind: input.kind,
    otherName: input.otherName,
  };
  const answer = await askUser<LuckyAnswer>(owner, QUERY, { request }, { timeout: TRANSPORT_MS });
  return answer?.taken === true;
}

async function resolveHere(request: LuckyRequest): Promise<LuckyAnswer> {
  const actor = await resolveUuid(request.actorUuid);
  const item = await resolveUuid(request.itemUuid);
  if (!actor || !item) return { taken: false };
  if (!isDiceModsEnabled(actor)) return { taken: false };
  if (wePlay(actor)) return { taken: false };
  const live = luckyItem(actor);
  if (!live) return { taken: false };
  if (item && String(item.id ?? "") && String(live.id ?? "") !== String(item.id ?? "")) {
    log(`lucky: request named ${item.name}, spending ${live.name}`);
  }

  const picked = await promptChoice({
    title: game.i18n.format("NOODLRHOOKS.Lucky.Title", { name: String(actor.name ?? "") }),
    body: game.i18n.format(
      request.mode === "incoming" ? "NOODLRHOOKS.Lucky.BodyIncoming" : "NOODLRHOOKS.Lucky.BodySelf",
      {
        kind: kindLabel(request.kind),
        name: request.otherName,
      },
    ),
    choices: [
      {
        id: "lucky",
        label: game.i18n.localize("NOODLRHOOKS.Lucky.Spend"),
        hint: game.i18n.localize(
          request.mode === "incoming" ? "NOODLRHOOKS.Lucky.SpendIncomingHint" : "NOODLRHOOKS.Lucky.SpendHint",
        ),
      },
      {
        id: "decline",
        label: game.i18n.localize("NOODLRHOOKS.Lucky.Decline"),
        hint: game.i18n.localize("NOODLRHOOKS.Lucky.DeclineHint"),
      },
    ],
    defaultId: luckyTimeoutId(),
  });
  if (picked !== "lucky") return { taken: false };

  const left = await adjustUses(live, -1);
  if (left === null) {
    log(`lucky: could not spend a Luck Point on ${actor.name}`);
    return { taken: false };
  }
  await announce(actor, request.mode);
  return { taken: true };
}

async function announce(actor: any, mode: LuckyMode): Promise<void> {
  try {
    await (globalThis as any).ChatMessage?.create?.({
      speaker: speakerFor(actor),
      flags: { [MODULE_ID]: { lucky: mode } },
      content: `<p><strong>${game.i18n.localize("NOODLRHOOKS.Lucky.Spend")}</strong> — ${game.i18n.format(
        mode === "incoming" ? "NOODLRHOOKS.Lucky.UsedIncoming" : "NOODLRHOOKS.Lucky.UsedSelf",
        { name: String(actor.name ?? "") },
      )}</p>`,
    });
  } catch (err) {
    log("lucky: could not announce:", err);
  }
}

async function replay(
  kind: LuckyRollKind,
  config: any,
  dialog: any,
  message: any,
  advantage: boolean,
  disadvantage: boolean,
): Promise<void> {
  const rollConfig: Record<string, unknown> = {
    noodlrLucky: true,
    advantage,
    disadvantage,
    ability: config.ability,
    skill: config.skill,
    tool: config.tool,
    event: config.event,
    ammunition: config.ammunition,
    attackMode: config.attackMode,
    mastery: config.mastery,
    target: config.target,
    isConcentration: config.isConcentration,
  };
  const dialogConfig = { configure: dialog?.configure };

  if (kind === "attack") {
    const activity = config.subject;
    if (typeof activity?.rollAttack !== "function") {
      throw new Error("no activity.rollAttack to replay");
    }
    await activity.rollAttack(rollConfig, dialogConfig, message);
    return;
  }

  const actor = actorOf(config);
  if (!actor) throw new Error("no actor to replay");
  if (kind === "concentration") {
    await actor.rollConcentration(rollConfig, dialogConfig, message);
    return;
  }
  if (kind === "save") {
    await actor.rollSavingThrow(rollConfig, dialogConfig, message);
    return;
  }
  if (kind === "skill") {
    await actor.rollSkill(rollConfig, dialogConfig, message);
    return;
  }
  if (kind === "tool") {
    await actor.rollToolCheck(rollConfig, dialogConfig, message);
    return;
  }
  if (kind === "death") {
    await actor.rollDeathSave(rollConfig, dialogConfig, message);
    return;
  }
  await actor.rollAbilityCheck(rollConfig, dialogConfig, message);
}

function selfCandidate(actor: any, config: any): { actor: any; item: any } | null {
  if (!actor || !isDiceModsEnabled(actor) || wePlay(actor)) return null;
  if (!shouldOfferSelf(config)) return null;
  const item = luckyItem(actor);
  return item ? { actor, item } : null;
}

function incomingCandidates(config: any): Array<{ actor: any; item: any }> {
  const out: Array<{ actor: any; item: any }> = [];
  const seen = new Set<string>();
  for (const actor of attackTargets(config)) {
    const id = String(actor?.uuid ?? actor?.id ?? "");
    if (!id || seen.has(id)) continue;
    seen.add(id);
    if (!isDiceModsEnabled(actor) || wePlay(actor)) continue;
    const item = luckyItem(actor);
    if (!item) continue;
    out.push({ actor, item });
  }
  return out;
}

function attackTargets(config: any): any[] {
  const found: any[] = [];
  for (const row of config?.targets ?? []) {
    const uuid = String(row?.uuid ?? row?.actorUuid ?? "");
    const doc = uuid ? resolveUuidSync(uuid) : null;
    const actor = doc?.documentName === "Actor" ? doc : doc?.actor;
    if (actor) found.push(actor);
  }
  if (found.length) return found;
  for (const token of (globalThis as any).game?.user?.targets ?? []) {
    if (token?.actor) found.push(token.actor);
  }
  return found;
}

function actorOf(config: any): any {
  const subject = config?.subject ?? null;
  if (isActor(subject)) return subject;
  if (subject?.actor) return subject.actor;
  if (isActor(config?.actor)) return config.actor;
  return config?.actor ?? null;
}

function isActor(doc: any): boolean {
  if (!doc) return false;
  if (doc.documentName === "Actor") return true;
  const uuid = String(doc.uuid ?? "");
  return uuid.startsWith("Actor.") && !uuid.includes(".Item.") && !uuid.includes(".Activity.");
}

function wePlay(actor: any): boolean {
  const combat: any = (globalThis as any).game?.combat;
  if (!combat?.started) return false;
  const combatant = (combat.combatants ?? []).find?.(
    (c: any) => c?.actor === actor || String(c?.actor?.id ?? "") === String(actor?.id ?? ""),
  );
  return Boolean(combatant && shouldAutomate(combatant));
}

function kindLabel(kind: LuckyRollKind): string {
  if (kind === "attack") return "attack";
  if (kind === "save" || kind === "concentration" || kind === "death") return "save";
  return "check";
}

function resolveUuidSync(uuid: string): any {
  try {
    return (globalThis as any).fromUuidSync?.(uuid) ?? null;
  } catch {
    return null;
  }
}

async function resolveUuid(uuid: string): Promise<any> {
  if (!uuid) return null;
  try {
    return resolveUuidSync(uuid) ?? (await (globalThis as any).fromUuid?.(uuid)) ?? null;
  } catch {
    return null;
  }
}

export function surveyLucky(): unknown {
  const token: any = (canvas as any)?.tokens?.controlled?.[0];
  const actor = token?.actor;
  const lines: string[] = ["lucky"];
  lines.push(`setting ${COMBAT_SETTINGS.diceMods}  enabled ${actor ? isDiceModsEnabled(actor) : "select a token"}`);
  if (actor) {
    const item = luckyItem(actor);
    const all = [...(actor.items ?? [])].filter((it: any) => {
      try {
        return String(it?.system?.identifier ?? "") === "lucky" || /^\s*lucky\s*$/i.test(String(it?.name ?? ""));
      } catch {
        return false;
      }
    });
    lines.push(`feat ${item ? `${item.name}  ${item.system?.uses?.max ?? "?"} uses` : "NONE — no spendable Lucky feat"}`);
    if (!item && all.length) {
      for (const it of all) {
        lines.push(
          `skipped ${it.name}  type=${it.type}  id=${it.system?.identifier ?? ""}  uses=${it.system?.uses?.max ?? "none"}`,
        );
      }
    }
    lines.push(`automated ${wePlay(actor) ? "yes — will not ask" : "no"}`);
  }
  const block = lines.join("\n");
  log(`lucky — copy everything below this line:\n${block}`);
  return { selected: actor ? 1 : 0, lines };
}
