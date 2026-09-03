// One-line chat totals, painted after dnd5e has finished decorating the card.
//
// dnd5e draws a formula, a collapsible tooltip, and then colours the total green or red for
// hit / miss / success / failure. The table asked for the opposite: the face, the modifier,
// a parenthetical verdict, and colour only on a natural 20 (green) or a natural 1 (red).
// 2024 saves and checks do not auto-succeed or auto-fail on 20 / 1.
//
// Listen on `dnd5e.renderChatMessage`, not core's `renderChatMessageHTML`. That core hook
// fires inside `super.renderHTML()`, before dnd5e's five passes — decorating there is
// wiped. The dnd5e hook is the one after those passes (chat-message.mjs:142).
//
// Blind rolls are not overridden. If the viewer cannot see the content, we leave the
// system's hidden card alone. Challenge / attack-result visibility still hides the
// verdict from players the way dnd5e already does; the GM always sees it.
//
// Compact cards (`body.noodlr-compact-cards`) stay a padding preference. This rewrite
// is always on.

import { isDnd5e } from "../system/dnd5e-rewards";
import { grazeDamage } from "../system/dnd5e-graze";
import {
  activityOf,
  attackHitForDamage,
  attackMessageOf,
  combinedDamageTotal,
  itemOf,
  masteryOf,
  readCheck,
  readHits,
  readSave,
  rollType,
  speakerToken,
  targetsOf,
  tokenFromActorUuid,
} from "./cards";
import {
  attackKind,
  attackMasterySuffixes,
  contestKind,
  damageMasterySuffixes,
  damagePartsFromRolls,
  faceColor,
  formatAttackLine,
  formatContestLine,
  formatDamageLine,
  readD20Breakdown,
  readDamageModifiers,
  traitMultiplier,
  type CardLabels,
} from "./card-line";

const DND5E_RESULT_CLASSES = ["success", "failure", "critical", "fumble"];

export function registerStreamlineCards(): void {
  Hooks.on("dnd5e.renderChatMessage", decorate);
}

function decorate(message: any, incoming: any): void {
  try {
    if (!isDnd5e()) return;
    const html = rootOf(incoming);
    if (!html || !message?.isRoll) return;
    if (!canSeeContent(message)) return;
    const type = rollType(message);
    if (type === "attack") paintAttack(message, html);
    else if (type === "save" || type === "death" || type === "concentration") paintContest(message, html, readSave(message).success);
    else if (type === "skill" || type === "ability") paintContest(message, html, readCheck(message).success);
    else if (type === "damage" || type === "healing") paintDamage(message, html);
  } catch (err) {
    console.warn("noodlr-hooks-55e: could not streamline a chat card:", err);
  }
}

function canSeeContent(message: any): boolean {
  if (game.user?.isGM) return true;
  return message?.isContentVisible !== false;
}

function canSeeAttackResult(): boolean {
  if (game.user?.isGM) return true;
  try {
    return game.settings.get("dnd5e", "attackRollVisibility") !== "none";
  } catch {
    return true;
  }
}

function canSeeChallenge(message: any): boolean {
  if (game.user?.isGM) return true;
  try {
    const origin = message?.getOriginatingMessage?.() ?? message;
    if (typeof origin?.shouldDisplayChallenge === "boolean") return origin.shouldDisplayChallenge;
  } catch {
    /* fall through */
  }
  return true;
}

function labels(): CardLabels {
  const i18n = (game as any)?.i18n;
  const loc = (key: string, fallback: string) =>
    (i18n?.localize?.(key) && i18n.localize(key) !== key ? i18n.localize(key) : fallback);
  return {
    fumble: loc("NOODLRHOOKS.Cards.Fumble", "Fumble!"),
    crit: loc("NOODLRHOOKS.Cards.Crit", "Critical Hit!"),
    hit: loc("NOODLRHOOKS.Cards.Hit", "Hit"),
    miss: loc("NOODLRHOOKS.Cards.Miss", "Miss"),
    success: loc("NOODLRHOOKS.Cards.Success", "Success"),
    failure: loc("NOODLRHOOKS.Cards.Failure", "Failure"),
  };
}

function masteryLabel(key: string): string {
  try {
    const cfg = (globalThis as any).CONFIG?.DND5E?.weaponMasteries?.[key];
    const raw = cfg?.label;
    if (raw) {
      const loc = (game as any)?.i18n?.localize?.(raw);
      if (loc && loc !== raw) return loc;
      if (typeof raw === "string" && !raw.startsWith("DND5E.")) return raw;
    }
  } catch {
    /* fall through */
  }
  return key.charAt(0).toUpperCase() + key.slice(1);
}

