// One window, three pages. The settings surface for everything this module enforces.
//
// Foundry's native settings list was adequate at sixteen checkboxes and stopped being adequate at
// forty-odd rows across three subjects. Two things pushed it over, and neither is length:
//
//   * **A stand-aside is invisible in the native list.** `ac5eOwnsConditions()` switches the whole
//     condition layer off while its checkbox still reads on, and a GM has no way to tell that apart
//     from the module being broken. Every row here carries an ownership badge from
//     `integration/ownership.ts`, which reads the same predicates the rules read.
//   * **A rule nobody has built looks identical to a rule that is switched off** — that is, like
//     nothing at all. The pages declare planned rules alongside live ones and say who covers them
//     today, so "does this module do cover?" has an answer in the interface rather than only in a
//     design document.
//
// The class is built on first use rather than at import time, like the capability sheet. It cannot be
// deferred as far as that one, because `registerMenu` inspects the prototype and so needs a real class
// during `init` — hence the try/catch around registration in `settings.ts`. The principle is unchanged:
// the windows are a convenience and the rules are the product, so a change in Foundry's application
// namespace must never be able to stop conditions, dying and the action economy from loading.
//
// Saving is per-control and immediate rather than on a Save button. These are world settings, a GM is
// the only person who can open this, and every one takes effect on the next roll — a form that
// batches them would only add a way to lose them.

import { MODULE_ID, log, warn } from "../constants";
import { advisories, conflicts, ownershipOf, type Ownership } from "../integration/ownership";
import { PAGES, pageById, type Page, type Row } from "./pages";
import { PRESETS, applyPreset, currentPreset } from "./presets";

const TEMPLATE = `modules/${MODULE_ID}/templates/rules-config.hbs`;

function localize(text: string, data?: Record<string, unknown>): string {
  try {
    const i18n = game.i18n;
    const out = data ? i18n?.format?.(text, data) : i18n?.localize?.(text);
    // Foundry returns an unknown key unchanged, which is what lets a row carry plain English.
    return out ? String(out) : text;
  } catch {
    return text;
  }
}

function readSetting(key: string): unknown {
  try {
    return game.settings.get(MODULE_ID, key);
  } catch {
    return undefined;
  }
}

interface ViewRow {
  id: string;
  label: string;
  hint: string;
  state: string;
  today: string;
  setting: string;
  kind: string;
  // Precomputed rather than compared in the template. Foundry's `eq` and `concat` helpers are
  // recent enough that relying on them buys a version dependency for no benefit.
  isBool: boolean;
  isNumber: boolean;
  isSelect: boolean;
  isAlways: boolean;
  stateLabel: string;
  value: unknown;
  checked: boolean;
  number: number;
  range?: { min: number; max: number; step: number };
  options: Array<{ value: string; label: string; selected: boolean }>;
  /** Ownership badge, absent when no rule area covers this row. */
  badge?: { text: string; tone: string; tip: string };
}

/**
 * How a resolved ownership reads on a row.
 *
 * `us` is deliberately silent. A badge on every row is a badge on none of them, and the answer a GM
 * is looking for when they open this window is which rows are NOT behaving as their switch suggests.
 */
function badgeFor(own: Ownership): ViewRow["badge"] {
  if (own.owner === "other") {
    return {
      text: localize("NOODLRHOOKS.Rules.Badge.Owned", { module: String(own.by) }),
      tone: "owned",
      tip: own.note ?? "",
    };
  }
  if (own.owner === "nobody" && !own.enabled) {
    return {
      text: localize("NOODLRHOOKS.Rules.Badge.Unenforced"),
      tone: "off",
      tip: own.note ?? localize("NOODLRHOOKS.Rules.Badge.UnenforcedTip"),
    };
  }
  if (own.owner === "system") {
    return {
      text: localize("NOODLRHOOKS.Rules.Badge.System"),
      tone: "system",
      tip: own.note ?? "",
    };
  }
  // Ours and running, or ours with a caveat worth reading.
  return own.note
    ? { text: localize("NOODLRHOOKS.Rules.Badge.Shared"), tone: "shared", tip: own.note }
    : undefined;
}

