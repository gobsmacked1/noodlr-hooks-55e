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
// THE CONTEST is passive Perception against the hider's Stealth total, and it is deliberately
// deterministic — no per-sweep roll. A poll that re-rolls every six seconds would eventually spot
// anyone by luck alone, which is a worse rule than either edition's. Ties go to the spotter, because
// the 2024 rules make the Stealth total the DC for a Perception check and a check meets its DC on equal.

import { log, MODULE_ID } from "../../constants";
import { isPrimaryGM } from "../../util/gm";

/** Senses that find a creature it would otherwise be too dark, or too invisible, to see. */
const PIERCING = ["truesight", "blindsight", "tremorsense"];

/** Vision 5e detection modes that see through concealment, if the GM has that module. */
const PIERCING_MODES = ["seeAll", "seeInvisibility", "blindsight", "feelTremor", "etherealSight"];

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

/** The ranges of the senses that see through concealment, keyed by sense. */
function piercingRanges(spotter: any): Record<string, number> {
  const out: Record<string, number> = {};

  // Vision 5e computes this for every actor whether or not the token has sight switched on, which makes
  // it strictly better than reading the sheet ourselves. Absent, we read the sheet.
  const derived: any = spotter?.actor?.detectionModes;
  if (derived && typeof derived === "object" && !Array.isArray(derived)) {
    for (const mode of PIERCING_MODES) {
      const range = Number(derived[mode]);
      if (Number.isFinite(range) && range !== 0) out[mode] = range < 0 ? Infinity : range;
    }
    if (Object.keys(out).length > 0) return out;
  }

  const senses: any = spotter?.actor?.system?.attributes?.senses ?? {};
  const ranges: any = senses?.ranges ?? senses;
  for (const sense of PIERCING) {
    const range = Number(ranges?.[sense]);
    if (Number.isFinite(range) && range > 0) out[sense] = range;
  }
  return out;
}

/**
 * Concealment that has nothing to do with dice: invisibility and the Ethereal Plane.
 *
 * Only consulted on the fallback path in `perception.ts` — the one taken by a creature with no detection
 * modes configured, which is most of the bestiary. When real detection modes run, core already enforces
 * all of this and doing it twice would be both redundant and a way to disagree with the screen.
 */
export function concealed(spotter: any, target: any, distance: number): string | null {
  const doc = target?.document ?? target;
  const special: any = (globalThis as any).CONFIG?.specialStatusEffects ?? {};
  const piercing = piercingRanges(spotter);
  const reaches = Object.values(piercing).some((range) => distance <= range);

  if (hasStatus(doc, String(special.INVISIBLE ?? "invisible")) && !reaches) return "invisible";
  // Vision 5e's status, and harmless to check without it: nothing else sets `ethereal`.
  if (hasStatus(doc, "ethereal") && !piercing.etherealSight && !piercing.seeAll)
    return "on the Ethereal Plane";
  return null;
}

/**
 * Does `target` evade `spotter` this sweep? Returns why, or null when the creature is plainly seen.
 *
 * `distance` is only used for concealment; the Stealth contest itself is rangeless, because 5e gives no
 * distance penalty to Perception and inventing one would be house-ruling in code.
 */
export function evades(
  spotter: any,
  target: any,
  distance: number,
  useModes: boolean,
): string | null {
  if (!useModes) {
    const hidden = concealed(spotter, target, distance);
    if (hidden) return hidden;
  }

  const hiding = hidingState(target);
  if (!hiding) return null;

  const perception = passivePerception(spotter);
  if (perception >= hiding.dc) return null;

  const dc = Number.isFinite(hiding.dc) ? hiding.dc : "unreachable";
  return `hidden — ${hiding.from} says DC ${dc} against passive Perception ${perception}`;
}

/** A human-readable line about what a token is doing to stay unseen, for diagnostics. */
export function describeStealth(token: any): string {
  const hiding = hidingState(token);
  if (!hiding) return "not hiding";
  return `hiding at DC ${hiding.dc} (${hiding.from})`;
}
