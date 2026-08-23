// Wall and scene config fields for movement height.
//
// Injected the same way Wall Height 7.0.8 does — no extra template — because those two
// windows are core's and we do not own their parts. We write only our namespace.
// When `wall-height` is active they already draw top / bottom; a second pair would
// fight, so we skip the wall fields and still add enclosure / floor / defaults
// (they have none of those).

import { MODULE_ID } from "../constants";
import { DEFAULT_WALL_BOTTOM, DEFAULT_WALL_TOP, scenePolicyOf, wallBounds } from "../core/wall-height";
import { moduleActive } from "../util/modules";

function rootOf(html: unknown): HTMLElement | null {
  if (html instanceof HTMLElement) return html;
  const anyHtml = html as { querySelector?: unknown; 0?: unknown } | null;
  if (anyHtml && typeof anyHtml.querySelector === "function") return anyHtml as HTMLElement;
  const first = anyHtml?.[0];
  return first instanceof HTMLElement ? first : null;
}

function localize(key: string): string {
  try {
    return String(game.i18n?.localize?.(key) ?? key);
  } catch {
    return key;
  }
}

function insertAfter(root: HTMLElement, selectors: string[], html: string): boolean {
  if (root.querySelector(`[name="flags.${MODULE_ID}.enclosure"], [name="flags.${MODULE_ID}.top"]`)) {
    return false;
  }
  for (const selector of selectors) {
    const node = root.querySelector(selector);
    const host = node?.closest("fieldset") ?? node?.closest(".form-group") ?? node?.parentElement;
    if (!host) continue;
    host.insertAdjacentHTML("afterend", html);
    return true;
  }
  return false;
}

export function registerWallHeightUi(): void {
  Hooks.on("renderWallConfig", (app: any, html: unknown) => {
    try {
      if (moduleActive("wall-height")) return;
      const root = rootOf(html);
      if (!root) return;
      const scene = scenePolicyOf(app?.document?.parent ?? (globalThis as any).canvas?.scene);
      const { top, bottom } = wallBounds(app?.document ?? {}, scene);
      const ours = app?.document?.flags?.[MODULE_ID] ?? {};
      const theirs = app?.document?.flags?.["wall-height"] ?? {};
      const topSet = ours.top != null && ours.top !== "" || Number.isFinite(Number(theirs.top));
      const bottomSet = ours.bottom != null && ours.bottom !== "" || Number.isFinite(Number(theirs.bottom));
      const topValue = topSet ? String(top) : "";
      const bottomValue = bottomSet ? String(bottom) : "";
      const block = `
    <fieldset>
      <legend>${localize("NOODLRHOOKS.Walls.Legend")}</legend>
      <div class="form-group">
        <label>${localize("NOODLRHOOKS.Walls.Top")}</label>
        <div class="form-fields">
          <input name="flags.${MODULE_ID}.top" type="number" step="any" value="${topValue}" placeholder="${scene.defaultTop}">
        </div>
      </div>
      <div class="form-group">
        <label>${localize("NOODLRHOOKS.Walls.Bottom")}</label>
        <div class="form-fields">
          <input name="flags.${MODULE_ID}.bottom" type="number" step="any" value="${bottomValue}" placeholder="${scene.defaultBottom}">
        </div>
        <p class="hint">${localize("NOODLRHOOKS.Walls.TopHint")}</p>
      </div>
    </fieldset>`;
      insertAfter(root, [`[name="door"]`, `[name="move"]`], block);
      app?.setPosition?.({ height: "auto" });
    } catch {
      // A missing core field must not break the wall window.
    }
  });

  Hooks.on("renderSceneConfig", (app: any, html: unknown) => {
    try {
      const root = rootOf(html);
      if (!root) return;
      const policy = scenePolicyOf(app?.document);
      const flags = app?.document?.flags?.[MODULE_ID] ?? {};
      const defaultTop = flags.defaultWallTop == null ? "" : String(flags.defaultWallTop);
      const defaultBottom = flags.defaultWallBottom == null ? "" : String(flags.defaultWallBottom);
      const outdoor = policy.enclosure !== "indoor" ? "selected" : "";
      const indoor = policy.enclosure === "indoor" ? "selected" : "";
      const natural = policy.floor !== "manmade" ? "selected" : "";
      const manmade = policy.floor === "manmade" ? "selected" : "";
      const block = `
    <fieldset>
      <legend>${localize("NOODLRHOOKS.Walls.SceneLegend")}</legend>
      <div class="form-group">
        <label>${localize("NOODLRHOOKS.Walls.Enclosure")}</label>
        <div class="form-fields">
          <select name="flags.${MODULE_ID}.enclosure">
            <option value="outdoor" ${outdoor}>${localize("NOODLRHOOKS.Walls.Outdoor")}</option>
            <option value="indoor" ${indoor}>${localize("NOODLRHOOKS.Walls.Indoor")}</option>
          </select>
        </div>
        <p class="hint">${localize("NOODLRHOOKS.Walls.EnclosureHint")}</p>
      </div>
      <div class="form-group">
        <label>${localize("NOODLRHOOKS.Walls.Floor")}</label>
        <div class="form-fields">
          <select name="flags.${MODULE_ID}.floor">
            <option value="natural" ${natural}>${localize("NOODLRHOOKS.Walls.Natural")}</option>
            <option value="manmade" ${manmade}>${localize("NOODLRHOOKS.Walls.Manmade")}</option>
          </select>
        </div>
        <p class="hint">${localize("NOODLRHOOKS.Walls.FloorHint")}</p>
      </div>
      <div class="form-group">
        <label>${localize("NOODLRHOOKS.Walls.DefaultTop")}</label>
        <div class="form-fields">
          <input name="flags.${MODULE_ID}.defaultWallTop" type="number" step="any" value="${defaultTop}" placeholder="${DEFAULT_WALL_TOP}">
        </div>
      </div>
      <div class="form-group">
        <label>${localize("NOODLRHOOKS.Walls.DefaultBottom")}</label>
        <div class="form-fields">
          <input name="flags.${MODULE_ID}.defaultWallBottom" type="number" step="any" value="${defaultBottom}" placeholder="${DEFAULT_WALL_BOTTOM}">
        </div>
      </div>
    </fieldset>`;
      insertAfter(
        root,
        [`[name="environment.globalLight.enabled"]`, `[name="grid.distance"]`, `[name="grid.type"]`],
        block,
      );
      app?.setPosition?.({ height: "auto" });
    } catch {
      // Same as the wall window: missing core markup is not a reason to throw.
    }
  });
}
