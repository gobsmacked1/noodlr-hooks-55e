// The combat dossier: what a hostile combatant actually is, read from its own sheet.
//
// The AI-run NPC turn used to receive the combat tracker and nothing else — initiative, HP tiers,
// conditions — so the model was improvising a statblock from the creature's name. It would invent
// abilities the creature does not have and overlook the ones it does, and no amount of prompt
// tuning fixes not knowing. This module supplies the missing half: movement, senses, defenses, and
// the concrete list of actions, spells, and consumables the actor is carrying.
//
// Lifetime (user's framing, 2026-08-02): a dossier exists for the duration of the skirmish and is
// discarded when the creature dies or combat ends. Two halves with different rules:
//   - Capabilities and counts are re-read EVERY turn. A cached ammo count is a wrong ammo count the
//     moment an arrow is spent, and "the archer ran out of arrows" is precisely the behavior we want.
//   - Notes (what it did on earlier turns) accumulate in memory for the combat only, so a creature
//     can act like it remembers closing to melee last round.
//
// Nothing here interprets rules. It reports what the sheet says, using the system-path table, and
// lets the model plus the rules silo do the reasoning.

import { log } from "../constants";
import { pick, pickNumber, pickString, systemPaths, type SystemPaths } from "../system/profiles";

/** Cap the action list so a spell-heavy caster can't eat the whole context budget. */
const MAX_ACTIONS = 40;
/** Notes kept per combatant; older ones fall off. */
const MAX_NOTES = 8;

export interface DossierAction {
  name: string;
  /** The system's own activation wording ("Action", "Bonus Action", "1 minute", ...). */
  activation: string;
  /** Remaining/maximum uses, ammunition count, or item quantity — whatever applies. */
  supply: string;
  range: string;
  damage: string;
  /** Spell level, when the item is a spell. */
  level: string;
}

export interface Dossier {
  name: string;
  intelligence: number | null;
  wisdom: number | null;
  hp: string;
  armor: string;
  speed: string;
  senses: string;
  challenge: string;
  actions: DossierAction[];
  notes: string[];
}

// Per-combat, per-combatant notes. Cleared on combat end and on death; see registerDossierCleanup.
const notes = new Map<string, string[]>();

/** Record something a combatant did, so later turns in the same fight can refer back to it. */
export function noteDossierEvent(combatantId: string, line: string): void {
  const trimmed = line.trim();
  if (!combatantId || !trimmed) return;
  const list = notes.get(combatantId) ?? [];
  list.push(trimmed);
  while (list.length > MAX_NOTES) list.shift();
  notes.set(combatantId, list);
}

export function clearDossier(combatantId: string): void {
  notes.delete(combatantId);
}

export function clearAllDossiers(): void {
  notes.clear();
}

/**
 * Drop a creature's accumulated notes when it dies or the fight ends — the user's rule, and also the
 * honest one: a dossier is a live read of a living combatant, not campaign memory. Anything worth
 * keeping past the skirmish belongs in a silo, deliberately.
 */
export function registerDossierCleanup(): void {
  Hooks.on("deleteCombat", () => clearAllDossiers());
  Hooks.on("updateCombatant", (combatant: any, changes: any) => {
    if (changes?.defeated === true) clearDossier(String(combatant?.id ?? ""));
  });
}

/** Ammunition and charges: whichever of uses / linked consumable / quantity the item actually has. */
function readSupply(actor: any, item: any, P: SystemPaths): string {
  const usesMax = pickNumber(item, P.itemUsesMax);
  // dnd5e 4.x flipped this field from "remaining" to "spent". Reporting a spent count as remaining
  // would tell the model a nearly-exhausted ability is nearly full — read both and prefer the one
  // that is actually a remainder.
  const spent = pickNumber(item, P.itemUsesSpent);
  const remaining =
    pickNumber(item, P.itemUses) ??
    (usesMax !== null && spent !== null ? Math.max(0, usesMax - spent) : null);
  if (remaining !== null && usesMax !== null && usesMax > 0) {
    return `${remaining}/${usesMax} uses`;
  }

  // A weapon that consumes ammunition points at another item on the same actor; report ITS count,
  // because "3 arrows left" is the fact that changes the creature's plan.
  const consumeType = pickString(item, P.itemConsumeType);
  const targetId = pickString(item, P.itemConsumeTarget);
  if (targetId) {
    const ammo = actor?.items?.get?.(targetId);
    if (ammo) {
      const qty = pickNumber(ammo, P.itemQuantity);
      const label = consumeType === "ammo" || !consumeType ? "" : `${consumeType} `;
      return qty === null ? `${label}${ammo.name}` : `${label}${ammo.name} x${qty}`;
    }
  }

  const qty = pickNumber(item, P.itemQuantity);
  // Quantity is only interesting for things you can run out of; a quantity of 1 on a sword is noise.
  if (qty !== null && qty !== 1) return `x${qty}`;
  return "";
}

function readRange(item: any, P: SystemPaths): string {
  const label = pickString(item, P.itemRangeLabel);
  if (label) return label;
  const value = pickNumber(item, P.itemRange);
  if (value === null) return "";
  const units = pickString(item, P.itemRangeUnits);
  return units ? `${value} ${units}` : String(value);
}

function readActivation(item: any, P: SystemPaths): string {
  const label = pickString(item, P.itemActivationLabel);
  if (label) return label;
  return pickString(item, P.itemActivation);
}

