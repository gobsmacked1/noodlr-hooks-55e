// Whether a creature that is trying not to be seen actually gets away with it.
//
// Foundry's vision pipeline answers "is there an unobstructed line to a lit token", which is a question
// about geometry. 5e's question is "did you beat their Perception", which is a question about dice, and
// nothing in core or dnd5e connects the two: the system ships a `hiding` status effect that is wired to
// absolutely nothing, and a Stealth roll's total is never persisted anywhere — it exists as a chat
// message and then it is gone. So a rogue who rolled 27 was spotted by a guard with passive Perception
// 10 the instant a wall stopped being in the way, which makes rogue-shaped play impossible against a
// module that starts fights automatically (user, 2026-08-04). This file is the missing half.
//
// WHERE THIS PLUGS IN, and why it is not a patch. Stealthy wraps every detection mode's `_canDetect`
// through libWrapper so that stealth affects what everyone's screen renders. We do not need to: our
// perception sweep builds its own throwaway vision source and calls `testVisibility` itself, so we own
// the call site and can simply refuse the result. That means no libWrapper, no ordering war with
// Stealthy or Vision 5e over the same prototype, and no risk of our automation query changing what the
// GM actually sees. It also means our answer is deliberately narrower than theirs: we decide whether a
// fight starts, not whether a token is drawn.
//
// WHAT COUNTS AS HIDING. Only a creature in a deliberate hidden state is ever contested — an ordinary
// walking player is spotted exactly as before. That state comes from the first of these that answers:
// Stealthy's banked roll, Perceptive's stored DC, our own banked roll, or dnd5e's `hiding` status
// effect (which we honour with passive Stealth, so toggling the icon in the token HUD is enough).
// Deferring to the other two modules when they are installed is the whole of our integration with them:
// no dependency, no patching, and the GM's own visible source of truth wins over ours.
//
// BEYOND MUNDANE HIDING. A rogue's Stealth roll is only the common case. Invisibility, Fog Cloud,
// Nondetection, Pass Without Trace and the rest are recognised by name from a table in
// `systems/dnd5e-concealment.ts`, and so are the things that see through them — truesight, See
// Invisibility, a wolf's keen senses. This file never learns a spell name: the table speaks a small
// abstract vocabulary of capabilities (`truesight`, `seeInvisible`, `blindsight`, `tremorsense`,
// `devilsSight`, `etherealSight`, `detectMagic`, `divination`, `hearing`) and the engine only matches
// tags against tags. Another game system is a sibling table, not a change here. See that file's header.
//
// THE CONTEST is passive Perception against the hider's Stealth total, and it is deliberately
// deterministic — no per-sweep roll. A poll that re-rolls every six seconds would eventually spot
// anyone by luck alone, which is a worse rule than either edition's. Ties go to the spotter, because
// the 2024 rules make the Stealth total the DC for a Perception check and a check meets its DC on equal.

import { log, MODULE_ID } from "../../constants";
import { isPrimaryGM } from "../../util/gm";
import {
  concealmentsOn,
  detectorsOn,
  sheetSenses,
  type Concealment,
} from "../systems/dnd5e-concealment";

/** What we store when we bank a Stealth roll ourselves. */
interface Banked {
  dc: number;
  ts: number;
}

/** A creature's hidden state, whoever is keeping track of it. */
export interface Hiding {
  dc: number;
  from: string;
}

/**
 * Watch the chat log for the rolls that start and end a hidden state.
 *
 * Reading chat rather than dnd5e's `rollSkillV2` hook is a deliberate trade. The hook fires only on the
 * client that made the roll, so every client would have to write the flag and only some would have
 * permission; `createChatMessage` fires everywhere, which lets the primary GM be the single writer.
 * One writer, no races, no permission failures, and NPC rolls are captured on the same path.
 */
export function registerStealthWatch(): void {
  Hooks.on("createChatMessage", (message: any) => {
    if (!isPrimaryGM()) return;
    const roll: any = message?.flags?.dnd5e?.roll;
    const type = String(roll?.type ?? "");

    if (type === "skill" && String(roll?.skillId ?? "") === "ste") {
      const total = Number(message?.rolls?.[0]?.total);
      if (Number.isFinite(total)) void bank(message?.speaker, total);
      return;
    }

    // The 2024 rules end hiding on an attack roll or a spell with a verbal component, and both editions
    // agree that swinging at someone gives you away. Damage is not checked separately: it follows an
    // attack that has already cleared the state.
    if (type === "attack" || spokenSpell(message)) void clear(message?.speaker);
  });

  Hooks.on("deleteCombat", () => {
    // A fight is loud. Whatever anyone was hiding behind, it is over now, and a stale flag that quietly
    // suppresses the next encounter forever is the failure mode this feature is most likely to have.
    void clearScene();
  });
}

