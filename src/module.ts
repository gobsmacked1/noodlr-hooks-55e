// Noodlr Hooks 5.5e — entry point.
//
// A standalone rules-automation module for D&D 5e (2024). It depends on nothing, and everything it
// does works with only Foundry and the dnd5e system installed. Where a mechanics module IS present it
// stands aside rather than competing: midi-qol owns attack workflows and concentration when it is
// configured to, Automated Conditions 5e owns condition math, Gambit's owns the opportunity attacks it
// implements. Each of those checks lives beside the code it guards.
//
// Four folders, and the split is the plan for a second game system rather than tidiness:
//
//   * `system/` — everything that knows a D&D name: spell tables, feat identifiers, sheet paths. A
//     `noodlr-hooks-pf2e` replaces this folder and nothing else.
//   * `rules/`  — enforcement. Conditions, dying, concentration, stealth, the action economy, Speed,
//     forced movement, reactions. Reads `system/` for the particulars; never hardcodes one.
//   * `tactics/`— deciding what a creature does with its turn. The planner, the tiers, the dossier.
//   * `core/`   — geometry and measurement with no rules in it at all: the board, movement, cover
//     searches, seeded randomness. Portable as-is.
//
// Where hooks are registered matters more than it looks, and two of these placements are load-bearing:
//
//   * `registerMovementCap()` and `registerForceAction()` must run at `init`. The first installs a
//     Token subclass at `setup`, which has already passed by the time `ready` fires; the second writes
//     to a registry core deep-freezes inside `setupGame()`, before the `setup` hook, where a late write
//     is a silent no-op rather than an error.
//   * Anything driven by a roll must be registered on EVERY client, not inside the GM block. Those
//     hooks fire on whichever client rolled, which for a player character is the player's browser. A
//     rogue could attack from hiding and stay hidden for exactly this reason, because the reveal
//     listener had been registered for GMs only.

