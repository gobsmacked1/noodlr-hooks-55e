// Portent: replace a D20 Test with a banked number, before the die is thrown.
//
// Same veto-and-replay as Lucky (`dnd5e.preRoll*` is `Hooks.call` — synchronous).
// Registered BEFORE Lucky so the bank is asked first. A spent face replays with
// `minimum === maximum === face` (dnd5e's own clamp) and `noodlrLucky: true`,
// because Advantage on a fixed 14 does nothing. A declined Portent replays with
// only `noodlrPortent`, so Lucky can still hold.
//
// THE OWNER IS ASKED, not the roller, when replacing someone else's test.
// Sight uses `observersWhoSee` — one implementation of "can X see Y". Missing
// tokens fail toward seeing. Self needs no sight test.
//
// Once per turn is a stamp on the owner, including out of combat (`ooc`).
// A long rest replaces the bank and clears the stamp. Combat start clears an
// `ooc` stamp so the first turn is a fresh once-per-turn.
//
// The clock never fires a face. A wrong number spent forever is unrecoverable.

import { COMBAT_SETTINGS, MODULE_ID, log } from "../constants";
import { adjustUses } from "../capability/primitives";
import { isDiceModsEnabled } from "../settings";
import { isDnd5e } from "../system/dnd5e-rewards";
import { readRest } from "../system/dnd5e-rest";
import {
  clearPortentTurn,
  facesOf,
  isGreaterPortentItem,
  notePortentSpent,
  portentDiceCount,
  portentHasFace,
  portentItem,
  portentRollKind,
  portentSpentThisTurn,
  portentTimeoutId,
  rollPortentFaces,
  spendPortentFace,
  writePortentFaces,
  type PortentRollKind,
} from "../system/dnd5e-portent";
import { shouldAutomate } from "../tactics/registry";
import { tokenOf } from "./candidates";
import { observersWhoSee } from "./sight";
import { readFlag } from "../util/flags";
import { isPrimaryGM, rollerForActor } from "../util/gm";
import { promptChoice } from "../util/prompt";
import { askUser, registerQuery } from "../util/queries";
import { speakerFor } from "../util/speaker";

const QUERY = "portent";
const TRANSPORT_MS = 30_000;
const MAX_ASKED = 2;

interface PortentRequest {
  actorUuid: string;
  itemUuid: string;
  kind: PortentRollKind;
  rollerName: string;
  self: boolean;
}

interface PortentAnswer {
  face: number | null;
}

let holding = false;

export function registerPortent(): void {
  registerQuery(QUERY, async (data: any) => {
    const request = data?.request as PortentRequest | undefined;
    if (!request?.actorUuid || !request.itemUuid) return { face: null };
    return await resolveHere(request);
  });

  if (!isDnd5e()) return;
  const Hooks = (globalThis as any).Hooks;
  if (!Hooks?.on) return;

  // V1 only. Same trap as Lucky: a false from V1 never reaches V2, and listening
  // to both would let V2 through while V1 is holding.
  Hooks.on("dnd5e.preRollD20Test", (config: any, dialog: any, message: any) => {
    try {
      return hold(config, dialog, message);
    } catch (err) {
      log("portent: preRollD20Test failed:", err);
      return undefined;
    }
  });
  Hooks.on("dnd5e.preRollDeathSave", (config: any, dialog: any, message: any) => {
    try {
      if (!Array.isArray(config.hookNames)) config.hookNames = ["deathSave"];
      else if (!config.hookNames.includes("deathSave"))
        config.hookNames = ["deathSave", ...config.hookNames];
      return hold(config, dialog, message);
    } catch (err) {
      log("portent: preRollDeathSave failed:", err);
      return undefined;
    }
  });

  Hooks.on("dnd5e.restCompleted", (actor: any, result: any, config: any) => {
    try {
      // `readRest().long` is the ledger (includes newDay). Portent is lost on a
      // Long Rest, not on a short rest that happens to tick the calendar.
      if (!readRest(result, config).triggers.includes("on_long_rest")) return;
      void refillPortent(actor);
    } catch (err) {
      log("portent: rest refill failed:", err);
    }
  });

  Hooks.on("combatStart", (combat: any) => {
    try {
      if (!isPrimaryGM()) return;
      clearOocStamps(combat);
    } catch (err) {
      log("portent: combatStart clear failed:", err);
    }
  });
}

