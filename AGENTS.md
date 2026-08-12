# AGENTS.md — noodlr-hooks-55e

Durable memory for **noodlr-hooks-55e**, the D&D 5e (2024) rules-automation module. Auto-loaded as
context; keep it current with durable facts and decisions, never secrets.

## What this is

A standalone Foundry VTT module that enforces the rules D&D 5e states and nothing enforces. It was
split out of [`noodlr`](../noodlr-main/AGENTS.md) on 2026-08-08 — noodlr had started game-system
agnostic and accumulated months of 5e-specific enforcement, which made it hard to maintain and would
have made a second game system impossible. That module is now an AI game master with no opinion about
which game is being played; this one is the rules, with no AI in it.

**Neither module depends on the other.** noodlr-hooks-55e alone is a complete automation module that
runs a fight with nobody narrating. noodlr alone is a chatbot and media generator that never touches a
rule. Together they are what shipped as noodlr v0.4.48.

## Design principles inherited from noodlr

0. **No third-party module is ever a dependency.** Midi QoL is the case that prompted it: superb,
   widely installed, and repeatedly quiet for months at a stretch, so anything built on it strands the
   table when it lapses. Learn from them, depend on none of them. Where a module IS present it may
   raise fidelity — the item-use path routes through midi when it exists — but every feature must work
   with nothing installed but Foundry and dnd5e. Prefer detection signals core cannot take away: token
   position hooks and a hit-point decrease exist in every version; "the attack roll is about to
   resolve" does not.
1. **Rules versus tactics.** This module may know **where the system keeps its numbers** and **which of
   a creature's options are worth considering**. Deciding "close with the wizard and swing the rusty
   scimitar" is tactics and is ours. Working out whether the swing lands is the system's and midi's.
   The planner picks a verb, an implement and a target; it never computes an attack roll, damage, a
   save, a DC or a condition.
2. **Mechanics belong to mechanics modules.** Where midi-qol, DAE, Chris's Premades, Gambit's or
   Automated Conditions 5e already resolve something, stand aside rather than compete. Each stand-aside
   check lives beside the code it guards, and every one of them was read from that module's source
   rather than assumed.

## Layout, and why it is this shape

Four folders. The split is the plan for a second game system rather than tidiness:

- `src/system/` — everything that knows a D&D name: spell tables, feat identifiers, sheet paths,
  condition rules, reward arithmetic. **A `noodlr-hooks-pf2e` replaces this folder and nothing else.**
  Rules-as-data, not branches: nothing in `rules/` or `tactics/` ever learns a spell name.
- `src/rules/` — enforcement. Conditions, dying, concentration, stealth and hiding, perception and
  encounter initiation, reactions, forced movement, and `rules/economy/` (action slots and Speed).
- `src/tactics/` — what a creature does with its turn: the planner, the cognition tiers, the dossier,
  the per-encounter registry, banter profiling, the turn hooks.
- `src/core/` — geometry and measurement with no rules in it: the board, token movement, cover and
  hiding searches, sight screens, hazard containment, seeded randomness. Portable as-is.
- `src/capability/` — the runtime compiler's deterministic half: the cache, the scene collector, the
  executor, the predicates and the world-mutation primitives. Knows no D&D names either; what it runs
  was read off the sheet rather than written here.