import { MODULE_ID, log } from "./constants";
import {
  applyCompactCards,
  migrateSettings,
  registerCombatSettings,
  getCombatAutomation,
} from "./settings";
import { announceRuling, proposeRuling, requestBehavior, PROTOCOL } from "./integration/contract";
import { surveyAwareness } from "./tactics/awareness";
import { registerDossierCleanup } from "./tactics/dossier";
import { toggleSelectedCombatantAutomation } from "./tactics/control";
import { registerAutomationCleanup } from "./tactics/registry";
import { registerAutoRoll } from "./tactics/auto-roll";
import { registerAutomationTurnHook } from "./tactics/hooks";
import { registerFleeHooks, surveyFlee } from "./tactics/flee";
import { registerPerceptionWatch, surveyPerception } from "./rules/perception";
import { registerStealthWatch } from "./rules/stealth";
import { hideSelected, surveyHide } from "./rules/hide";
import { registerInvisibilityHooks } from "./rules/invisibility";
import { registerReactionHooks } from "./rules/reactions";
import { registerReactionOffers, surveyOffers } from "./rules/offer";
import { surveyCounterspell } from "./rules/counterspell";
import { surveyBarbs } from "./rules/barbs";
import { registerSneakOffers, registerSneakWatch, surveySneak } from "./rules/sneak";
import { registerReady, registerReadyExpiry, surveyReady } from "./rules/ready";
import { registerReadyWatch } from "./rules/ready-events";
import { registerWatchRelay } from "./integration/watch";
import { registerForcedMovement, surveyForced } from "./rules/forced";
import { registerDamageApplication, surveyDamage } from "./rules/damage";
import { registerDamageGate, surveyGate } from "./rules/gate";
import { registerSaveResolution, surveyDamageSaves } from "./rules/saves";
import { registerTemplateTargets } from "./rules/template-targets";
import { surveyLegendary } from "./rules/legendary";
import { registerForceAction, shove, undoForcedMovement } from "./rules/shove";
import { registerConditionHooks, surveyConditions } from "./rules/conditions";
import { firstAidTargets, registerDyingHooks, surveyDying, undoDying } from "./rules/dying";
import { announceJump, registerJumpWatch, surveyJump } from "./rules/jump";
import { registerProneWatch, surveyProne } from "./rules/prone";
import { registerInteractReach, surveyInteract } from "./rules/interact";
import { registerAuraWatch, surveyAuras } from "./rules/aura";
import { registerTransformWatch, restoreOriginalForm, surveyTransform } from "./rules/transform";
import {
  dismountSelected,
  dropAllRidersOf,
  mountSelected,
  registerRidingWatch,
  surveyRiding,
} from "./rules/riding";
import {
  clearInfluenceLocks,
  influenceTargets,
  registerInfluenceQueries,
  surveyInfluence,
} from "./rules/influence";
import { registerDisengageWatch } from "./rules/disengage";
import { registerDodgeHooks } from "./rules/dodge";
import {
  noteRepeatSave,
  registerRepeatSaveWatch,
  surveyRepeatSaves,
  type RepeatSave,
} from "./rules/repeat-save";
import { registerRecharge, surveyRecharge } from "./rules/recharge";
import type { Stance } from "./rules/influence";
import { surveyGeneralRules } from "./rules/general";
import { surveyActionButtons } from "./system/dnd5e-actions";
import { surveyGlossary } from "./system/dnd5e-glossary";
import { advisories, allOwnership, conflicts } from "./integration/ownership";
import { openRulesConfig } from "./apps/rules-config";
import { registerConcentrationHooks, surveyConcentration } from "./rules/concentration";
import { registerEconomyHooks } from "./rules/economy/enforce";
import { registerMovementCap, surveyMovement } from "./rules/economy/speed";
import { installTokenBadgeClicks } from "./util/token-badge";
import { surveyEconomy } from "./rules/economy/survey";
import { registerEncounterTracking } from "./tactics/encounter";
import { explainTurn } from "./tactics/explain";
import { flattenElevation, restoreElevation, testMove } from "./core/diagnose";
import { surveyActions } from "./tactics/survey";
import { restoreForfeited } from "./system/dnd5e-rewards";
import { runCurrentNpcTurn } from "./tactics/npc-turn";
import { registerDamageLog } from "./capability/damage-log";
import { surveyPrimitives } from "./capability/primitives";
import { registerCapabilityExecutor, surveyCapabilities } from "./capability/executor";
import {
  collectScene,
  recompileWorld,
  registerCapabilityCollector,
  surveyScene,
} from "./capability/collect";
import { pruneOrphans, surveyOrphans } from "./capability/hygiene";
import { surveyCacheAge } from "./capability/age";
import { surveyStanding } from "./capability/standing";
import { openCapabilitySheet, registerCapabilitySheet } from "./apps/capability-sheet";

/**
 * What this module tells a companion module about itself.
 *
 * `noodlr` scans for `noodlr-hooks-*` and reads this to decide which game system it is narrating and
 * what it may expect to hear about. Keep `protocol` in step with `integration/contract.ts`.
 */
export interface HooksDescriptor {
  protocol: number;
  systemId: string;
  /** The ruleset name a language model should be told it is playing, spelled out including edition. */
  rulesetName: string;
  capabilities: string[];
}

