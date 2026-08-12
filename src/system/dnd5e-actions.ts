// Which of the 2024 PHB action items a button belongs to. D&D 5e ONLY.
//
// SYSTEM-SPECIFIC BY NECESSITY, quarantined like the rider, declaration and concealment tables.
//
// WHY THIS FILE EXISTS. The 2024 PHB ships all thirteen actions as ordinary feat items, and Argon puts
// them straight on the action bar, so in any world carrying that content every general action has a
// button a player will press. Several of them are also implemented in `rules/`, reachable until now only
// from the console — which meant that which entrance a player used decided whether the rule ran at all.
// Hide was the first found (v0.2.2) and it was not the only one; the census of the user's own world
// (`noodlr-vtt/current_api.surveyActions.json`, 2026-08-07) found twelve of these items across four
// characters, every one of them claiming an Action.
//
// Recognising one is the same two-route problem every time, and it had already been solved twice
// independently in `dnd5e-dash.ts` and `dnd5e-stealth.ts`. A third and fourth copy is how the two
// eventually disagree, so the shape lives here once and those two delegate to it.
//
// THE TWO ROUTES, AND WHY THE ORDER MATTERS. The activity NAME is checked first, because a
// multi-purpose feature keeps its activities named — Cunning Action holds Dash, Disengage and Hide as
// three separately-named activities, and catching the item wholesale would swallow all three when only
// one was pressed. The item IDENTIFIER is the fallback, because the single-purpose PHB item is exactly
// the case midi renames: with its Activity Prefix setting on, an activity left at the default name
// displays as "Midi Use" and the name route finds nothing.
//
// The item's own name is consulted last and ONLY when the sheet states no identifier, so a world that
// deliberately re-identified a feature is never overruled by what it happens to be called.
//
// HOW ARGON'S BASIC-ACTIONS BAR REACHES US, read from `enhancedcombathud-dnd5e/scripts/echDnd5e.js`
// (2026-08-11). Its six buttons — Dodge, Dash, Disengage, Hide, Ready, Shove — are not custom code with
// a rules engine behind them; each is a `DND5eSpecialActionButton` that resolves three ways, in this
// order (`_onLeftClick`, :1146):
//
//   1. Convenient Effects, if installed AND it has an effect of the same NAME: the effect is toggled and
//      the item is never touched. CE ships a "Dodge" and no "Hide", which is why Hide reaches us and
//      Dodge does not — see `rules/dodge.ts`, which reads the status rather than the button.
//   2. The actor's OWN item, matched by localized name (`actor.items.getName`, :1111) — so in a world
//      carrying the 2024 PHB content, the button calls `activity.use()` on the real item and every
//      intercept below fires exactly as it would from the sheet. This is the main route and the one
//      that made the Hide bug visible.
//   3. Failing both, a chat card and nothing else (`createChatMessage`, :1164), plus a direct status
//      toggle for the only two buttons that name one (`flags.statusId`: dodging and hiding).
//
// The consequence worth remembering: a character WITHOUT the PHB item gets route 3, where no activity
// hook fires and no rule of ours can run. Argon's own `consumeActionEconomy` is display state on its
// panel objects and writes nothing to the actor, so that route spends nothing either.

import { hasFlag } from "../util/flags";
import { isDnd5e } from "./dnd5e-rewards";

export interface ActionSpec {
  /**
   * The `system.identifier` the 2024 PHB gives the item.
   *
   * Doubles as the flag suffix: `flags.<ns>.<id>` on an activity forces a match, and
   * `flags.<ns>.<id>Activity` on an item does the same for everything it holds. That is the escape
   * hatch for a homebrew or translated sheet this table cannot read, and it needs no code change.
   */
  id: string;
  /** What a multi-purpose feature calls this branch. */
  name: RegExp;
  /**
   * Only ever match a feature, never a weapon or a spell.
   *
   * Set on the two whose names are ordinary English inside a statblock: an "Attack" activity on a
   * longsword is the swing, not the PHB button that announces it, and a "Magic" one could be anything.
   * Mistaking either for the action item would exempt that weapon from the economy permanently, with
   * nothing reporting it — which is why `dnd5e-declarations.ts` has always carried the same guard.
   */
  featOnly?: boolean;
}