/** Does this message look like casting something with a verbal component? */
function spokenSpell(message: any): boolean {
  try {
    const uuid = String(
      message?.flags?.dnd5e?.item?.uuid ?? message?.flags?.dnd5e?.use?.itemUuid ?? "",
    );
    if (!uuid) return false;
    const item: any = (globalThis as any).fromUuidSync?.(uuid);
    if (item?.type !== "spell") return false;
    const props: any = item?.system?.properties;
    return Boolean(props?.has?.("vocal") ?? props?.includes?.("vocal"));
  } catch {
    return false;
  }
}

/** Every token on the current scene the given chat speaker refers to. */
function spoken(speaker: any): any[] {
  const tokens: any[] = (canvas as any)?.tokens?.placeables ?? [];
  const tokenId = String(speaker?.token ?? "");
  if (tokenId) {
    const one = tokens.find((t) => String(t?.id) === tokenId);
    if (one) return [one];
  }
  // A linked character rolling from its sheet names only the actor. Unlinked tokens all share one actor
  // id, so this fallback is only safe once the token id has failed to match.
  const actorId = String(speaker?.actor ?? "");
  if (!actorId) return [];
  return tokens.filter((t) => String(t?.actor?.id ?? "") === actorId && t?.document?.actorLink);
}

async function bank(speaker: any, dc: number): Promise<void> {
  for (const token of spoken(speaker)) {
    try {
      await token.document.setFlag(MODULE_ID, "stealth", { dc, ts: Date.now() } satisfies Banked);
      log(`stealth: ${token.name} is hiding at DC ${dc}`);
    } catch (err) {
      log(`could not record ${token?.name}'s stealth:`, err);
    }
  }
}

async function clear(speaker: any): Promise<void> {
  for (const token of spoken(speaker)) {
    if (!token.document.getFlag(MODULE_ID, "stealth")) continue;
    try {
      await token.document.unsetFlag(MODULE_ID, "stealth");
      log(`stealth: ${token.name} gave itself away`);
    } catch (err) {
      log(`could not clear ${token?.name}'s stealth:`, err);
    }
  }
}

async function clearScene(): Promise<void> {
  for (const token of (canvas as any)?.tokens?.placeables ?? []) {
    if (!token?.document?.getFlag?.(MODULE_ID, "stealth")) continue;
    try {
      await token.document.unsetFlag(MODULE_ID, "stealth");
    } catch {
      /* a flag that will not clear is not worth failing on */
    }
  }
}

/**
 * The DC to notice this creature, and who says so — or null when it is not hiding at all.
 *
 * Order matters: a module the GM installed and can see in their own UI outranks our invisible flag,
 * because when the two disagree the GM should be able to trust what is on their screen.
 */
export function hidingState(token: any): Hiding | null {
  const doc = token?.document ?? token;

  // Stealthy. `getBankedStealth` returns undefined when the creature is not hiding, which is exactly
  // the signal we want, and its author documented it as the integration surface.
  try {
    const stealthy: any = (window as any).stealthy;
    if (
      game.modules?.get?.("stealthy")?.active &&
      typeof stealthy?.getBankedStealth === "function"
    ) {
      const dc = Number(stealthy.getBankedStealth(token));
      if (Number.isFinite(dc)) return { dc, from: "Stealthy" };
    }
  } catch {
    /* their internals are not our contract; a throw means "no opinion" */
  }

  // Perceptive stores a passive DC per token, with -1 meaning "cannot be found".
  try {
    if (game.modules?.get?.("perceptive")?.active) {
      const raw = Number(doc?.getFlag?.("perceptive", "PPDCFlag"));
      if (Number.isFinite(raw) && raw !== 0) {
        return { dc: raw < 0 ? Number.POSITIVE_INFINITY : raw, from: "Perceptive" };
      }
    }
  } catch {
    /* same */
  }

  const own = doc?.getFlag?.(MODULE_ID, "stealth") as Banked | undefined;
  if (Number.isFinite(Number(own?.dc))) return { dc: Number(own?.dc), from: "a Stealth roll" };

  // The dnd5e `hiding` status effect on its own. The system wires it to nothing, so a GM or player who
  // ticked it in the token HUD has stated an intention that nothing else in Foundry acts on; honouring
  // it with passive Stealth turns that icon into a working declaration of "I am sneaking".
  if (hasStatus(doc, "hiding")) {
    const passive = Number(token?.actor?.system?.skills?.ste?.passive);
    const base = Number((globalThis as any).CONFIG?.DND5E?.skillPassive?.base ?? 10);
    return { dc: Number.isFinite(passive) ? passive : base, from: "the Hiding condition" };
  }

  return null;
}

/** Passive Perception, or the score of a creature with average Wisdom and no training. */
export function passivePerception(token: any): number {
  const passive = Number(token?.actor?.system?.skills?.prc?.passive);
  if (Number.isFinite(passive)) return passive;
  return Number((globalThis as any).CONFIG?.DND5E?.skillPassive?.base ?? 10);
}

function hasStatus(doc: any, id: string): boolean {
  try {
    return Boolean(doc?.hasStatusEffect?.(id));
  } catch {
    return false;
  }
}

