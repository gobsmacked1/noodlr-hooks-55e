// RAW half-ammo recover after a won fight, if the shooter can still search.
//
// Track only while `game.combat?.started`. Out-of-combat potshots do not count.
// Skip a thrown-weapon consume (`ammoUpdate.id === weapon.id`) — that is the
// Tile pin in `thrown.ts`. Skip Returning ammo; dnd5e never spends it.
// Listen to `dnd5e.rollAttack` V1 only (the V1/V2 pair is the Lucky trap).
// `ammoUpdate` exists before consume, so a last-arrow `destroy` still counts
// and we stash `toObject()` so the stack can be recreated.
//
// The spend is noted on the rolling client (a player's own attack). Recover
// runs on the primary GM. The ledger is a flag on the actor so it crosses
// that wire — an in-memory Map on the GM would miss every PC shot.
//
// Recover from `announceEncounterEndIfOver` after XP, before `combat.delete()`,
// when the party held the field. `deleteCombat` is the backup for a hand-ended
// wipe and a no-op after the first recover. Rides `combat.attackRange`.

import { MODULE_ID, log } from "../constants";
import { isAttackRangeEnabled } from "../settings";
import { isDnd5e } from "../system/dnd5e-rewards";
import { hasStatus } from "../system/dnd5e-conditions";
import {
  ammoRecovered,
  canSearchBattlefield,
  isPartySearcher,
  partyHeldTheField,
} from "../system/dnd5e-ammo";
import { pickNumber, systemPaths } from "../system/profiles";
import { isPrimaryGM } from "../util/gm";
import { speakerFor } from "../util/speaker";

const FLAG = "ammoSpent";

interface Stack {
  name: string;
  spent: number;
  payload: Record<string, unknown> | null;
}

interface AmmoBag {
  combatId: string;
  stacks: Record<string, Stack>;
}

const recovered = new Set<string>();
const pending = new Map<string, AmmoBag>();
const flushChain = new Map<string, Promise<void>>();

function combatIdOf(combat: any): string {
  return String(combat?.id ?? "");
}

export function registerAmmo(): void {
  if (!isDnd5e()) return;
  const Hooks = (globalThis as any).Hooks;
  if (!Hooks?.on) return;

  Hooks.on("dnd5e.rollAttack", (_rolls: unknown, data: any) => {
    try {
      noteAttackSpend(data);
    } catch (err) {
      log("ammo: rollAttack note failed:", err);
    }
  });

  Hooks.on("combatStart", (combat: any) => {
    recovered.delete(combatIdOf(combat));
  });

  Hooks.on("deleteCombat", (combat: any) => {
    try {
      void recoverSpentAmmunition(combat);
    } catch (err) {
      log("ammo: deleteCombat recover failed:", err);
    }
  });
}

function readBag(actor: any): AmmoBag | null {
  try {
    const bag = actor?.getFlag?.(MODULE_ID, FLAG) as AmmoBag | undefined;
    if (!bag || typeof bag !== "object" || !bag.stacks) return null;
    return bag;
  } catch {
    return null;
  }
}