export interface NoodlrHooksApi {
  noodlrHooks: HooksDescriptor;
  runNpcTurn(): Promise<void>;
  restoreForfeitedGear(): Promise<number>;
  explainTurn(): Promise<void>;
  surveyActions(opts?: { saveToFile?: boolean; max?: number; asText?: boolean }): Promise<unknown>;
  testMove(): Promise<Record<string, unknown> | undefined>;
  surveyPerception(): Promise<Record<string, unknown>>;
  surveyEconomy(): Record<string, unknown>;
  surveyMovement(): unknown;
  surveyForced(): unknown;
  surveyDamage(): unknown;
  surveyGate(): unknown;
  surveyDamageSaves(): unknown;
  surveyOffers(): unknown;
  surveyCounterspell(): unknown;
  surveyBarbs(): unknown;
  surveySneak(): unknown;
  surveyReady(): unknown;
  surveyLegendary(): unknown;
  surveyConditions(): unknown;
  surveyDying(): unknown;
  surveyConcentration(): unknown;
  surveyHide(): unknown;
  surveyAwareness(): unknown;
  hide(opts?: { force?: boolean }): Promise<void>;
  surveyJump(): unknown;
  surveyProne(): unknown;
  jump(): Promise<void>;
  surveyInteract(): unknown;
  surveyAuras(): unknown;
  surveyTransform(): unknown;
  surveyRiding(): unknown;
  mount(): Promise<unknown>;
  dismount(): Promise<unknown>;
  dumpRiders(): Promise<unknown>;
  restoreTransformation(): Promise<unknown>;
  surveyFlee(): unknown;
  surveyRepeatSaves(): unknown;
  surveyRecharge(): unknown;
  repeatSave(clause: RepeatSave): Promise<void>;
  surveyInfluence(): unknown;
  influence(opts?: { approach?: string; stance?: Stance; force?: boolean }): Promise<unknown>;
  clearInfluenceLocks(): Promise<number>;
  firstAid(): Promise<unknown>;
  surveyGeneralRules(): unknown;
  surveyActionButtons(): unknown;
  surveyGlossary(): unknown;
  push(feet?: number): Promise<unknown>;
  pull(feet?: number): Promise<unknown>;
  undoForcedMovement(): Promise<number>;
  undoDying(): Promise<number>;
  surveyPrimitives(): unknown;
  surveyCapabilities(): unknown;
  surveyScene(): Promise<unknown>;
  surveyStanding(): unknown;
  surveyOrphans(): Promise<unknown>;
  surveyCacheAge(): Promise<unknown>;
  pruneOrphans(options?: { includeAbsent?: boolean }): Promise<unknown>;
  compileScene(): Promise<unknown>;
  recompileWorld(options?: { since?: number }): Promise<unknown>;
  openCapabilities(actor?: unknown): void;
  openRules(page?: string): void;
  surveyOwnership(): unknown;
  flattenElevation(): Promise<number>;
  restoreElevation(): Promise<number>;
}

const descriptor: HooksDescriptor = {
  protocol: PROTOCOL,
  systemId: "dnd5e",
  // Spelled out rather than read from `game.system.title`, because that reports "D&D Fifth Edition"
  // for both the 2014 and the 2024 rules and the edition is the whole point of naming it.
  rulesetName: "Dungeons & Dragons Fifth Edition (2024)",
  capabilities: [
    "action-economy",
    "movement-speed",
    "forced-movement",
    "conditions",
    "dying",
    "concentration",
    "stealth",
    "surprise",
    "reactions",
    "perception",
    "npc-tactics",
    "encounter-resolution",
    // Protocol 2. Advertises that this module will ASK to have prose compiled, not that it can do it
    // — the listener is what supplies that, and with none installed nothing is ever requested.
    "capability-compiler",
  ],
};

/**
 * Push or pull whatever is targeted, away from or toward the selected token.
 *
 * A console entry point rather than a button: this is the manual override for a rule the automatic
 * layer does not recognise, and reaching for it means the GM has already decided what should happen.
 */
async function shoveTargets(feet: number, direction: "away" | "toward"): Promise<unknown> {
  const by: any = (canvas as any)?.tokens?.controlled?.[0];
  const targets = Array.from((game.user?.targets ?? []) as Set<any>);
  if (!by || targets.length === 0) {
    return { error: "select the creature doing the pushing and target the ones being moved" };
  }
  const results: Record<string, unknown> = {};
  for (const target of targets) {
    results[String(target?.document?.name ?? target?.name ?? "?")] = await shove({
      token: target,
      by,
      direction,
      distance: feet,
      label: game.i18n.localize("NOODLRHOOKS.Combat.Forced.ByHand"),
    });
  }
  return results;
}