function typeLabel(type: string): string {
  if (!type) return "";
  try {
    const table = (globalThis as any).CONFIG?.DND5E;
    const entry = table?.damageTypes?.[type] ?? table?.healingTypes?.[type];
    const raw = entry?.label ?? entry?.name;
    if (raw) {
      const loc = (game as any)?.i18n?.localize?.(raw);
      if (loc && loc !== raw) return loc;
      if (typeof raw === "string" && !raw.startsWith("DND5E.")) return raw;
    }
  } catch {
    /* fall through */
  }
  return type.charAt(0).toUpperCase() + type.slice(1);
}

function paintAttack(message: any, html: HTMLElement): void {
  const roll = message.rolls?.[0];
  const { face, modifiers } = readD20Breakdown(roll);
  const showResult = canSeeAttackResult();
  const reading = readHits(message);
  const connected =
    reading.hits.length > 0 ? true : reading.missed.length > 0 ? false : null;
  const kind = showResult ? attackKind(face, connected) : "plain";
  const item = itemOf(message);
  const mastery = masteryOf(message, item, speakerToken(message?.speaker)?.actor).toLowerCase();
  const suffixes: string[] = [];
  if (showResult) {
    let grazeAmount: number | null = null;
    if ((kind === "miss" || kind === "fumble") && mastery === "graze") {
      const graze = grazeDamage(message, item, activityOf(message, item));
      grazeAmount = graze?.amount ?? null;
    }
    suffixes.push(
      ...attackMasterySuffixes(mastery, kind, grazeAmount, masteryLabel("graze")).map((s) =>
        localizeMasterySuffix(s, mastery),
      ),
    );
  } else if (mastery === "nick") {
    suffixes.push(`(${masteryLabel("nick")})`);
  }
  const line = formatAttackLine({ face, modifiers, kind, labels: labels(), suffixes });
  paintD20Total(html, face, line);
  hideMath(html);
  if (suffixes.length) hideMasterySupplement(html);
}

function localizeMasterySuffix(suffix: string, key: string): string {
  const pretty = masteryLabel(key);
  const fallback = key.charAt(0).toUpperCase() + key.slice(1);
  if (!pretty || pretty === fallback) return suffix;
  return suffix.replaceAll(`(${fallback})`, `(${pretty})`);
}

function paintContest(message: any, html: HTMLElement, success: boolean | null): void {
  const roll = message.rolls?.[0];
  const { face, modifiers } = readD20Breakdown(roll);
  const kind = canSeeChallenge(message) ? contestKind(success) : "plain";
  paintD20Total(html, face, formatContestLine({ face, modifiers, kind, labels: labels() }));
  hideMath(html);
}

function paintDamage(message: any, html: HTMLElement): void {
  const parts = damageLinesOf(message);
  if (!parts.length) return;
  const attack = attackMessageOf(message);
  const item = itemOf(attack ?? message);
  const source = attack ?? message;
  const mastery = masteryOf(source, item, speakerToken(source?.speaker)?.actor).toLowerCase();
  const hit = attackHitForDamage(message) === true;
  const dealt = combinedDamageTotal(message);
  const suffixes = damageMasterySuffixes(mastery, hit, Number.isFinite(dealt) ? dealt : 0).map((s) =>
    localizeMasterySuffix(s, mastery),
  );
  const line = formatDamageLine(parts, suffixes);
  paintPlainTotal(html, line);
  hideMath(html, { keepFirstTotal: true });
  if (suffixes.length) hideMasterySupplement(html);
}

function damageLinesOf(message: any): ReturnType<typeof damagePartsFromRolls> {
  const healingTypes = (globalThis as any).CONFIG?.DND5E?.healingTypes ?? {};
  const actors = hitActorsOf(message);
  const rolls: Array<{ total: number; modifiers: number; type: string }> = [];
  for (const [i, roll] of (message.rolls ?? []).entries()) {
    const total = Number(roll?.total);
    if (!Number.isFinite(total)) continue;
    const type = String(roll?.options?.type ?? "");
    rolls.push({ total, modifiers: i === 0 ? readDamageModifiers(roll) : 0, type });
  }
  const firstHealing = rolls[0] && (rolls[0].type in healingTypes || rolls[0].total < 0);
  const traits = firstHealing ? null : sharedTraits(actors);
  return damagePartsFromRolls(rolls, traits, typeLabel);
}

