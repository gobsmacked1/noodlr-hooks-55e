// Clicks on an on-screen effect strip, which is not the token.
//
// Visual Active Effects draws its own vertical strip of effect icons in the top-right DOM overlay,
// outside the PIXI canvas — so `token-badge.ts` (which hit-tests inside Token#_onClickLeft) can
// never see a click there. A player looking at that strip is looking at the affordance they expect
// to press, and nothing was listening. "Top right corner" means the strip, not the sprite.
//
// Two routes are wired per registered status, because the tooltip route alone is poor UX (VAE's
// tooltips are `pointer-events: none` until the reader middle-clicks to lock them):
//   1. A labelled button in the effect's tooltip, via VAE's own `createEffectButtons` hook.
//   2. A primary-button click on the icon itself.
//
// Route 2 is free to take. VAE registers `deleteEffect` with `buttons: [2]`, and ApplicationV2's
// action dispatch only calls a handler when `buttons.includes(event.button)`, so a left-click
// reaches no VAE action. Its toggle is a `dblclick`, and its own document listener matches
// `[data-action=customButton].vae-button` rather than the icon. Nothing to collide with.
//
// THE ANCESTOR IS DELIBERATELY NOT CHECKED. Requiring `#visual-active-effects` around the icon
// would be a guess about one module's markup, and a wrong guess leaves the press dead with nothing
// saying why — the failure this file exists to fix. An `.effect-item` carrying a status only this
// module writes is ours wherever it is drawn, so a VAE fork or successor is answered for free.

import { debug, warn } from "../constants";
import { moduleActive } from "./modules";

const VAE_ID = "visual-active-effects";
const BUTTONS_HOOK = `${VAE_ID}.createEffectButtons`;
/** Every strip of this shape is VAE's markup; the status is what makes a row ours. */
const ITEM_SELECTOR = ".effect-item[data-effect-uuid]";

/** Reported by the surveys, so "the corner icon does nothing" starts from a fact. */
export function vaeActive(): boolean {
  return moduleActive(VAE_ID);
}

/** The subject is resolved by the caller from the effect's own parent — we know no game rules. */
type VaePanelHandler = (actor: any, effect: any) => void;

interface Binding {
  /** Status id carried by the badge, e.g. `noodlr-transformed`. */
  status: string;
  /** i18n key for the tooltip button. */
  label: string;
  handle: VaePanelHandler;
}

const bindings: Binding[] = [];
let wired = false;

/** A double-click is click, click, dblclick — so the first press must not fire twice. */
const RECENT_MS = 400;
const recent = new Map<string, number>();

function statusesOf(effect: any): string[] {
  const raw = effect?.statuses ?? effect?._source?.statuses ?? [];
  try {
    return [...raw].map((s: unknown) => String(s));
  } catch {
    return [];
  }
}

function bindingFor(effect: any): Binding | null {
  const statuses = statusesOf(effect);
  if (statuses.length === 0) return null;
  return bindings.find((b) => statuses.includes(b.status)) ?? null;
}

function actorOf(effect: any): any {
  const parent = effect?.parent ?? null;
  // An effect parented to an item still belongs to that item's actor.
  return parent?.documentName === "Actor" ? parent : (parent?.actor ?? parent ?? null);
}

function fire(binding: Binding, effect: any): void {
  const actor = actorOf(effect);
  if (!actor) {
    warn("vae panel: no actor behind", String(effect?.name ?? effect?.uuid ?? "?"));
    return;
  }
  debug("vae panel:", binding.status, "on", String(actor.name ?? actor.id ?? "?"));
  try {
    binding.handle(actor, effect);
  } catch (err) {
    warn("vae panel: handler failed:", err);
  }
}

function localize(key: string): string {
  try {
    return String(game.i18n?.localize?.(key) ?? key);
  } catch {
    return key;
  }
}

