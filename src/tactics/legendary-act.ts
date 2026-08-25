// Legendary actions — one option at the end of another creature's turn.
//
// dnd5e already spends `resources.legact` when the activity is used, and already refills it at the
// end of the legendary creature's own turn. What nobody did was press the button at the right
// moment. MM wording: only one option at a time, and only at the end of another creature's turn.
// Dumping all three Eye Rays the first time a PC ends their turn is the failure this exists to
// prevent.
//
// Who: `shouldAutomate`, same as a planned turn — playing the Beholder includes its Eye Rays. No
// extra setting. Primary GM only (the tracker hook is already gated).
//
// Stun / Incapacitated uses `isUnableToAct`, the same walk that skips the turn and (since v0.7.38)
// the Opportunity Attack. A stunned Beholder must not ray the Monk who just walked away.
//
// Lair actions are not this. Mythic shares the legendary pool and is included.

import { log, MODULE_ID } from "../constants";
import { readBoard, type BoardActor } from "../core/board";
import { turnRandom } from "../core/random";
import { pickNumber, systemPaths } from "../system/profiles";
import {
  isLegendaryActivation,
  legendaryCost,
  legendaryMax,
  legendaryRemaining,
} from "../system/dnd5e-legact";
import { speakerFor } from "../util/speaker";
import { isPrimaryGM } from "../util/gm";
import { prewarmCastSpells, readActions, type CreatureAction } from "./actions";
import { applyAwareness } from "./awareness";
import { useActionAt } from "./execute";
import { shouldAutomate } from "./registry";
import { isUnableToAct, skipReason } from "./skip";
import { mentalScore, tierForScore, tierProfile } from "./tiers";

export interface LegendaryFoe {
  name: string;
  tokenId: string;
  distance: number;
  elevation: number;
  hpFraction: number | null;
}

export interface LegendarySelf {
  elevation: number;
  hpFraction: number | null;
}

export interface LegendaryChoice {
  action: CreatureAction;
  cost: number;
  target: LegendaryFoe | "self" | null;
  score: number;
  reason: string;
}

let lastSlot: { combatId: string; combatantId: string } | null = null;
let lastBurst = "";

export function resetLegendaryAdvance(): void {
  lastSlot = null;
  lastBurst = "";
}

/**
 * Remember who is current and return who just ended, or null if this is the fight's first slot.
 *
 * The first `updateCombat` of a combat is not "the end of another creature's turn".
 */
export function noteLegendaryAdvance(combat: any): string | null {
  const combatId = String(combat?.id ?? "");
  const currentId = String(combat?.combatant?.id ?? "");
  const ended =
    lastSlot && lastSlot.combatId === combatId && lastSlot.combatantId && lastSlot.combatantId !== currentId
      ? lastSlot.combatantId
      : null;
  lastSlot = { combatId, combatantId: currentId };
  return ended;
}

export function isLegendaryAction(action: { activity?: { activation?: { type?: unknown } } }): boolean {
  return isLegendaryActivation(action.activity?.activation?.type);
}

function inRange(action: Pick<CreatureAction, "range">, self: LegendarySelf, foe: LegendaryFoe): boolean {
  const rise = foe.elevation - self.elevation;
  const separation = Math.hypot(foe.distance, rise);
  return separation <= action.range;
}

/**
 * Legal legendary options against the enemies this creature can currently perceive.
 *
 * Melee that cannot reach is dropped — a legendary action does not walk. Heal only when bloodied.
 * Lair activations never appear: `isLegendaryAction` refuses them.
 */
