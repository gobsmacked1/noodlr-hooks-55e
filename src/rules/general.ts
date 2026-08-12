// The general rules, and what became of each of them.
//
// The corpus coverage report finished with ten rules keys that dnd5e documents and never reads:
// `influence`, `indifferent`, `hostile`, `jumping`, `stable`, `study`, `utilize`, `breakingobjects`,
// `hazards` and `difficultyclass`. That list is short and finite, which is exactly what makes it
// worth hard-coding: unlike a creature's own abilities, these read the same for every creature in
// every campaign, so there is nothing for a compiler to compile.
//
// Working the list produced three builds and five deliberate refusals, and the refusals are the more
// useful half of the record. A rule left alone because somebody checked and found it already
// enforced is a different thing from one left alone because nobody got to it, and six months from
// now nothing distinguishes them unless it is written down. `api.surveyGeneralRules()` prints this
// table, so the answer is a console call rather than an afternoon.

import { COMBAT_SETTINGS, MODULE_ID, log } from "../constants";
import { enabledForEither, isInfluenceEnabled, isJumpEnabled } from "../settings";
import { DC_LADDER, OBJECT_REFERENCE, generalRulesApply } from "../system/dnd5e-checks";

/** What happened to one general rule. */
interface Disposition {
  /** The `CONFIG.DND5E.rules` key it appears under, which is how the coverage report named it. */
  key: string;
  rule: string;
  /** Who applies it now: this module, the game system, or deliberately nobody. */
  enforcedBy: "noodlr-hooks-55e" | "dnd5e" | "nobody, deliberately";
  why: string;
  /** Live, for the three that have a switch. */
  enabled?: boolean;
}

function dispositions(): Disposition[] {
  return [
    {
      key: "jumping",
      rule: "Long Jump is a number of feet up to your Strength score with a 10-foot run-up, half that standing; High Jump is 3 plus your Strength modifier, half that standing; each foot costs a foot of movement.",
      enforcedBy: MODULE_ID,
      why: "Core has a jump movement action and dnd5e prices it correctly, but nothing bounds the distance — and reading dnd5e's own `movement.jump` as a turn budget collapsed a jumping creature's whole turn to half its Strength score. `rules/jump.ts` caps each leap and `economy/speed.ts` now budgets a jump against walking Speed.",
      enabled: isJumpEnabled(),
    },
    {
      key: "influence",
      rule: "DC 15 or the creature's Intelligence score, whichever is higher; a failed check locks that approach for 24 hours.",
      enforcedBy: MODULE_ID,
      why: "Documented in `CONFIG.DND5E.rules` and read nowhere. The GM is asked whether the creature is willing, hesitant or unwilling — that judgement is not automatable — and everything downstream of the answer is.",
      enabled: isInfluenceEnabled(),
    },
    {
      key: "indifferent / hostile / friendly",
      rule: "Advantage on a check to influence a Friendly creature, Disadvantage against a Hostile one; Indifferent is the default.",
      enforcedBy: MODULE_ID,
      why: "The mechanical content of the three attitude entries, and the part everybody remembers as a principle and forgets as a die roll. Attitude defaults to the token's disposition and is overruled by a flag the GM sets, because a Hostile-disposition guard can be merely Indifferent to a bribe.",
      enabled: isInfluenceEnabled(),
    },
    {
      key: "stable",
      rule: "Three death-save successes, or a DC 10 Wisdom (Medicine) check, makes a dying creature Stable; damage ends it.",
      enforcedBy: MODULE_ID,
      why: "The death-save half and the damage clear already shipped with the dying layer. Administering first aid did not, because 2024 files it under Utilize and dnd5e ships no item for it — the same gap as the Hide action, with the same answer.",
      // The dying layer is per audience, so this is on if either side wants it; which creatures it
      // actually runs for is answered when one is in hand.
      enabled: enabledForEither(COMBAT_SETTINGS.dying),
    },
    {
      key: "hazards",
      rule: "Burning, falling, suffocating and the rest.",
      enforcedBy: MODULE_ID,
      why: "Already built, before this list was worked: `core/hazards.ts` moves a creature out of a persistent harmful area, with which areas hurt quarantined in `system/dnd5e-hazards.ts`.",
    },
    {
      key: "breakingobjects",
      rule: "Objects have AC and Hit Points, are immune to poison and psychic damage, may have a damage threshold, and are destroyed at 0 Hit Points.",
      enforcedBy: "dnd5e",
      why: "Checked, and the mechanical half is already somebody's: dnd5e applies a damage threshold in `documents/actor/actor.mjs:883` for any actor carrying `system.attributes.hp.dt`, and the drop to zero is the dying layer's. What is left is a statblock for scenery Foundry does not model as a document, and a GM's ruling on whether smashing a leg collapses the table. The published numbers are printed below rather than applied.",
    },
    {
      key: "difficultyclass",
      rule: "Very easy 5, Easy 10, Medium 15, Hard 20, Very hard 25, Nearly impossible 30.",
      enforcedBy: "nobody, deliberately",
      why: "Six numbers a GM picks from. There is nothing to apply on anyone's behalf — the table is here so this module's own DCs can be named rather than typed as bare integers.",
    },
    {
      key: "utilize",
      rule: "Using an object is an Action.",
      enforcedBy: MODULE_ID,
      why: "Not a new engine. The action economy already charges whatever the sheet says an activity costs, and a world with the 2024 PHB action items installed has a Utilize item that claims an Action like any other. The one Utilize with mechanics of its own — Administer First Aid — is built, above.",
    },
    {
      key: "study",
      rule: "Studying something is an Action, resolved with an Intelligence check.",
      enforcedBy: MODULE_ID,
      why: "Same answer as Utilize: the cost is priced by the action economy, and which check to call for is the GM's. There is no consequence to automate — a Study action produces information, and the information is the GM's to give.",
    },
  ];
}

/**
 * What this module does about each of the general rules, and why it does nothing about the rest.
 *
 * Includes the object reference table, which exists nowhere else a GM could reach it: it is printed
 * here precisely because it is not applied anywhere, and something that is never applied is otherwise
 * invisible.
 */
export function surveyGeneralRules(): unknown {
  const report = {
    applicable: generalRulesApply(),
    rules: dispositions(),
    difficultyClasses: DC_LADDER,
    objects: OBJECT_REFERENCE,
  };
  log("general rules survey", report);
  return report;
}
