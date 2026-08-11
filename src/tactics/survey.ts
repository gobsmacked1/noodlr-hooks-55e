// Learning the sheets from the sheets, rather than from documentation.
//
// Written 2026-08-03 at the user's suggestion, after two releases were lost to guessing at data shapes.
// A world with hundreds of imported statblocks IS the specification: whatever the importer, the system
// version and the installed automation modules actually produce is what the planner has to read, and no
// amount of API documentation substitutes for a census of the real thing.
//
// This reads and reports only. It never writes to an actor, and it never leaves the client except as a
// file the GM chooses to keep.
//
// The output is deliberately a CENSUS rather than a dump: counts of shapes, not hundreds of statblocks,
// so it fits in a chat message and answers questions like "does every attack activity state its range?"
// and "which module is injecting an activity onto every weapon?" at a glance.
//
// Extended 2026-08-07 to cover PLAYER characters as well. The original scan skipped them on purpose and
// that was right for its purpose, but every question the action economy raises — what claims an action
// slot, how many attacks one Action buys, what lets a rogue Dash for a bonus action — is a question about
// a character, so those went unmeasurable. Characters are a separate arm rather than extra rows, so the
// creature tallies stay comparable with earlier runs.

import { log, MODULE_ID } from "../constants";
import { writeReport } from "../util/write-file";
import { prewarmCastSpells, readActions } from "./actions";
import { notable, slotClaims, type SlotClaim } from "../rules/economy/claims";
import { explainAttacksPerAction } from "../rules/economy/ledger";
import { bonusDashSource } from "../system/dnd5e-dash";
import { pick, systemPaths } from "../system/profiles";

/** Count occurrences of a value, tolerating undefined as its own bucket. */
class Tally {
  private counts = new Map<string, number>();

  add(value: unknown): void {
    const key =
      value === undefined
        ? "(undefined)"
        : value === null
          ? "(null)"
          : value === ""
            ? "(empty string)"
            : String(value);
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
  }