const api: NoodlrHooksApi = {
  noodlrHooks: descriptor,
  runNpcTurn: () => runCurrentNpcTurn(),
  /** Give back everything a mercy ruling took off the party. */
  restoreForfeitedGear: () => restoreForfeited(),
  /** Dump what the planner can read off the selected combatant, and how it scored its options. */
  explainTurn: () => explainTurn(),
  /** Census every sheet in the world: activity shapes, activation types, ranges, flags, economy claims. */
  surveyActions: (opts) => surveyActions(opts),
  /** Really move the selected token one square, reporting what core said at each stage. */
  testMove: () => testMove(),
  /** Which creatures can see which, with distances, detection modes and each verdict. */
  surveyPerception: () => surveyPerception(),
  /** What every combatant has left this turn, and how many attacks one action buys them. */
  surveyEconomy: () => surveyEconomy(),
  /** How far each combatant has moved this turn against its Speed. */
  surveyMovement: () => surveyMovement(),
  /** Which push/pull rules are recognised on the selected creature, and whether the layer is live. */
  surveyForced: () => surveyForced(),
  /** Whether rolled damage is being applied here, for whom, and what could be put back. */
  surveyDamage: () => surveyDamage(),
  /** Which Damage buttons are held shut, why, and whether a verdict is still expected. */
  surveyGate: () => surveyGate(),
  /** Which saving throws are outstanding, who is rolling them, and what they will settle. */
  surveyDamageSaves: () => surveyDamageSaves(),
  /** Which reactions the selected creature would be offered, who gets asked, and what costs something. */
  surveyOffers: () => surveyOffers(),
  surveyCounterspell: () => surveyCounterspell(),
  /** Who could spoil the selected creature's next good roll, and whether anything is holding one open. */
  surveyBarbs: () => surveyBarbs(),
  /** Whether the selected creature would be offered Sneak Attack, who is asked, and what has spent it. */
  surveySneak: () => surveySneak(),
  /** What the selected creature is holding, for what trigger, and whether a compiler is listening. */
  surveyReady: () => surveyReady(),
  /** What the selected creature has left to resist with, and how much damage would be worth asking about. */
  surveyLegendary: () => surveyLegendary(),
  /** What condition combat math would apply for the controlled token against its current target. */
  surveyConditions: () => surveyConditions(),
  /** Who is dying, who is dead, and what the last drop to zero did. */
  surveyDying: () => surveyDying(),
  /** Who is concentrating on what, and who would roll the save. */
  surveyConcentration: () => surveyConcentration(),
  /** Whether each selected token may hide where it stands, and what it would cost. */
  surveyHide: () => surveyHide(),
  surveyAwareness: () => surveyAwareness(),
  /** Take the Hide action with every selected token. `force` skips prerequisites and the cost. */
  hide: (opts) => hideSelected(opts),
  /** What the selected token can leap, with and without the run-up it currently has. */
  surveyJump: () => surveyJump(),
  /** Whether the selected token is Prone, what standing would cost, and whether it already stood. */
  surveyProne: () => surveyProne(),
  /** Post that same reading to chat, because "can I get across that?" is the table's question. */
  jump: () => announceJump(),
  /** Whether the selected token is close enough to open a door, and who this client would measure. */
  surveyInteract: () => surveyInteract(),
  /** Which creature auras are on the scene, who they reach, and which copies we wrote. */
  surveyAuras: () => surveyAuras(),
  /** Which tokens are transformed, and whether a leftover restore badge is still on them. */
  surveyTransform: () => surveyTransform(),
  /** Who is riding whom, and whether Rideable has the layer. */
  surveyRiding: () => surveyRiding(),
  /** Mount every selected token onto the current target. */
  mount: () => mountSelected(),
  /** Dismount every selected rider. */
  dismount: () => dismountSelected(),
  /** Throw every rider off the selected mount. Revert also does this. */
  dumpRiders: async () => {
    let n = 0;
    for (const token of (canvas as any)?.tokens?.controlled ?? []) {
      n += await dropAllRidersOf(token?.document ?? token, { requireGm: false });
    }
    return { dumped: n };
  },
  /** Restore the selected token's original form. Does not spend a Wild Shape use. */
  restoreTransformation: async () => {
    let n = 0;
    for (const token of (canvas as any)?.tokens?.controlled ?? []) {
      if (await restoreOriginalForm(token?.actor)) n += 1;
    }
    return { restored: n };
  },
  /** Tokens currently running off the scene, and how many of their own turns they have left. */
  surveyFlee: () => surveyFlee(),
  /** Which save-ends effects the selected creature is still carrying, and who is rolling them. */
  surveyRepeatSaves: () => surveyRepeatSaves(),
  /** Whether a spent Recharge 5–6 would roll itself, and what on the selected creature is spent. */
  surveyRecharge: () => surveyRecharge(),
  /**
   * Register a save-ends clause on every selected token, for an effect applied off a stat block.
   * `{status: "paralyzed", ability: "con", dc: 13, source: "Ghoul's Claw"}`.
   */
  repeatSave: async (clause) => {
    for (const token of (canvas as any)?.tokens?.controlled ?? []) {
      await noteRepeatSave(token?.actor, clause);
    }
  },
  /** What an Influence attempt against each target would face: attitude, DC, and what is locked. */
  surveyInfluence: () => surveyInfluence(),
  /** Talk every targeted creature round with the selected one. The GM is asked for the stance. */
  influence: (opts) => influenceTargets(opts),
  /** Forget every 24-hour refusal in the world. The undo for a lockout that landed wrong. */
  clearInfluenceLocks: () => clearInfluenceLocks(),
  /** The selected token administers first aid to whatever it has targeted. */
  firstAid: () => firstAidTargets(),
  /** What this module does about each of the general rules, and why it does nothing about the rest. */
  surveyGeneralRules: () => surveyGeneralRules(),
  /**
   * Every 2024 PHB action item on this world's character sheets, and what pressing it actually does.
   * Reach for it when a button appears to do nothing: an `unbuilt` row is a rule nobody wired, which
   * from the table looks exactly like one that broke.
   */
  surveyActionButtons: () => surveyActionButtons(),
  /**
   * Items whose name is a general rule, and whether the compiler skips them.
   *
   * Answers one question and only one: does imported content drop `system.identifier`, leaving the
   * `feat`-only name test as the sole recogniser. A `MISSED` count of zero means the asymmetry costs
   * this world nothing and the test must NOT be widened.
   */
  surveyGlossary: () => surveyGlossary(),
  /** Manual forced movement, for a rule the automatic layer does not recognise. */
  push: (feet = 10) => shoveTargets(feet, "away"),
  pull: (feet = 10) => shoveTargets(feet, "toward"),
  /** Put back every creature moved by a push or pull in the current fight. */
  undoForcedMovement: () => undoForcedMovement(),
  /** Reverse the most recent drop-to-zero rulings. */
  undoDying: () => undoDying(),
  /** What the capability primitives can see: system, scene, summons, whether a fight is running. */
  surveyPrimitives: () => surveyPrimitives(),
  /** Which creatures on the scene are running compiled capabilities, and what each rule does. */
  surveyCapabilities: () => surveyCapabilities(),
  /** What this scene WOULD ask about, and what it costs nothing because the cache already has it. */
  surveyScene: () => surveyScene(),
  /** Everything a compiled capability says is permanently true about the selected creatures. */
  surveyStanding: () => surveyStanding(),
  /** Cached descriptors nothing can reach any more, and which of them are safe to remove. */
  surveyOrphans: () => surveyOrphans(),
  /** Which ruleset each cached reading was made under. Reports; never spends. */
  surveyCacheAge: () => surveyCacheAge(),
  /** Remove them. `declined` only by default; `{includeAbsent: true}` for the probable ones too. */
  pruneOrphans: (options?: { includeAbsent?: boolean }) => pruneOrphans(options),
  /** Read the scene now, rather than waiting for the next load. */
  compileScene: () => collectScene(),
  /**
   * Ask about every wording in the world again, ignoring the cache. SPENDS ONE COMPILE PER WORDING.
   *
   * The only route to a better answer after a doctrine or vocabulary change: the cache key is the
   * prose, so an improved compiler is invisible to text that has already been read once.
   */
  recompileWorld: (options?: { since?: number }) => recompileWorld(options),
  /** The review window for one creature. Defaults to the selected token, or your own character. */
  openCapabilities: (actor?: unknown) => openCapabilitySheet(actor),
  /** The settings windows: "house", "mechanics" or "combat". */
  openRules: (page?: string) => openRulesConfig(page),
  /**
   * Who is enforcing each rule right now, plus every advisory and suspected conflict.
   *
   * The console form of what the settings windows show. Reach for it first when a switch is on and
   * nothing appears to be happening — a stand-aside is silent by nature, and this is where it speaks.
   */
  surveyOwnership: () => ({
    rules: allOwnership(),
    advisories: advisories(),
    conflicts: conflicts(),
  }),
  flattenElevation: () => flattenElevation(),
  restoreElevation: () => restoreElevation(),
};

