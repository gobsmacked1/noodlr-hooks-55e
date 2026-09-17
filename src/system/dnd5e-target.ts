// Who a single-creature activity is aimed at — not the leftover click.
//
// Witch Bolt's first cast is Attack, range 60, creature 1. Its later Ongoing
// Damage activity overrides the target block and names nobody. Healing Word
// aims at a creature that may be an ally the player also owns. "Self" as a
// range unit is Flurry / Patient Defense, not "the only legal token is you".

const EXTERNAL = new Set(["creature", "enemy", "ally", "willing", "opponent", "hostile"]);

export function affectsTypeOf(activity: any): string {
  const own = activity?.target?.affects;
  if (activity?.target?.override === true) return String(own?.type ?? "").trim().toLowerCase();
  const item = activity?.item?.system?.target?.affects ?? activity?.item?.target?.affects;
  return String(own?.type || item?.type || "")
    .trim()
    .toLowerCase();
}

export function templateTypeOf(activity: any): string {
  const own = activity?.target?.template;
  if (activity?.target?.override === true) return String(own?.type ?? "").trim().toLowerCase();
  const item = activity?.item?.system?.target?.template ?? activity?.item?.target?.template;
  return String(own?.type || item?.type || "")
    .trim()
    .toLowerCase();
}

/**
 * A pointed creature / ally / enemy, not an area and not "you".
 *
 * Empty affect type (Witch Bolt's ongoing damage) is not this — that activity
 * does not ask for a new token. A template type means the area decides.
 */
export function needsExternalCreatureTarget(activity: any): boolean {
  if (templateTypeOf(activity)) return false;
  return EXTERNAL.has(affectsTypeOf(activity));
}

export function tokenIdOf(token: any): string {
  return String(token?.id ?? token?.document?.id ?? "");
}

export function actorTokenIds(actor: any, tokens: any[]): string[] {
  const actorId = String(actor?.id ?? actor?.document?.id ?? "");
  const out: string[] = [];
  const seen = new Set<string>();
  for (const token of tokens) {
    const id = tokenIdOf(token);
    if (!id || seen.has(id)) continue;
    const other = String(token?.actor?.id ?? token?.document?.actorId ?? "");
    if (actorId && other && other === actorId) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/** Every current target is one of the caster's tokens. Empty is not self-only. */
export function isSelfOnlyTargetSet(targetIds: string[], casterIds: string[]): boolean {
  if (targetIds.length === 0 || casterIds.length === 0) return false;
  const mine = new Set(casterIds.filter(Boolean));
  return targetIds.every((id) => Boolean(id) && mine.has(id));
}