export function legendaryOptions(
  actions: CreatureAction[],
  remaining: number,
  self: LegendarySelf,
  enemies: LegendaryFoe[],
): LegendaryChoice[] {
  const out: LegendaryChoice[] = [];
  for (const action of actions) {
    if (!action.available) continue;
    if (!isLegendaryAction(action)) continue;
    const cost = legendaryCost(action.activity);
    if (cost > remaining) continue;

    if (action.kind === "heal") {
      if (self.hpFraction === null || self.hpFraction >= 0.5) continue;
      out.push({
        action,
        cost,
        target: "self",
        score: 1.2 + 2.2 * (1 - self.hpFraction),
        reason: "hurt badly enough to spend a legendary action on it",
      });
      continue;
    }

    for (const enemy of enemies) {
      if (!inRange(action, self, enemy)) continue;
      let score = 1;
      score += 0.6 * (1 - Math.min(1, enemy.distance / 60));
      if (enemy.hpFraction !== null && enemy.hpFraction < 1) {
        score += 0.4 * (1 - enemy.hpFraction);
      }
      const reasons = [`${Math.round(enemy.distance)} away`];
      if (action.kind === "control") reasons.push("control");
      out.push({ action, cost, target: enemy, score, reason: reasons.join("; ") });
    }
  }
  return out;
}

function weightedChoice(options: LegendaryChoice[], noise: number, rand: () => number): LegendaryChoice {
  const temperature = Math.max(0.08, noise) * 1.5;
  const best = Math.max(...options.map((o) => o.score));
  const weights = options.map((o) => Math.exp((o.score - best) / temperature));
  const total = weights.reduce((a, b) => a + b, 0);
  let roll = rand() * total;
  for (let i = 0; i < options.length; i++) {
    roll -= weights[i];
    if (roll <= 0) return options[i];
  }
  return options[options.length - 1];
}

export function pickLegendaryAction(
  options: LegendaryChoice[],
  noise: number,
  rand: () => number,
): LegendaryChoice | null {
  if (options.length === 0) return null;
  return weightedChoice(options, noise, rand);
}

function combatantById(combat: any, id: string): any {
  const list: any[] = combat?.combatants?.contents ?? combat?.combatants ?? [];
  return list.find((c) => String(c?.id ?? "") === id) ?? null;
}

function resolveTarget(choice: LegendaryChoice, combatant: any, boardSelf: BoardActor): any {
  if (choice.target === "self") return combatant?.token ?? boardSelf.token;
  if (!choice.target) return boardSelf.token;
  const tokenId = choice.target.tokenId;
  const sceneTokens: any = (canvas as any)?.scene?.tokens;
  const contents: any[] = sceneTokens?.contents ?? sceneTokens ?? [];
  const doc = contents.find((t: any) => String(t?.id ?? "") === tokenId);
  return doc?.object ?? doc ?? null;
}

async function spendOne(combatant: any): Promise<void> {
  const actor = combatant?.actor;
  const name = String(combatant?.name ?? actor?.name ?? "?");
  if (!shouldAutomate(combatant)) return;
  if (isUnableToAct(combatant)) {
    log(`legendary action: ${name} cannot act (${skipReason(combatant)})`);
    return;
  }

  const remaining = legendaryRemaining(actor);
  if (remaining === null || remaining <= 0) return;

  await prewarmCastSpells(actor);
  const kit = readActions(actor);
  const raw = readBoard(combatant);
  if (!raw) {
    log(`legendary action: ${name} has no token on the scene`);
    return;
  }
  const board = applyAwareness(raw);
  const options = legendaryOptions(
    kit,
    remaining,
    { elevation: board.self.elevation, hpFraction: board.self.hpFraction },
    board.enemies,
  );
  if (options.length === 0) {
    log(`legendary action: ${name} has nothing in range (${remaining} left)`);
    return;
  }

  const P = systemPaths();
  const mental = mentalScore(pickNumber(actor, P.intelligence), pickNumber(actor, P.wisdom));
  // Same mid-ladder fallback as the planner: a missing number must not turn a dragon into a beetle.
  const noise = tierProfile(mental === null ? 4 : tierForScore(mental)).noise;
  const chosen = pickLegendaryAction(options, noise, turnRandom(String(combatant?.id ?? ""), "legendary"));
  if (!chosen) return;

  if (isUnableToAct(combatant)) {
    log(`legendary action: ${name} cannot act (${skipReason(combatant)})`);
    return;
  }

  const target = resolveTarget(chosen, combatant, board.self);
  const whom =
    chosen.target === "self"
      ? name
      : chosen.target?.name ?? "?";
  const line = `${name} uses a legendary action: ${chosen.action.name} on ${whom}.`;
  log(
    `legendary action: ${name} uses ${chosen.action.name} on ${whom} (cost ${chosen.cost}, ${remaining} left) — ${chosen.reason}`,
  );

  const ChatMessage = (globalThis as any).ChatMessage;
  try {
    await ChatMessage.create({
      content: `<p>${foundry.utils.escapeHTML(line)}</p>`,
      speaker: speakerFor(combatant?.token ?? actor, name),
    });
  } catch (err) {
    log("legendary action: could not announce:", err);
  }

  try {
    await useActionAt(chosen.action, target, { asReaction: false });
  } catch (err) {
    log(`legendary action: ${name} could not use ${chosen.action.name}:`, err);
    try {
      await ChatMessage.create({
        content: `<p><em>${foundry.utils.escapeHTML(name)}: Noodlr could not carry that out (${foundry.utils.escapeHTML(String(err))}). Resolve it manually.</em></p>`,
        speaker: speakerFor(combatant?.token ?? actor, name),
        whisper: ChatMessage.getWhisperRecipients("GM").map((u: any) => u.id),
      });
    } catch {
      /* announcement is optional */
    }
  }
}