function hold(config: any, dialog: any, message: any): boolean | void {
  if (config?.noodlrPortent) return;
  if (holding) return;
  const kind = portentRollKind(config?.hookNames);
  if (!kind) return;

  const roller = actorOf(config);
  const owners = ownersFor(roller);
  if (!owners.length) return;

  holding = true;
  void finish(config, dialog, message, kind, roller, owners).finally(() => {
    holding = false;
  });
  return false;
}

async function finish(
  config: any,
  dialog: any,
  message: any,
  kind: PortentRollKind,
  roller: any,
  owners: any[],
): Promise<void> {
  let face: number | null = null;
  try {
    for (const owner of owners.slice(0, MAX_ASKED)) {
      const item = portentItem(owner);
      if (!item || !portentHasFace(item) || portentSpentThisTurn(owner)) continue;
      const spent = await askPortent({
        actor: owner,
        item,
        kind,
        rollerName: String(roller?.name ?? ""),
        self: sameCreature(owner, roller),
      });
      if (spent !== null) {
        face = spent;
        break;
      }
    }
  } catch (err) {
    log("portent: ask failed; replaying the roll as it was:", err);
  }

  try {
    await replay(kind, config, dialog, message, face);
  } catch (err) {
    log("portent: replay failed — the cancelled roll was not put back:", err);
    try {
      (globalThis as any).ui?.notifications?.error?.(
        "Portent could not resume the roll. Try it again.",
      );
    } catch {
      /* a toast is courtesy */
    }
  }
}

async function askPortent(input: {
  actor: any;
  item: any;
  kind: PortentRollKind;
  rollerName: string;
  self: boolean;
}): Promise<number | null> {
  const owner = rollerForActor(input.actor) ?? String((game.users as any)?.activeGM?.id ?? "");
  if (!owner) return null;
  const request: PortentRequest = {
    actorUuid: String(input.actor.uuid ?? ""),
    itemUuid: String(input.item.uuid ?? ""),
    kind: input.kind,
    rollerName: input.rollerName,
    self: input.self,
  };
  const answer = await askUser<PortentAnswer>(owner, QUERY, { request }, { timeout: TRANSPORT_MS });
  return typeof answer?.face === "number" ? answer.face : null;
}

async function resolveHere(request: PortentRequest): Promise<PortentAnswer> {
  const actor = await resolveUuid(request.actorUuid);
  const item = await resolveUuid(request.itemUuid);
  if (!actor || !item) return { face: null };
  if (!isDiceModsEnabled(actor)) return { face: null };
  if (wePlay(actor)) return { face: null };
  if (portentSpentThisTurn(actor)) return { face: null };
  const live = portentItem(actor);
  if (!live || !portentHasFace(live)) return { face: null };

  const faces = facesOf(live);
  const picked = await promptChoice({
    title: game.i18n.format("NOODLRHOOKS.Portent.Title", { name: String(actor.name ?? "") }),
    body: game.i18n.format(
      request.self ? "NOODLRHOOKS.Portent.BodySelf" : "NOODLRHOOKS.Portent.BodyOther",
      {
        kind: kindLabel(request.kind),
        name: request.rollerName,
      },
    ),
    choices: [
      ...faces.map((face, index) => ({
        id: `face:${index}`,
        label: game.i18n.format("NOODLRHOOKS.Portent.Use", { face }),
        hint: game.i18n.format("NOODLRHOOKS.Portent.UseHint", { face }),
      })),
      {
        id: "decline",
        label: game.i18n.localize("NOODLRHOOKS.Portent.Decline"),
        hint: game.i18n.localize("NOODLRHOOKS.Portent.DeclineHint"),
      },
    ],
    defaultId: portentTimeoutId(),
  });
  if (!picked.startsWith("face:")) return { face: null };
  const index = Number(picked.slice(5));
  if (!Number.isInteger(index) || index < 0 || index >= faces.length) return { face: null };
  const face = await spendPortentFace(live, index);
  if (face === null) return { face: null };
  try {
    await adjustUses(live, -1);
  } catch {
    /* the bank is the truth; a uses write is the sheet catching up */
  }
  await notePortentSpent(actor);
  await announce(actor, face);
  return { face };
}

