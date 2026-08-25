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
// Pointer utilities (Glare → Eye Rays, Chomp → Bite ×2) are not the effect. `activity.use()` on
// the utility spends `legact` and posts flavour; the payload is a different item. A utility that
// points at nothing is not offered and is never spent. Range comes off the pointed activity, not
// Self.
//
// Two refill clocks, never swapped: `legact` is encounter + that creature's own turnEnd (dnd5e
// writes it; we never do). `legres` is long rest only — we increment `spent` via `resistSave`
// and never zero it on a turn or combat end.
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
import { legendaryResistances } from "../system/dnd5e-legendary";
import {
  matchPointerItem,
  numberedIndex,
  parseItemPointers,
  pickNumbered,
  pointerRangeOf,
} from "../system/dnd5e-pointer";
import { speakerFor } from "../util/speaker";
import { isPrimaryGM } from "../util/gm";
import { prewarmCastSpells, readActions, type ActionKind, type CreatureAction } from "./actions";
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

function inRange(range: number, self: LegendarySelf, foe: LegendaryFoe): boolean {
  const rise = foe.elevation - self.elevation;
  const separation = Math.hypot(foe.distance, rise);
  return separation <= range;
}

function itemIdOf(action: Pick<CreatureAction, "item">): string {
  return String(action.item?.id ?? "");
}

function proseOf(action: CreatureAction): string {
  return `${String(action.item?.system?.description?.value ?? "")} ${String(action.activity?.description?.value ?? "")}`;
}

function activityLabel(action: CreatureAction): string {
  return String(action.activity?.name ?? action.name ?? "");
}

function kitItems(kit: CreatureAction[], extra?: CreatureAction): { id?: unknown; name?: unknown; system?: { identifier?: unknown } }[] {
  const items: { id?: unknown; name?: unknown; system?: { identifier?: unknown } }[] = [];
  const seen = new Set<string>();
  for (const row of extra ? [extra, ...kit] : kit) {
    const id = itemIdOf(row);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    items.push(row.item);
  }
  return items;
}

export interface PointerPreview {
  unresolved: boolean;
  range: number;
  kind: ActionKind;
  token: string;
  times: number;
  numbered: boolean;
  die: number;
}

/**
 * A legendary utility that only names another item, or null if this option is the real thing.
 *
 * `unresolved` means the prose pointed and nothing on the sheet answered — do not spend a charge
 * on a stare. Range comes off the pointed activity's own `range.value` (Eye Rays are 120 even
 * when `override` is false), never off the utility (Self).
 */
export function previewPointer(action: CreatureAction, kit: CreatureAction[]): PointerPreview | null {
  const specs = parseItemPointers(proseOf(action));
  if (!specs.length) return null;
  const except = itemIdOf(action);
  const items = kitItems(kit, action);
  for (const spec of specs) {
    const item = matchPointerItem(spec.token, items, except);
    if (!item) continue;
    const kids = kit.filter((row) => itemIdOf(row) === String(item.id) && row.kind !== "utility");
    if (!kids.length) continue;
    const numbered = kids
      .map((row) => numberedIndex(activityLabel(row)))
      .filter((n): n is number => n !== null);
    const range = Math.max(...kids.map((row) => pointerRangeOf(row.activity, row.item)));
    const kind: ActionKind = kids.some((row) => row.kind === "control")
      ? "control"
      : kids.some((row) => row.kind === "attack")
        ? "attack"
        : kids[0]!.kind;
    return {
      unresolved: false,
      range,
      kind,
      token: spec.token,
      times: spec.times,
      numbered: numbered.length > 0,
      die: numbered.length ? Math.max(...numbered) : 0,
    };
  }
  return {
    unresolved: true,
    range: action.range,
    kind: action.kind,
    token: specs[0]?.token ?? "",
    times: 1,
    numbered: false,
    die: 0,
  };
}