function sharedTraits(
  actors: any[],
): { immune?: Iterable<string>; resist?: Iterable<string>; vuln?: Iterable<string> } | null {
  if (!actors.length) return null;
  const first = traitsOf(actors[0]);
  for (const actor of actors.slice(1)) {
    const next = traitsOf(actor);
    const types = new Set<string>([
      ...iterTypes(first.immune),
      ...iterTypes(first.resist),
      ...iterTypes(first.vuln),
      ...iterTypes(next.immune),
      ...iterTypes(next.resist),
      ...iterTypes(next.vuln),
    ]);
    for (const type of types) {
      if (traitMultiplier(first, type) !== traitMultiplier(next, type)) return null;
    }
  }
  return first;
}

function iterTypes(list: Iterable<string> | undefined): string[] {
  return list ? [...list] : [];
}

function hitActorsOf(message: any): any[] {
  const attack = attackMessageOf(message) ?? (rollType(message) === "attack" ? message : null);
  if (attack) {
    const hits = readHits(attack).hits;
    const actors = hits.map((doc: any) => doc?.actor).filter(Boolean);
    if (actors.length) return uniqueActors(actors);
  }
  const fromFlags = targetsOf(message)
    .map((t) => tokenFromActorUuid(t.uuid)?.actor)
    .filter(Boolean);
  return uniqueActors(fromFlags);
}

function uniqueActors(actors: any[]): any[] {
  const seen = new Set<string>();
  const out: any[] = [];
  for (const actor of actors) {
    const id = String(actor?.uuid ?? actor?.id ?? "");
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    out.push(actor);
  }
  return out;
}

function traitsOf(actor: any): { immune?: Iterable<string>; resist?: Iterable<string>; vuln?: Iterable<string> } {
  const traits = actor?.system?.traits;
  return {
    immune: traits?.di?.value,
    resist: traits?.dr?.value,
    vuln: traits?.dv?.value,
  };
}

function rootOf(html: any): HTMLElement | null {
  if (!html) return null;
  if (typeof html.querySelectorAll === "function") return html;
  const first = html[0];
  return first && typeof first.querySelectorAll === "function" ? first : null;
}

function prepareTotal(html: HTMLElement): HTMLElement | null {
  const first = html.querySelector<HTMLElement>(".dice-total");
  if (!first) return null;
  first.replaceChildren();
  first.classList.remove(...DND5E_RESULT_CLASSES);
  first.classList.add("noodlr-card-total");
  html.classList.add("noodlr-streamlined");
  return first;
}

function paintD20Total(html: HTMLElement, face: number | null, line: string): void {
  const first = prepareTotal(html);
  if (!first) return;
  const faceStr = face === null ? "?" : String(face);
  const rest = line.startsWith(faceStr) ? line.slice(faceStr.length) : `\u00a0${line}`;
  const faceEl = document.createElement("span");
  const color = faceColor(face);
  faceEl.className =
    "noodlr-card-face" +
    (color === "nat20" ? " noodlr-nat-20" : color === "nat1" ? " noodlr-nat-1" : "");
  faceEl.textContent = faceStr;
  first.append(faceEl);
  if (rest) {
    const restEl = document.createElement("span");
    restEl.className = "noodlr-card-rest";
    restEl.textContent = rest;
    first.append(restEl);
  }
}

function paintPlainTotal(html: HTMLElement, line: string): void {
  const first = prepareTotal(html);
  if (!first) return;
  const restEl = document.createElement("span");
  restEl.className = "noodlr-card-rest";
  restEl.textContent = line;
  first.append(restEl);
}

function hideMath(html: HTMLElement, opts: { keepFirstTotal?: boolean } = {}): void {
  for (const el of html.querySelectorAll<HTMLElement>(".dice-formula, .dice-tooltip")) {
    el.hidden = true;
  }
  for (const el of html.querySelectorAll<HTMLElement>(".dice-total .icons")) {
    el.remove();
  }
  if (opts.keepFirstTotal) {
    const totals = html.querySelectorAll<HTMLElement>(".dice-total");
    for (let i = 1; i < totals.length; i++) totals[i].hidden = true;
  }
}

function hideMasterySupplement(html: HTMLElement): void {
  for (const el of html.querySelectorAll<HTMLElement>("p.supplement")) {
    el.hidden = true;
  }
}
