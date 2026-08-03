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

import { log, MODULE_ID } from "../constants";
import { saveMedia } from "../media/storage";
import { pick, systemPaths } from "./system-profiles";

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
  /** Actors that yielded nothing readable: the population this whole subsystem fails on. */
  actorsWithNoReadableAction: string[];
  /** One real example per distinct activity type, for eyeballing the fields we do not tally. */
  examples: Record<string, unknown>;
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
 * Census the world's non-player actors.
 *
 * `saveToFile` writes the JSON alongside Noodlr's other output so it can be attached to a bug report or
 * ingested later; the compact summary always goes to the console regardless.
 */
export async function surveyActions(
  opts: { saveToFile?: boolean; max?: number } = {},
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
    actorsWithNoReadableAction: [],
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

  const max = opts.max ?? Number.POSITIVE_INFINITY;
  for (const actor of (game as any).actors ?? []) {
    // Player characters are not what the combat planner drives, and their sheets are shaped
    // differently enough to muddy the counts.
    if (actor?.type === "character" || actor?.hasPlayerOwner) continue;
    if (survey.actorsScanned >= max) break;
    survey.actorsScanned++;

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
    if (readable === 0) survey.actorsWithNoReadableAction.push(String(actor?.name ?? "?"));
  }

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
  // A hundred names is not a finding; a count and a handful of examples is.
  survey.actorsWithNoReadableAction = survey.actorsWithNoReadableAction.slice(0, 20);

  console.group(`Noodlr | sheet survey: ${survey.actorsScanned} actors`);
  console.log(survey);
  console.groupEnd();

  if (opts.saveToFile) {
    const blob = new Blob([JSON.stringify(survey, null, 2)], { type: "application/json" });
    const path = await saveMedia(blob, "survey", {
      subfolder: "survey",
      fileName: `${MODULE_ID}-sheet-survey.json`,
      ext: "json",
    });
    log(
      path ? `survey written to ${path}` : "survey could not be written to the world data folder",
    );
  }

  return survey;
}
