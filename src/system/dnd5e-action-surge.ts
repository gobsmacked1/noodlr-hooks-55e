// Action Surge is a Fighter class feature, not a PHB action and not an Active Effect.
//
// Stock dnd5e (2014 and 2024) ships it as a Utility with `activation.type: special`, one item use,
// and `effects: []`. `slotFor("special")` is null, so the economy hook used to let the button
// through, consume the use, and grant nothing. A level 20 fighter who then swung a fifth time was
// asked whether they really meant to go over 4 of 4 attacks — the dialog the table saw.
//
// Haste writes `flags.<ns>.extraAction` as a lasting AE. Action Surge cannot: it lasts this turn
// only, and a flag that outlives the stamp would hand out a free Action every later turn. The grant
// lives on the turn tally (`surge`) instead. `allowance()` stays AE-only so Haste + Surge stack.
//
// 2024: extra Action this turn, not the Magic action; 17+ is twice per rest, once per turn. The
// Magic-action restriction is parked — which remaining Action is "the surge one" is a second
// question, and the ledger does not yet split Actions by kind. The planner does not press this.
//
// Recognition is the same two-route shape as Hide / Dash: identifier first, name only on a feat
// that states no identifier. A weapon named Action Surge is not this feature.

import { isActionActivity, type ActionSpec } from "./dnd5e-actions";

export const ACTION_SURGE: ActionSpec = {
  id: "action-surge",
  name: /^\s*action\s+surge\s*$/i,
  featOnly: true,
};

export function isActionSurge(item: any, activity: any): boolean {
  return isActionActivity(item, activity, ACTION_SURGE);
}