function onPanelClick(event: MouseEvent): void {
  if (bindings.length === 0) return;
  if (event.button !== 0) return;
  const target = event.target as HTMLElement | null;
  if (!target?.closest) return;
  const item = target.closest(ITEM_SELECTOR) as HTMLElement | null;
  if (!item) return;
  const uuid = item.dataset?.effectUuid ?? "";
  if (!uuid) return;

  let effect: any = null;
  try {
    effect = (globalThis as any).fromUuidSync?.(uuid) ?? null;
  } catch {
    return;
  }
  const binding = effect ? bindingFor(effect) : null;
  if (!binding) return;

  const now = Date.now();
  const last = recent.get(uuid) ?? 0;
  recent.set(uuid, now);
  if (now - last < RECENT_MS) {
    event.preventDefault();
    event.stopPropagation();
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  fire(binding, effect);
}

function wire(): void {
  if (wired) return;
  wired = true;

  Hooks.on(BUTTONS_HOOK, (effect: any, buttons: any[]) => {
    const binding = bindingFor(effect);
    if (!binding || !Array.isArray(buttons)) return;
    buttons.push({
      label: localize(binding.label),
      callback: () => fire(binding, effect),
    });
  });

  // Capture phase, so the press is answered before anything else in the panel sees it.
  document.addEventListener("click", onPanelClick, true);
}

/**
 * Make a badge carrying `status` answer a click in the Visual Active Effects panel.
 * Harmless when VAE is absent: the hook never fires and the selector never matches.
 */
export function registerVaePanelAction(
  status: string,
  label: string,
  handle: VaePanelHandler,
): void {
  if (!status || bindings.some((b) => b.status === status)) return;
  bindings.push({ status, label, handle });
  wire();
}

function describeContainer(el: HTMLElement): string {
  for (let node: HTMLElement | null = el; node; node = node.parentElement) {
    if (node.id) return `#${node.id}`;
    const tag = String(node.tagName ?? "").toLowerCase();
    if (tag === "body" || tag === "html") break;
  }
  const cls = String(el.className ?? "").trim().split(/\s+/).slice(0, 3).join(".");
  return cls ? `.${cls}` : "(unidentified)";
}

/**
 * Which on-screen elements are currently drawing an effect row, and which of them we answer.
 *
 * Exists because "the icon in the corner does nothing" is not answerable from source: several
 * modules draw an effect strip in a DOM overlay, and only the one the reader is looking at
 * matters. AN UNRECOGNISED STRIP IS REPORTED RATHER THAN SKIPPED — reporting only the rows we
 * already handle can say nothing but "all wired", which is exactly the reassuring answer that
 * closes the question on a strip nobody has looked at. Grouped by container so a busy scene is a
 * few lines rather than one per condition.
 */
export function describeEffectPanels(): string[] {
  if (bindings.length === 0) return ["  nothing has registered a strip click"];
  let nodes: HTMLElement[] = [];
  try {
    nodes = [...document.querySelectorAll<HTMLElement>("[data-effect-uuid], [data-effect-id]")];
  } catch {
    return ["  the document could not be read"];
  }

  // container -> { rows, ours, wired }
  const groups = new Map<string, { rows: number; ours: string[]; wired: number }>();
  for (const node of nodes) {
    const where = describeContainer(node);
    const group = groups.get(where) ?? { rows: 0, ours: [], wired: 0 };
    groups.set(where, group);
    group.rows += 1;

    const uuid = node.dataset?.effectUuid ?? "";
    let effect: any = null;
    if (uuid) {
      try {
        effect = (globalThis as any).fromUuidSync?.(uuid) ?? null;
      } catch {
        effect = null;
      }
    }
    const binding = effect ? bindingFor(effect) : null;
    if (!binding) continue;
    group.ours.push(binding.status);
    // A row we can identify is a row we answer: the listener matches the same selector.
    if (node.closest(ITEM_SELECTOR)) group.wired += 1;
  }

  if (groups.size === 0) return ["  no effect strip is on screen right now"];

  const out: string[] = [];
  for (const [where, g] of groups) {
    if (g.ours.length === 0) {
      out.push(`  ${where}: ${g.rows} row(s), none of ours`);
      continue;
    }
    const dead = g.ours.length - g.wired;
    out.push(
      `  ${where}: ${g.rows} row(s), ours = ${g.ours.join(", ")}` +
        (dead > 0 ? ` — ${dead} NOT WIRED (unrecognised markup)` : " — click wired"),
    );
  }
  return out;
}