/**
 * After the tracker advances: each automated legendary creature except the one who just ended
 * spends at most one option. Awaited so Eye Rays land before the next planned turn starts.
 */
export async function fireLegendaryActions(combat: any, endedCombatantId: string | null): Promise<void> {
  if (!combat?.started || !isPrimaryGM()) return;
  if (!endedCombatantId) return;

  const burst = `${String(combat.id ?? "")}:${Number(combat.round ?? 0)}:${Number(combat.turn ?? 0)}`;
  if (lastBurst === burst) return;
  lastBurst = burst;

  const list: any[] = combat?.combatants?.contents ?? combat?.combatants ?? [];
  for (const combatant of list) {
    const id = String(combatant?.id ?? "");
    if (!id || id === endedCombatantId) continue;
    if (!shouldAutomate(combatant)) continue;
    await spendOne(combatant);
  }
}

export function surveyLegendaryActions(): unknown {
  const combat: any = game.combat;
  const lines = ["legendary actions"];
  if (!combat?.started) {
    lines.push("no combat");
    console.log(`[${MODULE_ID}] ${lines.join("\n")}`);
    return { combat: false };
  }

  const rows: Record<string, unknown>[] = [];
  const list: any[] = combat?.combatants?.contents ?? combat?.combatants ?? [];
  for (const combatant of list) {
    const actor = combatant?.actor;
    const remaining = legendaryRemaining(actor);
    const max = legendaryMax(actor);
    const kit = actor ? readActions(actor).filter(isLegendaryAction) : [];
    const names = kit.map((a) => `${a.name} (cost ${legendaryCost(a.activity)})`);
    const row = {
      name: String(combatant?.name ?? "?"),
      remaining,
      max,
      automated: shouldAutomate(combatant),
      unable: skipReason(combatant),
      options: names,
    };
    rows.push(row);
    lines.push(
      `  ${row.name}  ${remaining ?? "?"}/${max ?? "?"}  ${row.automated ? "we play" : "hand"}` +
        `${row.unable ? `  ${row.unable}` : ""}` +
        `${names.length ? `  — ${names.join(" | ")}` : "  — no legendary activities"}`,
    );
  }
  const ended = lastSlot?.combatId === String(combat.id ?? "") ? lastSlot.combatantId : null;
  const endedName = ended ? String(combatantById(combat, ended)?.name ?? ended) : "nobody yet";
  lines.push(`last slot was ${endedName}; next advance spends for everyone else we play`);
  console.log(`[${MODULE_ID}] ${lines.join("\n")}`);
  return { ended: endedName, rows };
}
