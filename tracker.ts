// Ground-truth ⚔️ combat state block, rebuilt from Foundry's combat tracker each turn.
// This is Noodlr's key advantage: instead of trusting the model to copy its own last
// block, the module injects the real state as authoritative context. System-agnostic and
// best-effort — HP/condition locations vary by game system, so extraction degrades
// gracefully (enemies fall back to tiers; unknown HP is labeled).

interface Hp {
  value: number;
  max: number;
  temp: number;
}

/** Best-effort HP extraction across common system data shapes. */
function readHp(actor: any): Hp | null {
  const sys = actor?.system;
  const candidates = [sys?.attributes?.hp, sys?.hp, sys?.health, sys?.attributes?.health];
  for (const hp of candidates) {
    if (
      hp &&
      typeof hp === "object" &&
      (typeof hp.value === "number" || typeof hp.max === "number")
    ) {
      return {
        value: Number(hp.value ?? 0),
        max: Number(hp.max ?? hp.value ?? 0),
        temp: Number(hp.temp ?? 0),
      };
    }
  }
  return null;
}

/** Descriptive HP tier for enemies (fewer exact numbers to corrupt; good DMing). */
function hpTier(hp: Hp | null): string {
  if (!hp || hp.max <= 0) return "unknown condition";
  const ratio = hp.value / hp.max;
  if (hp.value <= 0) return "down";
  if (ratio > 0.99) return "fresh";
  if (ratio > 0.5) return "wounded";
  if (ratio > 0.25) return "bloodied";
  return "near death";
}

function readConditions(actor: any): string[] {
  const out = new Set<string>();
  const statuses = actor?.statuses;
  if (statuses && typeof statuses.forEach === "function") {
    statuses.forEach((s: string) => out.add(String(s)));
  }
  const effects = actor?.effects;
  if (effects && typeof effects.forEach === "function") {
    effects.forEach((e: any) => {
      if (!e?.disabled && e?.name) out.add(String(e.name));
    });
  }
  return [...out];
}

export function isCombatActive(): boolean {
  return Boolean(game.combat?.started);
}

/** Build the ⚔️ ground-truth block, or null when there is no active combat. */
export function buildCombatStateBlock(): string | null {
  const combat = game.combat;
  if (!combat || !combat.started) return null;

  const turns: any[] = combat.turns ?? [];
  if (turns.length === 0) return null;

  const round = combat.round ?? 0;
  const currentName = combat.combatant?.name ?? "?";
  const turnIdx = typeof combat.turn === "number" ? combat.turn : 0;
  const nextName = turns[(turnIdx + 1) % turns.length]?.name ?? "?";

  const initLine = turns.map((c) => `${c.name}(${c.initiative ?? "—"})`).join(", ");

  const lines: string[] = [
    `⚔️ ROUND ${round} — Turn: ${currentName} → next: ${nextName}`,
    `Init: ${initLine}`,
  ];

  for (const c of turns) {
    const actor = c.actor;
    const isPC = Boolean(c.hasPlayerOwner ?? actor?.hasPlayerOwner);
    const hp = readHp(actor);
    const cond = readConditions(actor);
    const condStr = cond.length > 0 ? cond.join(", ") : "none";
    const defeated = c.isDefeated ? " [defeated]" : "";

    if (isPC && hp) {
      const temp = hp.temp > 0 ? ` (+${hp.temp})` : "";
      lines.push(`${c.name}: HP ${hp.value}/${hp.max}${temp} | Cond: ${condStr}${defeated}`);
    } else {
      lines.push(`${c.name}: ${hpTier(hp)} | Cond: ${condStr}${defeated}`);
    }
  }

  lines.push("Field: (positions are narrative zones; see the fiction)");

  return `# Authoritative combat state (rebuilt from Foundry — trust this over any earlier block)\n${lines.join("\n")}`;
}
