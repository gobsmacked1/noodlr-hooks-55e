// One-line chat totals. Pure: no Foundry, no DOM.
//
// dnd5e draws a formula, a collapsible tooltip, and then colours the total green or red for
// hit / miss / success / failure. The table asked for the opposite: the face, the modifier,
// a parenthetical verdict, and colour only on a natural 20 (green) or a natural 1 (red).
// 2024 saves and checks do not auto-succeed or auto-fail on 20 / 1, so those labels stay
// Success / Failure even when the face is 20 or 1.
//
// FIRST NUMBER IS THE FACE, not the total. Crit and fumble show no modifier column, which
// only makes sense if the number is the die. A regular line is `15    +7    (Hit)` — the
// comparison against AC / DC still uses the total (face + modifiers).
//
// Weapon-mastery suffixes are labels. Push, Graze, and Nick's economy are implemented
// elsewhere; Cleave, Sap, Topple, Slow, and Vex are not automated here. The card still
// names the mastery that was chosen so the table can see it.

export const COL = "    ";

export type AttackKind = "fumble" | "crit" | "hit" | "miss" | "plain";
export type ContestKind = "success" | "failure" | "plain";
export type FaceColor = "nat20" | "nat1" | "none";

export interface D20Breakdown {
  face: number | null;
  modifiers: number;
  total: number;
}

export interface CardLabels {
  fumble: string;
  crit: string;
  hit: string;
  miss: string;
  success: string;
  failure: string;
}

export interface DamagePartLine {
  amount: number;
  modifiers: number;
  typeLabel: string;
}

export const ATTACK_HIT_MASTERIES = ["cleave", "push", "sap", "topple"] as const;
export const ATTACK_ANY_MASTERIES = ["nick"] as const;
export const DAMAGE_HIT_MASTERIES = ["slow", "vex"] as const;

export function faceColor(face: number | null): FaceColor {
  if (face === 20) return "nat20";
  if (face === 1) return "nat1";
  return "none";
}

export function formatSigned(n: number): string {
  if (!Number.isFinite(n) || n === 0) return "";
  return n > 0 ? `+${n}` : String(n);
}

export function joinColumns(...parts: Array<string | number | null | undefined>): string {
  return parts
    .map((part) => (part === 0 || part ? String(part) : ""))
    .filter((part) => part.length > 0)
    .join(COL);
}

/**
 * Active d20 face and the non-die remainder of the total.
 *
 * Advantage / Lucky keep one result `active` and discard the rest; those discarded
 * faces must not become the number on the card.
 */
export function readD20Breakdown(roll: any): D20Breakdown {
  const total = Number(roll?.total);
  const face = activeFace(roll, 20);
  const safeTotal = Number.isFinite(total) ? total : NaN;
  const modifiers = face !== null && Number.isFinite(safeTotal) ? safeTotal - face : 0;
  return { face, modifiers, total: safeTotal };
}

/** Sum of kept dice faces on a damage roll, so the modifier column is `total - dice`. */
export function readDamageModifiers(roll: any): number {
  const total = Number(roll?.total);
  if (!Number.isFinite(total)) return 0;
  let dice = 0;
  let any = false;
  for (const die of roll?.dice ?? []) {
    for (const result of die?.results ?? []) {
      if (result?.active === false || result?.discarded) continue;
      const n = Number(result?.result);
      if (!Number.isFinite(n)) continue;
      dice += n;
      any = true;
    }
  }
  return any ? total - dice : 0;
}