/**
 * Every item the creature could plausibly act with. We include anything carrying an activation, plus
 * anything with a quantity (potions, ammunition, thrown weapons) — a healing potion has no activation
 * in some systems but is exactly the option a bloodied creature should consider.
 */
function readActions(actor: any, P: SystemPaths): DossierAction[] {
  const items: any[] = Array.from(actor?.items ?? []);
  const out: DossierAction[] = [];

  for (const item of items) {
    if (out.length >= MAX_ACTIONS) break;
    const activation = readActivation(item, P);
    const supply = readSupply(actor, item, P);
    const damage = pickString(item, P.itemDamageLabel);
    if (!activation && !supply && !damage) continue;

    const levelRaw = pick(item, P.itemSpellLevel);
    const level =
      item?.type === "spell" && levelRaw !== undefined ? `level ${String(levelRaw)}` : "";

    out.push({
      name: String(item?.name ?? "").slice(0, 60),
      activation,
      supply,
      range: readRange(item, P),
      damage,
      level,
    });
  }
  return out;
}

/** Alternate movement modes (fly/swim/burrow/climb) as "fly 60", skipping zeroes. */
function readAltSpeeds(actor: any, P: SystemPaths): string {
  const raw = pick(actor, P.altSpeeds);
  if (!raw || typeof raw !== "object") return "";
  const parts: string[] = [];
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key === "walk" || key === "units" || key === "hover") continue;
    const n = Number(typeof value === "object" ? (value as any)?.value : value);
    if (Number.isFinite(n) && n > 0) parts.push(`${key} ${n}`);
  }
  return parts.join(", ");
}

function readSenses(actor: any, P: SystemPaths): string {
  const raw = pick(actor, P.senses);
  if (typeof raw === "string") return raw;
  if (!raw || typeof raw !== "object") return "";
  const parts: string[] = [];
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key === "units" || key === "special") continue;
    const n = Number(typeof value === "object" ? (value as any)?.value : value);
    if (Number.isFinite(n) && n > 0) parts.push(`${key} ${n}`);
  }
  return parts.join(", ");
}

/** Build a live dossier for one combatant. Cheap and synchronous; call it every turn. */
export function buildDossier(combatant: any): Dossier | null {
  const actor = combatant?.actor;
  if (!actor) return null;
  const P = systemPaths();

  try {
    const hpValue = pickNumber(actor, P.hpValue);
    const hpMax = pickNumber(actor, P.hpMax);
    const speed = pickNumber(actor, P.speed);
    const speedUnits = pickString(actor, P.speedUnits) || "ft";
    const alt = readAltSpeeds(actor, P);

    return {
      name: String(combatant?.name ?? actor?.name ?? "?"),
      intelligence: pickNumber(actor, P.intelligence),
      wisdom: pickNumber(actor, P.wisdom),
      hp: hpValue !== null && hpMax !== null ? `${hpValue}/${hpMax}` : "",
      armor: pickString(actor, P.armor),
      speed: speed !== null ? `${speed} ${speedUnits}${alt ? `, ${alt}` : ""}` : alt,
      senses: readSenses(actor, P),
      challenge: pickString(actor, P.challenge),
      actions: readActions(actor, P),
      notes: notes.get(String(combatant?.id ?? "")) ?? [],
    };
  } catch (err) {
    // A sheet we can't read is not a reason to refuse the turn — it just falls back to today's
    // behavior, where the model works from the creature's name alone.
    log("dossier build failed:", err);
    return null;
  }
}

function actionLine(a: DossierAction): string {
  const bits = [a.activation, a.level, a.range, a.damage, a.supply].filter(Boolean);
  return `- ${a.name}${bits.length ? ` — ${bits.join(", ")}` : ""}`;
}

/**
 * Format the dossier for injection. The closing constraint matters as much as the data: without it a
 * model happily invents a breath weapon for a creature whose sheet lists a club.
 */
export function buildDossierBlock(combatant: any): string | null {
  const d = buildDossier(combatant);
  if (!d) return null;

  const vitals = [
    d.intelligence !== null ? `INT ${d.intelligence}` : "",
    d.wisdom !== null ? `WIS ${d.wisdom}` : "",
    d.hp ? `HP ${d.hp}` : "",
    d.armor ? `AC ${d.armor}` : "",
    d.speed ? `Speed ${d.speed}` : "",
    d.senses ? `Senses ${d.senses}` : "",
    d.challenge ? `CR/level ${d.challenge}` : "",
  ]
    .filter(Boolean)
    .join(" | ");

  const lines = [`# Combat dossier — ${d.name} (read from its own sheet)`];
  if (vitals) lines.push(vitals);

  if (d.actions.length > 0) {
    lines.push("What it is carrying and can do:");
    lines.push(...d.actions.map(actionLine));
    lines.push(
      "This list is complete. If an ability is not on it, this creature does not have it — do not " +
        "invent one, and do not spend a resource the counts above say is gone.",
    );
  } else {
    lines.push(
      "Its sheet lists no usable items, so it acts with its body and whatever the fiction has " +
        "already established — nothing more.",
    );
  }

  if (d.notes.length > 0) {
    lines.push("Earlier this fight:");
    lines.push(...d.notes.map((n) => `- ${n}`));
  }

  return lines.join("\n");
}