Plus `src/integration/` (`contract.ts`, what we tell noodlr, and `capability.ts`, the descriptor
schema), `src/apps/capability-sheet.ts` (the GM's veto over what a model read), `src/settings.ts`
(every setting and the reasoning behind each default), and `src/util/`.

## The integration contract

Five hooks, named `noodlrHooks.*` rather than after this module, so a future `noodlr-hooks-pf2e` fires
the same five and a listener is written once. Full shapes in `src/integration/contract.ts`.

- `noodlrHooks.preRuling` — stopping (`Hooks.call`). Returning false cancels the ruling. Synchronous by
  necessity, because callers are inside Foundry `pre*` hooks; a model cannot answer here, which is why
  noodlr deliberately does not listen to it.
- `noodlrHooks.ruling` — `{kind, module, systemId, summary, detail, actor, token, combat, undo?}` after
  the fact. Seven kinds fire today: `condition`, `dying`, `concentration`, `forced`, `surprise`,
  `encounter`, `influence`. `undo` is present only where a reversal really exists.
- `noodlrHooks.behavior` — `{verb, ...}` for a social move. `FLEE`, `SURRENDER` and `MERCY` fire from
  `tactics/encounter.ts`; `PERSUADE`, `DECEIVE`, `INTIMIDATE`, `BRIBE` and `PARLEY` now fire from
  `rules/influence.ts`, which is the first trigger any of the five has ever had. `AMBUSH` and
  `DISTRACT` are still declared with no trigger, so adding one is a call site rather than a contract
  change.
  - **`incoming: true` means the verb is being done TO `actor`, and it arrived with Influence.** Every
    earlier verb was self-directed — a creature that FLEEs is the one fleeing — so a listener could
    safely read `actor` as the doer. A creature that is PERSUADEd is the one *responding*, and it is
    still the one whose voice is wanted: noodlr voices NPCs, so handing over the party's negotiator by
    swapping `actor` and `target` would name a player character as the speaker. The flag reverses the
    sentence instead. Fire it on any request where the named creature is the recipient, and expect a
    listener that ignores it to narrate the right creature saying the wrong thing.
- `noodlrHooks.turn` — a planned turn, before it is announced, carrying the intent, the GM-only
  reasoning, and a `BanterProfile` read off the sheet. A listener may rewrite the intent.
- `noodlrHooks.compile` — protocol 2. A BATCH of features whose prose needs turning into descriptors,
  so a listener can run the whole scene concurrently. See the capability-compiler section below.

**`waitFor` is the reason these work at all.** Foundry hooks are synchronous; a listener that wants to
post a card or generate a line pushes its promise into `waitFor` and this module awaits it before
continuing. Without it a narration lands after the dice it was meant to introduce.

**Nothing here is required.** Every hook is fire-and-forget when nobody is listening, and the rules
consequence is identical either way. A behavior request returning false is the normal case.

## Flags are a user-facing contract

Every escape hatch — `extraAction`, `extraBonus`, `extraReaction`, `attacksPerAction`, `bonusDash`,
`damageRider`, `sniper`, `bonusHide` — was documented under `flags.noodlr.*` before the split, and GMs
have Active Effects built against those paths. **`src/util/flags.ts` reads this module's namespace and
falls back to `noodlr`'s; writes only ever go to this module's own.** The fallback is permanent, not a
migration window: there is no way to rewrite an Active Effect somebody authors next year against the
older documentation, and an effect targeting a flag nobody reads fails silently.

Two live-state flags get the same treatment for sharper reasons. Banked stealth (`stealth`) clears from
both namespaces, because a hide nobody can clear would suppress every encounter forever and look exactly
like the module being broken. The mercy forfeiture (`mercyForfeit`) restores from whichever namespace
holds the payload, because that flag is the only copy of a stripped party's gear.

Settings migrate once: `migrateLegacySettings()` copies `noodlr.combat.*` into this module's namespace on
first load, reading through `game.settings.storage` because the old keys are no longer registered and
`get` throws on an unregistered key.

## THE SECOND PIVOT (2026-08-09) — the runtime capability compiler

Hand-coding rules ended here, and the number that ended it is `noodlr-rules-corpus`'s own:
**6,018 distinct new engines covering 35,969 rules**. That is not expensive, it is arithmetically dead.
Worse, the top of that queue is not rules at all — "the eye has Darkvision 30 feet", "the plant makes
three Vine attacks" are per-creature FACTS, already answered at runtime by `sheetSenses` and
`attacksPerAction`, and they only look like gaps because the corpus reads books instead of sheets.

So the sheet becomes the source. A frontier model reads each creature's own prose **once**, at scene
load, and compiles it into a machine-readable descriptor; deterministic code executes that descriptor
every turn. Three things fall out for free: the 8,343 conflicts the corpus found stop mattering,
because the actor on the scene IS the precedence answer; licensing dissolves, because the module ships
no book text and reads what the operator already owns; and future books need no mining.

**The one non-negotiable: the model COMPILES, it never ADJUDICATES.** This does not reopen the v0.4.22
decision to cut the per-turn model call. The call moved to scene load, not into the turn. Nothing in
`src/capability/` is async during a turn and nothing there can reach the network.

### What is where

- `src/integration/capability.ts` — the schema, and the only source of truth for it. 17 trigger
  events, 36 effect kinds, 20 predicate kinds, the three-way `engine | narration | gm` adjudication
  axis. `validateCapability()` is the gate.
- `src/integration/contract.ts` — `requestCompile()`, protocol **2**. Same `callAll` + `waitFor` +
  `handled` shape as `requestBehavior`, with one deliberate difference: it hands over a **batch**, so
  the listener can run a whole scene concurrently instead of one feature at a time.
- `src/capability/cache.ts` — file-backed shards under `assets/noodlr-hooks-55e/capabilities/`,
  in-memory `Map` warmed at ready, keyed by normalized prose hash.
- `src/capability/collect.ts` — walks the scene's actors, extracts features, dedups by prose hash,
  consults the cache, batches the misses into one request.
- `src/capability/{executor,predicates,primitives,uses,quantity,bindings,damage-log,describe}.ts` —
  the deterministic half.
- `src/apps/capability-sheet.ts` — the GM's veto.

### The findings that shaped it, all measured rather than argued

- **Comprehension was never the problem; the output contract was.** The corpus probe
  (`scripts/probe-vocabulary.mjs`) found the model reads these rules correctly — Loathsome Limbs came
  back with `on_turn_end` plus both guards that matter — while **0 of 73,546 mined conditions were
  structured** and `other` alone carried **1,367 distinct parameter keys**. The mining vocabulary was
  closed at the KIND level and wide open at the PARAMETER level. This schema closes both: every effect
  kind states exactly which parameters it takes, and conditions are predicates rather than sentences.
- **`summon_creature` was genuinely missing**, confirmed before adding it: summon-like atoms' largest
  bucket was `UNCLASSIFIED / other` at 289. The other 35 kinds are the corpus's, unchanged.
- **The cache key is the prose, not the creature.** 4,661 SRD features reduce to **1,387 distinct
  wordings**, and one trait's text is shared by **270 creatures** — traits are templated with
  `[[lookup @name lowercase]]` rather than naming their owner, so the same Pack Tactics is
  byte-identical everywhere. A scene of twenty goblins costs one reading. `normalizeProse` folds
  whitespace and strips tags and **must never touch words or numbers**: "15 or more Slashing damage"
  and "5 or more" are different rules.
- **Sharded and flushed, not one file written through.** Sixteen shards by first hex digit; `put`
  marks dirty and the collector awaits one `flush` per batch. One file rewritten per store makes a
  forty-feature scene load forty O(n) uploads.
- **Not a world setting.** Foundry ships every world setting to every client and this payload
  interests exactly one of them.

### Invariants, and the reasoning that is easy to undo

- **Every escape hatch fails CLOSED.** An effect kind of `other`, or a `custom` predicate, means the
  model understood a rule it could not express — and a guard that cannot be evaluated must PREVENT the
  rule from firing, never be skipped. A trait that silently heals when it should not is undetectable
  at the table; one that never fires shows up on the capability sheet as needing a human. Same
  reasoning as `verdictFromSignals` declining on unknown coverage in the corpus.
- **`locked` is load-bearing.** Once a GM has fixed a bad compile, a model upgrade or a cache miss
  must never silently overwrite it. `rejected` is remembered for the same reason: re-asking about a
  wording that has already been thrown away spends credit to reach the same answer.
- **The descriptor cache is shareable, and that is a designed property.** Descriptors are mechanics;
  mechanics are not copyrightable. `exportable()` strips `prose`, which is the same boundary
  `assertNoQuotes` enforces at the other end of the corpus pipeline. A GM can publish a compiled
  cache and others can drop it in.
- **Nothing here is required.** With no listener, `requestCompile` returns unhandled, no descriptors
  exist, and the planner behaves exactly as it did before any of this. The switch
  (`capabilities.compile`) defaults **off**, because it spends the operator's own credit.
- **The six primitives were worth building regardless**, and were built first for that reason: direct
  damage and healing, a generalised `damageTaken` event carrying `{amount, types[], source}`,
  create/delete token, insert a combatant at a chosen initiative slot, generic condition apply
  including stacked exhaustion, and a use-counter mutator outside `activity.use`.
- **The damage log lives on every client.** The amount is only computable from `updateActor`, which
  fires everywhere, while the damage TYPES arrive on the applying client. A GM-only ledger would be
  blind to damage a player applied.

Diagnostics: `api.surveyPrimitives()`, `api.surveyCapabilities()`, `api.surveyScene()` (what this
scene WOULD ask about and what the cache already answers), `api.compileScene()`, `api.openCapabilities()`.

### Five of the seventeen triggers are wired, and the sheet has to say so (2026-08-11)

`registerCapabilityExecutor()` attaches a hook to `on_damage_taken`, `on_zero_hp`, `on_turn_start`,
`on_turn_end` and `on_activity_use`. The other twelve never fire. That is fine and was always the
design — the compiler is offered all seventeen because "the cloak recharges on a long rest" is a true
reading whether or not this build listens for one, and a vocabulary that hid the unheard events would
teach the model to mis-file rules rather than skip them.

**What was wrong is that `isExecutable()` never looked at the trigger.** It gated on adjudication, the
effect kind and the predicates, so a rule with a perfectly executable `heal` hanging off
`on_long_rest` was badged **active** on the capability sheet while nothing on earth would ever run it.
The comment above the executor's wiring block asserted the opposite in plain English — "the rest are
legitimate compiler output and simply never fire, which the capability sheet shows as inert" — which is
the worst version of this bug: the intent was written down, believed, and never implemented. Fixed by
`WIRED_TRIGGERS` in `integration/capability.ts`, checked first in `isExecutable()`, which feeds the
sheet badge, the `runs` column of `api.surveyCapabilities()` and the executor's own refusal from one
place. **Wiring a new hook means adding its event to that list in the same change**, or the sheet will
go on calling a working rule dead — the inverse failure, and the harder one to notice.

This is the same principle as the ownership resolver, arriving from the other direction: there we made
a rule that had stood aside say so, and here a rule that cannot fire. `always`, `on_short_rest` and
`on_long_rest` are all correctly inert today; `noteRest()` in `capability/uses.ts` exists and has no
callers.

### What the enabled-module audit gave the compiler (2026-08-11)

From `_research\_audit\overlap-effects-and-summons.md`, which read all ten from source.

- **Aura Effects answers `on_enter_area` in the platform's own terms, and we should copy it rather than
  stand aside from it.** It converts an aura into a real `RegionDocument` flagged with its own origin,
  then reads entry and exit as a **set difference on `token.regions`** against a `_priorRegions`
  snapshot stashed in the `updateToken` options — core's containment bookkeeping doing the geometry, so
  shape and elevation come free. Application is routed to a single client through
  `CONFIG.queries["auraeffects.applyAuraEffects"]` invoked as `activeGM.query(...)`, which is our
  `isPrimaryGM()` discipline in the newer core idiom. **No libWrapper anywhere in it.** Strictly better
  than the movement-hook distance scan we would otherwise have reached for, and the two cannot collide
  because ours would carry our own origin flag.
- **Effect Macro is the one real conflict, and it is ours to fix.** Its trigger list duplicates six of
  ours by meaning (`onTurnStart`, `onTurnEnd`, `onCreate` on a status-bearing effect, and via dnd5e
  `damageActor` and `restCompleted`). It fires nothing on its own — a human must paste JS into
  `flags.effectmacro.<trigger>` — so the collision is narrow and specific: **a premade or DDB-imported
  item that already carries a macro for the trait our compiler reads off the same prose**, e.g. a
  regeneration that heals twice. Nothing on either side detects it and no setting of theirs removes it.
  Planned stand-aside, same shape as `alreadyAutomated()`: the collector skips a feature whose effects
  carry `flags.effectmacro` keys. Their executor election is `getDesignatedUser() ?? activeGM`, the
  same answer as our `rollerForActor`.
- **Rest Recovery cancels dnd5e's `pre*` rest hooks and then re-enters `actor._rest()`**, so
  `dnd5e.restCompleted` still fires and is the hook to use when rest triggers are wired. It owns
  per-item recovery, so a descriptor restoring the same counter double-restores — harmless for
  set-to-max, wrong for "regain 1d4 uses".
- **DAE is trending legacy and must not be leaned on.** Foundry v14 absorbed the expiry model
  (`CONST.ACTIVE_EFFECT_EXPIRY_EVENTS`, plus `start.combatant` so source-turn versus target-turn is
  expressible natively), and DAE v14 is down to two corrective libWrapper patches whose own comments
  defer further to dnd5e 6.0. What it still uniquely supplies is the change-key vocabulary
  (`macro.*`, `ATL.*`, `StatusEffect`) that DDB-imported items depend on — which is the DDB finding
  already recorded below, seen from the other end. It does **not** manage exhaustion
  (`DAEdnd5e.ts:382` deletes it from its own base-value handling), so our
  `flags.dnd5e.<condition>Level` encoding is uncontested.
- Convenient Effects 9.2.5 does **not** override `CONFIG.statusEffects` or the token HUD, and applies
  nothing without the separate `dfreds-triggers` module, which is not installed. Its exhaustion code is
  gated on its own `ceEffectId`, so a status we write natively never reaches it. Automated Evocations,
  Polyglot and Visual Active Effects are inert with respect to everything here.

### What the same audit found about space, sight and movement (2026-08-11)

From `_research\_audit\overlap-space-and-sight.md`. The cover half of it retired build-queue item 1,
above. The rest:

- **A module that teleports by deleting and recreating the token destroys every flag we own, silently.**
  `stairways` 0.12.0 does exactly this (`teleport.js:37-40`), so the arriving token is a new id with no
  banked stealth, no economy budget stamp, and — the one that matters — **no `mercyForfeit` payload,
  which is the only copy of a stripped party's gear.** No movement hook fires either, so nothing of ours
  gets a chance to migrate anything. There is no defence available from our side short of watching
  `deleteToken`, and the honest mitigation is to know it: a forfeiture that must survive is one the GM
  should restore before anyone takes the stairs. Terrain Mapper's stairs are the safe kind — they pause
  the move and prompt, which our stall watchdog already survives.
- **`isForcedMovement()` is broader than our own action, deliberately, and the audit's proposed split is
  based on a misreading — checked before acting on it.** The finding is right that `regionba` 1.5.2 uses
  `action: "displace"` for teleports and for Prevent-Movement bounce-backs (`teleportToken.js:53`,
  `stopMovement.js:109`). The recommendation was to stop exempting `displace` from the Speed budget.
  **There is no such exemption to remove:** every path in `rules/economy/speed.ts` — the `maxCost`
  truncation, the `preMoveToken` refusal and the `moveToken` Dash charge — gates on
  `movement.method` being `dragging` or `keyboard`, so an API move never reaches any of them, and
  `isForcedMovement` is not imported anywhere in `economy/`. Its only two callers are the reaction layer
  and the grapple-drag guard, and for both a bounce-back genuinely should not provoke. The residue is
  the opposite of the one reported: a bounced creature keeps the walked distance charged in core's
  `movementHistory` while standing where it started, so it is under-refunded rather than over-served.
  That is the safe direction and it is core's history doing it, so it stays.
- **Patrol's shallowness is confirmed from source**, as the older note here inferred: `patrol.js:242` is
  literally `visionPolygon.fov.contains(centre)` with no `testVisibility` and no detection modes. It
  creates no combat and is gated on `!game.combat?.started`. It exposes a stopping hook,
  `prePatrolAlerted` — worth taking, so Patrol stops raising the alarm about a creature our stealth
  layer has already ruled unseen.
- `walls-have-ears` is audio only, but its `CONFIG.Canvas.polygonBackends.sound.testCollision(...,
  {type: "sound"})` is the answer if hearing ever becomes a sense we model. `smarttarget` is harmless;
  `about-face` only matters in rotate mode, and this table is on flip.

### What it found about turn flow and the economy (2026-08-11)

From `_research\_audit\overlap-turnflow-and-economy.md`.

- **A module that suppresses the system's chat card makes every capture we own go blind, silently.**
  Monk's Token Bar passes `messageConfig.create = false` for group and contested rolls
  (`systems/dnd5e-rolls.js:174`), so no dnd5e card is created and `flags.dnd5e.roll` never exists.
  Everything here that watches `createChatMessage` — the Stealth capture above all, but also the
  attack and save readings the forced-movement layer depends on — simply never sees those rolls. A
  group Stealth check requested through the token bar hides nobody, and nothing anywhere reports why.
  Its own surface is `updateChatMessage` on `flags["monks-tokenbar"].tokens[<id>].roll` if we ever want
  to read it. **Generalise the lesson: our roll captures assume the system's card exists, and that is an
  assumption any roll-requesting module can break.** Now warned about in `advisories()`.
- **`hurry-up` races the planner's own turn advance.** `CombatTimer.onEnd()` calls
  `game.combat?.nextTurn()` gated on nothing but its `goNext` setting and `game.user.isGM` — it asks
  nothing about whether a turn is mid-resolution — so with `runForNPC` on it fires on exactly the turns
  we play, and a slow automated turn gets skipped or double-advanced. Its `runForNPC: false` scopes the
  timer to players and removes the conflict. Warned about in `conflicts()` when both switches are on.
- **`show-xp-dialog` is a second writer of `system.details.xp.value`**, beside `dnd5e-rewards.ts`. Not a
  race — both are deliberate GM actions — but an award that appears twice has two plausible authors.
- **Argon (`enhancedcombathud`) is complementary, which matters because it puts the 2024 PHB action
  items on the bar.** Its `consumeActionEconomy` is client-local display state on its own panel objects;
  nothing is written to the actor and nothing dnd5e reads. Items go through the standard `Activity#use`,
  so the `dnd5e.preUseActivity` veto fires normally and a refused use just fails to light the button.
  It was therefore *not* implicated in the PHB `Attack` double-charge, which was ours and is now fixed —
  see the declarations note under the Speed invariants below.
- `combatbooster` releases and re-selects tokens on turn change when `controlToken` is on, which fights
  GM selection during automated turns but touches no rules state. `blind-skill-rolls` always keeps GM
  ids in the whisper array, so our captures cannot go blind through it — our own care is the reverse,
  not to publicly echo a roll that arrived blinded. `chatlog-prune` deletes no documents.

## The general rules (2026-08-09) — the finite queue, worked

The other half of what the corpus is for. `coverage.json` finished with **ten** rules keys that dnd5e
documents in `CONFIG.DND5E.rules` and reads nowhere, and unlike a creature's own abilities these read
the same for every creature in every campaign — so there is nothing for a compiler to compile and they
stay hard-coded. Three builds and five deliberate refusals came out of working the list.
**`api.surveyGeneralRules()` prints the whole table**, which is `src/rules/general.ts`, and it exists
because a rule left alone after somebody checked is indistinguishable six months later from one nobody
got to.

Built: **Jump** (`rules/jump.ts`), **Influence and the attitudes** (`rules/influence.ts`), and
**Administer First Aid** (in `rules/dying.ts`). Refused with reasons: breaking objects (dnd5e already
applies `hp.dt`, and the rest is scenery Foundry does not model plus a GM's ruling), difficulty class
(six numbers a GM picks from — `DC_LADDER` exists so our own DCs are named rather than typed as bare
integers), utilize and study (the action economy already charges what the sheet says, and a Study
action produces information, which is the GM's to give), hazards (already built in `core/hazards.ts`).

New settings live under `general.*`, deliberately not `combat.*`: a party jumps a chasm and talks a
guard captain round without anybody rolling initiative, and these have no counterpart in `noodlr` to
migrate, so the inherited prefix would have implied one.

- **Jumping was a near miss, not a gap, and the interaction was the actual bug.** Core has a real
  `jump` movement action and dnd5e prices it correctly (`deriveTerrainDifficulty = () => 1` and an
  identity cost function, `documents/token.mjs:139-140`). Nothing bounds the DISTANCE. Worse,
  `economy/speed.ts` budgeted the turn against `movement[action]`, and dnd5e populates
  `movement.jump` as `str.value / 2` (`data/actor/templates/attributes.mjs:456`) purely to colour the
  drag ruler — so selecting the jump action collapsed a Strength 16 fighter's whole turn to eight
  feet, with everything already walked counted against it. `speedFor()` now returns walk speed for a
  jump and `jumpVeto()` caps each leap separately.
- **The long jump is the SCORE and the high jump is the MODIFIER.** Getting them the wrong way round
  produces numbers that look plausible, which is why it is spelled out in `dnd5e-checks.ts` and
  asserted in the tests. Never read `movement.jump` as either: it is the standing long jump and only
  that, and has no answer at all for the high jump.
- **A leap is a RUN of consecutive `jump` waypoints, not one per waypoint.** Dragging four squares in
  one motion is one twenty-foot jump. And the veto measures the leaps inside a path, never the path's
  total: a drag that walks fifteen feet then leaps ten is a legal ten-foot jump.
- **Influence draws the line at the judgement.** The rule opens with "The DM then determines whether
  the monster feels willing, unwilling, or hesitant", and that is not automatable — its inputs are a
  conversation and a relationship. So it is ASKED, every time, via `DialogV2`, and nothing guesses it.
  Everything downstream is arithmetic the table forgets rather than argues about: DC 15 or the
  creature's Intelligence SCORE (a floor, not a scale), Advantage when Friendly and Disadvantage when
  Hostile, the right skill rolled on the right sheet.
- **An unwilling refusal sets NO lockout.** The rule hangs the 24 hours on "a failed check", and no
  check was made. This is the part most often played wrong.
- **Attitude is not disposition.** Disposition drives border colour, target rings and who counts as an
  enemy; attitude is a social stance that can differ in both directions. Disposition is the default,
  an explicit token flag overrules it, and the flag is written to the TOKEN — writing it to the actor
  would make every future copy of that guard start out already won over.
- **The lockout stamps which clock it used.** `game.time.worldTime` is the honest reading, but plenty
  of worlds never advance it, and there a world-time lockout would never expire — a creature refused
  in session two still refusing in session forty, which reads exactly like a bug. So the clock is
  chosen when the lock is SET and recorded on it, and a lock from the other clock is let through
  rather than compared across clocks.
- **Administer First Aid is the Hide action's twin.** 2024 files it under Utilize and dnd5e ships no
  item for it, so a deliberate stabilise had no button anywhere while three successful death saves
  already reached Stable. DC 10 Wisdom (Medicine), costs the healer's Action, charged whether or not
  it succeeded, and announced either way — a silent failure looks like the button not working.

## The design: deterministic NPC combatants

Carried over verbatim from noodlr's AGENTS.md, where this was "Phase 7". Paths in the older text below
predate the 2026-08-08 reorganization: `system-profiles.ts` is now `system/profiles.ts`, `combat/auto/`
is split across `rules/`, `tactics/` and `core/`, and `combat/systems/` is `system/`.

> **PIVOT, 2026-08-02 (supersedes the AI-driven design below).** After vetting the v0.4.21 turn loop
> with others, the user cut the per-turn model call: one request per beat per creature makes every
> encounter slow and a horde fight unaffordable. Combat decisions are now made **locally, by a
> deterministic planner, with zero AI calls**. The LLM turn loop is removed outright (user's choice of
> three offered options), not kept as a mode. What survives from N1/N2: `system-profiles.ts`, the
> dossier's live sheet reading, and the per-encounter lifecycle. Everything below about beats, `END
> TURN`, and `MAX_TURN_STEPS` is history — kept for the reasoning, not as a description of the code.
>
> **The engine (user chose utility scoring over a literal branching tree):** generate every legal
> option, score each by the considerations the creature's tier unlocks, then choose by *weighted
> random* rather than by maximum. That last step is the design, not an implementation detail. Argmax
> produces tournament-grinder monsters; pure randomness produces noise; score-proportional choice with
> tier-set sharpness produces an owlbear that usually mauls what is closest and a lich that almost
> always does the clever thing. "Most appropriate, not best" is literally the temperature dial.
>
> **Competence is two dials, not one.** Gating alone yields a creature with two options that plays
> both flawlessly, which reads as eerily precise rather than stupid. So each tier carries `unlocks`
> (what it can conceive of), `noise` (0.85 at insect → 0.08 at god-like: how reliably it acts on the
> best option), and `breadth` (how many options it weighs — its attention span and the CPU ceiling).
>
> **Tier ladder** (`src/combat/auto/tiers.ts`), thresholds from the user's table on (INT+WIS)/2:
> 1 its entire action economy (move, action, bonus action, features, spell-likes, reactions, recharge
> abilities, legendary actions) + call for help · 2 + target the apparent weakest, flee when hurt ·
> 3 + avoid strong opponents, use inventory, Help an ally, surrender · 4 + stealth, deception, control
> maneuvers, advanced casting, self-healing, keep distance, seek cover, mercy · 5 + heal and protect
> allies · 6 + target the real threats, focus fire · 7 + reposition for advantage, hold resources ·
> 8 + manipulate enemies, resource denial · 9 + the long game.
>
> **Two relocations the user made on 2026-08-02 that are easy to undo by accident:** fleeing lives at
> tier 2, not 3 — running from pain is instinct, and a cornered rat manages it. Access to the full
> action economy lives at tier 1: even an insect uses everything it physically has, because competence
> is about *choosing*, never about access. Tier 1's limits are `breadth` and `noise`, not a shorter kit.
>
> **The inverted withdrawal rule (subtle, easy to "fix" backwards).** Tier 4 steps out of melee only
> "when not at risk of an opportunity attack". The naive reading backs away when something is adjacent
> — the exact moment leaving costs a free hit. So an already-engaged creature stays and fights, and one
> that is merely *about to be* closed on (enemy within reach + speed) gives ground while it is still
> free to. Refusing the melee before it starts is the competent play.
>
> **`TIER_CAVEAT = 7` — where the ladder stops being honest.** Tiers 1-6 are fully mechanical. Tier 7
> is stretching: "bait them into the trap room" needs authored terrain the planner cannot invent.
> Tiers 8-9 (manipulation, generational scheming) are campaign-scale fiction; no per-turn automaton
> runs a decades-long con. Those tiers get the best of what *is* mechanical plus GM hints and voice.
> This is written into the code, not just here, so nobody later mistakes the gap for a bug.
>
> **Seeded, not merely random.** The choice is seeded from fight + round + combatant, so a turn
> replays identically: no reroll-shopping by clicking twice, and tests can assert real decisions.
>
> **Principle 0** (top of this file) was amended in the same breath to permit system-specific
> *tactics* behind an adapter while still forbidding system *rules*. The planner picks a verb, an
> implement, and a target; it never computes an attack roll, damage, a save, a DC, or a condition.

Original AI-driven spec, agreed with the user 2026-08-02 and superseded the same day. The largest feature in the module, built in layers, each one
shippable alone. Goal: hostile combatants that behave plausibly *for what they actually are* —
partially aware of the rules (via the `system_rules` silo) and fully aware of their own sheet
(movement, abilities, feats, spells, inventory, consumables). Worked examples the user set as the
bar: a skeletal archer that runs out of arrows, switches to a melee weapon, and closes to reach; a
caster that heals itself or an ally; a bloodied, intelligent creature that flees or drinks a potion
rather than dying in place.

Why today's "Act as NPC" cannot do any of that: `runCurrentNpcTurn()` makes ONE completion, asks for
"their single action", and injects only the combat-tracker block — which carries initiative, HP
tiers, and conditions, and explicitly says positions are narrative zones. **The creature's own
capabilities are never sent.** The model improvises a statblock from the creature's name, on a
battlefield it cannot see, without ever seeing a die result (macros resolve after generation). Three
missing inputs, one missing loop. Not a prompt-wording problem.

Organizing principle: **we count, the model reasons, the automation modules resolve.** Noodlr never
learns what a "bonus action" is. It reads the actor's items as Foundry stores them, including the
system's own activation labels, and enforces only what is checkable as data — does this ability exist
on this actor, does it have uses/ammo left, has that activation slot already been spent this turn.
Meaning stays with the model plus the rules silo. Principle #1 survives intact.

**The dossier** (user's term and framing): each hostile combatant gets a briefing generated from its
sheet, live for the duration of the skirmish and discarded at death or combat end. Volatile numbers
(uses, ammo, HP) are re-read every turn — a cached count is a wrong count the moment something is
spent — while accumulated *notes* (what it did on previous turns, morale state) persist for the
combat only.

Layers:

- **N1 — Dossier + perception briefing.** `src/combat/system-profiles.ts` (candidate-path data table,
  D&D 5e filled in first, generic probing fallback — user chose the profile approach) and
  `src/combat/dossier.ts`. Read-only; no behavior change beyond the model finally knowing its own
  statblock. Includes the closing constraint "only these abilities exist" — the anti-improvisation clause.
- **N2 — The turn loop.** Replace the single completion with propose → resolve dice → feed authoritative
  results back → next step, until the model writes END TURN or a step cap trips. Same shape as the GM
  chat continuation, generalized; multiattack, bonus actions, and move-then-shoot fall out of it.
- **N3 — Structured intents + legality gate + execution.** The model proposes intents rather than prose;
  the module validates them against the activation budget and the actor's real item list, then executes
  through the item's own use path so Midi QoL/DAE/CPR resolve the mechanics. GM approval on by default.
  Execution sits behind a thin adapter with a narrate-only fallback, because `item.use()` is dnd5e-shaped.
- **N4 — Cognition tiers from the sheet** (user chose auto-from-INT/WIS with a per-actor override). The
  strongest lever is *information scope*, and it is free: a beast is told only what it perceives (nearest
  threat, who hurt it last, whether it is badly hurt), a tactician gets the full tracker, ally intent, and
  what `npc_state` remembers about the party. Doctrine text, planning depth, and self-critique scale with
  it; low tiers can route to a cheaper model, which matters when eight skeletons each take a turn.
  Deliberate blunders come from a real seeded Foundry roll, not from temperature, so they are auditable
  and reproducible in tests.
- **N5 — Positioning.** Movement, cover, line of sight, morale/retreat, and coordination between
  high-intelligence enemies. Hardest layer; deliberately last.

Still refused, per principle #2: damage application, condition management, concentration, attack
resolution. Those are Midi QoL's job and always will be.

#### Deterministic planner — what landed in v0.4.22, and what to distrust

Shipped:

- `src/combat/config.ts` — `combat.automation` (`full` | `partial` | `off`, default full) and
  `combat.banter` (default on), both in Text Generation under the ruleset field.
- `src/combat/auto/registry.ts` — per-encounter opt-in set keyed by **combatant id**, cleared on
  `deleteCombat`. Deliberately in memory: a flag on the actor would silently change every future copy
  of that goblin. PCs are refused in every mode.
- `src/combat/auto/control.ts` — Act-as-NPC toggles the selected token(s); multi-select honored;
  pressing again takes the creature back mid-fight with no dialog. Tool is rendered **only** in
  `partial` mode.
- `src/combat/auto/tiers.ts`, `board.ts` (measurement only, tolerant of grid-API drift and gridless
  scenes), `planner.ts` (options → scoring → seeded weighted choice), `hooks.ts` (`updateCombat`,
  primary GM only, so an assistant GM does not double-plan).
- `src/combat/npc-turn.ts` rewritten: **decides and announces only.** Intent posts publicly; the tier
  and scoring rationale go to the console, never to chat — players must not be shown how the monster
  thinks.

Reservations and known gaps:

- **Nothing is executed yet.** No movement, no `item.use()`, no turn advance. The GM resolves what the
  card announces. Execution is the next layer and lands with GM approval on by default.
- **NPC Banter is registered but inert.** With the LLM loop gone, combat currently makes zero AI
  calls, which is what "remove it entirely" meant. Banter returns as one optional short line.
- **Threat detection is a proxy.** "Carries many spells" stands in for "is artillery"; a martial
  damage dealer reads as harmless to tier 6. Needs no rules knowledge, which is why it was chosen.
- **Tier 4's deception and disarm are unimplemented.** Stealth is real (see positioning below); only
  `save`-type items are identifiable generically as control options, and the rest need identifiers
  the adapter cannot read yet.
- **Cover and hiding are computed for real, against ONE observer each** (user's call, 2026-08-02,
  after the announce-only version was rejected as too valuable to skip). `auto/positioning.ts` scans
  12 bearings × 3 radii nearest-first and returns the first square that is reachable (straight-line
  move ray, not pathfinding) and out of sight of the reference observer. Cover tests the **furthest**
  player, hiding the **nearest**. Known hole, accepted: cover from the far archer is not cover from
  the near one. Upgrading is one parameter — the search takes an observer, so passing two costs one
  extra ray per candidate. The angular start is seeded, so identical creatures don't all break left.
- **The cover budget is half the creature's speed**, because movement already spent acting is not
  tracked. Deliberately under-promises rather than proposing a shuffle it could not afford.
- **Collision API is v13-verified** (`ClockwiseSweepPolygon.testCollision(origin, dest, {type, mode:
  "any"})`) with two older shapes tried in turn. An unreadable API returns null and is treated as "no
  cover found", never as "cover found" — the failure mode must be a creature standing in the open,
  not one claiming cover that isn't there.
- **Keeping distance reads the opponent's sheet too.** An enemy whose items are unreadable is assumed
  to threaten one grid step, deliberately: guessing "harmless" would walk archers into a grapple on
  every unfamiliar system. The reverse error (an archer that over-respects a spellcaster's reach) is
  cheap by comparison.
- **Reach defaults to one grid step** when an item states no range. Deliberate: exact reach is a rules
  detail we refuse to model, so a 10-ft polearm may be planned as if adjacent.
- **Unreadable INT/WIS lands at tier 4, not tier 1** — a missing number turning a dragon into a beetle
  is the worse failure.
- **Encounter resolution** (`auto/encounter.ts`, addendum of 2026-08-02): a fight can end by flight,
  surrender, or mercy rather than a body count. The module records the outcome, flips the token from
  Hostile to Neutral for surrender and mercy (one reversible field), and posts a GM-whispered card
  stating what the addendum says the outcome is worth. It deliberately does **not** award experience,
  divide loot, or strip the party's currency/weapons/armour on a mercy — experience and loot are
  system-specific arithmetic — see the rewards adapter below, which the user approved on 2026-08-02.
- **`combat/systems/dnd5e-rewards.ts` is the one place Noodlr does system arithmetic, deliberately
  fenced.** Gated on `game.system.id === "dnd5e"`, returns a no-op report elsewhere, and nothing in
  `auto/` imports system knowledge — a second system is a sibling file, not edits in the planner.
  Holds: the published CR→XP table (the actor's own `details.xp.value` wins when present, since
  homebrew overrides it), even splitting across PC combatants (floored — no XP conjured from a
  remainder), and the mercy forfeiture.
- **XP counts what is left on the field: the dead and the surrendered, nothing for escapees**
  (revised by the user 2026-08-02, replacing the original half-value-for-fleeing rule). Two reasons,
  both worth keeping: a fled token is often deleted, so its value was never reliably countable, and
  parties frequently rout enemies deliberately — intimidation, pity, protecting a faction's regard —
  which is a fight they chose not to have rather than one they won. Do not "restore" the half rule.
- **Forfeiture is destructive, so it is recorded before it happens.** Every removed item's full data
  and every coin is written to an actor flag (`noodlr.mercyForfeit`) *before* deletion;
  `restoreForfeited()` puts it all back, reachable from a button on the mercy card and from
  `api.restoreForfeitedGear()`. A mercy ruling that lands wrong mid-session must be one click to undo,
  not a reconstruction from memory. Forfeiture and the XP award both run once, at encounter end, not
  at the moment of the ruling — "no experience from the combat encounter" is an encounter-level rule.
- **Aggression is inferred from players rolling dice** during combat, which is what mercy hangs on.
  A proxy, and deliberately a generous one: a false positive costs a withheld mercy, a false negative
  spares a party that is still stabbing. Needs round ≥ 2, so it cannot fire on the opening round.
- **Banter** (`combat/banter/`, user-supplied library 2026-08-03). `banter/banter.txt` ships in the
  package and is **fetched at runtime, not bundled**, so a GM can edit, cut, or translate lines in
  place with no build step. Missing file = silent monsters, never an error.
  - Frequency: `INT + 2·CHA − 2·WIS`, clamped 0-10, 10% per point. **The signs are intentional and
    confirmed — do not "fix" the subtraction.** Cleverness makes a creature pleased with its own
    commentary, charisma makes it a show-off (doubled), and wisdom is knowing when to shut up
    (subtracted, doubled). The minus also runs in reverse for free: a negative WIS modifier flips
    positive, so fools are the loudest things on the field. One term, both behaviours.
  - Hard gate: **no language, no lines**, whatever the modifiers say. Anything that *can* talk is
    then floored at 1 point (10%). Checked against published stat blocks before adding the floor:
    the raw formula puts goblins, hobgoblins, bandits, orcs, and ogres at exactly 0 (a goblin's −1 WIS
    gives +2, its −1 CHA takes −2 back), which muted every mook while dragons ran at 90%. The floor
    sits outside the formula, after the language gate, so the arithmetic itself stays as specified.
  - **Banter draws from its own seeded RNG stream** (`auto/random.ts`, stream `"banter"`). If it
    shared the tactics stream, switching banter off would shift every subsequent number and silently
    change what creatures *do*. Any future per-turn randomness needs its own stream for the same reason.
  - Tagging is by section heading plus per-line detection, with ancestry words LATCHING onto the
    following lines (the race section names a race once and then continues about it). A wrong-ancestry
    or wrong-sex taunt scores 0 — excluded outright, not merely disfavoured, because "Elf!" thrown at
    a dwarf is worse than silence. Gender markers are deliberately few: `hag-seed` is neutral (it is
    the *spawn* of a hag, aimed at Caliban) and `fellows` is a crowd, both verified against the file.
  - Speech follows the table's existing TTS switch; banter never enables voice on its own.
- **Reactions and legendary actions are readable but not yet triggered** — which also means the
  "or during a reaction" half of the banter trigger is unbuilt; turn-start only today. Recharge state is honored
  (a spent breath weapon is not offered). Reactions, counterspell, and legendary actions all fire on
  *other* creatures' turns, which needs an off-turn hook and a cost model the sheet does not state
  machine-readably. Tier 1 grants the access; the trigger layer is still to build.
- **Alignment gates mercy**, read as free text: lawful-anything, or anything not evil. An unreadable
  alignment is treated as *not* merciful — inventing a conscience the GM never wrote is the worse error.
- Revert map: the pivot is self-contained in `src/combat/auto/` plus the rewritten `npc-turn.ts`.
  Restoring the AI loop means restoring that one file from v0.4.21.

## Research method: the corpus, subagents, and not losing the work

Every "nobody automates this" finding in this file came from reading source, never from asking a model
what it remembered. That is only affordable because the sources are already on disk.

- **The corpus lives at `C:\Project\_research\`** (outside all three workspace roots, so tools must be
  pointed at it explicitly and a plain workspace search will not find it):
  - `dnd5e\` — dnd5e **5.3.3** system source. `module\*.mjs`, `module\config.mjs`, `lang\en.json`, and
    crucially `packs\_source\` — the unpacked authored CONTENT, which is where the "it's only prose"
    verdicts are actually decided. `dnd5e533\` is a duplicate of the same version; ignore it.
  - `fvtt13\foundryvtt\` — a full Foundry v13 install with **readable client source** under
    `resources\app\`. This is what makes claims like "`#initializeMovementActions` overwrites the cost
    function" checkable rather than plausible.
  - `ftypes14\` — Foundry **v14** API type definitions, carrying the doc comments. The only way to answer
    "does this API exist in 14 but not 13", which has bitten us (`maxCost` arrived in 14.357).
  - `midi-v14\`, `midi-qol\`, `gambits\`, `cpr\`, `vision5e\`, `perceptive\`, `patrol\`, `talia\` — the
    modules we compare against and deliberately stand down for.
  - `gh_*.py`, `gh_issues_found.json`, `milestones.json` — helpers used to search dnd5e issues and releases
    when the question is "did they ever intend to build this".
  - `_audit\` — completed audit reports (see below).
- **`rg` (ripgrep) over the corpus is the primary instrument.** Absence of evidence is the finding in most
  of these investigations, so searches must be exhaustive and the negative result stated with the pattern
  that produced it.
- **PowerShell output is unreliable in the agent shell (observed 2026-08-06).** `Get-ChildItem` and
  `Select-String` have silently returned empty output where the paths plainly existed. `cmd /c dir` and the
  file-reading tools were unaffected. Do not conclude a file is missing from a bare PowerShell listing.
- **Read a clone's version with `git describe --tags`, never from its committed manifest (2026-08-11).**
  Most of these repos template the version in at release time, so the checked-in value is whatever was
  last hand-edited: Convenient Effects' `static/module.json` says `7.0.0` on the `v9.2.5` tag, and its
  `package.json` says `1.0.0`. Aura Effects writes `"#{VERSION}#"`, which is harmless precisely because
  it is obviously wrong — **a plausible-looking stale number is the dangerous form**, since it invites
  no second look and quietly ages a finding by two major versions. Cite the tag, and say which file the
  number came from.

**Subagent protocol (adopted 2026-08-06, after losing a batch — twice).** Six research subagents were
launched as blocking calls in one message. All five that started **finished their work within about a
minute each and wrote a complete final report**; the batch was then killed 77 minutes later because the
handoff back to the parent hung. The work was never slow, and it was never lost — but the *delivery* was
all-or-nothing and there was no copy on disk, because the briefs said "report back" and "modify nothing".

1. **The file is the deliverable, the reply is expendable.** Every research brief names an output path
   under `_research\_audit\` and instructs the agent to create the file *before* researching and rewrite it
   after each section. An interrupted run then still leaves a usable artifact.
2. **Background them** (`run_in_background: true`). A blocking call looks identical whether it is working
   or hung, which is precisely how 77 minutes went by.
3. **Cap the fan-out at two or three.** A blocking batch is only as fast as its worst member and the blast
   radius of one stall is the whole batch.
4. **Bound the effort** in the brief ("finish within ~60 tool calls; a complete-but-partial file beats an
   exhaustive one that never gets written").

**Recovery drill — a vanished subagent's work is usually still on disk.** Transcripts persist at
`C:\Users\Superuser\.cursor\projects\c-Project-noodlr-memory\agent-transcripts\<chat-id>\subagents\<agent-id>.jsonl`,
one JSON event per line with `role` and `message.content[]`. **The final report is the `text` block of the
last `role: "assistant"` event**; tool calls appear as `tool_use` entries but their results are stripped, so
the report is all that is recoverable — which is exactly the part worth having. Sort the folder by write
time to find the batch. A transcript containing only the opening `user` event is an agent that never
started. Five reports (~68k characters, fully cited) were recovered this way on 2026-08-06 and now sit in
`_research\_audit\`: conditions/exhaustion, cover/visibility/surprise, damage/death/hazards, movement rules
beyond Speed, and spellcasting/resources.

## How to tell whether dnd5e enforces a rule (audited 2026-08-06)

Three times now we have built something after discovering the system does not do it (actions v0.4.38,
Speed v0.4.39, forced movement v0.4.40). This is the generalised detection method, so the fourth time is
a five-minute check instead of a five-hour audit. Full report and the citations behind every number:
`_research\_audit\documentation-signals.md`.

- **There is no warning word. The tell is structural: look at where the rule's number lives.** If the
  quantity the rule turns on — a distance, a count of actions, a number of feet — appears only in
  `description.value`, in `chatFlavor`, or in a journal page, and **no schema field could hold it**, then
  nothing enforces it and nothing will until the schema changes. Quantified: 57 content files state a
  forced-movement distance in prose, 52 of them have `effects: []`, and no YAML key in any of the 4,674
  content files can express displacement (every `distance:` is `range.distance`). The orphaned number is
  the signal; `effects: []` on its own is weak evidence, since plenty of pure-damage items have none.
- **`CONFIG.DND5E.rules` (`config.mjs:4673`) is the index of the prose surface.** Its own JSDoc: *"List of
  rules that can be referenced from enrichers."* ~170 entries, every value a bare UUID — `shoving`,
  `hiding`, `speed`, `bonusaction`, `dash`, `opportunityattacks`, `cover`. **The test only works in one
  direction:** presence proves nothing (`difficultterrain` is listed *and* implemented), but a rules-table
  key that appears nowhere in `module/**.mjs` outside the config files is prose-only.
- **`&Reference[...]` documents; `[[/...]]` does dice.** `enrichReference` returns a content link and a
  tooltip. The one exception is `&Reference[condition=x]`, which adds a hand-operated "apply status"
  button. The `[[/attack|damage|save|check|...]]` family produces real rolls — but only rolls: nothing
  compares the result to anything or applies a consequence. `[[/award]]` is the only enricher that changes
  actor state on its own. `@Embed[...]` is core, and purely presentational.
- **A config entry that is only `{label, reference}` exists to be linked to.** `weaponMasteries` is the
  archetype and the only table in `config.mjs` that is purely that shape throughout. The refined test is
  the absence of any sibling key beyond `label`/`icon`/`abbreviation`/`fullKey`, and it works *within* a
  table too: a `conditionTypes` entry carrying `special` is wired into core's `specialStatusEffects`; one
  carrying only `name`/`icon`/`reference` is not.
- **A non-empty `chatFlavor` is the content team's to-do list.** Only 129 of 4,674 files have one, it has
  exactly one consumer (`documents/activity/mixin.mjs:704`, which makes it a chat-card subtitle), and when
  filled in it reads like a stage direction: *"On Hit: Target pushed 15 feet away."* (fire giant), *"On
  Failure: Target is pushed 20 feet back."* (air elemental).
- **Ask which Activity type could express the rule.** The closed list is Attack, Cast, Check, Damage,
  Enchant, Forward, Heal, Save, Summon, Transform, Utility. None of those verbs moves a target. The wiki's
  gloss on the last one is the system naming the concept itself: *"Utility: make an arbitrary roll or just
  indicate something happened."*
- **The schema JSDoc is more honest than the prose docs.** `documents/activity/_types.mjs:35`:
  *"`consume.action` — Should action economy be tracked? Currently only handles legendary actions."* That
  is the system stating the v0.4.38 gap outright, in a doc comment, where nobody would look.
- **The 5.0.0 release notes' "What's Next" is the only place gaps are published.** It lists "Action
  tracking", "Range, reach, & cover", and "Ruler integration with movement rules" — all three of the
  things we have since built — prefaced with *"neither can we promise any firm timelines"*. A roadmap item
  is a confession. Check the newest release's equivalent section before starting anything.
- **Two traps.** `movementAutomation` is the only setting whose display name contains "Automation" and it
  governs terrain cost and token blocking, never Speed. And the gap is usually *not* "automation exists
  but defaults off" — the enforcement toggles mostly ship ON; the real problem is that the automation is
  narrower than its name. The genuine off-by-default exceptions worth knowing: `encumbrance` (`"none"`)
  and `autoRecharge` (`"no"`).
- **Disproved, so don't bother:** `lang/en.json` contains essentially no "we will not do this" vocabulary
  (the closest is one "at your DM's discretion" about optional class features), and no limitations or
  "what is automated" page was found on the dnd5e wiki. Core states its position only in the positive, in
  developer docs: rules are a system's job, so a rule the system never modelled as data is a rule nobody
  enforces.
- **Core adjudicates six statuses and paints the rest.** `CONFIG.statusEffects` entries are `{id, name,
  img}`; only `CONFIG.specialStatusEffects` (`dead`, `invisible`, `blind`, `burrow`, `hover`, `fly`) is
  consumed by core, for defeat, vision and elevation.

Five further audits from the same 2026-08-06 batch sit beside that report. They were the standing gap
list; most of it has since been built or reassigned — see the next section before reading any of them.

## The standing gap list, re-read after the split and the pivot (2026-08-10)

The five audits were written on 2026-08-06, which is **before** the 2026-08-08 module split and before the
2026-08-09 capability compiler. They were still described here as the queue to work from, and they are not:
the list was stale in both directions at once, and following it would have sent someone to rebuild features
that shipped. Each verdict below was checked against the current source rather than inferred from the age
of the report.

**Built since — do not rebuild.** Attack-time condition math, auto-fail Str/Dex and the auto-crit within
5 feet (`system/dnd5e-conditions.ts`); Incapacitated blocking activity use (`rules/economy/enforce.ts`);
concentration ending on a failed save (v0.4.44); drop-to-0, death-save failures from damage, and **instant
death** (`rules/dying.ts:287` — the audit lists that one as prose-only); hiding contested against passive
Perception, plus the reveal (`rules/stealth.ts`, `rules/hide.ts`); surprise; per-creature perception and
encounter initiation (`rules/perception.ts`); the Speed budget and Dash (v0.4.39); forced movement
(v0.4.40); opportunity attacks (`rules/reactions.ts`); jumping, Influence and Administer First Aid
(2026-08-09). That is four of the five leads in the conditions audit and four of the five in the movement
audit.

**Reassigned to the compiler — there is no engine to build.** The spellcasting audit's own lead sentence is
the pivot's thesis stated three days early: *"Activity schemas cannot express most spell rules … those must
be macros or GM adjudication."* Everything downstream of it — persistent and ongoing damage, saves-to-end,
component gating, "destroy on a 1", counterspell timing — is per-item prose that a compiled descriptor
carries. So is the damage audit's area-damage finding: Moonbeam's enter-and-end-turn save exists only in
description text, and `on_enter_area` / `on_turn_start` with a `damage` effect are already in the
vocabulary. What those need is **executor support for placing and watching an area**, which is a primitive,
not a rules engine. Do not open these as rules work.

**What actually survives is short, and it is general rules** — universal, identical for every creature, the
same category as jumping and Influence. Ordered by value over cost. The first three are cheap *now* and
were not in August, because the hard half shipped for unrelated reasons:

1. ~~**Cover as an AC bonus.**~~ **Dropped 2026-08-11 — `simplecover5e` already does it, and does it
   better than we specified.** The reasoning that put it first still holds as far as dnd5e goes: the
   system applies `coverHalf` / `coverThreeQuarters` (+2 and +5 to AC **and** to Dexterity saves,
   `actor.mjs:115-120`, `attributes.mjs:228-234`) the instant the status is present, sets it from
   nothing, and we already count blocked corner rays in `rules/hide.ts`. What the audit found is that
   Simple Cover 5e 2.2.1 sets the status (`config.mjs:52-57` → `status.mjs:179-190`, routed to the GM
   through a `CONFIG.queries` handler) **and independently pre-adjusts the target's AC net of dnd5e's
   own `ac.cover`** (`automation.mjs:452-465`), plus Dexterity saves and a hard block on saves under
   total cover — automatically, off `dnd5e.preRollAttack` / `preRollSavingThrow`, with no libWrapper.
   Its geometry is 3D occluder prisms with elevation banding and Wall Height support, corner-to-corner
   with grid-aware line counts, iterating the attacker's corners too; our 3-of-4 rule is the flat
   special case of it. **Building ours would double-apply, not fill a gap.** The `today` line on the
   cover row in `apps/pages.ts` now says so, which is the whole point of that field.
   - Worth doing instead, cheaply: consume `api.getCover()` to replace the corner-ray approximation in
     the Hide prerequisite when the module is present. That is the raise-fidelity-when-available
     pattern principle #0 already permits for midi, not a dependency — the approximation stays.
   - Caution if this is ever revisited: it stands down for midi **only** when midi's
     `coverCalculation === "simplecover5e"`, and it has no awareness of AC5e at all
     (`rg -ni "ac5e|automated-conditions"` returns nothing). Two cover implementations can both be live.
2. **Unseen attacker and unseen target.** Advantage when the attacker cannot be seen, disadvantage when the
   target cannot be. `rules/perception.ts` already answers "can this creature see that one" per-creature
   against a hand-built vision source, and the injection point is the same `preRollAttack` the condition
   matrix uses.
3. **A ranged attack with a hostile within 5 feet is at disadvantage.** A board query and a matrix row.
4. **Dodge.** dnd5e ships a `dodging` status with **zero** consumers. One condition-matrix entry (attacks
   against at disadvantage, Dexterity saves at advantage) plus a button of the same shape as Hide's, since
   nothing in the system presses it either. Verified unbuilt.
5. **Standing up from Prone costs half Speed**, and a prone creature should pay crawl rates to walk — core
   charges the extra distance only if the Crawl action is selected, and never charges the stand-up. The
   Speed ledger already exists; this is a charge levied on a status removal.
6. Lower value, and several are honest refusals: squeezing, flying without a fly speed (core does not
   prevent it), mounted combat, falling damage (core has no concept of falling at all), the
   suffocation/starvation/extreme-environment clocks, and difficult terrain auto-placed from spell
   templates.

**Check `ac5eOwnsConditions()` before building 1 through 4.** Automated Conditions 5e covers Invisible and
visibility-aware Blinded already, and ships cover and range logic of its own that stands down only when
midi is present. The stand-aside that exists for the condition matrix may cover part of this queue outright,
and dual enablement is the silent-race failure documented below — measure before writing.

## A silent stand-aside is a bug report waiting to happen (v0.2.0, 2026-08-11)

Every stand-aside in this module was written as a correctness measure and each one is right. Together
they created a failure nobody had named: **the setting still reads ON while nothing happens.**
`ac5eOwnsConditions()` switches the entire condition layer off, `midiOwnsConcentration()` hands
concentration to midi, Gambit's takes opportunity attacks — and Foundry's native settings list can only
show a value, never who is acting on it. At the table that is indistinguishable from the module being
broken, and it is the single most likely thing to be reported as a bug in this repo.

- **`src/integration/ownership.ts` is the one place that answers "who is enforcing this right now",
 and it must READ the enforcement predicates rather than restate their conditions.** A resolver with
 its own copy of "is AC5e on" would drift, and it would drift into telling the GM the opposite of the
 truth — worse than saying nothing. `ownershipOf(id)` returns `{owner: us|other|system|nobody, by,
 note, enabled, covered}`; `enabled` and `owner` are deliberately separate, because "on and overruled"
 is the whole point.
- **`src/util/modules.ts` is the only place that reads another module's state.** Three copies of the
 midi config lookup was what forced it. The lookup is not obvious: prefer `MidiQOL.configSettings()`
 over the stored `ConfigSettings` setting, because midi mutates the live object and a GM who changed a
 switch without reloading has a stale stored value; fall back to the setting because the global does
 not exist until midi's ready hook. Nothing there throws — an unreadable module means "I could not
 tell", which every caller reads as "nobody else owns this, keep enforcing". Failing the other way
 would switch our own rules off because a settings object had an unexpected key. `midiOn()` exists
 because almost every mechanical midi setting is a string enum whose off position is `"none"`, so
 plain truthiness reports off as on.
- **Advisories are separate from ownership, and they are the more useful half.** `advisories()` reports
 cross-cutting conditions that belong to no rule area: midi's `checkRange` and `wallsBlockRange` are
 live at stock settings (read through `checkMechanic`, which ignores midi's Optional Rules master
 switch) and cancel an item use with only a log line. That is the first thing to check when something
 of ours "does not fire". `conflicts()` is for suspicions rather than certainties — wm5e's possible
 double Push — because standing aside needs proof and warning does not.
- **Three windows, not one, and not the native list** (`src/apps/rules-config.ts` + `pages.ts` +
 `presets.ts`). This reverses the note in `constants.ts` that said sixteen checkboxes fit Foundry's own
 list; that reasoning was sound about length and missed ownership entirely. `debugLogging` stays native
 on purpose: client-scoped, not a rule, and it should be findable without knowing which window to open.
- **`pages.ts` is the roadmap and the settings surface in one file, deliberately.** Every row carries a
 `state`: `live` (a real setting a real rule reads), `planned` (nobody has built it — no setting is
 registered, and the row says who covers it today), or `system` (dnd5e already does it). The `system`
 rows exist because their absence reads as a gap: a GM comparing us against midi's list needs to see
 "damage immunities: the system already does this" rather than nothing. Planned rows render collapsed
 under "not built yet" so the page stays a settings page. **Promoting a rule is: change `state`, add
 `setting`, register it** — which means a rule cannot ship without somebody deciding where its switch
 lives, and a switch cannot appear without a rule behind it.
- **Two facts about `registerMenu`, both read from core source rather than assumed, and both fatal if
 guessed.** `client/helpers/client-settings.mjs:189` **throws** unless `type.prototype` is a
 `FormApplication` or an `ApplicationV2` — a duck-typed object with a `render()` method is rejected, so
 the obvious lazy shim does not work. And `client/applications/settings/config.mjs:202` does
 `new menu.type()` with **no arguments**, so the page cannot be passed as an option and must be baked
 into a subclass per page. Each subclass needs its own `id`, or all three pages share one window.
 Registration is wrapped in try/catch: the rules are the product and the windows are the convenience.
- Templates are fetched by path at render time, so a missing one is a console 404 rather than a build
 error. `scripts/package.ps1` asserts every `.hbs` by name; add to that list when adding a template.
- **`scripts/check-i18n.mjs` runs as part of `npm run check`**, because a missing key renders as the raw
 dotted string in the middle of a settings page and reads as a broken window rather than as a missing
 translation. A regex cannot see through a template literal, so the two key families assembled at
 runtime (`Rules.State.*`, `Capabilities.Status.*`) have their members named in the script itself —
 **add a family there whenever a key is built from a variable**, or nothing checks it.
- Presets write settings and hold no state of their own; `currentPreset()` reports whichever profile the
 world happens to match. **"Alongside Midi QoL" sets dying and concentration off explicitly even though
 the runtime stand-asides already do it**, because making that split visible is the entire point of the
 exercise.
- Diagnostics: `api.surveyOwnership()`, `api.openRules("house"|"mechanics"|"combat")`.

## Never name a `data-action` after one of core's own verbs (v0.3.0, 2026-08-12)

The Combat page had three navigation tabs and they were unusable: the pane that was already selected
could not be left, so the other two were unreachable. Reported as "something very wrong with the
navigation tabs", and the cause is a namespace collision nothing warns about.

**`tab` is RESERVED by `ApplicationV2`.** Its `#onClickAction` has a `case "tab"` that calls core's own
`_onClickTab` before any custom `actions` entry is consulted, and that method wants a `.tabs` ancestor
and a `static TABS` declaration this window never had. Its first line is an early return when the
clicked button already carries `.active` — which is exactly the symptom, arrived at from a direction
nobody would guess from the outside. A custom `actions.tab` handler is dead code that looks live.

The general rule: **a `data-action` name is shared with core, so treat the reserved verbs as taken.**
`tab` is the one that bit us; `close`, `submit` and `toggleDisabled` are the others in that switch.

### The layout that replaced them, and why it is better rather than merely different

The user's answer was to remove the navigation and draw both sides at once, and it is the right one
for reasons beyond the bug: **the two columns of a split rule are one decision, and a tab strip makes
comparing them an act of memory.** A table that wants death saves for the party and a clean kill for
the mooks is answering one question, and it should be able to see both halves of its answer.

- `pages.ts` lost its `Tab` layer. A `Page` holds `Section`s; a `Section` carries EITHER `rows` (full
 width, applies to everyone) or `columns` (one per audience, drawn side by side).
- **A full-width section is rendered as a single unlabelled column**, so the template has exactly one
 loop over rows. The alternatives were a Handlebars partial — which means registration, another
 filename for `package.ps1` to assert, and a second thing to keep in step — or the same markup twice,
 which is how two branches stop matching.
- **The three split rows are ONE literal appearing in both columns.** `settingKey(row, audience)`
 resolves the base key against the column, so `DYING_ROW` edits `combat.dying.npc` on the left and
 `combat.dying.pc` on the right with no chance of the two halves' wording drifting apart.
- Every `id`/`for` pair is `noodlr-<rowId>-<audience>`, because a duplicated `id` makes the second
 column's label focus the first column's checkbox — a bug that looks like the setting not saving.
- Movement and the Speed cap stayed **shared**, deliberately: the cap already exempts the GM and every
 creature this module plays, so splitting it would offer a switch whose other half changes nothing.

### Three settings are per audience now, and the migration has two steps

`combat.dying`, `combat.concentration` and `combat.economy` register as `<key>.npc` and `<key>.pc`.
**The bare key is no longer registered and `game.settings.get` throws on it**, which is why
`SPLIT_COMBAT_SETTINGS` and `audienceKey()` exist in `constants.ts` and why nothing may read one of
those keys directly. `settings.ts` (`splitValue`), `pages.ts` (`settingKey`), `ownership.ts` (`keyFor`)
and `presets.ts` (`expand`) are the four places that resolve a base key, and a fifth would be one too
many.

- **Audience is the sheet type, not `hasPlayerOwner`.** `audienceOf()` answers `pc` only for
 `type === "character"`. Ownership was the obvious test and is wrong on a common configuration: a
 world set to "All Players: Owner" makes every goblin player-owned, so the bestiary would silently be
 governed by the party's column. `surveyEconomy()` reports both fields side by side for that reason.
- **The accessors take the creature, and the diagnostics need a second answer.** `enabled()` in
 `dying.ts` and `concentration.ts` is now "is this running for THIS creature", so registration and the
 surveys — which have no creature in hand — go through `enabledAtAll()` / `enabledForEither(base)`.
 Reporting the selected token's answer as the layer's would read as the whole thing being off whenever
 a goblin happens to be selected.
- The subject is always the creature the rule happens TO: the one dropping, the one holding the spell,
 the one spending the action.
- **`SETTINGS.migration` is a number, not a boolean, and `settingsMigrated` stays registered.** Step 1
 is the 0.1.0 copy out of the `noodlr` namespace; step 2 is this fan-out. A world that had run step 1
 under the old boolean would never see step 2 if both shared one flag, and `game.settings.get` throws
 on the unregistered old marker if it is deleted. Both steps read through `game.settings.storage`,
 because in each case the source key is no longer registered.
- Presets still state one position per rule and `expand()` writes it to both sides. That is deliberate:
 a preset is a starting point, and "death saves for the party but not the mooks" is a decision to make
 afterwards rather than a profile to ship.

### Saving is batched, and the window looks like `noodlr`'s

Each control used to write immediately. That is now one submit behind a title-bar Save, and the reason
is not only consistency: **an immediate write has to re-render to keep the ownership badges honest**
(turning concentration off changes what the row beside it reports), and a re-render mid-edit discards
every other control the GM had already moved. Batching means one re-render, after the write, when the
badges can be recomputed from settings that exist. The cost is real and is why the button turns amber:
edits closed without saving are lost. Same trade `noodlr` makes.

- `src/apps/header-save.ts` is a **deliberate second copy** of `noodlr`'s, down to the
 `.noodlr-header-save` class name and the amber dirty state. Neither module depends on the other and
 that is the architecture; ten lines are cheaper than the coupling, and a GM should not be able to tell
 which module drew the window.
- `tag: "form"` makes the window frame itself the form, which is what lets the header button survive a
 PART re-render — it is attached to the frame, and the frame is not what gets replaced.
- **Controls carry `data-setting` and no `name`.** A setting key contains dots, and Foundry's form
 serializer expands a dotted name into a nested object, so submitted data would arrive shaped like
 `{combat: {dying: {npc: true}}}` and need flattening back. `noodlr`'s prompt fields solved the same
 problem the same way. Consequence: `#onSubmit` reads the DOM itself, and any new control needs
 `data-setting` or it silently never saves.
- Fonts were the user's other complaint and the cause was `var(--font-size-11, 0.7rem)` throughout:
 Foundry's numbered font variables are much smaller than the fallbacks suggested. Explicit `rem` values
 matching `noodlr`'s 0.8–0.85rem scale replaced them. **Do not reintroduce `--font-size-N`.**
- The text-selection rule gained `!important` and moved to `.noodlr-hooks`, matching the note in
 `noodlr`'s stylesheet: core's `user-select: none` shifts between patch releases and has out-specified
 an unweighted rule before.

## Hard-won invariants

- **A capability read that comes back empty is a bug until proven otherwise.** Found in the first play
  test of automated combat (2026-08-03, fix in v0.4.23): every creature "called out for help" and did
  nothing else, because the planner asked each item for `system.actionType` and dnd5e v4+ (the 2024
  rules) no longer has one — everything doable moved into `item.system.activities`, a collection of
  typed activities each carrying its own attack type, range and uses. An archmage read as having zero
  attacks, and the planner *correctly* played a creature with no attacks. The failure mode is the
  dangerous one: no error, no exception, plausible-looking output. Consequences now baked in —
  - `src/combat/actions.ts` is the single normalizer from an actor's items to `CreatureAction`s. It
    duck-types the shape (activities present? use it; otherwise the legacy `actionType`) rather than
    branching on `game.system.id`, and it **logs** when an actor with items yields no actions.
  - Never fall through to `system.actionType` on an item that *has* an `activities` field, even an
    empty one: dnd5e keeps a deprecation shim there and reading it logs a warning per item.
  - `api.explainTurn()` (`src/combat/auto/explain.ts`) dumps what was read and how every option scored
    for the selected combatant. Reach for it first when a creature behaves oddly; it turns this class
    of silent-empty bug into a one-line answer.
- **dnd5e 5.x facts the combat reader depends on** (researched from system source 2026-08-03, after two
  releases were lost to inference; `src/combat/actions.ts` is the only place that should know any of it):
  - `activity.range.units` has INITIAL value `"self"`, and `range.override === false` means "this
    activity states no range; use the item's". Reading either literally gives a reach of zero, which is
    why a Dire Wolf could not bite anybody. `"spec"` means see-the-description; `"any"` is unlimited;
    distances are `ft`/`mi`/`m`/`km`. Melee fallback: `item.system.range.reach`, else 5 ft.
  - An empty `attack.type.value` means **melee/weapon**, not unknown: the system fills it during data
    preparation, and its weapon-type map deliberately omits `natural`, so every claw and bite lands
    there. Only an explicit `"ranged"` makes something ranged.
  - Spells: `system.method` (was `preparation.mode`) with values `atwill`/`innate`/`ritual`/`pact`/
    `spell`; `system.prepared` is a NUMBER (0/1/2), and NPCs are never prepared-filtered. Whether a
    method spends a slot is `CONFIG.DND5E.spellcasting[method]?.slots` — ask the table, do not hardcode.
  - Limited monster casting is usually a **feat with a `cast` activity**: uses live on the feat, and the
    spell it points at is where the shape lives. Enumerate the cast activity (for the uses) and skip
    spell items flagged `flags.dnd5e.cachedFor` (clones the system makes on first use), or you offer the
    same ability twice with the wrong resource attached.
  - Action economy is `activity.activation.type`; `CONFIG.DND5E.activityActivationTypes` carries
    `passive`, `scalar` and `consume.property` metadata. Legendary/mythic draw on
    `actor.system.resources.legact`; `resources.lair` is a boolean plus an initiative count, not a pool.
  - Languages: `system.traits.languages.value` is a real `Set` (plus semicolon-delimited `.custom`), and
    the literal `"ALL"` is a sentinel. `.communication` (telepathy) is NOT a language — a telepath with
    no tongue cannot be taunted in words.
- **"Midi Attack" is a label, not a thing.** midi-qol replaces the system's activity document classes and,
  with its Activity Prefix setting on, an activity displays midi's localized *type title* as its name. Do
  not match on it, and do not treat it as a duplicate to skip — it IS the creature's real attack. The
  activities that genuinely must be skipped are `canUse === false`, `isRider`, and
  `midiProperties.automationOnly`. Because midi may also register `midiAttack`-style types instead of
  replacing classes, classify activities by what they CARRY (`attack`, `damage.parts`, `save`) rather than
  by `type` string equality. Execute via `MidiQOL.completeActivityUse` with `midiOptions.targetUuids` +
  `ignoreUserTargets` when midi is present (falling back to `activity.use`), and set the acting user's
  targets as well: midi's default is to read `game.user.targets`, so an automated turn otherwise inherits
  whatever the GM had selected.
- **Automation owns the tracker; the GM owns their own creatures.** "Combat automation" full/partial is
  what decides whether Noodlr plays a creature, and playing one now includes ending its turn and
  advancing initiative (user's call, 2026-08-03). Consequences that must not be regressed: advancement is
  skipped if the tracker moved while the turn resolved (the GM got there first, or a surrender ended the
  fight); a resolved creature is skipped PAST rather than replayed, or the fight stalls on its corpse;
  the console entry point deliberately does not advance; and a runaway brake (`RUNAWAY_LIMIT` in
  `combat/auto/hooks.ts`) stops the chain after 24 consecutive automated turns, because an NPC-vs-NPC
  fight or a wiped party is otherwise an unbounded loop issuing real rolls unattended.
- **What the first real census proved (193 actors, 1689 items, 2067 activities; dnd5e 5.3.3 on Foundry
  14.365 with midi-qol, chris-premades, ddb-importer, Argon — `noodlr-vtt/noodlr-sheet-survey.json`).**
  Three of these overturned code written the same day from documentation alone:
  - **An empty `activation.type` means "not independently usable"** — 109 of 2067 activities, with empty
    activation *labels* to match, are the companion half of something else (the save rider on a bite, the
    extra damage on a sneak attack). Preparation fills an activation in when the item has one, so empty on
    a prepared actor is an assertion. Treating it as an action let a creature spend its turn on the save
    half of an attack it never made. `economyOf("")` returns null; do not "helpfully" default it.
  - **Passive activations must not be turn options.** 106 `special` activations exist (grapple-escape
    checks and the like). They are classified `free` for honesty but excluded from turn planning.
  - **Wrappers are how monsters cast.** 509 `cast` activities against 524 spell items: "1/day each:
    fireball" is a feat holding the uses and pointing at a *compendium* spell. `fromUuidSync` on an
    unloaded pack returns an index stub with no activities, so the spell must be resolved with an await
    (`prewarmCastSpells`, called before `planTurn`) or every caster reads as having no spells. Where a
    spell appears both as an item and behind a wrapper, the **wrapper wins** — it owns the resource, and
    casting the item bypasses the daily limit.
  - Confirmations, not corrections: `attack.type.value` was never empty on a prepared actor (277 melee,
    89 ranged); only 17 of 366 attacks state no numeric range, and all 17 are `self` (11) or `touch` (6),
    which is the population the reach fallback exists for; every spell in that world uses `method:
    "spell"`; 74 of 193 creatures have no language at all, so banter correctly never reaches them.
  - **The empty-activation rule is load-bearing, not redundant.** A follow-up census on 0.4.25 came back
    `riders: 2`, `midiAutomationOnly: 0`, `canUseFalse: 13` out of 2067 activities — so the system's own
    rider flag does NOT mark the 109 empty-activation companions, and midi links its save/damage halves
    through its own fields instead. Do not "simplify" by trusting `isRider` to catch them; keep all four
    checks, and re-measure with the survey if midi's linkage changes.
  - Also worth knowing: activity *names* are useless as identity — "Midi Use" 379, "Midi Attack" 349,
    "Midi Save" 298 are all midi's type titles. And `consumption.spellSlot: true` appears on plain
    weapon attacks, so it means nothing on its own.
- **Token movement in v13+ (researched from core source, 2026-08-03, after v0.4.24 shipped movement that
  announced itself and never happened).** All of this lives in `combat/auto/movement.ts`:
  - `TokenDocument#move(waypoint, options)` returns `Promise<boolean>` and has **four paths that resolve
    `false` without throwing** — path constrained to nothing, a `preMoveToken` veto, no usable waypoints,
    or `stopMovement()`. **A boolean-returning core API needs its false branch handled, not just its
    throw.** And the converse: **`move() === true` is not evidence of movement**, because core sets its
    success flag *before* `preUpdateToken` fires, so a handler that deletes `x`/`y` (Rideable does this for
    grappled/mounted tokens; Monk's Active Tiles for teleport cooldowns) yields `true` and a stationary
    token. Verify against `doc._source.x/y` — never the prepared `x`/`y`, which are animated mid-move.
  - **Wall constraint applies to API moves and the GM's "Unconstrained Movement" toggle does not**: core
    reads that setting only in `Token#_getDragConstrainOptions`. "I can drag it there myself" proves
    nothing. Bypass, when genuinely wanted, is `constrainOptions: {ignoreWalls: true}` or
    `action: "displace"`. We pass `ignoreCost: true` only, because the planner budgets movement itself.
  - Waypoint `x`/`y` are **top-left pixel integers**, not centres and not grid offsets. `snapped` is
    metadata recording a claim, and snaps nothing — call `doc.getSnappedPosition()` to actually snap.
    An unrecognised `action` **throws**; unknown waypoint keys are silently dropped.
  - A move **paused** by a region behaviour (Terrain Mapper stairs/elevators) never settles its promise,
    so every await is raced against a timeout and then `stopMovement()`ed. Without that, one stair tile
    hangs a creature's turn and the whole automated initiative chain behind it.
  - `update({x, y})` is not a teleport any more and not a fallback: since v13 it is routed through the
    same constraint/veto pipeline, and merely hides the outcome behind a truthy return.
  - Third-party vetoes to suspect first: **Token Warp** (clamps out-of-bounds moves, vetoing ours while
    moving the token itself). **NotYourTurn was on this list and has been cleared** — see below.
  - **NotYourTurn cannot block a planned turn, corrected from source 2026-08-11.** The old note here said
    it never checks `movement.method` so an API move reads as a player drag. True, and irrelevant: its
    `preMoveToken` handler exempts the current combatant outright — `if (token.id == combatTokenId)
    return;` (`NotYourTurn.js:159-162`) — before it ever reaches the role check, and the planner moves
    precisely the creature whose turn it is. Its role modes are 0 off / 1 warning-only / 2 dialog /
    3 autoblock, and only mode 3 returns false; `BlockGM` defaults to **1**, so at stock settings it
    cannot veto anything on a GM client anyway. **The real exposure is forced movement**, which displaces
    a token that is *not* the current combatant: at the default that costs a spurious "moved out of turn"
    warning and a GM whisper, and at dialog or autoblock it would break shoves outright. Its
    `moduleForcedMovement` flag is its own undo bookkeeping, not an API anyone else can set.
  - **Do not let our own geometry veto a move (2026-08-04).** v0.4.26 still moved nothing, and the reason
    was not in `moveTo` at all: the callers discarded every candidate destination first, silently, so core
    was never asked. Two causes, both ours. `occupied()` compared a Token placeable against a
    TokenDocument with `===`, so a creature counted *itself* as an obstacle. And our flat
    `blocked()` wall test vetoed candidates on an elevated scene — a party on top of a barbican reads as
    walled in by the rooms underneath, because that test knows nothing about elevation. `blocked()` is now
    advisory in `movement.ts` (logged, never a veto): **core is the authority on whether a move is legal,
    and a second silent opinion can only subtract moves it would have allowed.** It is still a real veto
    in `positioning.ts`, where the question is line of sight rather than legality.
  - Every rejection on the movement path must name the square and the reason. A bare `continue` is what
    made this cost three releases: `moveTo` reported refusals in detail while nothing ever reached it.
  - **Turn pace is a floor on duration, gated on completion — never a deadline (2026-08-04).** The clock
    starts when the tracker reaches the creature, and the tracker only advances after `runTurnFor`'s
    promise resolves, so a turn that takes longer than the floor simply takes longer. Nothing anywhere
    cuts a turn short, and nothing keys off "movement finished". Say this plainly when it comes up: the
    natural reading of "minimum turn duration" is a timer that could truncate a turn, and it is not one.
    The one place a clock CAN end something early is the move stall watchdog, which is why it counts only
    time with no visible animation — a twelve-square walk at one square per second is twelve legitimate
    seconds, and the flat 8-second timeout it replaced would have killed it mid-stride as a hang.
  - **Off-turn reactions, natively (2026-08-04).** `combat/auto/reactions.ts`, no module required — see
    design principle #0. Two triggers, chosen because core alone can detect them with certainty:
    `preUpdateToken`/`updateToken` for "someone left my reach" (snapshot who had the mover in reach
    BEFORE the change, compare after; these two hooks have been stable for many versions and catch a
    move made by any means), and a hit-point decrease via `preUpdateActor`/`updateActor` for "I was hurt
    off-turn" — split across both hooks because the old value only exists before and the reaction must
    not resolve until the damage has landed. Reaction-spent bookkeeping is OURS, keyed by combatant and
    cleared on round change, not read from any module's flags.
    Two things to know before extending it. An opportunity attack is not a sheet entry in any system —
    it is an ordinary melee attack spent as a reaction — so the code looks for the best melee attack,
    not a reaction-flagged item. And damage carries no attribution, so the creature whose turn it is
    gets the blame; that is right nearly always and wrong for traps and lingering area effects, which is
    why it is logged as an assumption.
  - **What the midi review established (2026-08-04, read from source; clones under `C:\Project\_research`).**
    Facts worth not rediscovering:
    - **Midi does NOT automate opportunity attacks.** Its `reactionmoved`/`isMoved` trigger type is
      declared but never dispatched from any of the eleven `doReactions` call sites. Its `recordAOO`
      setting is bookkeeping only: it marks a reaction spent when *you* attack off-turn.
    - **Gambit's Premades DOES**, via a Region per combatant, and is therefore a hard conflict — two
      opportunity attacks per departure. Hence the stand-aside check in `reactions.ts`. chris-premades
      implements no OA and registers no midi hooks, so it is safe. Gambit's is v13-only as of 2.1.44.
    - **Midi's reaction prompt cannot be answered programmatically** — `ReactionDialog` has no
      auto-select, and the only supported intervention is the awaited `midi-qol.ReactionFilter`. Do NOT
      cancel that hook and substitute your own Shield: midi only re-reads AC when the dialog returned a
      real result, so the attack resolves against the stale AC. Pre-empt earlier instead.
    - **`MidiQOL.setReactionUsed()` is a silent no-op unless `enforceReactions` is `"all"` or
      `"displayOnly"`** (it defaults to `"none"`, and `"character"` does not cover NPCs). We call it
      anyway, purely so midi's own prompt suppresses itself, and never rely on it — hence our own ledger.
    - dnd5e 5.3.3 has **zero reaction tracking** and **no Disengage flag, item or status effect**; it is
      prose in stat blocks only. The community convention is an ActiveEffect literally named "disengage",
      which is what we match.
    - Reaction uses want `isReaction: true` and `workflowOptions.targetConfirmation: "none"` in
      `midiOptions`, which is what midi's own reaction path passes.
  - **Planned, not built: Shield, Parry, Counterspell.** Without midi, dnd5e never compares an attack roll
    to an AC — a human eyeballs it — so there is no "about to hit" moment and Shield genuinely cannot be
    timed natively. The shape that respects principle #0 is a two-part job: an optional adapter that
    lights up when midi is present, hooking `midi-qol.preCheckHits` (the last point at which an AC change
    is still read by `checkHits`, followed by `actor.reset()`), `midi-qol.hitsChecked` for Parry, and
    `midi-qol.isDamaged` for retaliation at higher fidelity than our hit-point watcher; plus a NATIVE
    Counterspell off dnd5e's own activity-use hooks, since "a spell is being cast" is observable without
    midi. Every midi hook built from `WorkflowState_X` exists as both `midi-qol.preX` and `midi-qol.postX`
    and is awaited, so an async handler legitimately delays the workflow.
  - **Asking "can that monster see that player" (2026-08-04, source-verified).** Everything in
    `combat/auto/perception.ts`. Three separate traps, each of which fails SILENTLY:
    1. `token.isVisible` and `canvas.visibility.testVisibility` answer whether the CURRENT USER can see
       something. Core's method iterates `canvas.effects.visionSources` (what is initialized on this
       client) and short-circuits to `return game.user.isGM` when there are none — a confident "yes" to
       everything on an automation client. Neither can be scoped to an arbitrary token.
    2. An uncontrolled NPC has **no vision source on a GM's client**: `Token#_isVisionSource()` refuses
       for a GM unless the token is controlled. Build one by hand —
       `new CONFIG.Canvas.visionSourceClass({sourceId, object: token})` then
       `initialize(token.document._getVisionSourceData())` — and **never call `add()`**, which would
       register the monster's eyes with the canvas and change what the GM sees. Destroy it after use.
       `DetectionMode#testVisibility(visionSource, mode, config)` takes the source as a PARAMETER, which
       is the only reason per-creature perception is possible at all.
    3. **dnd5e never maps stat-block senses onto detection modes, and NPC tokens ship with sight off.**
       Its character template sets `prototypeToken.sight.enabled: true`; its NPC template has no
       prototypeToken block, and core's default is `enabled: sight.range > 0` with range 0.
       `_prepareDetectionModes()` returns early when sight is disabled, so the token gets NO modes and a
       vision test returns false for the entire bestiary. Senses live at
       `system.attributes.senses.ranges.{darkvision,blindsight,truesight,tremorsense}` since dnd5e 5.3
       (flat path still shimmed); vision-5e is the module that does the mapping properly. Our fallback:
       no usable modes → stated senses + a wall test, and log the creature once. **Never let an empty
       capability read pass as "cannot see".**
    Also: `detectionModes` is a **Record keyed by id in v14, an Array of `{id,...}` in v13** — the wrong
    shape yields an empty list, i.e. a blind monster, with no error. And running the detection-mode loop
    is what gets lighting, magical darkness and invisibility right for free; do not hand-roll those.
    Patrol (theripper93) tests `fov.contains()` only, which is why it ignores all of the above — take its
    architecture, not its test. Behaviour was the reference; the code is ours, nothing is vendored here.
  - **Starting a combat unattended (2026-08-04, source-verified).** Find the encounter **by scene**
    (`game.combats.find(c => c.scene?.id === scene.id)`) — `game.combats.viewed` is the tracker's current
    selection, i.e. UI state, and is meaningless on an automation client. Then
    `TokenDocument.createCombatants(docs, {combat})` (handles the already-a-combatant case),
    `combat.rollNPC()`, `combat.startCombat()`. dnd5e overrides `rollAll`/`rollNPC`/`rollInitiative`, so
    core's methods already apply the system's initiative configuration — never pass a formula.
    `rollNPC` not `rollAll` on purpose: rolling a player's initiative for them takes away the one roll
    they expect to make, and it is not the work the GM asked to be relieved of.
    `CONFIG.specialStatusEffects.DEFEATED` (default `"dead"`) via `document.hasStatusEffect()` is the
    defeated test; disposition must be `=== HOSTILE`, never `< 0`, because SECRET is −2 and is GM
    bookkeeping. Fires vetoable `noodlrPreCombatInitiated` and `noodlrCombatInitiated` hooks.
  - **Stealth: Foundry's vision question is not 5e's question (2026-08-04).** `combat/auto/stealth.ts`.
    Core answers "is there an unobstructed line to a lit token"; 5e asks "did you beat their Perception".
    Nothing connects the two natively — verified in dnd5e 5.3.3 source: the `hiding` status effect
    (introduced 3.1.0, note the "-ing") has no `special` key and is read by *nothing*, and a Stealth
    roll's total is never persisted to actor, token or flag; it exists as a chat message and then it is
    gone. Every piece of stealth state is therefore ours to own.
    - **We patch nothing, and that is the whole design.** Stealthy wraps each detection mode's
      `_canDetect` through libWrapper because it must change what every client renders. We do not: our
      sweep builds its own vision source and calls `testVisibility` itself, so we own the call site and
      simply refuse our own result. No libWrapper, no prototype-ordering war with Stealthy or Vision 5e,
      and no chance of an automation query altering the GM's screen. If we ever *do* need to affect
      rendering, Vision 5e's maintainer gave the recipe in their issue #77: wrap
      `CONFIG.Canvas.detectionModes.<id>.prototype._canDetect` per mode in a `setup` hook — never
      `DetectionMode.prototype._canDetect`, which Vision 5e's subclasses override without calling super.
    - **Only a declared hider is contested.** An ordinary walking player is spotted exactly as before.
      State comes from the first source that answers: Stealthy's `window.stealthy.getBankedStealth(token)`
      (returns `undefined` when not hiding — its author's documented integration surface, and there is no
      `game.modules.get("stealthy").api`), Perceptive's `flags.perceptive.PPDCFlag` (`-1` means
      "impossible"), our own `flags.noodlr.stealth`, then dnd5e's inert `hiding` status honoured with
      passive Stealth. Their modules outrank our flag on purpose: when the two disagree the GM should be
      able to trust the UI in front of them. This is the entire integration — no dependency, no patching.
    - **Passive Perception versus a static DC, never a re-roll.** A six-second poll that rolled each
      sweep would eventually spot anyone by luck, which is a worse rule than either edition's. Ties go to
      the spotter: 2024 makes the Stealth total the DC for a Perception check, and a check meets its DC
      on equal. 2014's letter wants an *active* check by a creature that searches; passive-vs-DC is the
      universal convention and we use it under both rulesets deliberately.
    - **Capture via `createChatMessage`, not `dnd5e.rollSkillV2`.** The hook fires only on the rolling
      client, so every client would race to write the flag and only some would have permission. The chat
      hook fires everywhere, letting the primary GM be the single writer. Message shape (verified):
      `flags.dnd5e.roll = {skillId: "ste", type: "skill"}`, total at `rolls[0].total`. Speaker matching
      must prefer `speaker.token` and only fall back to `speaker.actor` for linked actors — every
      unlinked goblin shares one actor id. Hook-name trivia if we ever switch: in dnd5e 5.x *both*
      `dnd5e.rollSkill` and `dnd5e.rollSkillV2` fire with the same `(rolls, {ability, skill, subject})`
      shape, so listening to both double-handles every roll.
    - **Never silent.** A stale hidden state suppressing every encounter forever is this feature's most
      likely failure, and it looks identical to the feature being broken. Each spotter/target pairing
      logs its suppression once, hiding clears on an attack roll or a verbally-cast spell and on combat
      end, and `api.surveyPerception()` dumps the whole matrix with distances, detection modes, passive
      Perception and each verdict.
    - **Concealment is only checked on the fallback path.** When real detection modes run, core already
      enforces invisibility and burrowing in its own `_canDetect`; doing it again would disagree with the
      screen. The stat-block fallback bypasses all of that, so invisibility and the Ethereal Plane are
      applied by hand there. Sense ranges come from Vision 5e's `actor.detectionModes` when present — a
      plain `Record<modeId, range>` computed for every actor *regardless of `sight.enabled`*, which makes
      it strictly better than reading the sheet — and from `senses.ranges` otherwise.
    - **Beyond mundane hiding, and the one deliberate breach of Principle 1 (2026-08-04, user's list).**
      Invisibility, Fog Cloud, Darkness, Nondetection, Pass Without Trace, the illusion spells, Mask of
      the Wild, Nature's Veil and friends are recognised BY NAME from a table in
      `combat/systems/dnd5e-concealment.ts` — the module's SECOND and last game-system-specific file,
      after `dnd5e-rewards.ts`. Rules-as-data, not branches: `auto/stealth.ts` never learns a spell name.
      The two sides meet through a small abstract capability vocabulary — `truesight`, `seeInvisible`,
      `blindsight`, `tremorsense`, `devilsSight`, `etherealSight`, `detectMagic`, `divination`,
      `hearing` — where a concealment declares what `pierced`s it and a sense declares what it `grants`.
      **To port to another system:** write a sibling file exporting the same three functions
      (`concealmentsOn`, `detectorsOn`, `sheetSenses`) gated on its own `game.system.id`, and switch on
      it in `stealth.ts`. A system without invisibility simply never emits `seeInvisible` and the engine
      is unchanged. Name matching is not laziness: Foundry stores no machine-readable "this conceals"
      marker and dnd5e's conditions cover only `invisible`, so the name is the only signal that exists.
      It fails safe — an unrecognised effect does nothing, exactly as before the table existed.
    - **Concealment placed in the world, not worn (2026-08-04, user's correction).** `auto/screens.ts`.
      A party does not cast Fog Cloud on itself — it drops the fog, the Darkness sphere or the illusory
      hedge BETWEEN itself and the guard, so nothing is ever applied to the hider and an effects-only
      model misses the common case entirely. Screens are found geometrically: walk the line between the
      two token centres at half a grid square (capped at 80 samples) and test containment against
      MeasuredTemplates, Regions, and AmbientLights configured as darkness sources. Each is absolute
      until pierced, so a watcher must get past the interposed thing before it has any chance at what is
      behind it. **Worn and interposed are both real and the screens table is checked BOTH ways**
      (user's correction, 2026-08-05): a fog bank is usually placed, but Darkness cast on oneself is the
      canonical Devil's Sight warlock build — they walk the battlefield inside it, seeing out perfectly
      while the guard still has to pierce it. That renders as light emitted by the TOKEN, which the
      ambient-light layer never sees, so token lights with `light.negative` are scanned too; and when a
      module applies it as an effect instead, the worn check catches it. The sampled line includes both
      endpoints, so a creature standing in its own darkness is found exactly like one standing behind
      someone else's. **Naming is the hard part, not the geometry:** Foundry records nothing on a template
      about which spell placed it beyond an origin link that has moved across dnd5e versions and may now
      point at an Activity rather than an Item, so several paths are tried and an unresolvable name means
      the screen is ignored — the correct failure, since an unrecognised template must not start blocking
      sight. Not modelled: the Study action to disbelieve an illusion, which is a player's declared action
      and not something a six-second poll should perform on an NPC's behalf.
    - **Three rules encoded there that are easy to get wrong.** Nondetection is applied to the WATCHER,
      not the hider: it conceals nobody, it blinds the diviner. It removes ONLY capabilities that came
      from a Divination spell (`divined`, tracked separately by `detectorsOn`) — a demon's innate
      truesight is its own eyes and survives, while True Seeing, See Invisibility, Detect Magic and
      Locate Creature do not. Glitterdust and Faerie Fire also survive, being evocations that coat a
      creature in light rather than scry for it. Magical Darkness is deliberately not beaten by
      darkvision. And `trait` versus
      `effect` is a correctness distinction — an always-on trait (Mask of the Wild, Feral Senses, a
      wolf's Keen Hearing) is matched against items, an activated ability (Nature's Veil, One with
      Shadows) only against active effects, or every ranger would be permanently invisible.
    - **Not modelled, deliberately:** the 2024 prerequisites for Hide (Heavily Obscured or ¾ cover, and
      out of all enemy line of sight), size, and lighting-based Perception modifiers. Also the wild-shaped
      flea: no mechanical hook exists for "this shape is unremarkable", and that stays the GM's call.
  - **Perception is one-way, and shouting has a range (2026-08-04, user's spec).** Only a hostile
    creature spotting a player token ever starts a fight; nothing tests a player as the spotter, because
    a party that chose to sneak has chosen not to fight and opening combat on the players' own eyeballs
    would make stealth impossible. Recruitment is capped by `getEngageRadius()` (default 30, scene units,
    configurable): only hostiles within that distance of the SPOTTER join, so one sentry cannot pull a
    whole dungeon. Measured with elevation, and deliberately through walls — it models a shout. The party
    is deliberately NOT radius-limited: adventurers arrive together, and a scout spotted ahead of the
    marching order should not be left fighting alone.
  - **Sweeping does not stop when the fight starts (2026-08-05, user's report).** The radius cap has a
    necessary consequence: creatures out of earshot legitimately miss the opening, and they must be able
    to arrive later or they never arrive at all — a hostile outside the original radius was shot at over
    several rounds and the tracker ignored it. So sweeps continue during combat, restricted to hostiles
    not already enlisted, and a hit routes to `reinforce()` instead of `engage()`: add the newcomer plus
    whoever IT can shout to, `rollNPC()` (which rolls only the unrolled, leaving existing places intact),
    announce, done — never `startCombat()` again. Two entry points, because perception is not the only
    way into a fight: **being hurt joins you regardless of what you saw**, on `preUpdateActor` (not
    `updateActor` — only a DROP counts and the old value is gone afterwards), matching the victim by
    `actor.token.id` because an unlinked token's synthetic actor reports the shared BASE actor id.
    Sweeps still stand down for a combat that exists but has not started: that is someone mid-setup, and
    usually our own initiative wait.
  - **A turn order is not real until everyone has a number (2026-08-04, from a live test).** Rolling the
    monsters and calling `startCombat()` in the same breath put a monster at turn zero of a provisional
    order and automation played the whole round: the player was unconscious before ever rolling. Two
    independent guards now, and both are wanted. `perception.ts` posts the "roll for initiative" call,
    then holds up to `INITIATIVE_WAIT_MS` (60 s, polled once a second) for `initiativeSettled()` before
    `startCombat()`; on expiry it `rollAll()`s the stragglers and says so in chat, because an absent
    player must not be able to freeze an encounter. `hooks.ts` `takeTurn()` independently refuses to play
    any turn while a non-defeated combatant has no initiative, which also covers a combat the GM began by
    hand, and picks the fight back up from an `updateCombatant` hook the moment the last straggler rolls
    (guarded by a `combat:round:combatant` token so the two entry points cannot both play the same turn).
    Defeated combatants are excluded from the check so a corpse cannot deadlock the fight.
  - **Movement is not just walking (2026-08-04).** `combat/auto/locomotion.ts` reads every mode on the
    sheet and is the only place allowed to decide which one a creature uses. Two rules encoded there,
    both deliberate: flight wins over walking whenever it is faster (a dragon does not jog), while swim,
    burrow and climb are last resorts for creatures with nothing else, because Foundry models no terrain
    types and choosing "swim" for a land creature crossing a dungeon floor would be inventing a rule.
    The chosen mode sets the movement BUDGET as well as the action passed to `move()` — reading walk
    speed alone gave a wyvern 20 ft instead of 80 and gave aquatic monsters 0.
  - **Let core do the cost accounting.** `moveTo` passes `maxCost: budget` rather than `ignoreCost: true`.
    The old flag was a quiet rules violation: difficult terrain costs double, so 30 ft of movement buys
    15 ft of bog, and core already knows the multiplier for every movement action — including that a
    flyer pays nothing for the bog. Do not reintroduce `ignoreCost` to "fix" a short move.
  - **Reach is three-dimensional.** `BoardActor.elevation` exists and the planner measures separation as
    `hypot(horizontal, rise)`. A creature that can neither fly nor climb is not offered a melee option
    against something above it, which is what stopped ground troops from walking hopefully at a hovering
    caster and burning the turn. Horizontal-only measurement remains elsewhere (kiting, cover) on purpose.
  - `api.testMove()` (`combat/auto/diagnose.ts`) is the ground truth when this recurs: it really moves the
    selected token one square, escalating walls-enforced → walls-ignored → `displace` → `noHook`, reports
    core's answer at each stage, and restores the position. Whichever attempt first succeeds names the
    cause without any inference.
- **Observe the world, don't infer it.** `api.surveyActions({ saveToFile: true })` censuses every sheet in
  the world — activity types, activation types, range units, flag namespaces, spell methods, language
  shapes, and one worked example per activity type. When a data shape is in question, run it before writing
  code against a guess. Both v0.4.22 and v0.4.23 shipped bugs that this would have caught in seconds
  (user's suggestion, 2026-08-03: "we can map whatever you need dynamically from within the running world
  itself"). Written to `<mediaFolder>/survey/noodlr-sheet-survey.json`, i.e.
  `assets/noodlr-out/survey/` by default; `asText: true` prints one selectable block instead, for a GM
  whose Foundry is on another host.
  - **The instrument has to be aimed at the current question before asking for a run** (2026-08-07). It
    skipped player characters by design — the planner drives monsters — and that quietly made it useless
    for everything the action economy raises, since action slots, attacks-per-action and bonus-action Dash
    are all character problems. v0.4.47 added a `characters` arm (separate from the creature tallies, so
    older runs stay comparable) plus a world-wide `claims` section listing every FEATURE that would be
    charged a slot and is not exempted as a damage rider. Before asking the user to re-run this, check
    that it actually measures what is currently in doubt.
  - `attacksPerAction` is the one value in the economy that is detected rather than counted, so
    `explainAttacksPerAction()` in `economy/ledger.ts` returns its source alongside the number and
    `attacksPerAction()` is a thin caller — the two can never disagree, which a separate reimplementation
    in the survey would eventually have done.
  - `economy/claims.ts` is shared by the census and by `api.surveyEconomy()` for the same reason. It
    deliberately depends on no settings: a census must be askable with every automation switched off.
  - `notable()` filters on the ITEM being a feature rather than on the activity being damage-typed. The
    narrower test was tried first and would have missed the Sneak Attack that prompted all this, because
    nothing guarantees an importer typed it as damage.
- **Probe Foundry globals lazily, one at a time.** Building an array of fallback candidates evaluates
  every entry, and merely *touching* a deprecated global (`ClockwiseSweepPolygon`) emits a console
  warning even when the modern namespace already answered. `src/combat/auto/positioning.ts` stores
  thunks and resolves them in order for exactly this reason.

- **The declaration is the status; a Stealth roll is only a number (v0.4.43, 2026-08-07).** Reported from
 play: a rogue who never took the Hide action was never spotted by anything, never triggered an encounter,
 and killed hostiles one at a time while they stood oblivious. Root cause was the trigger, not the contest —
 `stealth.ts` banked a hidden state on ANY `ste` roll appearing in chat, with no prerequisite and no expiry,
 and the flag persisted in the world save. **The bug was inherited:** Stealthy's README says outright
 *"Rolling a Stealth skill check will apply the Hidden effect"*, Perceptive does the same on
 `flags.dnd5e.roll.skillId === "ste"`, and neither clears on an attack. They survive it *on some tables*
 because midi's `removeHiddenInvis` toggles the `hidden`/`hiding` statuses off after every attack roll —
 and it had never heard of `flags.noodlr.stealth`. Only Chris's Premades gates on the Hide action.
 - **Correction (2026-08-10, re-read from source): `removeHiddenInvis` does NOT run on a stock midi
 install**, so this note previously overstated the safety net. The field defaults `true`
 (`settings.ts:290`) but is read through `checkRule()` (`Workflow.ts:2110-2111`, `:8431`), which gates on
 `optionalRulesEnabled` — and that defaults **false** (`settings.ts:213`). A GM reading midi's config
 panel sees `true` and concludes the opposite of the truth. Consequence for us: with midi at defaults
 **nothing in the world clears a hidden state except our own reveal**, so the `dnd5e.rollAttack` listener
 in `stealth.ts` is more load-bearing than the note implied, and the status-presence rule below is the
 only structural guard. It also means the inherited bug is live on stock installs of Stealthy and
 Perceptive rather than merely latent. Full comparison: `_research\_audit\stealth-modules-comparison.md`;
 rules audit: `_research\_audit\stealth-hide-raw.md`.
 - **`hidingState()` must not read our banked flag unless the `hiding` status is present.** That single
 ordering is what makes a stale flag structurally incapable of hiding anyone, and it means every way of
 removing the status — token HUD, midi, an effect expiring, our own reveal — ends the state without
 knowing we exist. Do not "optimise" it by reading the flag first.
 - **Reveal off `dnd5e.rollAttack`, never a chat message.** Midi merges the attack into its own card and
 posts no separate attack message, so the old `createChatMessage` listener waited for something that
 never came. The system hook fires inside midi's flow (midi itself registers
 `Hooks.once("dnd5e.rollAttack")` at `AttackActivity.ts:446` to catch the ammo update). It fires only on
 the rolling client, which is fine and is the point: a creature giving itself away is always acted by
 someone who owns it, so that client can always write. Consequence — **`registerStealthWatch()` must be
 registered on every client, not inside the GM-only block.** Note `enrichers.mjs:281` fires the same hook
 with `subject: null` for a bare `[[/attack]]`, and both `rollAttack` and `rollAttackV2` fire, so listen
 to one and guard the subject.
 - **A missed attack DOES reveal you, in both editions** — the hit-only rule the user remembered is
 **Skulker's Sniper** benefit (2024 PHB p. 208), not a house rule, so it is a feat lookup rather than a
 setting. Skulker ships in NO dnd5e compendium (PHB, not SRD), so there is no authored identifier to
 trust: `dnd5e-stealth.ts` tries `flags.noodlr.sniper`, then `system.identifier`, then the item name.
 Its Fog of War (advantage on Hide in combat) is honoured too; its Blindsight 10 needs nothing, because
 `sheetSenses` already reads the range off the sheet.
 - Sniper is the only reason we ever need hit-or-miss, and `attackConnected()` is deliberately NOT
 `forced.ts`'s `hitTargets`: an empty target list means "nobody" there and "no idea" here. **Unknown
 reveals.** Crit and fumble are answered before the AC loop, or a single unreadable AC would discard the
 one fact the die already settled.
 - **We do NOT apply the `invisible` condition for mundane hiding**, even though 2024 Hide grants the
 Invisible condition. Perceptive does, and it makes hiding indistinguishable from magical invisibility to
 every sense-aware module; dnd5e's own content shares our instinct and stamps only `hiding`.
 - **`auto/hide.ts` exists because dnd5e ships no Hide action** outside Cunning Action, Nimble Escape and
 Shadow Stealth. With the status as the declaration, no button would mean most of the party can never
 hide. Cover is estimated by counting blocked corner rays (3 of 4 = three-quarters); that is an
 approximation of a rule 5e states as a fraction of the target obscured, it is what every cover module
 does, and it is stated in the file so nobody mistakes it for exact. Prerequisites are evaluated
 per-watcher, because every term in the rule is relative to an observer.
 - **Invisibility's break is separate from the hiding clear, deliberately.** Midi couples them under one
 rule and therefore deletes Greater Invisibility on the first attack — the entire difference between a
 second-level spell and a fourth-level one. `auto/invisibility.ts` skips concentration effects
 (`actor.concentration.effects.has(effect)`, not the localised "Concentrating:" prefix) so a wizard who
 made someone else invisible does not lose their own spell by swinging.
 - **Surprise was free capability.** dnd5e already lists `surprised` in
 `CONFIG.DND5E.conditionEffects.initiativeDisadvantage` and reads it during initiative prep; it just never
 decides who is surprised. We do, using the literal test (a joining hostile that cannot perceive one
 party member), applied before `rollNPC()` since it modifies the roll. Players are never marked —
 perception is one-way by design, so we have no honest basis for it.
 - The damage-starts-a-fight path shares the sweep's `sweeping` guard: `engage()` holds for up to 60 s
 waiting on initiative, so without it a second casualty during that wait creates a second Combat.

- **Nobody counts actions, so we do (v0.4.38, 2026-08-05).** Verified in dnd5e 5.3.3 source, not assumed:
  `CONFIG.DND5E.activityActivationTypes` gives each activation type an optional `consume` property naming
  an actor resource pool, and exactly three declare one — `legendary`, `mythic` and `crew`. `action`,
  `bonus` and `reaction` carry a label, a header and a group and nothing else, which means the whole
  consumption block at `mixin.mjs:540` (gated on `activationConfig?.consume`) never runs for them and the
  system's own "not enough actions" warnings are unreachable. No per-turn counter exists anywhere in the
  data model. This is intentional — the system's JSDoc says *"Currently only handles legendary actions"*
  and "Action tracking" is an unshipped 5.0.0 roadmap item — and no module fills the gap either: midi's
  `enforceReactions`/`enforceBonusActions` default to `"none"`, there is no `enforceActions` at all, and
  even when enabled midi asks rather than blocks. Full rules reference and gap audit in
  [`docs/action-economy-2024.md`](docs/action-economy-2024.md). Load-bearing details:
  - **The veto is `dnd5e.preUseActivity`, not a patch.** It fires before the usage dialog and before any
    chat card, and returning false cancels cleanly. midi's activity `use()` calls `super.use()`, so the
    same hook fires under midi as without it. Do not reach for libWrapper here.
  - **Do NOT add `consume: { property }` to `activityActivationTypes.action` to borrow the system's
    legendary-action enforcement.** It is tempting and it is wrong: it mutates shared config for every
    other module in the world and would double-count against anything else doing the same.
  - **The budget lives on the actor as a flag, not in a Map.** The hook fires on whichever client used
    the item, so a player's browser must be able to read and write its own budget; GM-side memory is
    invisible to exactly the person it needs to stop. Writing through `actor.setFlag` also gets unlinked
    tokens right for free, because it lands in that token's ActorDelta.
  - **Nothing is ever reset.** A tally carries the stamp of the turn it belongs to, and a stale stamp
    reads as zero. Derived, not stored, so every client computes the same answer with no write and no
    race. The stamp is the round in which the creature's own turn most recently began — which is what
    "refreshes at the start of your turn" means, and what a naive per-round reset gets wrong for a
    reaction spent earlier in the round than the creature's own turn.
  - **Actions and attacks are separate currencies.** One Action buys several attacks, so counting attack
    rolls as actions stops a fighter's second swing — the single most common thing in the game. Actions
    used is `nonAttackActions + ceil(attacks / attacksPerAction)`. `attacksPerAction` is *read*, not
    guessed: dnd5e class features carry stable `system.identifier` values (`extra-attack`,
    `two-extra-attacks`, `three-extra-attacks`). Monsters have no such field, so Multiattack prose is
    parsed for a number word and defaults to **2** when unparseable — biased generous on purpose, since
    blocking a legal attack is a bug report while allowing one too many is merely a bad turn.
  - **Automated creatures are hard-blocked; players are configurable; the GM is never blocked, only
    asked.** The player default is "ask, then log the answer publicly" rather than a hard block, because
    the rules break their own general case constantly — Haste grants a whole extra action — and a system
    with no way to say yes makes those features unplayable (user, 2026-08-05). Asking privately and
    answering publicly is what keeps the override usable without making it abusable.
  - **Effects grant slots via flags, not via code changes here:** `flags.noodlr.extraAction`,
    `extraBonus`, `extraReaction` (AE mode Add) and `flags.noodlr.attacksPerAction` (Override).
  - `execute.ts` asks the ledger *before* attempting, because a hook veto cancels without throwing and
    the attempt loop would otherwise report a swing that never happened.
  - **Extra damage is not an action, and the test has to be a name table (v0.4.46, 2026-08-07).** Reported
    from play: a rogue hit, was offered its Sneak Attack, and was told it had already used its action.
    `systems/dnd5e-riders.ts` is the quarantined table; `enforce.ts` consults it *first*, before even the
    Incapacitated refusal, because a rider is never used on its own — if the attack it rides on was legal
    then so is it. `actions.ts` drops rider items from the planner's options entirely, since a planner that
    can pick one will occasionally pick it and that turn does nothing.
    - **The obvious structural rule is wrong, and it was measured rather than argued.**
      `scripts/census-damage-activities.mjs` over dnd5e 5.3.3's `packs/_source` (3,246 activities in 3,199
      items) finds **62 `damage`-type activities that legitimately claim a real slot** — 57 action, 4 bonus,
      1 reaction: Holy Nimbus, every flask of oil, Divine Eminence, Heat Metal, Storm's Thunder. So
      "a damage activity never costs a slot" would make all of those free. Do not reintroduce it.
    - **Stock content was never the bug.** The same census shows dnd5e models riders correctly: 92 damage
      activities carry an empty activation and 13 carry `special`, both of which `slotFor` already declines
      to police. What needs the table is everything downstream — ddb-importer, premade libraries,
      hand-edited sheets — one of which had given Sneak Attack a real activation.
    - **Divine Smite is deliberately absent.** Free in 2014 and a bonus-action SPELL in 2024, sharing the
      identifier `divine-smite`. Listing it would hand 2024 paladins a free bonus action and buys nothing in
      2014, where the legacy feature already carries `special`.
    - Recognition order is flag (`flags.noodlr.damageRider`), then `system.identifier`, then the item name —
      and the name is only consulted when there is NO identifier, so a world that deliberately
      re-identified a feature is not overruled by what it happens to be called.
  - Diagnostics: `api.surveyEconomy()`, whose `claims` list names every activity that would be charged a
    slot. The Sneak Attack report was undiagnosable from the tally alone: the count was right and the thing
    being counted was wrong.

- **A chat card that names no speaker is signed with the author's assigned character (v0.4.46, 2026-08-07).**
  Reported as an attribution bug of ours and it was core filling in a blank: a player owning four characters
  saw Noodlr's cards signed with a different one, which was not even on the scene. Two getters in
  `client/documents/chat-message.mjs` do it —
  `get speakerActor() { return getSpeakerActor(this.speaker) ?? this.author?.character ?? null }` and
  `get alias() { return speakerAlias ?? this.speakerActor?.name ?? authorName }`. So the fallback is
  `user.character` from User Configuration, regardless of what is selected or even present on the scene.
  `ChatMessage.getSpeaker()` with no arguments has the same hole one step earlier, in its CASE 5.
  - **An empty alias string is no better than no speaker**, because `this.speaker.alias || null` discards it
    and falls through identically. Several of our cards were building `{ alias: String(x?.name ?? "") }`.
  - The same fallback feeds `getRollData()` and the portrait, so an unsigned card containing an inline roll
    would be evaluated against the wrong sheet.
  - Rule: **every card goes through `util/speaker.ts`.** `speakerFor(subject)` for a card about one
    creature, `narrator()` for the module's own voice (announcements about the fight, GM diagnostics).
    Never `ChatMessage.create({content})` with no speaker, and never a bare alias that could be empty.
  - `playedTokens(user)` is the single answer to "which characters is this person playing", **plural on
    purpose** — a player may legitimately drive two at once, and the old single-answer resolution is what
    made a four-character player look like whichever one sorted first. Order: selection (only readable for
    `isSelf`; another client's control state is not replicated), then the assigned character's token, then
    anything else owned here. Ownership is tested with `testUserPermission`, not `ownership[id] === 3`, for
    the same reason `rollerForActor` does: Foundry resolves through the default row and its ownership dialog
    *deletes* the per-user entry for anyone left on Default, so "All Players: Owner" matches nothing raw.
    Diagnostics: `api.surveyPlayed()`.

- **Nobody enforces Speed either (v0.4.39, 2026-08-05).** Same shape of finding as the action economy, and
  verified the same way. Core Foundry v13+ *does* have a real movement model — `TokenDocument#movementHistory`
  records every waypoint crossed during a turn, `Combat#_clearMovementHistoryOnStartTurn` resets it, and each
  waypoint carries a terrain-adjusted `cost` — but core has no concept of a creature's Speed and never
  compares the two. dnd5e supplies the number and spends it entirely on ruler colour (`TokenRuler5e` in
  `module/canvas/ruler.mjs`: green under Speed, amber under double, red beyond). `movementAutomation` sounds
  like the setting for this and is not — it governs movement *cost* (difficult terrain, climb/swim without
  the matching speed, crawl, token blocking), never a budget. midi-qol has exactly one `moveToken` listener
  and it expires DAE `isMoved` effects. So the ruler turns red and the token keeps going. Load-bearing:
  - **Truncate on the drag, veto everywhere else.** `Token#_getDragConstrainOptions` can carry `maxCost`
    (added in core **14.357** — it does not exist in v13, where unknown keys are silently destructured
    away), and core then discards waypoints past the budget inside `constrainMovementPath`, so the token
    stops at the line exactly as it stops at a wall. `preMoveToken` is the backstop for arrow keys: it can
    reject a move outright but **cannot shorten one** — waypoints are deep-frozen and only `autoRotate`
    and `showRuler` are writable.
  - **Budget the whole turn, not the remainder.** Core's docs do not say whether `maxCost` is measured
    against the proposed path alone or the path plus the history already recorded this turn, and the answer
    decides whether a second drag in one turn starts from zero. Passing the whole-turn allowance is correct
    under the "history counts" reading and merely lets the backstop do the work under the other; passing
    the remainder would silently halve the budget under the first. Do not "simplify" this without testing.
  - **Dash is charged, not asked.** A creature with something left to spend may drag past its Speed; the
    moment it does, `moveToken` charges the Dash and posts it to chat. The dash count lives in the action
    ledger's `Tally`, not beside the movement code, so it resets on the same lazy turn stamp as the slot
    that paid for it.
  - **Dash is NOT always an Action.** Corrected before release (user, 2026-08-06). A Rogue with Cunning
    Action and a Monk with Step of the Wind Dash as a **bonus action, for free**, and Expeditious Retreat
    grants the same to Sorcerers, Wizards and Warlocks while it runs. Charging the Action in those cases
    silently deletes the class feature, on the most routine thing a rogue does all night. `systems/dnd5e-dash.ts`
    reads it from `system.identifier` (`cunning-action`, `monks-focus`, `step-of-the-wind`, `fleet-step`,
    `ki`) — the same stable-identifier mechanism as Extra Attack — falling back to item and effect names,
    with `flags.noodlr.bonusDash` as the escape hatch for anything unlisted. Expeditious Retreat is
    `effectOnly`, since owning the spell grants nothing: dnd5e names its concentration effect
    `"Concentrating: <spell>"`, so the SPELL name is what gets matched, never the localised prefix.
    **The bonus action is preferred whenever it is available**, because that is what those features are
    for; the Action is the fallback once the bonus action is gone. If both are free the player is not
    asked, which is a deliberate call — it is a legal choice between two resources rather than a rule
    violation, the bonus action is right in nearly every case, and a dialog every time a rogue runs would
    be worse than an occasional undo.
  - **Two Dashes in one turn is legal and supported.** A rogue may spend its full movement, its bonus
    action on Cunning Action, and its action on a second Dash, for three times its Speed (user,
    2026-08-06). `chargeDash` therefore LOOPS, re-reading the budget after each charge so the allowance
    grows as the debt settles — charging once per move event would leave the second Dash unpaid when both
    are crossed in a single drag. The drag itself is only ever offered ONE Dash of headroom at a time,
    though: triple Speed stays reachable across successive drags, but a mis-drag cannot spend both slots
    before the player notices. `takeDash` takes the slot from its caller so the ledger stays agnostic
    about which resource a given system thinks Dash costs.
  - **Subclass `CONFIG.Token.objectClass` at `setup`, not `init`** — dnd5e installs `Token5e` at `init`, and
    extending whatever is there keeps its `ignoreTokens` handling. Registered from `init` on **every**
    client, not from the GM-only `ready` block: the person being constrained is the player.
  - **Dash exists TWICE and both halves must charge through one ledger entry (v0.4.48, 2026-08-07).**
    Measured, not reasoned: the census of the user's own world found all four characters carrying a `Dash`
    feature with `system.identifier === "dash"` claiming a real Action, plus `Cunning Action → Dash`
    claiming a bonus — the 2024 PHB action items, which Argon puts straight on the action bar. So a Dash is
    both an inference from movement AND a pressable activity, and `spend()` recorded only the slot while
    `budgetFor()` reads `dashesTaken`. Pressing the button therefore bought no extra Speed, and the movement
    it was bought for charged a SECOND slot: a rogue's Cunning Action took its bonus action and then its
    whole Action. Every charge site in `enforce.ts` now goes through `charge()`, which routes a Dash to
    `takeDash` instead. **The general lesson is the same one Sneak Attack taught:** whenever a layer infers
    a resource spend from behaviour, check whether the world also has a button for it, because a world with
    the PHB items installed has a button for nearly everything.
  - `isDashActivity` checks the ACTIVITY name first and the item identifier second, and the order is
    load-bearing. midi renames activities whose names were left at the default, so the standalone `Dash`
    item's activity reads "Midi Use" (identifier route), while a multi-purpose feature keeps its activities
    named — "Cunning Action" holds Dash, Disengage and Hide (name route). Neither route alone covers both.
  - Exempt: the GM (staging is not cheating), Noodlr's own automation (it budgets before it steps), and
    anyone moving outside their own turn. Diagnostics: `api.surveyMovement()`.
  - **The Hide button charges a slot too, and refuses rather than asks (v0.4.48).** Same census, same cause:
    a `Hide` feature claiming an Action existed beside our free button, so the cost depended on which one
    the player pressed. `auto/hide.ts` now bills an Action, or a bonus action when `bonusHideSource` finds
    Cunning Action, Nimble Escape or Shadow Stealth. It deliberately does NOT reproduce `enforce.ts`'s
    over-budget dialog: that dialog exists for features which legitimately break the general rule, and the
    ones that matter (Haste and relatives) already work by raising the allowance via
    `flags.noodlr.extraAction`, so they never reach a refusal. `force` is the override, and it now skips the
    cost as well as the cover prerequisites. Charged after the roll so a cancelled dialog is free, but
    charged whether or not the check beat the DC — spending the action is the rule.
    - **Pricing the two entrances the same was only half the job; they are now ONE entrance (2026-08-11).**
      Reported from play as a Hide problem and it was: `takeHideAction` was reachable only from
      `api.hide()` — there is no toolbar tool and no keybind, and the scene-control group registers just
      Act-as-NPC, GM-only, in `partial` mode. So the button a player actually presses is the PHB `Hide`
      feature on their own sheet, which Argon puts on the action bar, and pressing it spent an Action and
      did **nothing else**: no cover or line-of-sight prerequisite, no Stealth roll, no banked DC, leaving
      `hidingState()` to fall back to passive Stealth *if* the item stamped the status at all. Every word
      of the Hide implementation was unreachable at the table. `interceptHideActivity()` in `rules/hide.ts`
      now catches it from `enforce.ts` and cancels the activity, and `takeHideAction` bills the slot once.
    - **`isHideActivity` matches the activity name first and the item identifier second**, the same two
      routes and the same order as `isDashActivity`, and the order is load-bearing for the same reason:
      Cunning Action holds Dash, Disengage and Hide as separately-named activities so only the Hide one may
      be caught, while the standalone item is the case midi renames to "Midi Use" and must be found by
      identifier. Intercepting on the item alone would swallow a rogue's Dash and Disengage.
    - **The economy layer hands over rather than charging on the way past**, which is why the intercept
      lives inside `police()` rather than in a second `preUseActivity` listener. Two listeners would make
      the outcome depend on registration order, and getting it wrong means enforce charges and then
      `takeHideAction` charges again — the Dash double-charge rebuilt from parts. It sits after the
      Incapacitated refusal so a stunned creature is stopped at the button.
    - **A second press is not a toggle, deliberately (user, 2026-08-11).** Taking the Hide action twice is
      two Hide actions with a new DC, and the way out is removing the status — which is exactly what makes
      the status-presence rule above work, since every route to clearing it ends the state without knowing
      we exist. Expect this reported again: the button looks like it should toggle.
    - No token on the scene means no geometry to test and nothing to stamp, so the intercept declines and
      lets the sheet do whatever it would have done. Cancelling into silence is the one outcome worse than
      not intercepting, which is also why the async half surfaces a failure rather than logging it.
  - **The Attack and Magic buttons are announcements, and cost nothing (2026-08-11).** Third instance of
    the shape Dash and Hide taught, and the plainest: the 2024 PHB ships all thirteen actions as feat
    items, and two of them are followed by the thing that actually costs the Action. Pressing `Attack`
    (identifier `attack`, a `utility` activity claiming an action) charged one, and then the weapon's own
    attack activity charged another through the attack count — so a character without Extra Attack was
    refused their first swing of the turn. `magic` is identical and was missed in the first report, with
    three activities (Spell, Magic Item, Ritual) each claiming an action before the spell claims its own.
    `system/dnd5e-declarations.ts` is the quarantined table; `enforce.ts` consults it after the
    Incapacitated refusal and before the ledger.
    - **Charge nothing at the button rather than making the follow-through free.** The ledger already
      models the Attack action correctly — the first attack roll buys the Action and the rest of
      `attacksPerAction` rides on it — so a fighter with Extra Attack comes out right with nobody
      counting declarations at all. And a declaration is not a commitment: pressing Attack and thinking
      better of it should cost nothing, which is the generous direction this layer takes everywhere.
    - **Both the identifier and the name are matched only on `type === "feat"`**, tighter than the rider
      table, because "Attack" and "Magic" are generic enough to be a homebrew weapon. Exempting a weapon
      would not merely miss a rider — it would make that weapon free to use every turn, forever, with
      nothing reporting it.
    - **Dash stays out of the table.** It is charged twice for the same reason and cannot simply be
      skipped: whoever charges it has to record the Dash itself so the movement cap knows the Speed is
      paid for. Hide stays out too — our button and the item are two ways of pressing one thing, so
      whichever the player uses exactly one Action goes. Dodge, Disengage, Help, Ready, Search, Study,
      Influence and Stabilize are complete actions with no follow-through, and are correctly billed.
    - **Known imperfection, left alone:** a readied attack is the Reaction the Ready action bought, but it
      reaches the ledger as an attack claiming an Action, so a player who readies and then fires looks
      over budget and is asked. Nothing distinguishes a readied use from a normal one.
    - The claims census field `treatedAsRider` became `exemptedAs` and `claims.ridersExempted` became
      `claims.exempted`, because a field saying "rider" about the Attack button is a diagnostic telling a
      lie. `test/economy.test.ts` locks the arithmetic down.

- **Ammunition is not a consumption type (fixed v0.4.39).** `activityAvailable` looked for a consumption
  target of `type: "ammunition"`, which does not exist: dnd5e 5.3.3 has exactly six consumption types
  (`activityUses`, `itemUses`, `material`, `hitDice`, `spellSlots`, `attribute` — `config.mjs`
  `DND5E.activityConsumptionTypes`). Ammunition is a property of the **weapon**, resolved against the
  actor's stock at roll time through `item.system.ammunitionOptions`, a getter that already filters the
  actor's consumables to the right subtype and marks empty stacks `disabled`. The dead check meant an
  archer with an empty quiver looked fully armed, so the planner picked the bow, the use failed, and the
  creature spent its turn doing nothing rather than drawing the sword on its own sheet. Ask the getter;
  do not reimplement the filter.

- **Standing in fire is not weather (v0.4.39).** The planner had no notion that one square could be worse
  than another, so a hostile burned to death inside an Incendiary Cloud without ever trying to leave.
  `auto/hazards.ts` tests the creature's centre against every placed template and region using the same
  containment primitives as the sight-screen test, and rings outward for the nearest clear, walkable,
  unoccupied point. **Which areas hurt is not a geometric question** — a template knows its radius and
  nothing about what is inside it — so that judgement is a name table in `systems/dnd5e-hazards.ts`,
  quarantined exactly like the concealment table. Persistent areas only: an instantaneous Fireball leaves
  its template on the canvas long after the fire is gone, and a creature fleeing yesterday's explosion
  looks broken. Gated on the new tier-2 `understandsHazards`, so mindless things still burn where they
  stand.

- **Nobody implements forced movement at all (v0.4.40, 2026-08-06).** The third finding of this shape, and
  the starkest. Verified against dnd5e 5.3.3, core v13.351, midi-qol v14, Gambit's Premades and Chris's
  Premades before a line was written.
  - **dnd5e automates none of it.** No occurrence of `shove|knockback|displace|forced movement` anywhere in
    the 421 files under `module/`, and every one of the ~60 hits for `push` is `Array.prototype.push`. **No
    activity type has a schema field that could express "move the target N feet"** — the concept is absent,
    so no amount of content authoring could represent one. The only code in the system that moves a token
    is a Region Behavior that rotates a scene area for carousel rooms, and the system registers no movement
    hook listeners.
  - **Weapon Mastery is presentational.** `CONFIG.DND5E.weaponMasteries` is eight `{label, reference}`
    pairs; each key as a whole word appears nowhere outside the config files. The diagnostic case is
    Topple, which could trivially have been an AE applying `prone` — that machinery demonstrably works
    elsewhere in the same content — and the quarterstaff YAML contains zero occurrences of "prone".
    Correction to a common list: **Push weapons are Pike, Warhammer, Heavy Crossbow and Greatclub**; the
    Greatsword is Graze.
  - **In the content, every distance is prose,** and the pattern is consistent: when a rule pushes *and*
    imposes a condition, the condition gets a real Active Effect and the push is left in the English.
    Open Hand Technique is the specimen — three sibling activities, Addle and Topple with real effects,
    Push with `effects: []` and no distance anywhere, and an authoring note that lists the two and omits
    the third. Unarmed Strike models the Shove *save* correctly (`ability: [str, dex]`,
    `dc.calculation: str` → 8 + Str + proficiency) and the knock-prone branch; the 5 feet does not exist.
    The closest thing to a modelled distance in the whole set is Bigby's `[[5 + 5 * @flags.dnd5e.summon.mod]]`,
    inside `description.chatFlavor` — a display string.
  - **Nor does anything else.** midi ships `MidiQOL.moveToken` / `moveTokenAwayFromPoint` and calls them
    from nothing — macro API only, no game mechanic. Gambit's covers ~10 items (Shield Master 2024 the only
    mainstream one) with a real helper that iterates `canvas.grid.measurePath` for diagonal correctness and
    marches a ray in tenth-of-a-square steps on wall contact. Chris's covers two, both delegating to the
    separate `cat` module. Custom D&D 5e ships a Move *activity* — good, but an authoring tool: hand-built
    per item, human picks the destination, no rules knowledge. **Nobody handles a hazardous landing**
    (Gambit's prints a chat line asking the GM to fix it), scene edges, or elevation.
  - **Core standardised the concept even though nothing uses it.** v12's `forced` flag was replaced 1:1 by
    `action: "displace"` — core's own deprecation shim returns `action === "displace"` for the old
    property. So displacement is the platform's official "involuntary".
  - **The architecture that follows: ask with `walk`, move with a zero-cost action.** `displace` cannot be
    softened — `#initializeMovementActions` (`client/game.mjs:840-852`) *validates* that it teleports,
    is unmeasured, has `walls: null`, then **overwrites** its animation and cost functions — so a shove
    executed as `displace` would go through walls and snap instantly. Instead `constrainMovementPath` is
    asked where a *walked* path would stop (pure, writes nothing) and the move is committed to that
    already-legal point as `noodlrForce`. Same split CAT arrived at.
  - **Registering a movement action: `init` only, and only `label` + `icon` are required.**
    `#initializeMovementActions` defaults every other field (including `deriveTerrainDifficulty = null`
    and `getCostFunction`) and then **deep-freezes the registry inside `setupGame()`, before the `setup`
    hook** — so registering at `setup` is a silent no-op, not an error. It throws on a missing label or
    icon. `registerForceAction()` therefore runs from `init` on every client and everything downstream
    feature-detects the key, falling back to `displace`. The custom key travels on the wire and core's
    animation path looks it up without a fallback, which is safe only because Foundry activates modules
    world-wide rather than per client.
  - **Coordinate systems are the live bug risk.** `constrainMovementPath` takes and returns **top-left**
    waypoints; every measurement in `auto/` is from the **centre**. `shove.ts` converts at that boundary
    (`toCorner`/`toCentre`) — conflating them puts a medium creature half a square out and a Huge one two
    squares out, and it is invisible in a code review. An empty returned path means "cannot leave the
    square", which must not be confused with the unreadable-API case that retries with our own ray.
  - **Two checks are deliberately repeated after core answers:** core's boundary test uses the PADDED
    canvas rather than the visible map, and creature blocking belongs to the *system* — dnd5e implements it
    properly in its `constrainMovementPath` override (correct multi-space footprints and elevation) but
    **disables itself unless `game.settings.get("dnd5e", "movementAutomation") === "full"`**, so on many
    tables it never runs.
  - **Detection has to come off chat messages, not roll hooks.** `dnd5e.rollAttack` / `rollSavingThrow` are
    ordinary local hooks that fire only on the rolling client, so a player's attack is invisible to the GM
    through them. The GM-side readings, verified in source: attack = `flags.dnd5e.roll.type === "attack"`
    with `flags.dnd5e.targets` (`{name, img, uuid, ac}`) and `rolls[0]` a `D20Roll` whose `options.target`,
    `isCritical` and `isFumble` all survive deserialisation; hit/miss is **stored nowhere** and must be
    recomputed as dnd5e's renderer does. Save = `roll.type === "save"` with `roll.ability`, DC at
    `rolls[0].options.target`, and — crucially — `flags.dnd5e.originatingMessage`, the usage card's id,
    which is the ONLY link back to the activity that demanded the save. Under midi read
    `flags["midi-qol"].hitTargetUuids` / `.failedSaveUuids` off `updateChatMessage` instead: those are
    **token** uuids (better than dnd5e's actor uuids), written unconditionally by `displayAttackRoll` /
    `displaySaves` and not subject to midi's `SaveToChatCard` setting. Select the path by **presence of the
    flags, not presence of the module** — midi can have its automation switched off.
  - **Known-heuristic list, logged rather than asserted:** a null recorded AC conflates total cover with an
    unreadable sheet and is skipped (dnd5e's own formula scores it as a *hit*, via `total < null` coercing
    to `total < 0` — we deliberately diverge); anything rolled from a sheet has no `originatingMessage` and
    is unattributable; `flags.dnd5e.targets` keys by actor uuid, so two linked tokens of one actor
    **collapse into a single entry** before we see it; `BasicRoll#isFailure` returns `false` when there is
    no DC, so absence must be tested first; concentration saves are byte-identical to ordinary saves.
  - **Shove is automatable only because the conditions disambiguate it after the fact.** 2024 folds grapple
    and shove into one save activity, so a failed save cannot say which the attacker chose — but `grappled`
    means grapple, `prone` means the knockdown branch, and neither means the 5-foot push. Hence
    `unlessStatus` and a 700 ms settle before reading.
  - **Applied automatically with an undo, not by prompting** (user, 2026-08-06). Most of these rules are
    permissive ("you *can* push"), so a confirmation on every hit would cost more table time than the
    occasional reversal; every card carries "Put it back" and `api.undoForcedMovement()` reverses the fight.
    **One rule per event only** — mastery, then on-hit, then damage-type — because stacking two is a rules
    interpretation rather than an automation. Push beats pull when a warlock owns both invocations.
  - The application ledger is keyed on the **activation** (message id), not the turn: a card midi revises
    several times cannot push twice for one hit, while a spell cast twice in a turn still pushes twice, and
    a GM testing out of combat is not permanently blocked. Once-per-turn riders are simply not enforced
    outside combat, since there are no turns.
  - Exempt from opportunity attacks and from the Speed budget by construction: `isForcedMovement()` in
    `shove.ts` is the single predicate both `reactions.ts` and the movement cap consult, and it recognises
    `displace` as well as our own action so a shove from *any* module using core's idiom is covered.
  - Stands down on `activity.flags.cat.macros` (Chris's) or `item.flags["gambits-premades"].gpsUuid`
    (Gambit's) when those modules are active. Diagnostics: `api.surveyForced()`; manual use:
    `api.push(feet)` / `api.pull(feet)`.
  - **Not implemented, deliberately:** rules that only knock prone (Destructive Wave, Tidal Wave, the Topple
    mastery) are conditions rather than movement; Vortex Warp needs a human-chosen destination; Antilife
    Shell pushes continuously as its caster walks; the grappler's own halved Speed belongs to the movement
    budget. Core has no concept of falling, so what happens when Reverse Gravity ends is the table's call.

- **Concentration: the system does everything except finish the sentence (v0.4.44, 2026-08-07).** The
 fourth finding of this shape and the narrowest, because unlike actions, Speed and forced movement the
 mechanic is *almost* implemented. Verified in dnd5e 5.3.3 source. It tracks concentration properly
 (`actor.concentration`, effect created at `activity/mixin.mjs:470`, casting a second one ends the first
 at `mixin.mjs:251`); it detects damage and computes the correct DC (`attributes.mjs:548-552` →
 `getConcentrationDC` at `actor.mjs:471`, `clamp(floor(dmg/2), 10, modern ? 30 : Infinity)` — cap and
 edition both right); and `rollConcentration` (`actor.mjs:1709`) builds the save correctly, reading the
 ability, the save bonus and `roll.mode`, which is how War Caster already reaches the roll. **Then it
 stops.** `challengeConcentration` posts a whispered button; `rollConcentration` fires two hooks and
 returns. `endConcentration` has exactly five callers — item deleted, effect deleted, two context menus,
 and starting a new concentration — and **not one of them is a saving throw**. The card renders the
 failure in red and the spell stays up. So the two missing pieces are the two ends: nobody presses the
 button, and nobody reads the verdict. A third clause, *"Your Concentration ends if you have the
 Incapacitated condition or you die"* (2024 PHB; 2014 says the same), is enforced nowhere at all.
 Load-bearing details in `combat/auto/concentration.ts`:
 - **The roll is routed, not centralised.** `rollConcentration` returns null unless `this.isOwner`, and a
 character's Constitution save is a roll the player expects to make — the same argument as `rollNPC`
 versus `rollAll` for initiative. `dnd5e.damageActor` fires on **every** client (the `Hooks.callAll` at
 `attributes.mjs:564` sits outside the `userId === game.userId` guard, and `options.dnd5e.hp` is set in
 `_preUpdate` so it travels with the update), which is what makes routing possible: each client asks
 `isRollerFor(actor)` and exactly one says yes.
 - **`rollerForActor()` in `util/gm.ts` is three passes, most specific first, and the order matters.**
 Assigned character (`user.character`), then an explicit Owner row, then `testUserPermission`. The last
 is the test midi's `playerForActor` lacks — Foundry resolves ownership as
 `ownership[id] ?? ownership.default ?? NONE` and its dialog *deletes* the row for anyone left on
 Default — but it must stay last, because in a world whose default permission is Owner it would
 otherwise hand every character's save to whichever player sorts first. Sorted by id within each pass
 so all clients agree.
 - **Suppress the stock prompt with the system's own switch**, `options.dnd5e.concentrationCheck = false`
 in `preUpdateActor`, and only when the election names somebody — a button is better than nothing.
 Leaving the card up would let a player produce a second save from a stale prompt. If the dialog is
 cancelled the prompt is re-posted rather than the save vanishing silently.
 - **Register `dnd5e.rollConcentration` only.** `rollConcentration` calls it *and* `...V2` with the same
 rolls (`actor.mjs:1758-1759`), so listening to both judges every save twice. Same trap as
 `rollSkill`/`rollSkillV2`.
 - **Ask hit points, not just the status, for "already broken".** `damageActor` fires from inside
 `Actor#update`, which resolves before `applyDamage` returns — so the Unconscious our dying layer
 applies has NOT landed yet, but `hp.value` has. Reading only the status puts a save dialog in front of
 a character who is already on the floor.
 - **No undo, deliberately, unlike the dying layer.** `endConcentration` deletes an Active Effect and core
 cascades that to everything registered dependent on it — the Wall of Fire's template, the effects Bless
 put on four other actors. The one effect is restorable; the cascade is not, and a half-restored spell is
 worse than an honestly ended one. Legibility is the mitigation instead: public roll, a card naming the
 spell and the reason, and an off switch.
 - **Stand aside from midi wholesale, on ordering grounds rather than politeness.** midi's
 `doConcentrationCheck` defaults to `"chat"` and its own `dnd5e.rollConcentration` listener
 (`Hooks.ts:1964`) ends concentration on a failure when `removeConcentration` is on — so midi owns the
 verdict, and does not press the button either. But midi *also* writes `options.dnd5e.concentrationCheck`
 from its own `preUpdateActor` (`Hooks.ts:237`), so suppression becomes a hook-registration-order race.
 Setting midi's concentration handling to "None" hands the whole job to Noodlr. Diagnostics:
 `api.surveyConcentration()`.

- **Automated Conditions 5e is a superset of the condition rules, so we defer to it (2026-08-07).** Read
 from its source, which is cloned at `C:\Project\_research\ac5e`; two audits sit in `_research\_audit\`
 (`ac5e-coexistence.md`, `ac5e-techniques.md`). Its `automateStatuses` setting (default **ON**) drives a
 table hooked to the same `preRollAttack` and `preRollSavingThrow` we use, covering everything in
 `dnd5e-conditions.ts` plus attacker Prone and Restrained disadvantage, Invisible, Grappled,
 visibility-aware Blinded and legacy Exhaustion. `ac5eOwnsConditions()` therefore switches our whole
 condition layer off when it is present and enabled — the same shape as the midi stand-asides, and the
 same thing AC5e itself does when midi owns range.
 - **The overlap is not benign just because advantage does not stack.** The two agree on the rule and
 disagree on the mechanism, which is what makes dual enablement a silent race: we cancel an auto-failed
 save with `return false`, AC5e rolls it against a forced DC of 999 with `criticalSuccess` pushed to 21
 (there is no `-99` anywhere in its source, despite the README); we force a critical on `rollAttack`
 after confirming the hit, AC5e sets `criticalSuccess = 1` on the damage roll up front. Whichever hook
 registers first wins, differently each time.
 - **The exception that must not be "tidied" into the same gate:** AC5e's refusal to let an Incapacitated
 creature use an activity is behind `autoArmorSpellUse`, which ships `"off"`. At stock settings it
 blocks nothing, so `enforce.ts` keeps ours and consults `ac5eOwnsIncapacitatedUse()` separately.
 - **Do not reach for their override API.** `ac5e.statusEffectsOverrides.register()` is real, documented
 and fires from a one-shot `ac5e.statusEffectsReady` hook carrying `{tables, overrides}` — an `apply`
 returning `""` clears a rule and `undefined` leaves it. It would let us suppress their rules one status
 at a time, and using it would make us the module that reaches into another's internals to win a fight
 neither of us needs. Recorded because it is genuinely well built, not because we should call it.
 - **Their README is not a specification.** It documents a `dnd5e.preRollConcentration` hook that does not
 exist in the source, and describes range and cover without mentioning that both stand down when midi is
 present. Verify against `scripts/**/*.mjs` before believing anything about this module.
 - Concentration is safe: `endConcentration`, `challengeConcentration` and `rollConcentration` appear
 nowhere in AC5e. It only shapes the save (War Caster advantage, encumbrance and legacy exhaustion
 disadvantage) once something else calls for one, which is exactly the division of labour we want.
 - Found while wiring this: the save hooks were cancelling an auto-failed save **before** consulting
 `enabled()` — the gate lived only in the async announcement — so a paralysed creature's Strength save
 died silently with condition automation switched off. Fixed in the same change. A synchronous
 `return false` needs its own gate; a check in the async half guards the message, not the cancellation.

## Every button on the bar, and what it does (v0.2.3, 2026-08-11)

The Hide bug was not one bug. It was one instance of a shape — **an action we implement, reachable only
from the console, sitting beside a button on the player's screen that does something else** — and the
right response to finding one was to enumerate the rest rather than fix the one that got reported. The
user said so within ten seconds of resuming smoke-testing, and they were right: three more were live.

`src/system/dnd5e-actions.ts` is the answer and the inventory. **`PHB_ACTIONS` lists all thirteen 2024
general actions with a `handling` and a note**, `api.surveyActionButtons()` prints it against the world's
actual sheets with a carrier count, and `test/economy.test.ts` asserts that the set marked `intercepted`
is exactly the set `enforce.ts` hands over. A fifth interception that forgets its hand-over now fails a
test instead of failing quietly at a table.

- **Argon is not a rules module and never was, which is why this was reachable at all.** Read from
 `enhancedcombathud-dnd5e/scripts/echDnd5e.js`: each basic-action button is a `DND5eSpecialActionButton`
 resolving three ways — Convenient Effects if it holds an effect of the same NAME (`:1147`), else **the
 actor's own item matched by localized name** (`:1111`) used through the ordinary `activity.use()`, else
 a bare chat card plus a direct status toggle for the only two that name one (`:1164`, dodging and
 hiding). Route 2 is why intercepting `dnd5e.preUseActivity` catches the bar for free in any world
 carrying the PHB content, and route 1 is why **Dodge specifically does not arrive that way**: CE ships a
 "Dodge" effect and no "Hide". Argon's `consumeActionEconomy` is display state on its own panel objects
 and writes nothing to the actor, so route 3 spends nothing either.
- **Newly wired: Influence, Administer First Aid, Disengage and Dodge.** The first two are intercepted
 beside Hide in `police()`; the second two are *observed*, because there is nothing to adjudicate in
 them and cancelling a working button to reimplement it buys nothing.
- **Influence is the first rule that needs two clients, and `src/util/queries.ts` is how.** The rule's own
 wording — "the DM then determines whether the monster feels willing, unwilling, or hesitant" — puts the
 judgement on the GM, while the check is a roll on the player's sheet and the lockout is a flag on an NPC
 token the player cannot write. `CONFIG.queries` (v13+) is core's addressed request/response channel: it
 returns a promise, it has a timeout, and it is what Aura Effects uses to funnel writes to one client. A
 socket would have meant inventing correlation ids, a reply channel and a timeout that all already exist.
 Handlers are registered on **every** client because core resolves a query on the receiving one, and a GM
 asking answers in-process rather than over the wire. **A null answer is a real outcome** — offline GM,
 closed dialog, timeout are indistinguishable — and every caller must treat it as "no ruling", never as a
 default. Influence is also billed here (`rules/economy/bill.ts`) precisely because intercepting the
   button took it out of the ledger's hands; checked before the GM is bothered, paid only once a ruling
   arrives. **`bill.ts` is now the only answer to "is it this creature's turn"** for the three rules that
   resolve themselves — Hide, Administer First Aid and Influence — which had grown three copies of that
   test and would eventually have disagreed. It deliberately does not carry `enforce.ts`'s over-budget
   dialog: that exists for features which legitimately break the general rule, and every one of those
   works by raising the allowance through `flags.noodlr.extraAction`, so a self-resolving rule refuses and
   says why instead.
- **Dodge's expiry is the half that mattered, and it is deliberately NOT gated on who owns the rules.**
 dnd5e ships a `dodging` status read by nothing, AC5e reads it and never writes it, and the PHB item
 carries no duration — so "until the start of your next turn" was enforced by nobody and a round-one
 Dodge was still lit in round nine. An icon that lies is worse than an unautomated rule, and clearing a
 stale marker is bookkeeping rather than a rules opinion, so `rules/dodge.ts` expires it whenever the
 condition layer is on even when `ac5eOwnsDodging()` is true.
 - **`toggleStatusEffect(id, {active: false})` is not enough to clear it.** Core resolves the effect to
 delete by the status's static `_id` when it has one (`client/documents/actor.mjs:496`) and every
 dnd5e condition has one, so it deletes the system's marker and walks past CE's identically-statused
 effect — which, on a world with CE installed, is the one Argon actually created. Delete by reading
 `effect.statuses` off the actor instead, single-status effects only.
- **Disengage's mark is turn-stamped and never cleared**, the action ledger's trick: a stamp that belongs
 to another turn reads as absent, so nothing has to remember to reset it and every client computes the
 same answer. Before this, `reactions.ts` could only detect a Disengage by matching an effect NAME against
 `/disengag|withdraw/` — a premade-library convention the system does not follow — so on a stock world the
 button spent an Action and the creature was struck at anyway as it walked away.
- **`isActionActivity` needed a `featOnly` guard the moment it was generalised.** "Attack" and "Magic" are
 ordinary English inside a statblock: a longsword's `Attack` activity matched the PHB declaration by name,
 which for `phbActionOf` meant a wildly inflated census and for anything that later billed off it would
 have meant exempting that weapon from the economy permanently. `dnd5e-declarations.ts` had always carried
 the same guard; generalising the recogniser is what nearly lost it. Caught by a test, not by review.
- **Still unbuilt, and now saying so on the record:** Help (a pledge of Advantage on a roll made later,
 with nothing to hang it on), Ready (a prose trigger, and the reaction it buys is billed as an Action —
 the known imperfection already recorded under the declarations note), and Search (the roll is one skill
 of four and the reading is the GM's). Study and Utilize stay refused in `rules/general.ts`.

## Configuration, not code: what to tell a GM

Problems reported as module bugs that were world configuration, or another module's defaults, instead.
Recorded because they will be reported again.

- **Reactions, concentration and saves all prompting the GM** is midi's `playerForActor()`, and the cause is
  narrower than "wrong ownership level". Core resolves ownership through the default row —
  `getUserLevel` is `ownership[user.id] ?? ownership.default ?? NONE` (`common/abstract/document.mjs:383-392`)
  — so **"All Players: Owner" genuinely does grant every player Owner rights, and is not a broken setting.**
  midi simply cannot read it: `playerForActor` does raw `ownership[userId] === 3` lookups and never consults
  `default`, and Foundry's ownership dialog *deletes* the per-user entry for anyone left on "Default"
  (`client/applications/apps/document-ownership.mjs:150-155`) rather than writing `-1`, so there is nothing
  to match and it falls through to `preferredActiveGM()`. **Two things satisfy it, either alone:** an
  explicit Owner row for that player, or the character being assigned to the user in User Configuration
  (`user.character`), which midi checks first. A world with "All Players: Owner" and no character assignments
  hits neither, which is exactly what the GM had. Assistant GMs never match at all, because every lookup
  searches `game.users.players`, which excludes GMs by definition. Note also that midi's second check finds
  the *first* active player holding an explicit Owner row, so each character should have exactly one.
  Separately, midi's `doConcentrationCheck` defaults to `"chat"`, which **auto-rolls** the save rather than
  offering it; `"chatOnly"` hands it back to the player.
- **Eldritch Blast beams stuck on a corpse.** dnd5e 5.3.3 does not model beams at all — the SRD item is one
  attack activity with one 1d10 part and `target.affects.count: 1`; multiple beams exist only in the prose,
  and the expectation is one press per beam. The lock-on is midi's `untargetDeadTokens`, which reads
  `hp.value <= 0` 500 ms after the workflow ends, so with manual damage application the corpse still has
  positive HP and is never released. Both `AutoRemoveTargets` and `TargetConfirmation` are **client**-scoped,
  so the GM's settings never reach the player's browser. Per-beam retargeting has been an open dnd5e feature
  request since 2021 ([#1067](https://github.com/foundryvtt/dnd5e/issues/1067), closed unimplemented).
- **An item use that does nothing at all, with midi installed, is probably midi's range check** (audited
  2026-08-10; full inventory `_research\_audit\midi-automation-settings.md`). Midi ships with nearly every
  mechanical automation **off** — `autoCheckHit`, `autoCheckSaves`, `autoApplyDamage`, `autoItemEffects`,
  `autoTarget`, `consumeResource` and even `addChatDamageButtons` all default to `none`/`off` — so a stock
  install formats chat cards and runs a workflow without determining hits, resolving saves, applying damage
  or spending resources. **Two rules are the exception and they are live out of the box:**
  `optionalRules.checkRange` defaults `"longFail"` and `wallsBlockRange` defaults `"center"`
  (`settings.ts:274`, `:297`), and both are read through `checkMechanic()` (`Workflow.ts:1995`,
  `MidiActivityMixin.ts:1741-1742`), which — unlike `checkRule()` — **ignores `optionalRulesEnabled`
  entirely** (`settings.ts:303-306`). An out-of-range or wall-blocked use is therefore cancelled with only
  a log line, which at the table is indistinguishable from our automation failing to fire. Check this before
  debugging anything of ours that "just doesn't happen".
  - Also worth knowing when reading that config panel: reaction *prompting* (`doReactions`,
    `gmDoReactions`) defaults to `"all"` while `enforceReactions` and `enforceBonusActions` default to
    `"none"` and exclude NPCs even at `"character"`. A table seeing reaction dialogs reasonably concludes
    reactions are enforced. They are not, which is why our own ledger exists.
  - Midi's `concentrationAutomation` is deprecated and **force-set false** (`settings.ts:1024-1033`), which
    corroborates the stand-aside reasoning below but does **not** weaken it: that flag was midi's own
    tracking implementation, now handed to dnd5e. The two settings our stand-aside actually turns on are
    untouched and still live — `doConcentrationCheck: "chat"` (`settings.ts:172`) and `removeConcentration:
    true` (`:225`), the latter read by midi's `dnd5e.rollConcentration` listener at `Hooks.ts:1924`/`:1947`.
- **Imported items whose riders quietly do nothing, and why DDB Importer must never be uninstalled**
  (audited 2026-08-10, source read; full report `_research\_audit\ddb-importer-dependencies.md`). DDB
  Importer declares **zero** module dependencies — `relationships` names only the `dnd5e` system — so
  Foundry never warns, and its Midi/DAE recommendations are docs-only. What it actually does is stamp other
  modules' namespaces into the documents it generates: `flags.dae.transfer`/`stackable` and
  `flags.midi-qol.forceCEOff` on **every** effect, DAE-only change keys (`macro.execute`,
  `macro.itemMacro`, `macro.StatusEffect`, `macro.tokenMagic`, `flags.dae.specialDuration`), `ATL.light.*`,
  and Midi-only keys — chiefly `flags.midi-qol.OverTime`, whose *value* is Midi's own comma-separated
  mini-language (`turn=end,damageRoll=2d6,saveDC=13,saveAbility=con,saveRemove=true`) and the entire
  encoding for recurring damage and repeat saves. An unmatched change key is stored and ignored by
  `ActiveEffect#apply`, so the item still rolls attack and damage while the per-turn poison, the fear, the
  torchlight and the macro simply never happen, **with nothing in the console saying why.** Expect this
  reported as our bug. The whole layer is one boolean (`*-add-midi-effects`, default off for characters and
  on for munching) whose "recommended" value is computed as `midiQolInstalled && daeInstalled`.
  - **Do not tell a GM to uninstall DDB Importer after importing.** With `no-item-macros` at its default
    the emitted change value is `function.DDBImporter.lib.DDBMacros.macroFunction.spell("x.js")`, so the
    module supplies the function body at runtime and removing it breaks items already on sheets.
  - **`addStatusEffectChange()` is the pattern we should be copying**, and it is principle #0 implemented
    at the authoring end rather than the reading end: with DAE present it emits `macro.StatusEffect`, and
    without it writes the **core-native** encoding instead — the `statuses[]` array, a
    `&Reference[condition]` enricher, and `flags.dnd5e.<condition>Level` for exhaustion. That is also
    independent confirmation that our own condition primitive is on the right encoding.

## Open items carried over from noodlr

- **OPEN BUG — melee-only hostiles still move oddly (reported 2026-08-05, v0.4.36 test).** The user saw
  "unusual movement behaviour" from melee-only creatures during an otherwise clean encounter and had no
  time to characterise it: not whether they stall, overshoot, path badly or refuse to close. Start with
  `api.explainTurn()` on a misbehaving creature and `api.testMove()` on its token — between them those
  report the planner's scoring and every stage of what core did with the move. Prime suspects:
  `reachableElevation` and the 3D `separation` check in `planner.attackOptions`, and the `maxCost`
  constraint, which refuses a path costing more than the creature's Speed rather than moving it as far as
  it can. **The v13 theory is dead** (census, 2026-08-07): the host is 14.365, so `maxCost` exists there.
  The same census settles the other half — all four movement-veto modules are active in that world:
  `NotYourTurn@4.0.0`, `tokenwarp@14.365.2`, `Rideable@5.0.17` and `monks-active-tiles@14.01`.
  **"Disable NotYourTurn first" was wrong advice and has been withdrawn (2026-08-11):** it exempts the
  current combatant, which is the only token a planned turn moves, so it can never have caused this.
  Suspect Token Warp and Rideable first, then our own `maxCost` and `reachableElevation`.
- **UNVERIFIED CONFLICT — `wm5e` (Weapon Mastery 5e) versus our Push mastery.** Active in the user's world
  at 14.533.6, a version scheme matching AC5e's, so probably the same author. `system/dnd5e-forced-movement.ts`
  implements Push natively (`trigger: "mastery"`, read from `flags.dnd5e.roll.mastery`) and
`rules/forced.ts::alreadyAutomated()` stands aside only for Chris's Premades and Gambit's — it has never
heard of wm5e. If wm5e moves the target, a Pike or Warhammer hit pushes twice. **Not confirmed:** wm5e is
not in `C:\Project\_research` and none of its code has been read. Clone it before either adding a
stand-aside or dismissing the risk. As of 2026-08-11 this is at least **visible**: `conflicts()` in
`integration/ownership.ts` warns about it in the settings windows whenever wm5e is active and our forced
movement is on, and says outright that it is unverified. A warning is the honest response to a
suspicion — a stand-aside would need proof, and guessing wrong there deletes a rule that works.
- **`attacksPerAction` probably misses Thirsting Blade** — inference, not observed, since the census's only
  warlock took Pact of the Chain. `economy/ledger.ts` reads `extra-attack`/`two-extra-attacks`/
  `three-extra-attacks`, right for fighters, rangers, paladins, barbarians and monks, but a Pact of the
  Blade warlock's second attack comes from the `thirsting-blade` invocation and would read as 1. One
  identifier to add.
- **The 2026-08-06 audit batch was re-read on 2026-08-10 and is no longer the queue** — most of it shipped
  and the rest belongs to the compiler. The surviving general-rules queue is six items and lives in "The
  standing gap list, re-read after the split and the pivot" above. The audits themselves stay in
  `C:\Project\_research\_audit\` as the citation trail; read that section first so you know which parts of
  them are still true.
- **Tooling and release discipline** are inherited unchanged from noodlr: prettier printWidth 100,
  `npm run check` + `lint` + `build` before commit, LF via `.gitattributes`, small commits at working
  checkpoints, and — the one that has bitten twice — **verify a release's ASSETS, not just its tag.**
  `gh release view <tag> --json assets` must list both `module.json` and `module.zip`, and
  `releases/latest/download/module.json` must return the new version. An assetless release makes the
  newest release the broken one and blocks updating for everyone.
