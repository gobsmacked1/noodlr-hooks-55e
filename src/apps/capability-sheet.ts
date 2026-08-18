// The capability sheet: what a model made of one creature's written abilities, and the GM's veto.
//
// Everything else in the compiler runs unattended. This window is the one place a human sees what was
// read and can disagree with it, which is what makes the whole design acceptable: a model interprets
// prose once, and a person who knows the table can correct, freeze or throw away any interpretation
// before it decides anything at play.
//
// FOUR ACTIONS, AND ONE OF THEM IS LOAD-BEARING:
//
//   * **Edit** rewrites the rules by hand. Validated before it is stored — a hand edit that does not
//     parse is a capability that silently stops firing, which is worse than the bad compile it was
//     meant to fix.
//   * **Lock** is the promise. `cache.put` refuses to overwrite a locked entry, so a model upgrade, a
//     cache miss, or another GM's scene load can never quietly undo the correction. Editing alone
//     deliberately does not protect; a GM who wants their version to survive says so.
//   * **Reject** removes a hallucinated rule from play without deleting the evidence. Rejected entries
//     stay in the cache, are never re-requested, and are never exported.
//   * **Recompile** buys a second reading. Refused on a locked entry, by design.
//
// The class is built lazily rather than at import time. `noodlr` defines its windows at module scope
// because windows are what that module is; here the windows are a diagnostic and the rules are the
// product, so a change in Foundry's application namespace must not be able to stop conditions, dying
// and the action economy from loading.

import { MODULE_ID, log, warn } from "../constants";
import { isPrimaryGM } from "../util/gm";
import { isCapabilityCompileEnabled } from "../settings";
import { validateCapability, type Capability } from "../integration/capability";
import * as cache from "../capability/cache";
import { currentProvenance, describeStamp, driftOf, type Provenance } from "../capability/age";
import { describeCapability } from "../capability/describe";
import { featuresOf, rebindActor, recompileFeatures } from "../capability/collect";

const TEMPLATE = `modules/${MODULE_ID}/templates/capability-sheet.hbs`;

interface Row {
  id: string;
  label: string;
  prose: string;
  known: boolean;
  status: string;
  statusLabel: string;
  locked: boolean;
  rejected: boolean;
  edited: boolean;
  /** Compiled, and the model honestly found no mechanical rule in it. Not a failure. */
  flavourOnly: boolean;
  model: string;
  when: string;
  /**
   * Non-empty when this reading was made against a different ruleset than the one it will run under.
   * Reported and nothing else — see `capability/age.ts` for why a version bump does not spend money.
   */
  drift: string;
  rules: ReturnType<typeof describeCapability>;
  inert: number;
}

function localize(key: string, fallback: string, data?: Record<string, unknown>): string {
  try {
    const i18n = game.i18n;
    const text = data ? i18n?.format?.(key, data) : i18n?.localize?.(key);
    return text && text !== key ? String(text) : fallback;
  } catch {
    return fallback;
  }
}

/**
 * One line saying what a reading was made against, or "" when it still matches this world.
 *
 * Deliberately a sentence rather than a badge: the useful thing to tell a GM is not "stale" — the
 * reading is very probably still correct — but WHICH ruleset it was made under, so they can judge
 * whether their own dnd5e upgrade touched the ability in front of them. The two answers are the two
 * buttons already on the row: Recompile buys a fresh reading, Lock records that they have checked it.
 */
function driftLine(capability: Capability | undefined, now: Provenance): string {
  if (!capability) return "";
  const reasons = driftOf(capability, now);
  if (reasons.length === 0) return "";
  const was = describeStamp(capability);
  return was
    ? localize("NOODLRHOOKS.Capabilities.Drift", `read under ${was}`, { was })
    : localize(
        "NOODLRHOOKS.Capabilities.DriftUnstamped",
        "read before this module recorded the ruleset",
      );
}