  /** Highest counts first, so the interesting outliers are visible without scrolling. */
  top(limit = 25): Record<string, number> {
    const sorted = [...this.counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
    return Object.fromEntries(sorted);
  }

  get size(): number {
    return this.counts.size;
  }
}

interface Survey {
  world: {
    foundry: string;
    system: string;
    systemVersion: string;
    modules: string[];
  };
  actorsScanned: number;
  itemsScanned: number;
  activitiesScanned: number;
  /** Items whose `system.activities` field is absent entirely — the legacy shape. */
  itemsWithoutActivities: number;
  itemTypes: Record<string, number>;
  activityTypes: Record<string, number>;
  activationTypes: Record<string, number>;
  attackTypes: Record<string, number>;
  attackClassifications: Record<string, number>;
  rangeUnits: Record<string, number>;
  /** How often an attack activity states no numeric range at all — the fallback we must get right. */
  attacksWithoutRange: number;
  /** Recurring activity names, which is how an injected activity gives itself away. */
  activityNames: Record<string, number>;
  /** Flag namespaces seen on items and on activities: the honest way to spot module-injected data. */
  itemFlagScopes: Record<string, number>;
  activityFlagScopes: Record<string, number>;
  spellMethods: Record<string, number>;
  /** The shape of the languages field, since "does it speak?" gates all banter. */
  languageShapes: Record<string, number>;
  creatureTypes: Record<string, number>;
  /** The three documented reasons to skip an activity, counted so their prevalence is known. */
  skippable: {
    canUseFalse: number;
    riders: number;
    midiAutomationOnly: number;
    castActivities: number;
    cachedSpellClones: number;
  };
  /** Actors carrying no activities at all. Rare, and usually a deliberately inert sheet. */
  actorsWithNoActivities: string[];
  /**
   * What the planner's own reader makes of these sheets — the only numbers that predict behaviour.
   *
   * Everything above counts what is IN the data. This counts what survives being read, which is the
   * distinction that matters: a census showing 366 attack activities means nothing if the reader
   * discards them. `actorsWithNoTurnAction` is precisely the population that falls back to shouting for
   * help, and until now it was inferred from play reports instead of measured.
   */
  reader: {
    actionsRead: number;
    kinds: Record<string, number>;
    economies: Record<string, number>;
    unavailable: number;
    viaCastWrapper: number;
    actorsWithNoTurnAction: string[];
    actorsWithNoTurnActionCount: number;
  };
  /**
   * The player characters, reported separately rather than folded into the counts above.
   *
   * Everything else here exists to learn monster sheets for the planner, which is why PCs were originally
   * skipped outright — their sheets are shaped differently enough to muddy the tallies. But the action
   * economy, the Dash rules and the damage riders all apply to characters and *only* really bite there, so
   * the questions those raise were unanswerable from a census that could not see a rogue (2026-08-07).
   * Kept as its own arm so the NPC numbers stay comparable with earlier runs.
   */
  characters: {
    scanned: number;
    rows: CharacterRow[];
  };
  /**
   * What could be charged an action slot, across the whole world.
   *
   * `unexemptedFeatures` is the interesting list: a feature that claims an Action or a bonus action and is
   * neither a damage rider nor one of the PHB action buttons that merely announce one. Most entries are
   * legitimate — dnd5e's own content has a good few, Holy Nimbus and thrown oil among them — but this is
   * exactly where a mis-authored ability hides, which is what turned a rogue's Sneak Attack into a spent
   * Action and made a fighter's Attack button cost a second one.
   */
  claims: {
    total: number;
    byItemType: Record<string, number>;
    exempted: number;
    unexemptedFeatureCount: number;
    unexemptedFeatures: SlotClaim[];
  };
  /** One real example per distinct activity type, for eyeballing the fields we do not tally. */
  examples: Record<string, unknown>;
}

/** The reads that decide what one character is permitted to do on its turn. */
interface CharacterRow {
  name: string;
  level: number | null;
  classes: string[];
  /** Detected, not counted — and the one value here most likely to be wrong. */
  attacksPerAction: number;
  attacksPerActionFrom: string;
  /** What lets them Dash for a bonus action, or null if the Action is their only way. */
  bonusDash: string | null;
  slotClaims: number;
  notableClaimCount: number;
  notableClaims: SlotClaim[];
}

function describeShape(value: unknown): string {
  if (value === undefined) return "(absent)";
  if (value === null) return "(null)";
  if (typeof value === "string") return value.trim() ? "string" : "empty string";
  if (Array.isArray(value)) return value.length > 0 ? "array" : "empty array";
  if (value instanceof Set) return value.size > 0 ? "Set" : "empty Set";
  if (typeof value === "object")
    return `object{${Object.keys(value as object)
      .slice(0, 6)
      .join(",")}}`;
  return typeof value;
}

/** Flag namespaces present on a document, excluding core's own. */
function flagScopes(doc: any): string[] {
  const flags = doc?.flags ?? {};
  return Object.keys(flags).filter((k) => k !== "core" && k !== "exportSource");
}

/**
 * Census the world's sheets: the creatures the planner drives, and the characters it does not.
 *
 * `saveToFile` writes the JSON alongside Noodlr's other output so it can be attached to a bug report or
 * ingested later; the compact summary always goes to the console regardless.
 */
export async function surveyActions(
  opts: { saveToFile?: boolean; max?: number; asText?: boolean } = {},
): Promise<Survey> {
  const P = systemPaths();
  const survey: Survey = {
    world: {
      foundry: String((game as any).version ?? "?"),
      system: String((game as any).system?.id ?? "?"),
      systemVersion: String((game as any).system?.version ?? "?"),
      modules: [...((game as any).modules ?? [])]
        .filter((m: any) => m?.active)
        .map((m: any) => `${m.id}@${m.version ?? "?"}`)
        .sort(),
    },
    actorsScanned: 0,
    itemsScanned: 0,
    activitiesScanned: 0,
    itemsWithoutActivities: 0,
    itemTypes: {},
    activityTypes: {},
    activationTypes: {},
    attackTypes: {},
    attackClassifications: {},
    rangeUnits: {},
    attacksWithoutRange: 0,
    activityNames: {},
    itemFlagScopes: {},
    activityFlagScopes: {},
    spellMethods: {},
    languageShapes: {},
    creatureTypes: {},
    skippable: {
      canUseFalse: 0,
      riders: 0,
      midiAutomationOnly: 0,
      castActivities: 0,
      cachedSpellClones: 0,
    },
    actorsWithNoActivities: [],
    reader: {
      actionsRead: 0,
      kinds: {},
      economies: {},
      unavailable: 0,
      viaCastWrapper: 0,
      actorsWithNoTurnAction: [],
      actorsWithNoTurnActionCount: 0,
    },
    characters: { scanned: 0, rows: [] },
    claims: {
      total: 0,
      byItemType: {},
      exempted: 0,
      unexemptedFeatureCount: 0,
      unexemptedFeatures: [],
    },
    examples: {},
  };

  const itemTypes = new Tally();
  const activityTypes = new Tally();
  const activationTypes = new Tally();
  const attackTypes = new Tally();
  const attackClassifications = new Tally();
  const rangeUnits = new Tally();
  const activityNames = new Tally();
  const itemFlagScopes = new Tally();
  const activityFlagScopes = new Tally();
  const spellMethods = new Tally();
  const languageShapes = new Tally();
  const creatureTypes = new Tally();
  const readerKinds = new Tally();
  const readerEconomies = new Tally();
  const claimItemTypes = new Tally();

  /** Fold one actor's slot claims into the world-wide totals. */
  const countClaims = (actor: any): SlotClaim[] => {
    const claims = slotClaims(actor);
    survey.claims.total += claims.length;
    for (const claim of claims) {
      claimItemTypes.add(claim.itemType);
      if (claim.exemptedAs) {
        survey.claims.exempted++;
      } else if (notable(claim)) {
        survey.claims.unexemptedFeatureCount++;
        // A hundred rows is a dump, not a finding; the count above carries the scale.
        if (survey.claims.unexemptedFeatures.length < 80)
          survey.claims.unexemptedFeatures.push(claim);
      }
    }
    return claims;
  };

  const isCharacter = (actor: any): boolean =>
    actor?.type === "character" || Boolean(actor?.hasPlayerOwner);

  const max = opts.max ?? Number.POSITIVE_INFINITY;
  for (const actor of (game as any).actors ?? []) {
    // Player characters are not what the combat planner drives, and their sheets are shaped
    // differently enough to muddy the counts. They get their own arm, below.
    if (isCharacter(actor)) continue;
    if (survey.actorsScanned >= max) break;
    survey.actorsScanned++;

    countClaims(actor);
    languageShapes.add(describeShape(pick(actor, P.languages)));
    creatureTypes.add(pick(actor, P.creatureType));

    let readable = 0;
    for (const item of actor.items ?? []) {
      survey.itemsScanned++;
      itemTypes.add(item?.type);
      if (item?.flags?.dnd5e?.cachedFor) survey.skippable.cachedSpellClones++;
      for (const scope of flagScopes(item)) itemFlagScopes.add(scope);
      if (item?.type === "spell") {
        // Read the raw source, never the deprecated `preparation` getter.
        spellMethods.add(item?.system?.method ?? item?._source?.system?.preparation?.mode);
      }

      const activities: any = item?.system?.activities;
      if (activities === undefined || activities === null) {
        survey.itemsWithoutActivities++;
        continue;
      }
      const list: any[] = activities.contents ?? (Array.isArray(activities) ? activities : []);
      for (const activity of list) {
        survey.activitiesScanned++;
        readable++;
        activityTypes.add(activity?.type);
        activationTypes.add(activity?.activation?.type);
        if (activity?.canUse === false) survey.skippable.canUseFalse++;
        if (activity?.isRider === true) survey.skippable.riders++;
        if (activity?.midiProperties?.automationOnly === true)
          survey.skippable.midiAutomationOnly++;
        if (String(activity?.type ?? "").toLowerCase() === "cast")
          survey.skippable.castActivities++;
        activityNames.add(activity?.name || `(item name: ${item?.name})`);
        for (const scope of flagScopes(activity)) activityFlagScopes.add(scope);

        if (activity?.type === "attack") {
          attackTypes.add(activity?.attack?.type?.value);
          attackClassifications.add(activity?.attack?.type?.classification);
          rangeUnits.add(activity?.range?.units);
          const stated = activity?.range?.value;
          if (stated === null || stated === undefined || stated === "")
            survey.attacksWithoutRange++;
        }

        // One worked example per activity type: the fields we did not think to tally live here, and
        // this is what turns "we think it looks like X" into "here is what it is".
        const key = String(activity?.type ?? "?");
        if (!(key in survey.examples)) {
          survey.examples[key] = {
            actor: actor?.name,
            item: item?.name,
            itemType: item?.type,
            activityName: activity?.name,
            activation: activity?.activation,
            attack: activity?.attack,
            range: activity?.range,
            target: activity?.target,
            uses: activity?.uses,
            consumption: activity?.consumption,
            damageParts: activity?.damage?.parts?.length ?? 0,
            flags: activity?.flags,
          };
        }
      }
    }
    if (readable === 0) survey.actorsWithNoActivities.push(String(actor?.name ?? "?"));

    // Now read the sheet the way a turn does. The prewarm is what lets a caster's compendium-backed
    // spells resolve, and it caches, so 193 actors cost one load per distinct spell.
    await prewarmCastSpells(actor);
    const actions = readActions(actor);
    survey.reader.actionsRead += actions.length;
    let turnOptions = 0;
    for (const action of actions) {
      readerKinds.add(action.kind);
      readerEconomies.add(action.economy);
      if (!action.available) survey.reader.unavailable++;
      if (action.viaCast) survey.reader.viaCastWrapper++;
      if (action.available && (action.economy === "action" || action.economy === "bonus"))
        turnOptions++;
    }
    if (turnOptions === 0) {
      survey.reader.actorsWithNoTurnActionCount++;
      if (survey.reader.actorsWithNoTurnAction.length < 25)
        survey.reader.actorsWithNoTurnAction.push(String(actor?.name ?? "?"));
    }
  }

  // The characters. Deliberately not put through `readActions` or the prewarm: that reader exists to
  // decide a monster's turn, nothing drives a PC on its owner's behalf, and prewarming every character's
  // spellbook would cost pack loads for an answer nobody asks. What is read here is only what the rules
  // layers actually consult about a character.
  for (const actor of (game as any).actors ?? []) {
    if (!isCharacter(actor)) continue;
    survey.characters.scanned++;
    const claims = countClaims(actor);
    if (survey.characters.rows.length >= 40) continue;

    const level = Number(actor?.system?.details?.level);
    const per = explainAttacksPerAction(actor);
    const interesting = claims.filter(notable);
    survey.characters.rows.push({
      name: String(actor?.name ?? "?"),
      level: Number.isFinite(level) ? level : null,
      classes: Object.keys(actor?.classes ?? {}),
      attacksPerAction: per.value,
      attacksPerActionFrom: per.source,
      bonusDash: bonusDashSource(actor),
      slotClaims: claims.length,
      notableClaimCount: interesting.length,
      // A fully kitted character carries dozens of features that legitimately cost an action; the count
      // above is the scale, and thirty rows is enough to spot one that should not be there.
      notableClaims: interesting.slice(0, 30),
    });
  }

  survey.claims.byItemType = claimItemTypes.top();
  survey.itemTypes = itemTypes.top();
  survey.activityTypes = activityTypes.top();
  survey.activationTypes = activationTypes.top();
  survey.attackTypes = attackTypes.top();
  survey.attackClassifications = attackClassifications.top();
  survey.rangeUnits = rangeUnits.top();
  // Names are the long tail: an injected activity appears on hundreds of items, so the top of this
  // list is exactly where a "Midi Attack" outs itself.
  survey.activityNames = activityNames.top(30);
  survey.itemFlagScopes = itemFlagScopes.top();
  survey.activityFlagScopes = activityFlagScopes.top();
  survey.spellMethods = spellMethods.top();
  survey.languageShapes = languageShapes.top();
  survey.creatureTypes = creatureTypes.top();
  survey.reader.kinds = readerKinds.top();
  survey.reader.economies = readerEconomies.top();
  // A hundred names is not a finding; a count and a handful of examples is.
  survey.actorsWithNoActivities = survey.actorsWithNoActivities.slice(0, 20);

  console.group(
    `Noodlr Hooks | sheet survey: ${survey.actorsScanned} creatures, ${survey.characters.scanned} characters`,
  );
  console.log(survey);
  // A GM whose Foundry runs on another machine cannot easily fetch the written file, and copying a
  // deeply nested console object is fiddly. `asText` prints one selectable block instead.
  if (opts.asText) console.log(JSON.stringify(survey, null, 2));
  console.groupEnd();

  if (opts.saveToFile) {
    const path = await writeReport(`${MODULE_ID}-sheet-survey.json`, survey);
    log(
      path ? `survey written to ${path}` : "survey could not be written to the world data folder",
    );
  }

  return survey;
}