function noteAttackSpend(data: any): void {
  if (!isAttackRangeEnabled()) return;
  const combat = (game as any)?.combat;
  const combatId = combatIdOf(combat);
  if (!combat?.started || !combatId) return;
  const ammoUpdate = data?.ammoUpdate;
  const ammoId = String(ammoUpdate?.id ?? "");
  if (!ammoId) return;

  const activity = data?.subject;
  const weapon = activity?.item;
  if (ammoId === String(weapon?.id ?? "")) return;

  const actor = activity?.actor ?? weapon?.actor;
  const actorId = String(actor?.id ?? "");
  if (!actorId) return;

  const ammo = actor.items?.get?.(ammoId);
  if (!ammo) return;
  const props = ammo.system?.properties;
  if (typeof props?.has === "function" && props.has("ret")) return;

  let payload: Record<string, unknown> | null = null;
  if (ammoUpdate.destroy && typeof ammo.toObject === "function") {
    try {
      payload = ammo.toObject() as Record<string, unknown>;
    } catch {
      payload = null;
    }
  }

  const prev = pending.get(actorId) ?? readBag(actor);
  const bag: AmmoBag =
    prev && prev.combatId === combatId
      ? { combatId, stacks: { ...prev.stacks } }
      : { combatId, stacks: {} };
  const stack = bag.stacks[ammoId];
  bag.stacks[ammoId] = {
    name: String(ammo.name ?? stack?.name ?? "ammunition"),
    spent: (stack?.spent ?? 0) + 1,
    payload: payload ?? stack?.payload ?? null,
  };
  pending.set(actorId, bag);
  queueFlush(actor);
}

function queueFlush(actor: any): void {
  const id = String(actor?.id ?? "");
  if (!id) return;
  const prev = flushChain.get(id) ?? Promise.resolve();
  const next = prev
    .then(() => {
      const bag = pending.get(id);
      if (!bag) return;
      return actor.setFlag(MODULE_ID, FLAG, bag);
    })
    .catch((err: unknown) => {
      log("ammo: could not store spend:", err);
    });
  flushChain.set(id, next);
}

export function looksLikeVictory(combat: any): boolean {
  const P = systemPaths();
  let hostiles = 0;
  let standing = 0;
  for (const c of combat?.combatants ?? []) {
    const any = c as any;
    if (any?.hasPlayerOwner ?? any?.actor?.hasPlayerOwner) continue;
    hostiles++;
    const hp = pickNumber(any.actor, P.hpValue);
    const dead = Boolean(any.isDefeated || (hp !== null && hp <= 0));
    if (!dead) standing++;
  }
  return partyHeldTheField({ hostiles, standing, mercy: false });
}

function actorCanSearch(actor: any): boolean {
  const hp = pickNumber(actor, systemPaths().hpValue);
  return canSearchBattlefield({
    hp,
    dead: hasStatus(actor, "dead"),
    unconscious: hasStatus(actor, "unconscious"),
  });
}

function actorIsParty(actor: any, combatant?: any): boolean {
  const FRIENDLY = (globalThis as any).CONST?.TOKEN_DISPOSITIONS?.FRIENDLY ?? 1;
  const token = combatant?.token ?? actor?.token;
  const disp = Number(token?.disposition ?? actor?.prototypeToken?.disposition);
  return isPartySearcher({
    character: String(actor?.type ?? "") === "character",
    playerOwned: Boolean(combatant?.hasPlayerOwner ?? actor?.hasPlayerOwner),
    friendly: disp === FRIENDLY,
  });
}

/**
 * Give back ⌊spent / 2⌋ on a victory. `opts.victory` is what the encounter
 * layer already computed (includes mercy). Without it, dead-hostiles only.
 */
export async function recoverSpentAmmunition(
  combat: any,
  opts?: { victory?: boolean },
): Promise<void> {
  if (!isPrimaryGM()) return;
  const id = combatIdOf(combat);
  if (!id || recovered.has(id)) return;
  recovered.add(id);
  await Promise.all([...flushChain.values()]);

  const victory = opts?.victory ?? looksLikeVictory(combat);
  const rows = collectRows(combat, id);
  if (!victory || !isAttackRangeEnabled() || rows.length === 0) {
    await clearBags(rows);
    return;
  }

  for (const row of rows) {
    const recoveredCount = ammoRecovered(row.stack.spent);
    const actor = row.actor;
    if (recoveredCount <= 0) continue;
    if (!actorIsParty(actor, row.combatant)) continue;
    if (!actorCanSearch(actor)) {
      log(`ammo: ${row.actorName} cannot search — ${row.stack.spent} ${row.stack.name} stay lost`);
      continue;
    }
    const ok = await restoreStack(actor, row.ammoId, row.stack, recoveredCount);
    if (!ok) continue;
    const lost = row.stack.spent - recoveredCount;
    const ChatMessage = (globalThis as any).ChatMessage;
    await ChatMessage.create({
      content: `<p>${game.i18n.format("NOODLRHOOKS.Combat.Ammo.Recovered", {
        name: row.actorName,
        recovered: recoveredCount,
        ammo: row.stack.name,
        lost,
      })}</p>`,
      speaker: speakerFor(row.combatant ?? actor, row.actorName),
    });
  }
  await clearBags(rows);
}