function activeFace(roll: any, faces: number): number | null {
  for (const die of roll?.dice ?? []) {
    if (Number(die?.faces) !== faces) continue;
    for (const result of die?.results ?? []) {
      if (result?.active === false || result?.discarded) continue;
      const n = Number(result?.result);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

export function attackKind(face: number | null, hit: boolean | null): AttackKind {
  if (face === 1) return "fumble";
  if (face === 20) return "crit";
  if (hit === true) return "hit";
  if (hit === false) return "miss";
  return "plain";
}

export function contestKind(success: boolean | null): ContestKind {
  if (success === true) return "success";
  if (success === false) return "failure";
  return "plain";
}

export function formatAttackLine(input: {
  face: number | null;
  modifiers: number;
  kind: AttackKind;
  labels: Pick<CardLabels, "fumble" | "crit" | "hit" | "miss">;
  suffixes?: string[];
}): string {
  const face = input.face === null ? "?" : input.face;
  const verdict =
    input.kind === "fumble"
      ? `(${input.labels.fumble})`
      : input.kind === "crit"
        ? `(${input.labels.crit})`
        : input.kind === "hit"
          ? `(${input.labels.hit})`
          : input.kind === "miss"
            ? `(${input.labels.miss})`
            : "";
  const mods = input.kind === "fumble" || input.kind === "crit" ? "" : formatSigned(input.modifiers);
  return joinColumns(face, mods, verdict, ...(input.suffixes ?? []));
}

export function formatContestLine(input: {
  face: number | null;
  modifiers: number;
  kind: ContestKind;
  labels: Pick<CardLabels, "success" | "failure">;
}): string {
  const face = input.face === null ? "?" : input.face;
  const verdict =
    input.kind === "success"
      ? `(${input.labels.success})`
      : input.kind === "failure"
        ? `(${input.labels.failure})`
        : "";
  return joinColumns(face, formatSigned(input.modifiers), verdict);
}

/**
 * One displayed part per roll. Traits apply per type; mixed targets are the caller's
 * problem (pass null and show the raw roll). First part keeps its modifier column only
 * when the type is untraited — a doubled or halved first number is already the total.
 */
export function damagePartsFromRolls(
  rolls: Array<{ total: number; modifiers: number; type: string }>,
  traits: { immune?: Iterable<string>; resist?: Iterable<string>; vuln?: Iterable<string> } | null,
  labelOf: (type: string) => string,
): DamagePartLine[] {
  return rolls.map((roll, i) => {
    const mult = traits ? traitMultiplier(traits, roll.type) : 1;
    const dice = roll.total - (i === 0 ? roll.modifiers : 0);
    const amount = applyTrait(i === 0 && mult === 1 ? dice : Math.abs(roll.total), mult);
    return {
      amount,
      modifiers: i === 0 && mult === 1 ? roll.modifiers : 0,
      typeLabel: labelOf(roll.type),
    };
  });
}

export function formatDamageLine(parts: DamagePartLine[], suffixes: string[] = []): string {
  const body = parts
    .map((part, i) => {
      const type = part.typeLabel ? `(${part.typeLabel})` : "";
      if (i === 0) return joinColumns(part.amount, formatSigned(part.modifiers), type);
      return joinColumns(part.amount, type);
    })
    .filter(Boolean)
    .join(", ");
  if (!suffixes.length) return body;
  return joinColumns(body, ...suffixes);
}

export function formatMastery(name: string): string {
  const trimmed = String(name ?? "").trim();
  if (!trimmed) return "";
  return `(${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)})`;
}

export function attackMasterySuffixes(
  mastery: string,
  kind: AttackKind,
  grazeAmount: number | null,
  grazeLabel: string,
): string[] {
  const key = String(mastery ?? "").toLowerCase();
  const out: string[] = [];
  if (
    (kind === "miss" || kind === "fumble") &&
    key === "graze" &&
    grazeAmount !== null &&
    grazeAmount > 0
  ) {
    out.push(joinColumns(grazeAmount, `(${grazeLabel})`));
  }
  if ((kind === "hit" || kind === "crit") && (ATTACK_HIT_MASTERIES as readonly string[]).includes(key)) {
    out.push(formatMastery(key));
  }
  if ((ATTACK_ANY_MASTERIES as readonly string[]).includes(key)) out.push(formatMastery(key));
  return out;
}

export function damageMasterySuffixes(mastery: string, hit: boolean, dealt: number): string[] {
  const key = String(mastery ?? "").toLowerCase();
  if (!hit || !(dealt > 0)) return [];
  if ((DAMAGE_HIT_MASTERIES as readonly string[]).includes(key)) return [formatMastery(key)];
  return [];
}

/** Immunity 0, resistance floor(½), vulnerability ×2. Unknown type is 1. */
export function traitMultiplier(
  traits: { immune?: Iterable<string>; resist?: Iterable<string>; vuln?: Iterable<string> },
  type: string,
): number {
  const t = String(type ?? "").toLowerCase();
  if (!t) return 1;
  if (hasType(traits.immune, t)) return 0;
  if (hasType(traits.vuln, t)) return 2;
  if (hasType(traits.resist, t)) return 0.5;
  return 1;
}

export function applyTrait(value: number, multiplier: number): number {
  if (!Number.isFinite(value)) return 0;
  if (multiplier === 0) return 0;
  if (multiplier === 0.5) return Math.floor(value * 0.5);
  if (multiplier === 2) return value * 2;
  return value;
}

function hasType(list: Iterable<string> | undefined, type: string): boolean {
  if (!list) return false;
  for (const entry of list) {
    if (String(entry).toLowerCase() === type) return true;
  }
  return false;
}