function viewRow(row: Row): ViewRow {
  const value = row.setting ? readSetting(row.setting) : undefined;
  const own = row.ownership ? ownershipOf(row.ownership) : null;
  const kind = row.setting ? (row.kind ?? "boolean") : "";
  return {
    id: row.id,
    label: localize(row.label),
    hint: localize(row.hint),
    state: row.state,
    today: row.today ?? "",
    setting: row.setting ?? "",
    kind,
    isBool: kind === "boolean",
    isNumber: kind === "number",
    isSelect: kind === "select",
    isAlways: kind === "",
    stateLabel: localize(`NOODLRHOOKS.Rules.State.${row.state}`),
    value,
    checked: value === true,
    number: Number(value ?? 0),
    range: row.range,
    options: Object.entries(row.choices ?? {}).map(([key, label]) => ({
      value: key,
      label: localize(label),
      selected: String(value) === key,
    })),
    badge: own ? badgeFor(own) : undefined,
  };
}

/** A section split into the rows a GM can act on and the rows that only inform. */
function viewSection(section: Page["tabs"][number]["sections"][number]) {
  const all = section.rows.map(viewRow);
  return {
    id: section.id,
    title: localize(section.title),
    blurb: section.blurb ? localize(section.blurb) : "",
    rows: all.filter((r) => r.state === "live"),
    // Planned and system rows are the map, not the controls. Collapsed, so the page stays a settings
    // page rather than becoming a roadmap with checkboxes hidden in it.
    notes: all.filter((r) => r.state !== "live"),
  };
}

let WindowClass: any = null;

function windowClass(): any {
  if (WindowClass) return WindowClass;
  const api = (foundry as any)?.applications?.api;
  const { ApplicationV2, HandlebarsApplicationMixin } = api ?? {};
  if (!ApplicationV2 || !HandlebarsApplicationMixin) {
    throw new Error("ApplicationV2 is unavailable; this Foundry version cannot show the settings.");
  }

  WindowClass = class RulesConfig extends HandlebarsApplicationMixin(ApplicationV2) {
    static DEFAULT_OPTIONS = {
      tag: "div",
      classes: ["noodlr-hooks", "noodlr-rules-config"],
      window: { title: "NOODLRHOOKS.Rules.Title", icon: "fa-solid fa-sliders", resizable: true },
      position: { width: 720, height: 760 },
      actions: {
        preset: RulesConfig.#onPreset,
        tab: RulesConfig.#onTab,
      },
    };

    static PARTS = { main: { template: TEMPLATE, scrollable: [".noodlr-rules__body"] } };

    #pageId: string;
    #tabId = "";

    constructor(options: any = {}) {
      super(options);
      this.#pageId = String(options.page ?? PAGES[0].id);
    }

    get page(): Page {
      return pageById(this.#pageId) ?? PAGES[0];
    }

    get title(): string {
      return localize(this.page.title);
    }

    async _prepareContext(): Promise<Record<string, unknown>> {
      const page = this.page;
      const tabs = page.tabs;
      const active = tabs.find((t) => t.id === this.#tabId) ?? tabs[0];
      const preset = currentPreset();
      return {
        pageId: page.id,
        blurb: localize(page.blurb),
        multiTab: tabs.length > 1,
        tabs: tabs.map((t) => ({ id: t.id, label: localize(t.label), active: t.id === active.id })),
        sections: active.sections.map(viewSection),
        presets: PRESETS.map((p) => ({
          id: p.id,
          label: localize(p.label),
          blurb: localize(p.blurb),
          active: p.id === preset,
        })),
        // Advisories are page-independent and cheap; showing them on every page is the point, since
        // the whole class of problem they describe is one a GM will not go looking for.
        notices: [...advisories(), ...conflicts()].map((n) => ({
          ...n,
          isWarn: n.level === "warn",
        })),
      };
    }

    _onRender(context: unknown, options: unknown): void {
      super._onRender?.(context, options);
      const root: HTMLElement = (this as any).element;
      for (const input of root.querySelectorAll<HTMLElement>("[data-setting]")) {
        input.addEventListener("change", (event) => void this.#onChange(event));
      }
    }

    async #onChange(event: Event): Promise<void> {
      const target = event.currentTarget as HTMLInputElement | HTMLSelectElement;
      const key = target?.getAttribute("data-setting");
      if (!key) return;
      let value: unknown;
      if (target instanceof HTMLInputElement && target.type === "checkbox") value = target.checked;
      else if (target instanceof HTMLInputElement && target.type === "number") {
        value = Number(target.value);
        if (!Number.isFinite(value as number)) return;
      } else value = target.value;
      try {
        await game.settings.set(MODULE_ID, key, value as never);
      } catch (err) {
        warn(`could not save ${key}:`, err);
        return;
      }
      // Re-render rather than patching in place: a setting can change another row's ownership badge
      // (turning concentration off changes what the row beside it reports), and a badge that lies
      // until the next open is the exact failure this window exists to fix.
      void this.render();
    }

    static async #onTab(this: any, _event: Event, target: HTMLElement): Promise<void> {
      this.setTab(String(target?.getAttribute("data-tab") ?? ""));
    }

    setTab(id: string): void {
      this.#tabId = id;
      void this.render();
    }

    static async #onPreset(this: any, _event: Event, target: HTMLElement): Promise<void> {
      const id = String(target?.getAttribute("data-preset") ?? "");
      const preset = PRESETS.find((p) => p.id === id);
      if (!preset) return;
      const DialogV2 = (foundry as any)?.applications?.api?.DialogV2;
      const ok = DialogV2
        ? await DialogV2.confirm({
            window: { title: localize("NOODLRHOOKS.Rules.Preset.Confirm") },
            content: `<p><strong>${localize(preset.label)}</strong></p><p>${localize(preset.blurb)}</p>`,
          })
        : true;
      if (!ok) return;
      const changed = await applyPreset(id);
      log(`applied preset "${id}" (${changed} setting(s) changed)`);
      ui.notifications?.info(
        localize("NOODLRHOOKS.Rules.Preset.Applied", {
          name: localize(preset.label),
          count: changed,
        }),
      );
      void this.render();
    }
  };

  return WindowClass;
}