interface Row {
  actor: any;
  combatant: any;
  actorName: string;
  ammoId: string;
  stack: Stack;
}

function collectRows(combat: any, combatId: string): Row[] {
  const rows: Row[] = [];
  const seen = new Set<string>();
  for (const c of combat?.combatants ?? []) {
    const actor = (c as any)?.actor;
    const actorId = String(actor?.id ?? "");
    if (!actorId || seen.has(actorId)) continue;
    seen.add(actorId);
    const bag = readBag(actor);
    if (!bag || bag.combatId !== combatId) continue;
    for (const [ammoId, stack] of Object.entries(bag.stacks ?? {})) {
      if (!stack || stack.spent <= 0) continue;
      rows.push({
        actor,
        combatant: c,
        actorName: String(actor.name ?? "someone"),
        ammoId,
        stack,
      });
    }
  }
  return rows;
}

async function clearBags(rows: Row[]): Promise<void> {
  const actors = new Set(rows.map((r) => r.actor));
  for (const actor of actors) {
    pending.delete(String(actor?.id ?? ""));
    try {
      if (actor?.getFlag?.(MODULE_ID, FLAG)) await actor.unsetFlag(MODULE_ID, FLAG);
    } catch (err) {
      log("ammo: could not clear spend flag:", err);
    }
  }
}

async function restoreStack(
  actor: any,
  ammoId: string,
  stack: Stack,
  recoveredCount: number,
): Promise<boolean> {
  try {
    const existing = actor.items?.get?.(ammoId);
    if (existing) {
      const qty = Number(existing.system?.quantity);
      const next = (Number.isFinite(qty) ? qty : 0) + recoveredCount;
      await existing.update({ "system.quantity": next });
      return true;
    }
    if (!stack.payload) {
      log(`ammo: ${stack.name} stack is gone and nothing was stashed to recreate it`);
      return false;
    }
    const copy = foundry.utils.duplicate(stack.payload) as Record<string, unknown>;
    delete copy._id;
    const system = (copy.system as Record<string, unknown> | undefined) ?? {};
    system.quantity = recoveredCount;
    copy.system = system;
    await actor.createEmbeddedDocuments("Item", [copy]);
    return true;
  } catch (err) {
    log(`ammo: could not restore ${stack.name} for ${actor?.name}:`, err);
    return false;
  }
}

export function surveyAmmo(): unknown {
  const combat = (game as any)?.combat;
  const id = combatIdOf(combat);
  const rows = combat ? collectRows(combat, id) : [];
  const lines = [
    `module: ${MODULE_ID}`,
    `setting (combat.attackRange): ${isAttackRangeEnabled() ? "on" : "off"}`,
    `combat started: ${Boolean(combat?.started)}`,
    `tracked spends: ${rows.length}`,
  ];
  for (const row of rows) {
    lines.push(
      `  ${row.actorName}: ${row.stack.spent} ${row.stack.name} → recover ${ammoRecovered(row.stack.spent)}`,
    );
  }
  console.log(lines.join("\n"));
  return {
    enabled: isAttackRangeEnabled(),
    spends: rows.map((r) => ({
      actor: r.actorName,
      ammo: r.stack.name,
      spent: r.stack.spent,
      recover: ammoRecovered(r.stack.spent),
    })),
  };
}