Hooks.once("init", () => {
  log(`initializing (Foundry ${game.version ?? "?"})`);
  registerCombatSettings();

  // Speed as an actual limit, which nothing else in the stack treats as one. Here rather than in
  // `ready` for two reasons: it installs a Token subclass at `setup`, which has already passed by the
  // time `ready` runs, and it has to be on the PLAYERS' clients, since a player dragging their own
  // token is the only thing it constrains.
  registerMovementCap();
  // After the Speed subclass: MouseInteractionManager copies `_onClickLeft` at draw, and canvas
  // init finishes before `ready`. A wrap registered here at `setup` is what makes the Wild Shape
  // restore icon actually fire.
  installTokenBadgeClicks();

  // A zero-cost, wall-respecting movement action for pushes and pulls. Must be here: core deep-freezes
  // the action registry inside `setupGame()`, before the `setup` hook, and writing to a frozen object
  // is a silent no-op rather than an error. Everything downstream feature-detects the key regardless.
  registerForceAction();

  const mod = game.modules.get(MODULE_ID);
  if (mod) mod.api = api;

  // And again at the console, because every diagnostic in AGENTS.md is written `api.surveyX()` and there
  // is no `api` in a browser console. Reported twice as the surveys "erroring" (2026-08-15), which is
  // exactly what `game.modules.get(...).api` misremembered as `api` produces: a ReferenceError that says
  // nothing about the module. `noodlrHooks` rather than `api` because a one-word global belongs to
  // whoever grabs it last, and this is the same prefix the hooks already use.
  (globalThis as any).noodlrHooks = api;
});

