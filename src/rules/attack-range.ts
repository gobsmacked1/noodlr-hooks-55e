// Refuse a use that cannot reach its target — players first, planned turns as a backstop.
//
// Lives inside `police()`, not as a second `dnd5e.preUseActivity` listener. Two listeners on
// that hook is how Hide and Dash double-charged. Called after the rider and Incapacitated
// intercepts and BEFORE `if (!slot) return true`, so an empty-activation Unarmed Strike
// enricher is still checked.
//
// Independent of combat: range is a physical fact. Fail open when there is no actor token,
// no resolvable target, or an unreadable range — a lock nobody can see is worse than a
// punch from across the room. If any resolved target is in range, allow.
//
// Public text names nobody. The GM is warned and allowed (staging / testing), except when
// this module is playing the creature. We always enforce when the switch is on — Midi QoL
// and AC5e are not a supported install, so this layer does not stand aside for them.

import { COMBAT_SETTINGS, MODULE_ID, log } from "../constants";
import { isAttackRangeEnabled } from "../settings";
import { isDnd5e } from "../system/dnd5e-rewards";
import {
  classifyActivityRange,
  distanceOf,
  isTooFar,
} from "../system/dnd5e-range";
import { matchPointerItem, parseItemPointers } from "../system/dnd5e-pointer";
import { tokenDistance } from "../core/positioning";
import { shouldAutomate } from "../tactics/registry";

function gridDistance(): number {
  const grid = (canvas as any)?.grid ?? (canvas as any)?.scene?.grid;
  const n = Number(grid?.distance);
  return n > 0 ? n : 5;
}

function elevationOf(token: any): number {
  const doc = token?.document ?? token;
  const n = Number(doc?.elevation);
  return Number.isFinite(n) ? n : 0;
}

function actorToken(actor: any): any | null {
  const controlled = [...((canvas as any)?.tokens?.controlled ?? [])];
  const mine = controlled.find(
    (t) => t?.actor === actor || String(t?.actor?.id ?? "") === String(actor?.id ?? ""),
  );
  if (mine) return mine;
  try {
    const placed = actor?.getActiveTokens?.(true);
    if (placed?.[0]) return placed[0];
  } catch {
    /* getActiveTokens needs a canvas */
  }
  return actor?.token ?? null;
}

function addToken(out: any[], seen: Set<string>, token: any): void {
  if (!token) return;
  const id = String(token.id ?? token.document?.id ?? token.uuid ?? "");
  if (id) {
    if (seen.has(id)) return;
    seen.add(id);
  }
  out.push(token);
}

function resolveUuid(uuid: string): any | null {
  try {
    const foundry = (globalThis as any).fromUuidSync;
    if (typeof foundry !== "function") return null;
    const doc = foundry(uuid);
    return doc?.object ?? doc ?? null;
  } catch {
    return null;
  }
}

function targetedTokens(usageConfig: any, messageConfig: any): any[] {
  const out: any[] = [];
  const seen = new Set<string>();
  const live = (game as any)?.user?.targets;
  if (live) {
    try {
      for (const token of live) addToken(out, seen, token);
    } catch {
      /* a Set that is not iterable is not a target */
    }
  }
  const rows: unknown[] = [
    ...(Array.isArray(usageConfig?.targets) ? usageConfig.targets : []),
    ...(Array.isArray(messageConfig?.data?.flags?.dnd5e?.targets)
      ? messageConfig.data.flags.dnd5e.targets
      : []),
  ];
  for (const row of rows) {
    const uuid = typeof row === "string" ? row : String((row as { uuid?: unknown })?.uuid ?? "");
    if (!uuid) continue;
    addToken(out, seen, resolveUuid(uuid));
  }
  return out;
}

function pointedReachOf(activity: any, actor: any, item: any): number | undefined {
  const flavor = String(activity?.description?.chatFlavor ?? "");
  const pointers = parseItemPointers(flavor);
  if (!pointers.length) return undefined;
  const items = [...(actor?.items ?? [])];
  for (const pointer of pointers) {
    const hit = matchPointerItem(pointer.token, items, item?.id);
    const reach = Number((hit as { system?: { range?: { reach?: unknown } } } | null)?.system?.range?.reach);
    if (Number.isFinite(reach) && reach > 0) return reach;
  }
  return undefined;
}