export const ATTACK_ACTION: ActionSpec = {
  id: "attack",
  name: /^\s*attack\s*$/i,
  featOnly: true,
};
export const MAGIC_ACTION: ActionSpec = { id: "magic", name: /^\s*magic\s*$/i, featOnly: true };
export const DASH_ACTION: ActionSpec = { id: "dash", name: /^\s*dash\s*$/i };
export const HIDE_ACTION: ActionSpec = { id: "hide", name: /^\s*hide\s*$/i };
export const DODGE_ACTION: ActionSpec = { id: "dodge", name: /^\s*dodge\s*$/i };
export const DISENGAGE_ACTION: ActionSpec = { id: "disengage", name: /^\s*disengage\s*$/i };
export const STABILIZE_ACTION: ActionSpec = { id: "stabilize", name: /^\s*stabili[sz]e\s*$/i };
export const INFLUENCE_ACTION: ActionSpec = { id: "influence", name: /^\s*influence\s*$/i };
export const SEARCH_ACTION: ActionSpec = { id: "search", name: /^\s*search\s*$/i };
export const STUDY_ACTION: ActionSpec = { id: "study", name: /^\s*study\s*$/i };
export const HELP_ACTION: ActionSpec = { id: "help", name: /^\s*help\s*$/i };
export const READY_ACTION: ActionSpec = { id: "ready", name: /^\s*ready\s*$/i };
export const UTILIZE_ACTION: ActionSpec = { id: "utilize", name: /^\s*utili[sz]e\s*$/i };

/** Is pressing this that action? */
export function isActionActivity(item: any, activity: any, spec: ActionSpec): boolean {
  if (!isDnd5e()) return false;
  const owner = item ?? activity?.item ?? null;
  if (!owner) return false;

  if (hasFlag(activity, spec.id) || hasFlag(owner, `${spec.id}Activity`)) return true;
  if (spec.featOnly && String(owner?.type ?? "") !== "feat") return false;
  if (spec.name.test(String(activity?.name ?? ""))) return true;

  const identifier = String(owner?.system?.identifier ?? "")
    .trim()
    .toLowerCase();
  if (identifier === spec.id) return true;
  return !identifier && spec.name.test(String(owner?.name ?? ""));
}

/** Is pressing this the Disengage action, by any of the routes above? */
export function isDisengageActivity(item: any, activity: any): boolean {
  return isActionActivity(item, activity, DISENGAGE_ACTION);
}

/** Is pressing this the Stabilize action — 2024's button for Administer First Aid? */
export function isStabilizeActivity(item: any, activity: any): boolean {
  return isActionActivity(item, activity, STABILIZE_ACTION);
}

/**
 * Is pressing this the Influence action?
 *
 * The PHB item carries two activities, "Use" and "Check", and neither is named Influence — so this one
 * is found by identifier in every case the census saw. Both activities match, which is right: whichever
 * the player picked, the same rule resolves it.
 */
export function isInfluenceActivity(item: any, activity: any): boolean {
  return isActionActivity(item, activity, INFLUENCE_ACTION);
}

/** Is pressing this the Dodge action? */
export function isDodgeActivity(item: any, activity: any): boolean {
  return isActionActivity(item, activity, DODGE_ACTION);
}

/** What this module does when the button is pressed. The vocabulary of the inventory below. */
export type ActionHandling =
  /** Intercepted: the activity is cancelled and one of our rules resolves it instead. */
  | "intercepted"
  /** Observed: the activity runs as the sheet intends and we record something from it. */
  | "observed"
  /** Announces what is coming; the follow-through pays for it. See `dnd5e-declarations.ts`. */
  | "declaration"
  /** The sheet's own behaviour is correct and complete; nothing of ours is involved. */
  | "system"
  /** Nothing enforces the rule. `note` says who would have to, and why we have not. */
  | "unbuilt";

export interface PhbAction {
  spec: ActionSpec;
  handling: ActionHandling;
  /** One line, written for a GM reading `api.surveyActionButtons()`. */
  note: string;
}