/** Rows for one creature: every written ability, compiled or not. */
function rowsFor(actor: any): Row[] {
  const seen = new Set<string>();
  const rows: Row[] = [];
  const now = currentProvenance();
  for (const feature of featuresOf(actor)) {
    if (seen.has(feature.id)) continue;
    seen.add(feature.id);
    const capability = cache.get(feature.id);
    // The feature is passed so a rule restating the item's own damage is badged here rather than only
    // refused at the moment it fires — see `RuleView.refused`.
    const rules = capability ? describeCapability(capability, feature.item) : [];
    const status = String(capability?.status ?? "uncompiled");
    rows.push({
      id: feature.id,
      label: capability?.label || feature.label,
      // The cache may hold an entry compiled from another creature's identical wording, in which case
      // it carries no prose of its own. The sheet always shows THIS creature's text.
      prose: feature.prose,
      known: Boolean(capability),
      status,
      statusLabel: localize(`NOODLRHOOKS.Capabilities.Status.${status}`, status),
      locked: capability?.status === "locked",
      rejected: capability?.status === "rejected",
      edited: Boolean(capability?.editedAt),
      flavourOnly: Boolean(capability) && rules.length === 0,
      model: String(capability?.compiledBy?.model ?? ""),
      when: capability?.compiledBy?.at
        ? new Date(capability.compiledBy.at).toLocaleDateString()
        : "",
      drift: driftLine(capability, now),
      rules,
      // A standing fact is not inert. Counting it as such is what made a third of every compiled
      // corpus look like wasted money on this sheet — see `capability/standing.ts`.
      inert: rules.filter((r) => r.inert).length,
    });
  }
  return rows;
}

/** Which row a button belongs to. A module function rather than a method: the action handlers are
 *  static and Foundry calls them with the instance as `this`, which is not a receiver a private
 *  instance method can be reached through without upsetting the type checker. */
function rowIdOf(target: HTMLElement): string {
  return String(target?.closest?.("[data-capability]")?.getAttribute("data-capability") ?? "");
}

let SheetClass: any = null;

function sheetClass(): any {
  if (SheetClass) return SheetClass;
  const api = (foundry as any)?.applications?.api;
  const { ApplicationV2, HandlebarsApplicationMixin } = api ?? {};
  if (!ApplicationV2 || !HandlebarsApplicationMixin) {
    throw new Error("ApplicationV2 is unavailable; this Foundry version cannot show the sheet.");
  }

  SheetClass = class CapabilitySheet extends HandlebarsApplicationMixin(ApplicationV2) {
    static DEFAULT_OPTIONS = {
      tag: "div",
      classes: ["noodlr-hooks", "noodlr-capability-sheet"],
      window: {
        title: "NOODLRHOOKS.Capabilities.Sheet.Title",
        icon: "fa-solid fa-scroll",
        resizable: true,
      },
      position: { width: 760, height: 720 },
      actions: {
        edit: CapabilitySheet.#onEdit,
        lock: CapabilitySheet.#onLock,
        reject: CapabilitySheet.#onReject,
        recompile: CapabilitySheet.#onRecompile,
        compileAll: CapabilitySheet.#onCompileAll,
      },
    };

    static PARTS = { main: { template: TEMPLATE, scrollable: [".noodlr-capabilities"] } };

    #actor: any;

    constructor(options: any = {}) {
      super(options);
      this.#actor = options.actor;
    }

    get actor(): any {
      return this.#actor;
    }

    get title(): string {
      return localize(
        "NOODLRHOOKS.Capabilities.Sheet.TitleFor",
        `Capabilities — ${String(this.#actor?.name ?? "?")}`,
        { name: String(this.#actor?.name ?? "?") },
      );
    }

    async _prepareContext(): Promise<Record<string, unknown>> {
      await cache.warm();
      // Both switches have to be on and this has to be the writing client before any button that
      // spends money is offered. Greyed rather than hidden, so the reason stays visible.
      const enabled = isCapabilityCompileEnabled();
      const primary = isPrimaryGM();
      const canCompile = enabled && primary;
      const rows = rowsFor(this.#actor).map((row) => ({
        ...row,
        canRecompile: canCompile && !row.locked,
      }));
      return {
        name: String(this.#actor?.name ?? "?"),
        img: String(this.#actor?.img ?? ""),
        rows,
        any: rows.length > 0,
        counts: {
          total: rows.length,
          known: rows.filter((r) => r.known).length,
          uncompiled: rows.filter((r) => !r.known).length,
          inert: rows.reduce((sum, r) => sum + r.inert, 0),
        },
        canCompile,
        offHint: !enabled,
        notPrimaryHint: enabled && !primary,
      };
    }

    static async #onEdit(this: any, _event: Event, target: HTMLElement): Promise<void> {
      const id = rowIdOf(target);
      const capability = cache.get(id);
      if (!capability) return;
      const edited = await promptForRules(capability);
      if (!edited) return;
      cache.putOverride({
        ...capability,
        rules: edited,
        // Editing a locked entry leaves it locked. Unlocking has its own button, and a GM correcting
        // a rule they already froze plainly did not mean to thaw it.
        status: capability.status === "locked" ? "locked" : "edited",
        editedAt: Date.now(),
      });
      await cache.flush();
      rebindActor(this.actor);
      void this.render();
    }

    static async #onLock(this: any, _event: Event, target: HTMLElement): Promise<void> {
      const id = rowIdOf(target);
      const capability = cache.get(id);
      if (!capability) return;
      const status =
        capability.status === "locked" ? (capability.editedAt ? "edited" : "compiled") : "locked";
      cache.putOverride({ ...capability, status });
      await cache.flush();
      void this.render();
    }

    static async #onReject(this: any, _event: Event, target: HTMLElement): Promise<void> {
      const id = rowIdOf(target);
      const capability = cache.get(id);
      if (!capability) return;
      const status =
        capability.status === "rejected"
          ? capability.editedAt
            ? "edited"
            : "compiled"
          : "rejected";
      cache.putOverride({ ...capability, status });
      await cache.flush();
      rebindActor(this.actor);
      void this.render();
    }

    static async #onRecompile(this: any, _event: Event, target: HTMLElement): Promise<void> {
      await runCompile(this, [rowIdOf(target)]);
    }

    static async #onCompileAll(this: any): Promise<void> {
      // Only what nobody has read yet. "Everything again" is per-row on purpose: re-reading a whole
      // sheet is a bill, and a button that spends one should not be the easiest thing to click.
      const ids = rowsFor(this.actor)
        .filter((row) => !row.known)
        .map((row) => row.id);
      if (ids.length === 0) return;
      await runCompile(this, ids);
    }
  };

  return SheetClass;
}