function notify(key: string, data?: Record<string, string>): void {
  try {
    const text = data
      ? game.i18n.format(key, data)
      : game.i18n.localize(key);
    ui.notifications?.warn(text);
  } catch {
    /* a toast is courtesy */
  }
}

/**
 * Allow this use, or veto it for range.
 *
 * Returns true to let `police()` continue (or finish). Returns false to cancel the activity.
 */
export function gateActivityRange(
  activity: any,
  usageConfig: any,
  messageConfig: any,
  driven = false,
): boolean {
  if (!isAttackRangeEnabled()) return true;
  if (!isDnd5e()) return true;

  const actor = activity?.actor;
  if (!actor) return true;

  const item = activity?.item;
  const classified = classifyActivityRange(activity, item, {
    grid: gridDistance(),
    attackMode: String(usageConfig?.attackMode ?? ""),
    pointedReach: pointedReachOf(activity, actor, item),
  });
  if (classified.kind === "skip") return true;

  const from = actorToken(actor);
  if (!from) return true;

  const targets = targetedTokens(usageConfig, messageConfig);
  if (!targets.length) return true;

  let anyIn = false;
  let anyResolved = false;
  let worst: { xy: number; rise: number; name: string } | null = null;
  for (const target of targets) {
    const xy = tokenDistance(from, target);
    if (!Number.isFinite(xy)) continue;
    anyResolved = true;
    const rise = elevationOf(target) - elevationOf(from);
    if (!isTooFar(classified, xy, rise)) {
      anyIn = true;
      break;
    }
    if (!worst || xy > worst.xy) {
      worst = { xy, rise, name: String(target?.name ?? target?.document?.name ?? "?") };
    }
  }
  if (!anyResolved || anyIn || !worst) return true;

  const limit = classified.limit ?? 0;
  const gap = distanceOf(classified, worst.xy, worst.rise);
  const who = String(actor.name ?? "?");
  const what = String(activity?.name ?? "an activity");
  log(
    `attack-range: ${who} ${what} is out of ${classified.kind} range ` +
      `(${gap.toFixed(1)} vs ${limit} — ${classified.reason}; ${worst.name})`,
  );

  const automating = driven || shouldAutomate(actor);
  if (game.user?.isGM && !automating) {
    notify("NOODLRHOOKS.Combat.AttackRange.GmWarn", {
      distance: String(Math.round(gap)),
      limit: String(Math.round(limit)),
    });
    return true;
  }

  notify(
    classified.kind === "melee"
      ? "NOODLRHOOKS.Combat.AttackRange.TooFar"
      : "NOODLRHOOKS.Combat.AttackRange.OutOfRange",
  );
  return false;
}

export function surveyAttackRange(): unknown {
  const token: any = (canvas as any)?.tokens?.controlled?.[0];
  const actor = token?.actor;
  const targets = [...((game as any)?.user?.targets ?? [])];
  const item = actor?.items?.contents?.[0] ?? actor?.items?.[0];
  const classified = item
    ? classifyActivityRange(item.system?.activities?.contents?.[0] ?? {}, item, {
        grid: gridDistance(),
      })
    : null;
  const lines = [
    `module: ${MODULE_ID}`,
    `setting (${COMBAT_SETTINGS.attackRange}): ${isAttackRangeEnabled() ? "on" : "off"}`,
    `creature: ${String(token?.name ?? "— select a token —")}`,
    `targets: ${targets.map((t: any) => String(t?.name ?? "?")).join(" | ") || "none"}`,
  ];
  if (token && targets[0]) {
    const xy = tokenDistance(token, targets[0]);
    const rise = elevationOf(targets[0]) - elevationOf(token);
    lines.push(`nearest target: ${xy.toFixed(1)} ft xy, Δz ${rise}`);
  }
  if (classified) lines.push(`sample class: ${classified.kind} (${classified.reason})`);
  console.log(lines.join("\n"));
  return {
    enabled: isAttackRangeEnabled(),
    selected: String(token?.name ?? ""),
    targets: targets.map((t: any) => String(t?.name ?? "")),
  };
}