const perPage = new Map<string, any>();

/**
 * The class Foundry's settings menu is given, one per page.
 *
 * Two constraints from core, both read from `client/helpers/client-settings.mjs` and
 * `client/applications/settings/config.mjs` rather than assumed:
 *
 *   * `registerMenu` **throws** unless `type.prototype` is a `FormApplication` or an `ApplicationV2`.
 *     A duck-typed object with a `render` method is rejected outright.
 *   * The menu button does `new menu.type()` with **no arguments**, so the page cannot be passed in
 *     as an option and has to be baked into the class.
 *
 * Hence a subclass per page rather than one class and a parameter. The distinct `id` is not
 * incidental either: without it all three pages would share one window, and opening Mechanics while
 * House Rules was up would re-render that window in place instead of giving you a second one.
 */
export function pageClass(pageId: string): any {
  const cached = perPage.get(pageId);
  if (cached) return cached;
  const Base = windowClass();
  const Sub = class extends Base {
    static DEFAULT_OPTIONS = { id: `noodlr-rules-${pageId}` };
    constructor(options: any = {}) {
      super({ ...options, page: pageId });
    }
  };
  perPage.set(pageId, Sub);
  return Sub;
}

/** Open one of the three pages. Ids are `house`, `mechanics`, `combat`. */
export function openRulesConfig(page = PAGES[0].id): void {
  try {
    new (pageClass(page))().render(true);
  } catch (err) {
    warn("could not open the rules settings:", err);
    ui.notifications?.error(localize("NOODLRHOOKS.Rules.OpenFailed"));
  }
}

/** The class to hand `game.settings.registerMenu`. Throws if ApplicationV2 is unavailable. */
export function menuShimFor(page: string): any {
  return pageClass(page);
}