/** Ask, then report in the same words whichever way it went. */
async function runCompile(app: any, ids: string[]): Promise<void> {
  const report = await recompileFeatures(app.actor, ids).catch((err) => {
    warn("recompile failed:", err);
    return null;
  });
  void app.render();
  if (!report) return;
  if (report.disabled) {
    ui.notifications?.warn?.(
      localize(
        "NOODLRHOOKS.Capabilities.Sheet.Disabled",
        "Reading abilities is switched off, or this is not the primary GM's client.",
      ),
    );
    return;
  }
  if (report.noCompiler) {
    ui.notifications?.warn?.(
      localize(
        "NOODLRHOOKS.Capabilities.Sheet.NoCompiler",
        "Nothing answered: Noodlr is not installed, or its own compiler switch is off.",
      ),
    );
    return;
  }
  if (report.skipped) {
    ui.notifications?.info?.(
      localize("NOODLRHOOKS.Capabilities.Sheet.Locked", "Locked, so it was left alone."),
    );
  }
  if (report.compiled) {
    ui.notifications?.info?.(
      localize("NOODLRHOOKS.Capabilities.Compiled", `Read ${report.compiled} abilities.`, {
        count: report.compiled,
      }),
    );
  } else if (report.rejected) {
    ui.notifications?.error?.(
      localize(
        "NOODLRHOOKS.Capabilities.Sheet.Rejected",
        "What came back did not validate; nothing was changed.",
      ),
    );
  }
}

/**
 * The hand editor: the rules array as JSON, re-offered with the errors if it does not validate.
 *
 * A form editor for arbitrary rule shapes would be a large build against a vocabulary of 36 effects
 * and 16 predicates, each with its own parameters. JSON plus the real validator is honest, and it is
 * the same check the compiled answer had to pass — an edit cannot get anything past it that a compile
 * could not.
 */
