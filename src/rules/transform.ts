// Token-corner Restore Transformation — the Paladin-aura treatment for a form change.
//
// dnd5e's restore is `Actor#revertOriginalForm`. It does not spend a Wild Shape use. Argon's Wild
// Shape button *does* use the activity, so this never intercepts it: beast-to-beast stays legal,
// and revert stays free. The badge is `hud: false` so Token HUD cannot toggle it off as a condition.
// The sprite itself is the click, plus a HUD control as backup.

import { GENERAL_SETTINGS, MODULE_ID, debug, log, warn } from "../constants";
import { isTransformUndoEnabled } from "../settings";
import { isDnd5e } from "../system/dnd5e-rewards";
import {
  TRANSFORM_STATUS_IMG,
  isOurTransformBadge,
  isPolymorphed,
  registerTransformStatus,
  transformBadgePayload,
} from "../system/dnd5e-transform";
import { wireEffectClicks } from "../util/token-badge";

function notify(key: string): void {
  try {
    ui.notifications?.warn(game.i18n.localize(key));
  } catch {
    /* courtesy */
  }
}

function hasBadge(actor: any): boolean {
  return [...(actor?.effects ?? [])].some(isOurTransformBadge);
}

export async function restoreOriginalForm(actor: any): Promise<boolean> {
  if (!actor) return false;
  if (!actor.isOwner) {
    notify("NOODLRHOOKS.General.TransformUndo.NoOwner");
    return false;
  }
  if (!isPolymorphed(actor)) {
    notify("NOODLRHOOKS.General.TransformUndo.NotTransformed");
    return false;
  }
  if (typeof actor.revertOriginalForm !== "function") {
    notify("NOODLRHOOKS.General.TransformUndo.NotTransformed");
    return false;
  }
  try {
    await actor.revertOriginalForm({ renderSheet: false });
    return true;
  } catch (err) {
    warn("transform: revertOriginalForm failed:", err);
    return false;
  }
}

async function syncBadge(actor: any): Promise<void> {
  if (!isTransformUndoEnabled() || !isDnd5e() || !actor) return;
  if (!actor.isOwner) return;
  const want = isPolymorphed(actor);
  const existing = [...(actor.effects ?? [])].filter(isOurTransformBadge);
  if (!want) {
    for (const effect of existing) {
      try {
        await effect.delete();
      } catch (err) {
        warn(`transform: could not drop badge on ${String(actor.name)}:`, err);
      }
    }
    return;
  }
  if (existing.length > 1) {
    for (const extra of existing.slice(1)) {
      try {
        await extra.delete();
      } catch {
        /* one leftover is noisy, not fatal */
      }
    }
    return;
  }
  if (existing.length === 1) return;
  registerTransformStatus();
  try {
    await actor.createEmbeddedDocuments("ActiveEffect", [transformBadgePayload(actor)]);
  } catch (err) {
    warn(`transform: could not present badge on ${String(actor.name)}:`, err);
  }
}

function wireToken(token: any): void {
  if (!token || !isTransformUndoEnabled()) return;
  wireEffectClicks(token, TRANSFORM_STATUS_IMG, (t) => {
    void restoreOriginalForm(t?.actor);
  });
}

function tokensOnScene(): any[] {
  try {
    return [...((canvas as any)?.scene?.tokens ?? [])]
      .map((d: any) => d?.object ?? d)
      .filter(Boolean);
  } catch {
    return [];
  }
}

function addHudButton(root: HTMLElement, title: string, icon: string, onClick: () => void): void {
  const col = root.querySelector(".col.right");
  if (!col) return;
  if (col.querySelector("[data-noodlr-transform]")) return;
  const btn = document.createElement("div");
  btn.className = "control-icon";
  btn.dataset.noodlrTransform = "1";
  btn.title = title;
  btn.innerHTML = `<i class="${icon}"></i>`;
  btn.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    onClick();
  });
  col.appendChild(btn);
}

export function registerTransformWatch(): void {
  registerTransformStatus();

  Hooks.on("updateActor", (actor: any) => {
    void syncBadge(actor);
  });
  Hooks.on("updateToken", (doc: any, changed: any) => {
    if (changed?.actorId !== undefined || changed?.flags?.dnd5e) {
      void syncBadge(doc?.actor);
    }
  });
  Hooks.on("dnd5e.transformActor", (actor: any) => {
    void syncBadge(actor);
  });
  Hooks.on("dnd5e.transformActorV2", (actor: any) => {
    void syncBadge(actor);
  });
  Hooks.on("refreshToken", (token: any) => {
    wireToken(token);
  });
  Hooks.on("canvasReady", () => {
    for (const token of tokensOnScene()) {
      void syncBadge(token.actor ?? token.document?.actor);
      wireToken(token);
    }
  });
  Hooks.on("renderTokenHUD", (_app: any, html: any) => {
    if (!isTransformUndoEnabled()) return;
    const token = _app?.object ?? _app?.token;
    const actor = token?.actor;
    if (!isPolymorphed(actor)) return;
    const root: HTMLElement | null = html instanceof HTMLElement ? html : (html?.[0] ?? null);
    if (!root) return;
    const title = game.i18n.localize("NOODLRHOOKS.General.TransformUndo.Hud");
    addHudButton(root, title, "fa-solid fa-rotate-left", () => {
      void restoreOriginalForm(actor);
    });
  });

  if ((canvas as any)?.ready) {
    for (const token of tokensOnScene()) {
      void syncBadge(token.actor ?? token.document?.actor);
      wireToken(token);
    }
  }

  Hooks.on("updateSetting", (_setting: any, _value: any, key?: string) => {
    if (key === `${MODULE_ID}.${GENERAL_SETTINGS.transformUndo}` || key?.endsWith(`.${GENERAL_SETTINGS.transformUndo}`)) {
      for (const token of tokensOnScene()) void syncBadge(token.actor ?? token.document?.actor);
    }
  });

  debug("transform watch registered");
}

export function surveyTransform(): unknown {
  const tokens = tokensOnScene();
  const lines = [`transform: ${isTransformUndoEnabled() ? "on" : "off"} — ${tokens.length} token(s)`];
  for (const token of tokens) {
    const actor = token.actor ?? token.document?.actor;
    if (!actor) continue;
    const form = isPolymorphed(actor);
    const badge = hasBadge(actor);
    if (!form && !badge) continue;
    lines.push(
      `  ${String(token.name ?? actor.name)} polymorphed=${form} badge=${badge}` +
        (form && !badge ? " — MISSING ICON" : "") +
        (!form && badge ? " — STALE BADGE" : ""),
    );
  }
  const block = lines.join("\n");
  log(block);
  return { text: block, tokens: tokens.length };
}