Hooks.once("ready", () => {
  log("ready");

  // Action economy and condition combat math. These hooks fire on the ROLLING client — often a player
  // — so they must not live inside the GM-only block below.
  registerEconomyHooks();
  // Drop leftover single-targets on template spells. Same hook, never a veto, and it must
  // run on the using client — that is whose `game.user.targets` dnd5e snapshots onto the card.
  registerTemplateTargets();
  registerConditionHooks();
  // Drop-to-0 Unconscious/Dead and damage-at-0 death failures. Writes on the updating client.
  registerDyingHooks();
  // Concentration saves. Deliberately not GM-only: the whole point is that a character's save is
  // rolled on the player's own client, which is also the only client allowed to roll it.
  registerConcentrationHooks();
  // Hiding: the declaration and the roll are read by the primary GM (gated inside), but the REVEAL
  // comes off `dnd5e.rollAttack`, which fires only on the client that rolled.
  registerStealthWatch();
  // Same reasoning: the Invisibility spell ends on the caster's own client.
  registerInvisibilityHooks();
  // The Disengage button, watched wherever it is pressed: the client that presses owns the sheet, and
  // so is the only one allowed to write the mark the opportunity-attack layer reads.
  registerDisengageWatch();
  // Step of the Wind doubles a jump for one turn, and only once the Focus Point is spent — so the
  // marker has to come off the button rather than off the sheet, on whichever client pressed it.
  registerJumpWatch();
  // Standing and crawl. Every client: a player standing or walking while Prone is that client's move.
  registerProneWatch();
  // Door reach. Every client: the presser's `preUpdateWall` is the one that can veto a click.
  registerInteractReach();
  // Creature auras. Every client hears movement; only the primary GM writes copies onto other sheets.
  registerAuraWatch();
  // Wild Shape restore icon. Every client: a player who Wild Shapes must get the badge on their token
  // without waiting for the GM, and they are the one who clicks it.
  registerTransformWatch();
  // Mount / follow / dismount. Every client: the rider's own drag is the one that must be refused,
  // and a player mounts from their own HUD.
  registerRidingWatch();
  // Dodge: the same watch, plus the expiry nothing in the stack performs. Half of it is GM-only, and
  // that gate is inside.
  registerDodgeHooks();
  // "Repeat the save at the end of each of its turns." Registered on every client, because the save
  // is rolled by whoever owns the afflicted creature rather than by the GM.
  registerRepeatSaveWatch();
  // Recharge 5–6 at the start of an NPC's turn. Primary-GM gated inside: the recovery hook can
  // fire on every client, and two dice on a failure would grant a breath nobody earned.
  registerRecharge();
  // Influence needs the GM's ruling and writes a flag on an NPC the asking player cannot touch. The
  // handlers are registered everywhere because core resolves a query on the RECEIVING client.
  registerInfluenceQueries();
  // A reaction is offered to whoever plays the creature, which for a character is the player. Same rule
  // as Influence: the GM detects the trigger, and the client that owns the sheet draws the prompt, spends
  // the reaction and rolls it.
  registerReactionOffers();
  // Sneak Attack, same shape and for the same reason: the GM's client reads the hit, and the rogue's own
  // client draws the dialog and rolls `@scale.rogue.sneak-attack` against its own roll data.
  registerSneakOffers();
  // And the feature being pressed from the sheet is watched everywhere, because the press happens on
  // whichever client owns the rogue and the turn has to be marked spent from there.
  registerSneakWatch();
  // A readied action is released by whoever owns the creature, for the same reason. Registered on every
  // client because the addressee is decided by who is playing, not by who noticed the trigger.
  registerReady();
  // And the compiler is asked from wherever Ready was pressed, which for a character is a player's
  // client. Routed to the GM so a player's browser never spends the world's credit.
  registerWatchRelay();
  // The Damage button held shut until the attack has been resolved. Every client, and that is the whole
  // point: the press to stop happens on the roller's own machine, and only that machine can refuse it.
  registerDamageGate();
  // Automated attacks skip the system's roll-configuration dialogs. Every client: a reaction
  // can roll on the GM, and `preRollAttack` fires only where the roll is built.
  registerAutoRoll();
  // The system's cards drawn at half height, if this screen asked for it.
  applyCompactCards();
  // What hurt whom, when, and with what. Every client keeps its own ledger, because the amount is
  // only computable from `updateActor` (which fires everywhere) while the damage TYPES arrive on the
  // applying client. A GM-only ledger would be blind to damage a player applied.
  registerDamageLog();
  // Compiled capabilities. Registered on every client so a rule can be evaluated wherever its trigger
  // fires; the executor itself defers the world mutation to the primary GM.
  registerCapabilityExecutor();
  // And the half that reads the sheets. Also every client: the cache is a plain file, and a player's
  // client needs the bindings for the action ledger to see a compiled Multiattack. Only the primary
  // GM ever requests a compile or writes the cache; that gate is inside.
  registerCapabilityCollector();

  if (game.user?.isGM) {
    // Bring stored settings up to what this build registers: the copy out of the `noodlr` namespace,
    // and the fan-out of the three per-audience rules. Each step runs once per world.
    void migrateSettings();
    // Combat dossiers live only for the skirmish: forget a creature's turn history when it dies or
    // the fight ends. Automation opt-ins are per-encounter too.
    registerDossierCleanup();
    registerAutomationCleanup();
    registerAutomationTurnHook();
    // Hostile creatures noticing the party and starting the fight without a GM's clicks.
    registerPerceptionWatch();
    // Off-turn reactions: opportunity attacks and hitting back when hurt.
    registerReactionHooks();
    // Pushes, pulls and shoves actually moving the creature they land on.
    registerForcedMovement();
    // Rolled damage landing on whoever was hit, which is also what switches on every rule that hangs
    // off dnd5e's damage hook: death saves, Unconscious at zero, instant death, concentration.
    registerDamageApplication();
    // A saving throw joined back to the spell that asked for it, so half of 24 is nobody's arithmetic.
    registerSaveResolution();
    // Noticing that somebody's readied trigger happened. One client watches, or every client asks the
    // same player about the same goblin's step.
    registerReadyWatch();
    registerReadyExpiry();
    // Watches whether the party is still swinging, which is what mercy hangs on.
    registerEncounterTracking();
    // A fleeing token is taken off the scene when combat is wiped mid-run-off, so it cannot
    // start a new fight the moment peace expires.
    registerFleeHooks();
    // A Capabilities button on every creature sheet. GM-only: it is the veto over what a model read,
    // and it spends credit.
    registerCapabilitySheet();
  }
});