/**
 * Every general action the 2024 PHB ships as a pressable item, and what happens when it is pressed.
 *
 * THE POINT OF THE TABLE is the `unbuilt` rows. A rule nobody built looks exactly like a rule that
 * silently failed, and the Hide bug (v0.2.2) was live for as long as it was because nothing anywhere
 * said which buttons we had joined up and which we had not. This is the same argument that produced
 * `rules/general.ts` for the orphaned rules keys and `apps/pages.ts` for the settings rows: a decision
 * somebody made deliberately has to be legible six months later, or it reads as an oversight.
 *
 * Order follows the PHB's own alphabetical listing so a reader can check it against the book.
 */
export const PHB_ACTIONS: readonly PhbAction[] = [
  {
    spec: ATTACK_ACTION,
    handling: "declaration",
    note: "the weapon's own attack claims the Action; charging the button too refused the first swing",
  },
  {
    spec: DASH_ACTION,
    handling: "intercepted",
    note: "charged as a Dash so the Speed cap knows the extra movement is paid for",
  },
  {
    spec: DISENGAGE_ACTION,
    handling: "observed",
    note: "the item applies no status, so the opportunity-attack layer had nothing to read; we mark it",
  },
  {
    spec: DODGE_ACTION,
    handling: "observed",
    note: "nothing reads the status dnd5e ships, so rules/dodge.ts imposes the rules and expires it",
  },
  {
    spec: HELP_ACTION,
    handling: "unbuilt",
    note: "grants Advantage on one roll by an ally chosen now and rolled later; nothing tracks a pledge",
  },
  {
    spec: HIDE_ACTION,
    handling: "intercepted",
    note: "prerequisites, the Stealth roll and the banked DC all live in rules/hide.ts",
  },
  {
    spec: INFLUENCE_ACTION,
    handling: "intercepted",
    note: "the GM is asked for the attitude, then the check is rolled and the 24-hour lockout recorded",
  },
  {
    spec: MAGIC_ACTION,
    handling: "declaration",
    note: "the spell claims the Action; three activities here each claimed one before the fix",
  },
  {
    spec: READY_ACTION,
    handling: "unbuilt",
    note: "a trigger written in prose and a reaction spent later; the reaction is charged as an Action",
  },
  {
    spec: SEARCH_ACTION,
    handling: "unbuilt",
    note: "would contest the DCs rules/stealth.ts banks, but the roll is one skill of four and the GM's to read",
  },
  {
    spec: STABILIZE_ACTION,
    handling: "intercepted",
    note: "Administer First Aid: DC 10 Medicine, in rules/dying.ts",
  },
  {
    spec: STUDY_ACTION,
    handling: "system",
    note: "refused deliberately in rules/general.ts — a Study produces information, which is the GM's to give",
  },
  {
    spec: UTILIZE_ACTION,
    handling: "system",
    note: "refused deliberately in rules/general.ts — the economy already charges what the sheet states",
  },
];

/** Which PHB action, if any, this button is. Null for everything that is not one of the thirteen. */
export function phbActionOf(item: any, activity: any): PhbAction | null {
  for (const action of PHB_ACTIONS) {
    if (isActionActivity(item, activity, action.spec)) return action;
  }
  return null;
}

/**
 * What happens when each action button on this world's sheets is pressed.
 *
 * The answer to "is this one in the same state Hide was in". `carriedBy` is how many characters
 * actually have the item — an `unbuilt` row that nobody carries is a rule nobody can press, while an
 * `unbuilt` row on four sheets is a button that does nothing every session.
 */
export function surveyActionButtons(): Record<string, unknown> {
  const rows: Record<string, unknown>[] = [];
  const actors: any[] = Array.from((game.actors as any) ?? []).filter(
    (a: any) => a?.type === "character",
  );

  for (const action of PHB_ACTIONS) {
    const carriers: string[] = [];
    for (const actor of actors) {
      for (const item of actor?.items ?? []) {
        const activities = Array.from(item?.system?.activities ?? []) as any[];
        const found = activities.length
          ? activities.some((activity) => isActionActivity(item, activity, action.spec))
          : isActionActivity(item, null, action.spec);
        if (found) {
          carriers.push(String(actor?.name ?? "?"));
          break;
        }
      }
    }
    rows.push({
      action: action.spec.id,
      handling: action.handling,
      carriedBy: carriers.length,
      carriers,
      note: action.note,
    });
  }

  return {
    system: String((game as any).system?.id ?? "?"),
    characters: actors.length,
    buttons: rows,
  };
}
