// One window, three pages. The settings surface for everything this module enforces.
//
// Foundry's native settings list was adequate at sixteen checkboxes and stopped being adequate at
// forty-odd rows across three subjects. Two things pushed it over, and neither is length:
//
//   * **A switch that does nothing is invisible in the native list.** dnd5e's Auto-recharge is the
//     remaining case — when theirs is on we stand aside so two d6s cannot succeed the second roll —
//     and the badge from `integration/ownership.ts` is what says so. Community packages used to
//     produce the same silent stand-aside; they are incompatible now and we always enforce.
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
// Saving is batched behind the title-bar Save button, matching `noodlr`'s config windows down to the
// class name — a GM moving between the two should not be able to tell which module drew the window.
// This reverses an earlier decision to save each control immediately, and the reason it reverses is not
// only consistency: an immediate save has to re-render to keep the ownership badges honest (turning
// concentration off changes what the row beside it reports), and a re-render mid-edit discards every
// other control the GM had already moved. Batching means one re-render, after the write, when the
// badges can be recomputed from settings that actually exist.
//
// The exposure that buys is real and is why the button turns amber: edits closed without saving are
// lost. Same trade `noodlr` makes.
//
// There are no navigation tabs. There used to be, and they were broken in a way worth recording:
// `data-action="tab"` is RESERVED by ApplicationV2. Its `#onClickAction` has a `case "tab"` that calls
// core's own `_onClickTab`, which wants a `.tabs` ancestor and a `static TABS` declaration this window
// never had — and which returns early when the clicked button already carries `.active`, so the visible
// symptom was a pane that could not be left. A custom `actions.tab` handler never got a look in. The
// general rule: never name a `data-action` after one of core's own verbs.

import { MODULE_ID, log, warn } from "../constants";
import { advisories, conflicts, ownershipOf, type Ownership } from "../integration/ownership";
import type { Audience } from "../util/audience";
import { installHeaderSaveButton } from "./header-save";
import { PAGES, pageById, settingKey, type Page, type Row, type Section } from "./pages";
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
  /** Unique within the rendered page, so the two halves of a split row get distinct `for`/`id` pairs. */
  domId: string;
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
  isString: boolean;
  isAlways: boolean;
  text: string;
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

/**
 * One row, resolved for one side.
 *
 * `audience` is the column being drawn, and it does two things: it picks which of a split rule's two
 * settings this control edits, and it asks the ownership resolver about that same side — so an economy
 * switched off for monsters and on for players badges honestly in both columns rather than reporting
 * whichever half happened to be checked first.
 */
function viewRow(row: Row, audience?: Audience): ViewRow {
  const key = settingKey(row, audience);
  const value = key ? readSetting(key) : undefined;
  const own = row.ownership ? ownershipOf(row.ownership, audience) : null;
  const kind = key ? (row.kind ?? "boolean") : "";
  return {
    domId: audience ? `${row.id}-${audience}` : row.id,
    id: row.id,
    label: localize(row.label),
    hint: localize(row.hint),
    state: row.state,
    today: row.today ?? "",
    setting: key ?? "",
    kind,
    isBool: kind === "boolean",
    isNumber: kind === "number",
    isSelect: kind === "select",
    isString: kind === "string",
    isAlways: kind === "",
    text: kind === "string" ? String(value ?? "") : "",
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

/**
 * Split the rows a GM can act on from the rows that only inform.
 *
 * Planned and system rows are the map, not the controls. They render collapsed, so a page stays a
 * settings page rather than becoming a roadmap with checkboxes hidden inside it.
 */
function partition(rows: Row[], audience?: Audience) {
  const all = rows.map((r) => viewRow(r, audience));
  return {
    rows: all.filter((r) => r.state === "live"),
    notes: all.filter((r) => r.state !== "live"),
  };
}

/**
 * A section, always as a list of columns.
 *
 * A full-width section becomes a single unlabelled column rather than a separate shape. That keeps the
 * template to ONE loop over rows: the alternative was a Handlebars partial, which would mean adding
 * partial registration and another filename for the packaging script to assert, or the same markup
 * written out twice, which is how the two halves eventually stop matching.
 */
function viewSection(section: Section) {
  const columns = section.columns?.length
    ? section.columns.map((column) => ({
        audience: column.audience as string,
        label: localize(column.label),
        blurb: column.blurb ? localize(column.blurb) : "",
        ...partition(column.rows, column.audience),
      }))
    : [{ audience: "", label: "", blurb: "", ...partition(section.rows ?? []) }];

  return {
    id: section.id,
    title: localize(section.title),
    blurb: section.blurb ? localize(section.blurb) : "",
    columns,
    split: Boolean(section.columns?.length),
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
      // The root element IS the form, which is what lets the header Save button survive a PART
      // re-render: it is attached to the window frame, and the frame is not what gets replaced.
      tag: "form",
      classes: ["noodlr-hooks", "noodlr-rules-config"],
      window: { title: "NOODLRHOOKS.Rules.Title", icon: "fa-solid fa-sliders", resizable: true },
      // Wider than it was: two columns of controls plus their hints need the room.
      position: { width: 900, height: 780 },
      form: {
        handler: RulesConfig.#onSubmit,
        submitOnChange: false,
        closeOnSubmit: false,
      },
      actions: {
        preset: RulesConfig.#onPreset,
      },
    };

    static PARTS = { main: { template: TEMPLATE, scrollable: [".noodlr-rules__body"] } };

    #pageId: string;

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
      const preset = currentPreset();
      return {
        pageId: page.id,
        blurb: localize(page.blurb),
        sections: page.sections.map(viewSection),
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
      installHeaderSaveButton(this, localize("NOODLRHOOKS.Rules.Save"));
    }

    /**
     * Collect and write every changed control.
     *
     * The controls carry no `name` attribute and are read out of the DOM by `data-setting` instead.
     * That is not stylistic: a setting key contains dots (`combat.dying.npc`), and Foundry's form
     * serializer expands a dotted name into a nested object, so the submitted data would arrive shaped
     * like `{combat: {dying: {npc: true}}}` and every key would have to be flattened back. `noodlr`'s
     * prompt fields solved the same problem the same way.
     */
    static async #onSubmit(this: any): Promise<void> {
      const root: HTMLElement | null = this.element ?? null;
      if (!root) return;
      let changed = 0;
      for (const input of root.querySelectorAll<HTMLElement>("[data-setting]")) {
        const key = input.getAttribute("data-setting");
        if (!key) continue;
        let value: unknown;
        if (input instanceof HTMLInputElement && input.type === "checkbox") value = input.checked;
        else if (input instanceof HTMLInputElement && input.type === "number") {
          value = Number(input.value);
          // A box someone cleared is not an instruction to store NaN.
          if (!Number.isFinite(value as number)) continue;
        } else if (input instanceof HTMLSelectElement || input instanceof HTMLInputElement) {
          value = input.value;
        } else continue;

        if (readSetting(key) === value) continue;
        try {
          await game.settings.set(MODULE_ID, key, value as never);
          changed += 1;
        } catch (err) {
          warn(`could not save ${key}:`, err);
        }
      }
      if (changed) log(`saved ${changed} setting(s)`);
      // Re-render even when nothing changed, so the ownership badges are recomputed: one rule going off
      // changes what the row beside it reports, and a badge that lies until the next open is the exact
      // failure this window exists to fix.
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