async function promptForRules(capability: Capability): Promise<Capability["rules"] | null> {
  const DialogV2: any = (foundry as any)?.applications?.api?.DialogV2;
  if (typeof DialogV2?.prompt !== "function") {
    ui.notifications?.warn?.("This Foundry version cannot show the editor.");
    return null;
  }

  let text = JSON.stringify(capability.rules ?? [], null, 2);
  // Up to three attempts rather than a loop without end: an editor that cannot be escaped except by
  // producing valid JSON is a trap, and closing the dialog is always an answer.
  for (let attempt = 0; attempt < 3; attempt++) {
    const answer: string | null = await DialogV2.prompt({
      window: { title: `${capability.label} — rules` },
      position: { width: 720 },
      content:
        `<p class="notes">${localize(
          "NOODLRHOOKS.Capabilities.Sheet.EditHint",
          "The rules array, checked against the same vocabulary a compiled answer has to pass.",
        )}</p>` +
        `<textarea name="rules" rows="22" style="width:100%;font-family:monospace;">${escapeHtml(text)}</textarea>`,
      ok: {
        label: localize("NOODLRHOOKS.Capabilities.Sheet.Save", "Save"),
        callback: (_event: Event, button: any) =>
          String(button?.form?.elements?.rules?.value ?? ""),
      },
      rejectClose: false,
      modal: true,
    }).catch(() => null);

    if (answer === null || answer === undefined) return null;
    text = answer;

    let parsed: unknown;
    try {
      parsed = JSON.parse(answer);
    } catch (err) {
      ui.notifications?.error?.(`Not valid JSON: ${String(err)}`);
      continue;
    }
    if (!Array.isArray(parsed)) {
      ui.notifications?.error?.("The rules have to be an array.");
      continue;
    }
    const check = validateCapability({ ...capability, rules: parsed });
    if (check.ok) return parsed as Capability["rules"];
    warn("hand-edited capability did not validate:", check.errors);
    ui.notifications?.error?.(check.errors.slice(0, 3).join(" · "));
  }
  return null;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const windows = new Map<string, any>();

/**
 * Show the sheet for one creature. Reuses the window already open for it, because the buttons mutate
 * a shared cache and two views of it would disagree the moment one of them was clicked.
 */
export function openCapabilitySheet(actor?: any): void {
  const subject =
    actor ??
    (canvas as any)?.tokens?.controlled?.[0]?.actor ??
    (game as any)?.user?.character ??
    null;
  if (!subject) {
    ui.notifications?.warn?.(
      localize(
        "NOODLRHOOKS.Capabilities.Sheet.NoActor",
        "Select a token, or open this from a character sheet.",
      ),
    );
    return;
  }
  const uuid = String(subject.uuid ?? subject.id ?? "");
  const existing = windows.get(uuid);
  if (existing?.rendered) {
    existing.bringToFront?.();
    void existing.render();
    return;
  }
  try {
    const app = new (sheetClass())({
      actor: subject,
      id: `noodlr-capabilities-${uuid.replace(/\W/g, "-")}`,
    });
    windows.set(uuid, app);
    void app.render(true);
  } catch (err) {
    warn("could not open the capability sheet:", err);
  }
}

let registered = false;

/**
 * A button on every creature's own sheet, which is where a GM is standing when they wonder what the
 * module made of a trait.
 *
 * `getHeaderControlsApplicationV2` rather than a sheet-specific hook: ApplicationV2 fires the header
 * hook once per class in the inheritance chain, so listening at the base catches every AppV2 sheet in
 * the system regardless of what dnd5e names its own. The legacy hook is registered too, because a
 * world may still be running an older sheet.
 */
export function registerCapabilitySheet(): void {
  if (registered) return;
  registered = true;

  Hooks.on("getHeaderControlsApplicationV2", (app: any, controls: any[]) => {
    if (!game.user?.isGM || !Array.isArray(controls)) return;
    const document = app?.document;
    if (document?.documentName !== "Actor") return;
    controls.push({
      icon: "fa-solid fa-scroll",
      label: "NOODLRHOOKS.Capabilities.Sheet.Open",
      action: `${MODULE_ID}-capabilities`,
      // AppV2 header controls dispatch through the host application's own action table, which knows
      // nothing about ours, so the work is done in the entry's own callback.
      onClick: () => openCapabilitySheet(document),
    });
  });

  Hooks.on("getActorSheetHeaderButtons", (app: any, buttons: any[]) => {
    if (!game.user?.isGM || !Array.isArray(buttons)) return;
    buttons.unshift({
      class: `${MODULE_ID}-capabilities`,
      icon: "fa-solid fa-scroll",
      label: localize("NOODLRHOOKS.Capabilities.Sheet.Open", "Capabilities"),
      onclick: () => openCapabilitySheet(app?.document ?? app?.actor),
    });
  });

  log("capability sheet registered");
}