// One scene-control group, GM-only, holding the single tool that has to be a button rather than an
// automatic behaviour: opting an individual creature into automation mid-fight.
//
// Foundry v13+ passes `controls` as a Record keyed by name. A custom group MUST define `activeTool`
// naming a tool that exists — and it must NOT be one of the real buttons, because whichever tool is
// active is skipped when clicked. The inert `home` entry exists solely to absorb that role, and is
// hidden so it does not appear as a dead icon in the flyout.
Hooks.on("getSceneControlButtons", (controls: Record<string, any>) => {
  if (!controls || typeof controls !== "object") return;
  if (!game.user?.isGM) return;
  // Only offered in "partial" automation: in "full" every creature is played anyway, and in "off" the
  // GM has said they want the fight in their own hands.
  if (getCombatAutomation() !== "partial") return;
  try {
    controls[MODULE_ID] = {
      name: MODULE_ID,
      title: "NOODLRHOOKS.Controls.GroupTitle",
      icon: "fa-solid fa-dice-d20",
      order: 90,
      activeTool: "home",
      tools: {
        home: {
          name: "home",
          title: "NOODLRHOOKS.Controls.GroupTitle",
          icon: "fa-solid fa-dice-d20",
          order: 0,
          visible: false,
          onChange: () => {},
        },
        npcTurn: {
          name: "npcTurn",
          title: "NOODLRHOOKS.Combat.ToggleAutomation",
          icon: "fa-solid fa-hand-fist",
          order: 1,
          button: true,
          visible: true,
          onChange: () => void toggleSelectedCombatantAutomation(),
        },
      },
    };
  } catch (err) {
    log("could not add scene controls:", err);
  }
});

// Re-exported so a companion module can import the contract's types without depending on this
// package, and so the shape stays greppable from one place.
export { announceRuling, proposeRuling, requestBehavior };
export type {
  Ruling,
  RulingKind,
  BehaviorRequest,
  BehaviorVerb,
  TurnEvent,
} from "./integration/contract";