/**
 * Everything this creature can bring to bear on someone trying not to be seen, at this distance.
 *
 * Senses are range-limited, because blindsight 30 is not blindsight. Capabilities that come from a spell
 * or a feature by name are not: their real ranges vary, and guessing wrongly in either direction is worse
 * than taking "I cast See Invisibility" to mean what it says.
 */
function capabilities(spotter: any, distance: number): { tags: Set<string>; bonus: number } {
  const tags = new Set<string>();
  for (const [tag, range] of Object.entries(sheetSenses(spotter?.actor))) {
    if (distance <= range) tags.add(tag);
  }
  const named = detectorsOn(spotter?.actor);
  for (const tag of named.tags) tags.add(tag);
  return { tags, bonus: named.bonus };
}

/** Concealment that carries no name we would match: the plain status effects. */
function statusVeils(target: any): Concealment[] {
  const doc = target?.document ?? target;
  const special: any = (globalThis as any).CONFIG?.specialStatusEffects ?? {};
  const found: Concealment[] = [];

  // Folded in here so a token made invisible by any route — a spell, a module, the GM ticking the icon —
  // reaches the same code as one carrying an effect named "Greater Invisibility".
  if (hasStatus(doc, String(special.INVISIBLE ?? "invisible"))) {
    found.push({
      label: "invisible",
      pierced: ["truesight", "seeInvisible", "blindsight", "tremorsense"],
      bonus: 0,
      absolute: true,
      negates: [],
    });
  }
  if (hasStatus(doc, "ethereal")) {
    found.push({
      label: "on the Ethereal Plane",
      pierced: ["truesight", "etherealSight"],
      bonus: 0,
      absolute: true,
      negates: [],
    });
  }
  return found;
}

/** Every concealment on a creature, from names and from statuses, without duplicates. */
function veils(target: any): Concealment[] {
  const found = concealmentsOn(target?.actor);
  for (const veil of statusVeils(target)) {
    if (!found.some((seen) => seen.label === veil.label)) found.push(veil);
  }
  return found;
}

/**
 * Does `target` evade `spotter` this sweep? Returns why, or null when the creature is plainly seen.
 *
 * Order of resolution, and each step earns its place:
 *   1. Work out what the spotter can do, then let the hider's wards take capabilities away. Nondetection
 *      conceals nobody — it blinds the diviner — so it has to be applied to the watcher, not the hider.
 *   2. Any unpierced absolute concealment hides the creature outright, roll or no roll. An invisible bard
 *      who never touched the Stealth skill is still invisible.
 *   3. Otherwise contest, with every concealment's bonus added to the Stealth DC. This is where Pass
 *      Without Trace earns its +10 and a wolf's keen senses earn their +5 the other way.
 *
 * `useModes` says whether core's own detection modes already ran. When they did, core has enforced plain
 * invisibility itself and we must not judge it twice, or we would disagree with what is on screen.
 * Everything core knows nothing about — which is every entry in the table bar invisibility — still applies.
 *
 * Distance reaches only the senses. The contest itself is rangeless: 5e gives no distance penalty to
 * Perception, and inventing one would be house-ruling in code.
 */
export function evades(
  spotter: any,
  target: any,
  distance: number,
  useModes: boolean,
): string | null {
  const present = veils(target);
  const { tags, bonus } = capabilities(spotter, distance);
  for (const veil of present) {
    for (const lost of veil.negates) tags.delete(lost);
  }

  for (const veil of present) {
    if (!veil.absolute) continue;
    if (useModes && veil.label === "invisible") continue;
    if (veil.pierced.some((tag) => tags.has(tag))) continue;
    return veil.label;
  }

  const hiding = hidingState(target);
  if (!hiding) return null;

  const dc = hiding.dc + present.reduce((sum, veil) => sum + veil.bonus, 0);
  const perception = passivePerception(spotter) + bonus;
  if (perception >= dc) return null;

  const shown = Number.isFinite(dc) ? String(dc) : "unreachable";
  return `hidden — ${hiding.from} says DC ${shown} against passive Perception ${perception}`;
}

/** What a creature is doing to stay unseen, for diagnostics. */
export function describeStealth(token: any): string {
  const parts: string[] = [];
  const hiding = hidingState(token);
  if (hiding) parts.push(`hiding at DC ${hiding.dc} (${hiding.from})`);
  for (const veil of veils(token)) parts.push(veil.label);
  return parts.length > 0 ? parts.join("; ") : "not hiding";
}

/** What a creature brings to spotting people, for diagnostics. */
export function describeSenses(token: any): string {
  const senses = Object.entries(sheetSenses(token?.actor)).map(
    ([tag, range]) => `${tag} ${Number.isFinite(range) ? range : "unlimited"}`,
  );
  const named = detectorsOn(token?.actor);
  const all = [...senses, ...named.labels];
  if (named.bonus) all.push(`+${named.bonus} passive Perception`);
  return all.length > 0 ? all.join(", ") : "nothing special";
}