export interface RealizedPointer {
  payloads: CreatureAction[];
  label: string;
}

/**
 * Turn a pointer into the activities that actually resolve. `rolls` is one value per use
 * (a real 1d10 for Eye Rays). Empty payloads means refuse — do not use the utility alone.
 */
export function realizePointer(
  action: CreatureAction,
  kit: CreatureAction[],
  rolls: number[],
  used: Set<number>,
): RealizedPointer | null {
  const preview = previewPointer(action, kit);
  if (!preview) return null;
  if (preview.unresolved) return { payloads: [], label: action.name };

  const except = itemIdOf(action);
  const items = kitItems(kit, action);
  const specs = parseItemPointers(proseOf(action));
  const spec = specs.find((s) => matchPointerItem(s.token, items, except));
  const item = spec ? matchPointerItem(spec.token, items, except) : null;
  if (!item) return { payloads: [], label: action.name };

  const kids = kit.filter((row) => itemIdOf(row) === String(item.id) && row.kind !== "utility");
  const numbered = kids
    .map((row) => {
      const n = numberedIndex(activityLabel(row));
      return n === null ? null : { n, value: row };
    })
    .filter((row): row is { n: number; value: CreatureAction } => row !== null);

  const times = spec?.times ?? 1;
  let payloads: CreatureAction[] = [];
  if (numbered.length) {
    const needed = rolls.length ? rolls : Array.from({ length: times }, () => 1);
    payloads = pickNumbered(numbered, needed, used);
  } else if (kids[0]) {
    payloads = Array.from({ length: times }, () => kids[0]!);
  }

  const names = payloads.map((row) => {
    const raw = activityLabel(row);
    return raw.replace(/^\d+\s*:\s*/, "") || row.name;
  });
  const source = String(action.item?.name ?? action.name);
  const label = names.length ? `${source} → ${names.join(", ")}` : action.name;
  return { payloads, label };
}

const usedRays = new Map<string, Set<number>>();