async function announce(actor: any, face: number): Promise<void> {
  try {
    await (globalThis as any).ChatMessage?.create?.({
      speaker: speakerFor(actor),
      flags: { [MODULE_ID]: { portent: face } },
      content: `<p><strong>${game.i18n.localize("NOODLRHOOKS.Portent.Spend")}</strong> — ${game.i18n.format(
        "NOODLRHOOKS.Portent.Used",
        { name: String(actor.name ?? ""), face },
      )}</p>`,
    });
  } catch (err) {
    log("portent: could not announce:", err);
  }
}

async function replay(
  kind: PortentRollKind,
  config: any,
  dialog: any,
  message: any,
  face: number | null,
): Promise<void> {
  const rollConfig: Record<string, unknown> = {
    noodlrPortent: true,
    noodlrLucky: face !== null,
    advantage: config.advantage,
    disadvantage: config.disadvantage,
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
  if (face !== null) {
    rollConfig.rolls = [{ options: { minimum: face, maximum: face } }];
    rollConfig.minimum = face;
    rollConfig.maximum = face;
  }
  const dialogConfig = { configure: dialog?.configure };

  if (kind === "initiative") {
    const actor = actorOf(config);
    if (typeof actor?.rollInitiativeDialog !== "function") {
      throw new Error("no actor.rollInitiativeDialog to replay");
    }
    await actor.rollInitiativeDialog(
      {
        event: config.event,
        minimum: face ?? undefined,
        maximum: face ?? undefined,
        noodlrPortent: true,
        noodlrLucky: face !== null,
      },
      dialogConfig,
    );
    return;
  }

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

export async function refillPortent(actor: any, faces?: number[]): Promise<number[] | null> {
  const item = portentItem(actor);
  if (!item) return null;
  const count = portentDiceCount(actor);
  const rolled = faces?.length ? parseOffered(faces, count) : await rollPortentFaces(count);
  if (!rolled.length) return null;
  await writePortentFaces(item, rolled);
  await clearPortentTurn(actor);
  try {
    await (globalThis as any).ChatMessage?.create?.({
      speaker: speakerFor(actor),
      flags: { [MODULE_ID]: { portentRefill: rolled } },
      content: `<p><strong>${game.i18n.localize("NOODLRHOOKS.Portent.Spend")}</strong> — ${game.i18n.format(
        "NOODLRHOOKS.Portent.Refilled",
        { name: String(actor.name ?? ""), faces: rolled.join(", ") },
      )}</p>`,
    });
  } catch (err) {
    log("portent: could not announce the refill:", err);
  }
  return rolled;
}

function parseOffered(faces: number[], count: number): number[] {
  return faces.filter((n) => Number.isInteger(n) && n >= 1 && n <= 20).slice(0, count);
}

function ownersFor(roller: any): any[] {
  const found: any[] = [];
  const seen = new Set<string>();
  const consider = (actor: any): void => {
    const id = String(actor?.uuid ?? actor?.id ?? "");
    if (!id || seen.has(id)) return;
    seen.add(id);
    if (!actor || !isDiceModsEnabled(actor) || wePlay(actor)) return;
    const item = portentItem(actor);
    if (!item || !portentHasFace(item)) return;
    if (portentSpentThisTurn(actor)) return;
    if (!canSeeRoller(actor, roller)) return;
    found.push(actor);
  };
  consider(roller);
  const tokens = (globalThis as any).canvas?.scene?.tokens;
  const list: any[] = tokens?.contents ?? tokens ?? [];
  for (const token of list) {
    consider(token?.actor ?? token?.document?.actor);
  }
  return found;
}

function canSeeRoller(owner: any, roller: any): boolean {
  if (!owner || !roller) return true;
  if (sameCreature(owner, roller)) return true;
  const from = tokenOf(owner);
  const to = tokenOf(roller);
  if (!from || !to) return true;
  try {
    return observersWhoSee([from], to).has(String(from.id ?? ""));
  } catch (err) {
    log("portent: sight test failed; offering anyway:", err);
    return true;
  }
}

function sameCreature(a: any, b: any): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const id = String(a.id ?? "");
  return Boolean(id) && id === String(b.id ?? "");
}

function clearOocStamps(combat: any): void {
  for (const c of combat?.combatants ?? []) {
    const actor = c?.actor;
    if (!actor || !portentItem(actor)) continue;
    const stamp = String(readFlag(actor, "portentTurn") ?? "");
    if (stamp === "ooc") void clearPortentTurn(actor);
  }
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

function kindLabel(kind: PortentRollKind): string {
  if (kind === "attack") return "attack";
  if (kind === "save" || kind === "concentration" || kind === "death") return "save";
  if (kind === "initiative") return "initiative";
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

export function surveyPortent(): unknown {
  const token: any = (canvas as any)?.tokens?.controlled?.[0];
  const actor = token?.actor;
  const lines: string[] = ["portent"];
  lines.push(
    `setting ${COMBAT_SETTINGS.diceMods}  enabled ${actor ? isDiceModsEnabled(actor) : "select a token"}`,
  );
  if (actor) {
    const item = portentItem(actor);
    const faces = item ? facesOf(item) : [];
    const count = portentDiceCount(actor);
    const greater = [...(actor.items ?? [])].some((it: any) => isGreaterPortentItem(it));
    lines.push(`feat ${item ? item.name : "NONE"}`);
    lines.push(`greater ${greater ? "yes" : "no"}`);
    lines.push(`bank ${faces.length ? faces.join(", ") : "empty"}  / ${count}`);
    lines.push(`spent this turn ${portentSpentThisTurn(actor) ? "yes" : "no"}`);
    lines.push(`automated ${wePlay(actor) ? "yes — will not ask" : "no"}`);
    if (!item) {
      const all = [...(actor.items ?? [])].filter((it: any) => {
        try {
          const id = String(it?.system?.identifier ?? "");
          return (
            id === "portent" ||
            id === "greater-portent" ||
            /^\s*(greater\s+)?portent\s*$/i.test(String(it?.name ?? ""))
          );
        } catch {
          return false;
        }
      });
      for (const it of all) {
        lines.push(`skipped ${it.name}  type=${it.type}  id=${it.system?.identifier ?? ""}`);
      }
    }
  }
  const block = lines.join("\n");
  log(`portent — copy everything below this line:\n${block}`);
  return { selected: actor ? 1 : 0, lines };
}

/** Record faces on the selected creature's Portent item. Empty list clears the bank. */
export async function recordPortent(faces: number[]): Promise<unknown> {
  const token: any = (canvas as any)?.tokens?.controlled?.[0];
  const actor = token?.actor;
  if (!actor) return { error: "select a token" };
  const item = portentItem(actor);
  if (!item) return { error: "no Portent feature on this creature" };
  const clean = parseOffered(faces, portentDiceCount(actor));
  await writePortentFaces(item, clean);
  await clearPortentTurn(actor);
  return { name: actor.name, faces: facesOf(item) };
}