function usedRaysFor(combat: any, combatant: any): Set<number> {
  const key = `${String(combat?.id ?? "")}:${Number(combat?.round ?? 0)}:${Number(combat?.turn ?? 0)}:${String(combatant?.id ?? "")}`;
  let set = usedRays.get(key);
  if (!set) {
    if (usedRays.size > 32) {
      const first = usedRays.keys().next().value;
      if (first) usedRays.delete(first);
    }
    set = new Set();
    usedRays.set(key, set);
  }
  return set;
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

    let range = action.range;
    let kind = action.kind;
    if (kind === "utility") {
      const preview = previewPointer(action, actions);
      if (!preview || preview.unresolved) continue;
      range = preview.range;
      kind = preview.kind;
    }

    if (kind === "heal") {
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
      if (!inRange(range, self, enemy)) continue;
      let score = 1;
      score += 0.6 * (1 - Math.min(1, enemy.distance / 60));
      if (enemy.hpFraction !== null && enemy.hpFraction < 1) {
        score += 0.4 * (1 - enemy.hpFraction);
      }
      const reasons = [`${Math.round(enemy.distance)} away`];
      if (kind === "control") reasons.push("control");
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

  const preview = previewPointer(chosen.action, kit);
  if (preview?.unresolved) {
    log(`legendary action: ${name} ${chosen.action.name} points at nothing resolvable — not spending`);
    return;
  }

  let realized: RealizedPointer | null = null;
  if (preview) {
    const used = usedRaysFor(game.combat, combatant);
    let rolls: number[] = [];
    if (preview.numbered) {
      const rolled = await rollRayDice(preview.die, preview.times, actor, name);
      if (!rolled) return;
      rolls = rolled;
    }
    realized = realizePointer(chosen.action, kit, rolls, used);
    if (!realized?.payloads.length) {
      log(`legendary action: ${name} ${chosen.action.name} resolved to no payload — not spending`);
      return;
    }
  }

  const target = resolveTarget(chosen, combatant, board.self);
  const whom =
    chosen.target === "self"
      ? name
      : chosen.target?.name ?? "?";
  const shown = realized?.label ?? chosen.action.name;
  const line = `${name} uses a legendary action: ${shown} on ${whom}.`;
  log(
    `legendary action: ${name} uses ${shown} on ${whom} (cost ${chosen.cost}, ${remaining} left) — ${chosen.reason}`,
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
    if (realized) {
      for (const payload of realized.payloads) {
        await useActionAt(payload, target, { asReaction: false, skipEconomy: true });
      }
    }
  } catch (err) {
    log(`legendary action: ${name} could not use ${shown}:`, err);
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

async function rollRayDice(sides: number, count: number, actor: any, name: string): Promise<number[] | null> {
  const Roll: any = (globalThis as any).Roll;
  if (typeof Roll !== "function") {
    log(`legendary action: ${name} has no Roll — cannot pick a numbered activity`);
    return null;
  }
  const out: number[] = [];
  for (let i = 0; i < Math.max(1, count); i++) {
    try {
      const roll = new Roll(`1d${sides}`, actor?.getRollData?.() ?? {});
      await roll.evaluate();
      const total = Number(roll.total);
      if (!Number.isFinite(total) || total < 1) {
        log(`legendary action: ${name} 1d${sides} was unreadable`);
        return null;
      }
      try {
        await roll.toMessage({
          flavor: `${name}: legendary ${sides === 10 ? "Eye Rays" : "option"}`,
          speaker: speakerFor(actor, name),
        });
      } catch {
        /* the number is what matters */
      }
      out.push(Math.floor(total));
    } catch (err) {
      log(`legendary action: ${name} could not roll 1d${sides}:`, err);
      return null;
    }
  }
  return out;
}

function optionLabel(action: CreatureAction, kit: CreatureAction[]): string {
  const cost = `cost ${legendaryCost(action.activity)}`;
  const preview = previewPointer(action, kit);
  if (!preview || preview.unresolved) return `${action.name} (${cost})`;
  if (preview.numbered) return `${action.name} → ${preview.token} (1d${preview.die}, ${cost})`;
  if (preview.times > 1) return `${action.name} → ${preview.token} ×${preview.times} (${cost})`;
  return `${action.name} → ${preview.token} (${cost})`;
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
    const kit = actor ? readActions(actor) : [];
    const legendary = kit.filter(isLegendaryAction);
    const names = legendary.map((a) => optionLabel(a, kit));
    const resist = legendaryResistances(actor);
    const row = {
      name: String(combatant?.name ?? "?"),
      remaining,
      max,
      resistances: resist,
      automated: shouldAutomate(combatant),
      unable: skipReason(combatant),
      options: names,
    };
    rows.push(row);
    const resistLine = resist ? `  resist ${resist.value}/${resist.max} (long rest only)` : "";
    lines.push(
      `  ${row.name}  actions ${remaining ?? "?"}/${max ?? "?"} (refills own turn end)` +
        `${resistLine}` +
        `  ${row.automated ? "we play" : "hand"}` +
        `${row.unable ? `  ${row.unable}` : ""}` +
        `${names.length ? `  — ${names.join(" | ")}` : "  — no legendary activities"}`,
    );
  }
  const ended = lastSlot?.combatId === String(combat.id ?? "") ? lastSlot.combatantId : null;
  const endedName = ended ? String(combatantById(combat, ended)?.name ?? ended) : "nobody yet";
  lines.push(`last slot was ${endedName}; next advance spends for everyone else we play`);
  lines.push(
    "REFILL: RAW and dnd5e's printed sentence = start of its turn; dnd5e code = end of its turn (turnEnd). We do not write the pool. A RAW override is not offered.",
  );
  console.log(`[${MODULE_ID}] ${lines.join("\n")}`);
  return { ended: endedName, rows };
}
