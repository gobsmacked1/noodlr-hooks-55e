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
  The optional `model` on that request is Noodlr's compile slug (`api.capabilityModel()`), not the
  chatbot's — this module never stores one of its own.
- `src/capability/cache.ts` — file-backed shards under `worlds/<id>/assets/noodlr-hooks-55e/capabilities/`
 (install-wide `assets/` before v0.7.4, and that tree is never read — see the multi-world note),
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
- **BECAUSE THE KEY IS THE PROSE, IMPROVING THE COMPILER CHANGES NOTHING UNTIL SOMEBODY ASKS AGAIN
  (`api.recompileWorld()`, v0.6.7).** This is the cache's central economy read as a hazard rather than
  a saving, and it went unnoticed through three doctrine changes: every sheet still hashes to the same
  key, `collectScene` still reports a hit, and the descriptors go on being the ones the *old* prompt
  produced. There was no route to a better answer for text already read once — `compileScene()` is
  cache-first by construction and the capability sheet's Recompile button is one creature at a time,
  which for a world of 223 wordings is not a route at all.
  - **It spends one compile per distinct wording and is called by no hook, ever.** That is the whole
    reason it is a separate entry point rather than a flag on `collectScene`: a cache-first collect
    runs on every scene load, and a switch that could make it re-ask is a bill nobody agreed to.
  - **Order: ask, validate, THEN stand the old one down.** Clear-then-ask trades a working cache for a
    provider outage. Same rule `recompileFeatures` already followed, and the reason `cache.clear()` is
    deliberately not on the API — a public "wipe it" is the clear-then-ask mistake with a button.
  - **Chunked at `MAX_BATCH` rather than sent whole**, so a failed request leaves the earlier chunks
    stored. A null answer stops the loop rather than repeating the same nothing per chunk, and
    `remaining` says what was skipped. `collectScene` uses the same loop: 120 is a save-point, not a
    scene ceiling. Stopping after the first chunk left thirteen level-20 PCs at 120 of 992 distinct
    wordings (noodlr-test, 2026-08-20). The older "compendium folder" fuse does not apply — this path
    only walks tokens the GM placed.
  - **`ASK_CAP` is 32,768 unread wordings per pass**, on `collectScene` and `recompileWorld`. Thirteen
    level-20 PCs were 992 distinct — the high side of a real table, not a bound. Past the cap we
    compile the first 32,768 and `ui.notifications.error` the rest, so a packed map cannot post an
    unbounded bill and a GM is not left guessing why the last row of tokens never compiled.
  - `locked` is skipped and counted; `rejected` is re-asked, because another go is what a recompile is
    for. Bindings for whatever is on the canvas are rebuilt at the end, so the new descriptors run
    without a scene reload.
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

### NOTHING COMPILED WAS BOUND ON A FRESH PAGE LOAD (v0.7.5, 2026-08-17)

The whole capability layer was inert on load, for eight days, silently. `registerCapabilityCollector()`
listens for `canvasReady` and is called from `Hooks.once("ready")` — and **core awaits
`initializeCanvas()` at `game.mjs:784` and calls `ready` at `:787`**, so the only `canvasReady` of the
page load has already fired by the time the listener exists. No collect, therefore no `cache.warm()`, no
bindings: 1,099 compiled descriptors on disk and an empty `Map` in front of them, so every rule that runs
off a binding did nothing and the action ledger could not see a compiled Multiattack.

- **It survived because the way anybody notices a capability is to drop the creature that carries it**,
  and `createToken` fires, schedules a collect and warms the cache as a side effect. Every test of this
  feature has ever been "place the monster, watch the rule" — which repairs the state it should have been
  measuring. **A GM who loads a world onto a scene that is already populated gets none of it**, and that
  is the ordinary case at a table.
- **Generalisable, and this repo will meet it again: a module registering from `ready` has already missed
  every hook core fires during startup.** The fix is a catch-up — `if (canvas?.ready) schedule(canvas.scene)`
  — not an earlier registration, because the collector needs `game.settings` and the compile listener. Any
  future listener for a setup-phase hook needs the same pairing, and the hook alone reads as sufficient.
- **The diagnostics could not see it either, and one of them was actively reassuring.** `surveyScene()`
  reported `cached` from `cache.has` against an unwarmed cache, so a full cache read as **0 cached, 109
  would ask**; `findOrphans()` walked an empty `Map` and reported nothing to prune. Both now `await
  cache.warm()`, which is idempotent and free once the collector has run. **An instrument that reports the
  opposite of the truth costs more than no instrument** — this one turned a wiring bug into a day spent
  looking for a data loss that had not happened.
- `findOrphans`, `surveyOrphans` and `surveyScene` are `async` as a consequence, and the API types with
  them. `pruneOrphans` over an empty cache deletes nothing, so the bug had no destructive symptom and
  nothing but a wrong number to notice it by — which is the other half of why it lasted.
- Both halves are pinned in `test/collect.test.ts`, and each was checked by removing the fix and watching
  its own test fail. A test that passes with the bug in place certifies nothing, and both of these would
  have: the fakes warm the cache incidentally, exactly as dropping a token does.

### A handed item is not a new token, and a shapechange is not a new token either (v0.7.14)

Coat of Many Eyes on the Aboleth (noodlr-test, 2026-08-20): Random Loot Generator created the item
**after** `createToken` had already collected that token, so the collector reported a hit and never
asked. The same hole is a player handing a magic item to a creature already on the scene — it looks
inert until a reload. Scene change was not enough for player clients either: `cache.warm()` is
once-per-session, so a wording the GM compiled after load stayed invisible in memory.

Foundry has no "received inventory" event. The receive signal is `createItem` on an embedded Item
(`item.actor` is who got it). Losing an item is ignored. `updateItem` only when the prose (or the
glossary skip) moved — equip / attune / uses / quantity must not schedule a collect. Sidebar-only
sheets wait until they have a token here. Gold and `flags.dnd5e.cachedFor` clones never schedule.

Other things that spawn onto a scene:

- **Summons already fire `createToken`.** dnd5e's Summon activity, our `summonCreature`, Automated
  Evocations — all `scene.createEmbeddedDocuments("Token", …)`. The existing token hook reads them.
  A summoned creature whose sheet was never compiled is a miss and gets bought; a Troll Limb that
  shares a cached wording costs nothing.
- **Wild Shape / Polymorph / Shapechange do not.** A linked transform (`Actor#transformInto` on a
  world actor) creates a **new** actor and retargets the existing token (`updateToken` + `actorId`).
  An unlinked token rewrites the synthetic actor in place (`updateActor` with `items` /
  `isPolymorphed`) and **never fires `dnd5e.transformActor`** — that hook is only on the linked
  branch. Both are listened for. Movement and HP updates are not.
- **`createActor` alone is not enough.** The new form exists before the token points at it, so
  `createItem` during actor creation fails `itemIsOnViewedScene`. The token retarget is the moment
  the sheet is on the scene.
- Player clients `cache.refresh()` on every collect (merge, do not drop) and retry unread wordings
  a few times, so a handed item binds without a scene change.

### Nine of the seventeen triggers are wired, and the sheet has to say so (2026-08-11)

`registerCapabilityExecutor()` attaches a hook to `on_damage_taken`, `on_zero_hp`, `on_turn_start`,
`on_turn_end` and `on_activity_use`; v0.7.0 added `on_short_rest` and `on_long_rest`, and v0.7.1 added
`on_hit` and `on_miss`, which are dispatched from `capability/attack.ts` rather than from a hook of their
own because nothing in dnd5e reports a hit. v0.7.6 finished Phase 3: `on_save_failed` /
`on_save_succeeded`, `on_attack_roll`, `on_condition_applied`, `on_move`. **Fourteen of seventeen
now fire.** The three that do not: `always` (answered by query, see `standing.ts`), `on_enter_area`
(needs `create_area`) and `on_leave_reach` (opportunity attacks already cover the printed case).
That is fine and was always the design — the compiler is offered all seventeen because "the cloak
recharges on a long rest" is a true reading whether or not this build listens for one, and a
vocabulary that hid the unheard events would teach the model to mis-file rules rather than skip them.

**What was wrong is that `isExecutable()` never looked at the trigger.** It gated on adjudication, the
effect kind and the predicates, so a rule with a perfectly executable `heal` hanging off
`on_long_rest` was badged **active** on the capability sheet while nothing on earth would ever run it.
The comment above the executor's wiring block asserted the opposite in plain English — "the rest are
legitimate compiler output and simply never fire, which the capability sheet shows as inert" — which is
the worst version of this bug: the intent was written down, believed, and never implemented. Fixed by
`WIRED_TRIGGERS` in `integration/capability.ts`, checked first in `isExecutable()`, which feeds the
sheet badge, the `runs` column of `api.surveyCapabilities()` and the executor's own refusal from one
place. **Wiring a new hook means adding its event to that list in the same change**, or the sheet will
go on calling a working rule dead — the inverse failure, and the harder one to notice. As of v0.7.0 the
list is DERIVED from the `WIRED` table below, so there is no longer a way to wire one and forget.

This is the same principle as the ownership resolver, arriving from the other direction: there we made
a rule that had stood aside say so, and here a rule that cannot fire. `always` is answered by query
instead (see `capability/standing.ts`).

**A rest-scoped USE is a different thing from a rest TRIGGER, and conflating the two hid a real bug for
two months (v0.4.2).** `periodStamp` derives "which rest are we after" from a counter on the actor, and
**`noteRest()` had no callers** — so a compiled `1/day` or per-short-rest rule spent its charge once and
never got it back for the rest of the campaign. Two earlier notes in this file recorded the missing
caller as a known fact and one of them went further and excused it ("does not need any while the system
owns rests"), which was simply wrong: dnd5e recovering the uses printed on a *sheet* says nothing about
a ledger we keep in our own flag. The lesson is about the shape of the note rather than the bug — **an
observation that something has no callers is a finding, and writing a reason it is fine turns it into a
dead end nobody re-opens.**

- Wired on `dnd5e.restCompleted`, and **not** gated on the primary GM. `Hooks.callAll` runs only on the
 client that performed the rest, and that client is the one that owns the actor and can therefore write
 the flag; a GM gate would mean a player's own long rest restored nothing. **That was true of the
 listener and false of the executor for four days** — see the next section.
- **A new day bumps the long counter even on a short rest**, because one counter serves both `day` and
 `long_rest` and dnd5e recovers per-day uses on any rest flagged `newDay`. That refreshes long-rest
 rules slightly early, which is the generous direction `readLedger` already errs in on purpose.
- Nothing is cleared — the stamp goes stale, exactly as with the action ledger. Locked by a test, so a
 future "tidy up by deleting stale entries" fails rather than losing a use spent before a reload.
- A table that narrates a long rest without opening the rest dialog gets no recovery, which is the same
 limitation dnd5e's own item uses have. Consistent, and worth saying out loud.

### One gate served two opposite kinds of hook, and the rests are what exposed it (v0.7.0, 2026-08-16)

Wiring the two rest triggers was supposed to be the cheapest possible proof of the dispatch path, since the
hook was already listened to. It was cheap and it found a live defect one layer down. **`fireTrigger` opens
with `if (!isPrimaryGM()) return []`, and that single line is correct for four of the five wired events and
wrong for the other one**, because the two kinds of hook feeding it need opposite treatment:

- A **document** hook (`updateCombat`, and our own damage ledger, which is maintained on every client
 because the amount is only computable from `updateActor`) arrives everywhere. `isGM` is a role several
 clients hold, so without narrowing a troll summons one limb per assistant GM. That is what the gate is
 for and it has earned itself.
- A **client-local** hook fires on the acting client alone. `Hooks.callAll("dnd5e.restCompleted")` runs on
 whoever rested and `dnd5e.postUseActivity` on whoever pressed the button — so there the same gate narrows
 nothing, it **discards the event outright whenever a player owns the actor**, which for rests and ability
 uses is most of the time. A player's own long rest would recover nothing and announce nothing, on a table
 where the identical rule visibly works for the GM's monsters.

**THE FAILURE IS SILENT AND ASYMMETRIC, WHICH IS WHY IT WOULD HAVE BEEN REPORTED AS SOMETHING ELSE.** There
is no error, and the rule works when the GM tests it — the two conditions that reliably send a diagnosis to
the wrong place. The pre-existing note directly above this section made the same mistake in prose: it
recorded, correctly, that the *listener* is not GM-gated, and never asked what happened downstream of it.
**A note that a hook is ungated says nothing about who executes**, and the two were four days out of step.

- **`runsOn(event)` in `integration/capability.ts` is the single answer, and `WIRED_TRIGGERS` is DERIVED
 from the same table.** That is the structural half of the fix: adding a hook IS declaring who executes
 it, and the previous shape — a list of wired events here, a gate in the executor, a comment in each — had
 three places to keep in step and no way to notice when they were not. Every redundant `isPrimaryGM()`
 beside a hook registration is gone; the executor's doctrine header now says nothing gates locally.
- **`on_activity_use` stays on the primary GM DELIBERATELY, and it is still a gap.** It is client-local
 like the rests, so widening it is one word — and the reason not to is that an activity can reach every
 effect kind there is. `summon_creature` and `insert_combatant` need world rights a player has not got,
 so a wider gate trades a silent non-firing for a **partial** one: the spend lands on the player's own
 sheet and the summon beside it is refused. Partial is worse than nothing, because nothing is at least
 consistent. The fix is a relay to the primary GM — `util/queries.ts` already carries one for Influence
 — and it is Phase 5 work, not a flag flip. Recorded at the table entry so the next reader finds the
 reason at the line rather than here.
- **The rests are on the acting client ON EVIDENCE, not on hope.** `npm run census:rests`
 (`scripts/peek-rest-rules.mjs`) over the live 1,099-capability cache: **25 rest-triggered rules, and all
 nine engine-adjudicated ones are a `recover_resource` on the resting creature's own item** — precisely
 what that client has rights to write. The other sixteen are `gm` or `narration` and mutate nothing. So
 the permission question was answered by measurement before the switch was flipped, which is the check
 `on_activity_use` cannot pass.
- **A long rest fires BOTH events and that is safe because `adjustUses` clamps.** Two capabilities in the
 live cache (Regurgitate, Pact Magic) carry a short-rest rule and a long-rest rule for the same mechanic,
 so a long rest runs both; the second reports "already at 2" and changes nothing. Pinned by a test,
 because were that clamp ever removed this becomes a double-recovery with no symptom.
- **ORDER IS LOAD-BEARING: `noteRest` is awaited BEFORE any rule fires.** `periodStamp` derives "which
 rest are we after" from the counter that `noteRest` writes, so a recovery rule carrying its own
 `uses: 1/long_rest` would otherwise be checked against the period that just ended and read as already
 spent — **the ability would refuse itself on the very rest that renews it.**
- **`readRest` in `system/dnd5e-rest.ts` reads `CONFIG.DND5E.restTypes[type].recoverPeriods` rather than
 comparing the type's name.** dnd5e's own `long` entry is `["lr", "sr"]`, which is the system stating the
 inclusion this dispatch depends on instead of us assuming it — and a rest type another module registers
 then works with no change here. The name comparison survives as the fallback, and **the fallback has to
 restate the inclusion** (`isLong || type === "short"`), or a long rest on a world whose CONFIG cannot be
 read stops recharging short-rest abilities: the exact failure the event exists to prevent, reintroduced
 in the branch nobody exercises. Caught by a test, not by review.
- Why it is worth wiring at all, given the yield: `on_long_rest` is **9** runnable rules in the
 whole-world census, not the 2 the biased subset suggested. Small, real, and the cheapest confirmation
 available that the dispatch path works before the expensive triggers are built on it.

### `on_hit` / `on_miss`, and the word the vocabulary has only one of (v0.7.1, 2026-08-16)

The largest trigger in the cache — **181 `on_hit` rules and 6 `on_miss`**, `npm run census:trigger -- <cache>
on_hit on_miss` — and it is dispatched from `capability/attack.ts`, called by `rules/damage.ts` once an attack
has settled. It exists as its own file rather than four lines at the call site because the event is ambiguous
in a way nothing on the descriptor resolves.

- **"ON A HIT" IS TRUE OF THE CREATURE SWINGING AND OF THE CREATURE BEING HIT, AND THE COMPILER HAS ONE WORD
 FOR BOTH.** A bite that poisons and a cloak that burns whoever strikes it compile to the same
 `trigger.event`, with opposite subjects. So the direction is decided once, here, **on evidence**: 44 of the
 47 engine-adjudicated `on_hit` rules point `effect.target` at `target`, and not one guard in the whole set
 names `attacker`. Every one reads "when I hit something, do this to what I hit". **These fire from the
 attacker's side and only from the attacker's side.**
- **The defender's reading is NOT implemented, deliberately, and it is not a wider dispatch of the same
 event.** It inverts every subject, so running both off one trigger would make `target` mean the attacker on
 some rules and the defender on others with nothing to tell them apart — plausible nonsense rather than an
 error, the same failure mode as a behavior verb narrated without its `incoming` flag. It needs `on_hit_by`,
 or an `incoming` flag of the shape `noodlrHooks.behavior` already carries. Until then such a rule compiles,
 binds, and never fires, which the capability sheet shows.
- **`EvalContext.trigger` was added for this and is the subtle half.** All four subjects resolve, and three
 were already right; `trigger` means "the creature this event is about" everywhere else, and its old
 `attacker ?? target` fallback resolves to the ATTACKER the moment an event fires from the attacker's side —
 which is `self`. A guard reading `who: "trigger"` would have tested the biter's hit points instead of the
 bitten creature's, silently and in the plausible direction. Set by this dispatch and by the save
 dispatch below; every older call site keeps the behaviour it had.
- **`ctx.activity` IS NOT OPTIONAL ON THIS PATH.** `duplicatesActivityDamage` is the only thing standing
 between a compiled "on a hit, deal 1d10 fire" and a cantrip's damage being rolled twice — and it can only
 refuse when the activity is in hand. Dispatching without it doubles the damage of every attack in the
 world, in arithmetic, with nothing thrown and nothing logged. 45 of the 71 pre-doctrine `on_hit` rules were
 exactly that restated damage line, so this is the common case rather than the corner.
- **Ordered after the reaction window and before the gate flag.** After, so a Shield that turned a hit into a
 miss has already moved the creature between the two lists and the rider follows the verdict rather than the
 die. Before, so every mutation a rider causes has landed by the time the Damage button is released.
- **THE IDEMPOTENCY GUARD IS THE ONLY ONE, which is worth knowing before deciding it is redundant.**
 `consider()` marks a message `handled` on the damage and healing branches and **not** on the attack branch,
 so a second render of the same attack — routine under midi, and produced by any flag write on the card —
 re-reads the verdict and reaches `settleAttack` again. Everything else down that path is idempotent by
 construction; a rider is not, because applying a poison twice spends two uses and stacks two effects.
- **It is coupled to auto-damage, and `capabilityAdvisories()` says so.** Reading whether an attack connected
 is what dispatches these, and that reading exists in exactly one place — dnd5e decides it in its chat
 card's RENDERER and stores the answer nowhere. So switching auto-damage off, or letting midi own damage,
 takes the attack riders with it while they stay bound and badged as running. A second parallel hit reading
 to decouple them would be two answers to "did that connect", which is the divergence this repo keeps
 finding. The coupling is real; being silent about it is what would not be acceptable. Same doctrine as
 greying "Behavioral automation".
- **A test that certifies nothing is the risk here, and one nearly shipped.** The refusal specimen originally
 wrote its damage as `effect.formula`, which the schema does not have — so the rule resolved to no amount,
 applied nothing, and the "duplicate damage is refused" assertion passed for entirely the wrong reason.
 Every damage specimen in `test/attack.test.ts` runs `validateCapability` first for that reason.
- Parked rather than done: five `tokenOf` helpers answer "a token for this actor" across `executor.ts`,
 `board.ts`, `candidates.ts`, `ready-events.ts` and `standing.ts`, differing in whether they return the
 placeable or the document and in their `getActiveTokens` arguments. That is a real duplication and a
 different question from `speakerToken`, which this dispatch uses. Consolidating it touches perception and
 readying and is not required by anything here.

### `on_save_failed` / `on_save_succeeded` (2026-08-18)

The highest-yield remaining trigger — **289 `on_save_failed` and 39 `on_save_succeeded`**,
`npm run census:trigger -- <cache> on_save_failed on_save_succeeded` over the 1,105-wording
noodlr-test cache — and it is dispatched from `capability/saves.ts`, called by `rules/saves.ts`
after `spoilAndResist`. Same shape as `on_hit`, arriving at the other verdict this module already
reads.

- **"ON A FAILED SAVE" IS TRUE OF THE CASTER AND OF THE CREATURE THAT ROLLED, AND THE COMPILER HAS
 ONE WORD FOR BOTH.** Hold Person restrains what failed; Evasion is a property of the creature
 saving. So the direction is decided once, here, **on evidence**: 188 of 249 engine-adjudicated
 save rules point `effect.target` at `target` (52 unset, 7 `self`, 2 `trigger`). Every common one
 reads "when I force a save and it fails, do this to what failed". **These fire from the CASTER's
 side and only from the caster's side.**
- **The saver's reading is NOT implemented, deliberately**, for the same reason the defender's
 `on_hit` is not. It needs `on_save_failed_by` / `on_save_succeeded_by`. Until then Evasion,
 Avoidance, Circle of Power and Prone Deficiency compile, bind, and never fire, which the
 capability sheet shows. The seven `self` engine rules are not a counter-example: Contact Other
 Plane is a caster saving against their own spell (`target === self`), and the rest are those
 saver-side traits.
- **A SAVE WITH NO DAMAGE STILL FIRES.** Hold Person is the specimen and `deals === false`. The
 early `if (!act.damage) return` in `settle()` is why this cannot be tacked onto the damage-apply
 loop — that return is load-bearing for damage and would have silently dropped every condition
 rider.
- **THE VERDICT IS FINAL ONLY AFTER BARBS AND LEGENDARY RESISTANCE.** A spoiled success becomes a
 failure; a bought failure becomes a success. Firing `on_save_failed` and then `on_save_succeeded`
 on the same message when Resist lands would apply both halves of Hold Person. `pendingResistance`
 waits on a failure that `canResist` and has not been `offered` yet — including the pass that is
 still waiting on a damage roll to price the stake.
- **Idempotency is per SAVE message, not per usage card.** One Fireball is five saves and five
 events. A second `settle` (damage arriving, a card re-render, a hand-pressed Resist) must not
 restrain twice.
- **`ctx.activity` IS NOT OPTIONAL**, same as `on_hit`. A Fireball compiled to "on a failed save,
 deal 8d6 fire" is the restated `damage.parts` line. `test/saves-trigger.test.ts` validates every
 damage specimen first, for the same reason `attack.test.ts` does.
- **Coupled to auto-saves, and `capabilityAdvisories()` says so.** The reading lives in one place;
 switching the layer off, or letting midi own saves or damage, takes the riders with it. A second
 parallel `readSave` would be two answers to "did that save". The on-save advisory is independent
 of the on-hit one, because a table can have auto-damage on and auto-saves off.
- **Subjects match the attack dispatch.** `self` / `attacker` = caster (read off the *usage* card,
 never the save — the save's speaker is the saver). `target` / `trigger` = the creature that
 rolled. `EvalContext.trigger` is set explicitly for the same inversion the attack path found.

### `on_attack_roll` (v0.7.6, 2026-08-18)

34 rules in the live 1,105-wording cache, and almost every engine one is `grant_advantage` /
`impose_disadvantage` / `modify_speed`. Those now write a timed Active Effect (Phase 4 duration,
below). Advantage on the roll that just posted is still a turn too late from this hook alone —
`capability/grants.ts` applies it on `preRollAttack` as well, and must never call `fireTrigger`
or the card posts twice.

- **THIS IS NOT `on_hit`.** It fires when the roll lands in chat, before anyone knows whether it
 connected — Reckless Attack, Pack Tactics, Faerie Fire. Coupling it to auto-damage would make
 those inert on every table that switched damage off, for no reason. `capabilityAdvisories()`
 says so on the on-hit line.
- **Chat, not `dnd5e.rollAttack`.** That hook fires only on the rolling client. `createChatMessage`
 and `updateChatMessage` fire everywhere, which is the same reason Ready and Stealth read attacks
 off the card. Midi fills the roll onto an existing workflow card, hence the update hook.
- **THE DIRECTION IS THE ATTACKER'S**, on the same evidence as `on_hit`. Reckless Attack and Zephyr
 Strike read "when I roll". Warding Flare, Shadowy Dodge and Soul of Vengeance are the defender's
 or a third party's reading and are NOT implemented — they need `on_attack_roll_by`. Until then
 they compile, bind, and never fire usefully.
- **One event per MESSAGE, not per target.** Zephyr Strike's speed bump is one change.
- Idempotency is the message id, cap 64. No speaker token means no fire, not a throw.

### `on_condition_applied` (v0.7.6, 2026-08-18)

8 rules in that cache. Dispatched from `createActiveEffect` after the effect exists, so a
`has_status` guard on the same status can see it — Nature's Ward is "when you are poisoned, you
are not", and the poison has to be on the actor for that guard to pass before the remove runs.

- **THE DIRECTION IS THE AFFLICTED CREATURE'S.** Nature's Ward, Wild Shape and Mindless Rage all
 name `self`. Melody of Sheltered Rest strips Surprise from allies in an aura and is the
 watcher's reading — NOT implemented. It needs `on_condition_applied_on`. Until then those
 compile, bind, and never fire usefully.
- **A hook that names no status must not run every bound rule.** `ruleMatchesApplied` in
 `capability/applied.ts` is the filter: a `has_status` / `lacks_status` guard names what it is
 watching for, and a `remove_status` / `apply_status` with no such guard names the status in the
 effect. A rule that names no status at all is skipped. Guessing would fire every bound rule on
 every effect, which is how Wild Shape would cancel itself the moment `transformed` landed (its
 effect removes `transformed`; its guard is `incapacitated`).
- **Wild Shape is the specimen that proves the filter.** Matching `effect.status` alone would
 drop the form on arrival. Matching the guard's named status does not.
- Idempotency is the effect id, cap 64.

### `on_move` (v0.7.6, 2026-08-18)

9 rules in that cache. Dispatched from `updateToken` when `x` / `y` / `elevation` changes, 150 ms
debounce, 400 ms settle window keyed on token + destination so walking to A, then B, then back
to A is three events.

- **THE DIRECTION IS THE MOVER'S.** Ashardalon's Stride is that reading. Crown of Radiance and
 Booming Blade wait for someone ELSE to walk near them and need `on_move_by`. Until then those
 compile, bind, and never fire usefully.
- **FORCED MOVEMENT FIRES.** Ashardalon's fire does not care why the caster moved, and
 opportunity-attack-style riders are the other reading, which this file does not implement.
 `isForcedMovement` is not consulted.
- **UNSET DAMAGE TARGETS ARE REFUSED, not defaulted to the mover.** `subjectOf` treats a missing
 `effect.target` as `self`, and Ashardalon's Stride in the live cache left the target unset with
 a `within_distance` guard that compares the mover to itself (0 ft ≤ 5). Wiring that without a
 refusal burns the caster for 1d6 fire every turn they walk. The refusal reason is on the
 capability sheet: `"on_move damage left its target unset — refusing to guess the mover"`. An
 explicit `target: "self"` still runs — that is a stated reading, not a guess.
- **`target: "trigger"` ON THIS EVENT IS THE SAME HOLE (v0.7.22).** `on_move` sets `ctx.trigger`
 to the mover, so a compiled "damage whoever triggered this" always hits the walker. Investiture
 of Flame (flames don't harm *you*; others take 1d10 if they enter/end turn within 5 ft) and
 Spike Growth (2d4 in the *area*) both compiled that way. A level-20 Land Druid Wild Shaped into
 a Giant Owl, the token recentered Medium→Large, and both riders plus a follow-on Feast of Flesh
 advantage posted — 6 HP written through to the original sheet. `onMoveDamageRefusal` is the
 one answer; the capability sheet and the executor both call it. Do not recompile the world to
 "fix" those descriptors — the guard is what ships.
- **A TRANSFORM IS NOT A WALK.** The same incident: Wild Shape / Polymorph / Shapechange writes
 `actorId` and/or `width`/`height`/`shape` and often `x`/`y` because Foundry keeps the centre.
 Core lists those dimension keys on `TokenDocument.MOVEMENT_FIELDS`. `tokenDeltaIsTransform`
 skips the combined write; a follow-up x/y-only recenter inside `TRANSFORM_GRACE_MS` (500 ms)
 is skipped too. A later walk is a full square and is not. Forced movement still fires —
 `isForcedMovement` is still not consulted.
- **Do not intercept the Argon Wild Shape button as revert.** Beast-to-beast must stay legal,
 and a revert must not spend a Wild Shape use. dnd5e already restores from the sheet header
 (`restoreTransformation`, visible when `isPolymorphed`) and the sidebar right-click.
 **The token-corner icon is the same restore**, shipped with riding in v0.7.23:
 `src/rules/transform.ts`. Status `noodlr-transformed`, `hud: false`, Wild Shape item art,
 click → `revertOriginalForm({ renderSheet: false })`. **`isOwner` must not be the write
 gate** — player and GM both own a PC, transform fires four hooks, and creating an AE does
 not `updateActor`, so a check-then-create raced two identical "Restore Transformation"
 icons (v0.7.23). Create is `isRollerFor` plus a keepId (`noodlrTransform0`) and an
 in-flight lock. Token HUD has a backup control. Setting `general.transformUndo`.
 `noodlrHooks.surveyTransform()` / `noodlrHooks.restoreTransformation()`.
- **A PIXI listener on the effect sprite is not a click (2026-08-21).** Core's
 `MouseInteractionManager` binds `clickLeft` to the Token. The sprite can look like a
 button and still never fire. `src/util/token-badge.ts` hit-tests the icon inside
 `Token#_onClickLeft` (wrapped on `CONFIG.Token.objectClass` at `setup`, after the Speed
 subclass — MouseInteractionManager copies the method when the token is drawn, and
 canvas init finishes before `ready`). The PIXI `pointerdown` stays as a cursor hint
 and a second path, with a 400 ms lock so both cannot restore twice. Same wrap serves
 the saddle icon.
- **`event.global` is screen space; the click lives on `interactionData.origin` (2026-08-21).**
 MIM's `#assignOriginData` stores `getLocalPosition(layer)` as `origin` and copies
 `event.global` as `screenOrigin`. Sprite `getBounds()` is world space. v0.7.25 compared
 global to bounds, so the wrap ran, the hit never landed, and the icon selected the
 token. Prefer `origin` (then `destination`), `layer.toGlobal`, and the AE's own `img`
 when the texture 404s to `hazard.svg`. Returning `false` from the wrap stops select/drag.
 A revert still dumps every rider — see riding below.
- **`on_enter_area` is still unheard.** It needs `create_area` (Phase 4). Do not tack it onto this
 hook — a token update is not an area entry.

### Sneak Attack, and the refusal predicate proved in the allow direction (v0.7.2, 2026-08-16)

`rules/sneak.ts` + `system/dnd5e-sneak.ts`. Built alongside `on_hit` deliberately, because it is the one
mechanic where the compiler and a hand-written layer can both plausibly claim the same feature, and the
release that dispatches attack riders is the release where that stops being hypothetical.

**The system already rolls this and nobody presses it.** dnd5e ships Sneak Attack as a real feature with a
real damage activity carrying `@scale.rogue.sneak-attack`, so the dice were never missing. Two things are:
the button is equally pressable on a turn where none of the conditions hold, and it is forgotten. Identical
finding to the damage tray, the concentration save and the legendary resistance, and the reason all four
layers exist.

- **It owns the DECISION and nothing else.** `readSneak` reads the conditions off the swing — Advantage on
 the roll, or an ally of the target within 5 feet with the attacker not at Disadvantage, plus a Finesse or
 Ranged weapon — and everything downstream is the person holding the sheet answering a prompt.
- **THE DICE ARE ROLLED ON THE ROGUE'S OWN CLIENT, which is why this crosses a wire at all.**
 `@scale.rogue.sneak-attack` resolves through that actor's roll data, the player sees their own dice, and
 the roll is posted under their name rather than appearing as something the GM did to them. Only the total
 comes back. Same `askUser` routing as the reaction offers, and the transport timeout is comfortably longer
 than the dialog's countdown or a slow reader is reported as having declined.
- **`offerSneakAttack` RETURNS an award; it does not apply one.** `damage.ts` calls in here and nothing here
 calls back, which keeps the dependency one-way — a cycle between two files this size works under ESM right
 up until somebody moves an initialiser to module scope. It lands down the same path graze takes, so the
 receipt and the undo come free.
- **Once per turn means once per ANY turn**, so this does not use the action ledger's `stampFor` — that
 answers "which of this creature's own turns is live", and a rogue who has used Sneak Attack on their turn
 may legitimately use it again on an opportunity attack during somebody else's. The stamp is the current
 slot in the initiative order, whoever owns it, and nothing is ever cleared: a stamp from another turn reads
 as absent. **Out of combat it is unlimited**, deliberately — there is no turn to clear a lockout, and a
 flag that never expires is the stale state this repo keeps paying for.
- **The item's own button records the spend too** (`registerSneakWatch`, on `dnd5e.postUseActivity`).
 Observation, not interception: the activity resolves exactly as it always did. Without it, a rogue who
 pressed the feature would be offered a second one on the next hit — double damage in the name of
 convenience.
- **The clock defaults to YES**, which is the prompt layer's one rule applied rather than an exception to
 it: the resource renews every turn, so a missed dialog costs that turn's damage and nothing that was being
 saved. Asked rather than applied because 2024 Cunning Strike spends these dice on riders and half a dozen
 subclass features hang off the "when you deal Sneak Attack damage" moment — none of it modelled here, and
 none of it ours to decide.

**`sneakClaimedNatively()` is the point of the exercise.** A compiled `damage` rule on this feature is
refused while we are dealing it, and the capability sheet says why.

- **`duplicate.ts` CANNOT SEE THIS CASE, which is why a second refusal exists at all.** That guard compares a
 rule's dice against the activity's `damage.parts`, and the specimen that produced this work is a feature
 hollowed out to a Utility with no parts at all — so the descriptor's `2d6` matches nothing, is correctly
 allowed, and lands on top of the offer. Same class of duplication, invisible from that angle.
- **Measured before building: all eleven compiled Sneak Attack wordings in the reference world are
 `adjudication: "gm"`**, so nothing doubles today. The model reading "once per turn, if you have Advantage"
 as a human's decision is the model being right. This is the guard for the release where a better doctrine
 makes one of them `engine` — which would otherwise be silent, because the only symptom is arithmetic.
- **NOTHING IS REFUSED WHEN NEITHER WE NOR CHRIS'S PREMADES IS DEALING IT.** A table that switched the offer
 off and compiled the feature deliberately has exactly one thing dealing the dice, and refusing there would
 leave nothing dealing them — the failure that reads as the compiler having been paid for nothing. This is
 the allow direction, and it is the half a refusal predicate gets wrong.
- Only `damage`. A `grant_capability` describing the feature costs nothing and feeds the prompt.
- **`runRule` takes the originating item for this**, so the refusal is asked with the feature in hand;
 `describe.ts` asks the same predicate statically, so it is a badge on the sheet rather than a line in a
 console somebody sees once. Same doctrine as the duplicate-damage refusal beside it.

**Where it stands down, and all three say so.** Everything here is reached from `settleAttack`, which only
runs when this module applies damage — so with auto-damage off the switch reads ON and no rogue is ever
asked. `sneakAdvisories()` reports that, and reports midi owning damage. Per rogue, `cprAutomatesSneak()`
stands aside for Chris's Premades, whose macro adds the dice on midi's damage-bonus pass; the ownership
resolver names it. **Chris's outranks our own switch** in `sneakClaimedNatively`, because its macro deals the
dice whether our offer is on or off.

Three readings worth not re-deriving.

- **`D20Roll.options.advantageMode` survives serialisation** (set during evaluation at
 `d20-roll.mjs:216-220`), so the attack MESSAGE is the authority on whether the swing had Advantage. Never
 the actor's current state, which has moved on by the time damage is rolled, and which the client being
 asked may not even hold.
- **THE 2024 ALLY CLAUSE IS NOT THE 2014 ONE, and Chris's Premades still reads the older sentence.** 2014
 said "another ENEMY OF THE TARGET is within 5 feet of it"; 2024 says "at least one of YOUR ALLIES", not
 Incapacitated. Foundry has no concept of an alliance, so disposition is the approximation: an ally is a
 token sharing the ATTACKER'S disposition, with the attacker and the target both excluded. CPR's macro is
 `findNearby(target, 5, {disposition: 'enemy'})` while being labelled `rules: '2024'`. The two agree on
 every ordinary fight and part company on a charmed creature — theirs qualifies it, ours does not, and ours
 errs toward refusing the bonus, which is the recoverable direction.
- **The weapon test requires a POSITIVE reading**, which is the one place this errs strict rather than
 generous. The generous direction offers Sneak Attack on a maul whenever the properties cannot be read, and
 a prompt that appears on every swing gets clicked through — at which point the rogue is dealing damage
 they did not earn and nothing says so.

Diagnostics: `api.surveySneak()`.

### What the enabled-module audit gave the compiler (2026-08-11)

From `_research\_audit\overlap-effects-and-summons.md`, which read all ten from source.

- **Aura Effects answers `on_enter_area` in the platform's own terms, and we should copy it rather than
  stand aside from it.** Creature emanations (Paladin auras) are a different job and shipped natively
  in v0.7.15 as a distance copy, not a Region — see the general-rules note above. This paragraph is
  still the recipe for **placed** areas (Spirit Guardians). It converts an aura into a real `RegionDocument` flagged with its own origin,
  then reads entry and exit as a **set difference on `token.regions`** against a `_priorRegions`
  snapshot stashed in the `updateToken` options — core's containment bookkeeping doing the geometry, so
  shape and elevation come free. Application is routed to a single client through
  `CONFIG.queries["auraeffects.applyAuraEffects"]` invoked as `activeGM.query(...)`, which is our
  `isPrimaryGM()` discipline in the newer core idiom. **No libWrapper anywhere in it.** Strictly better
  than the movement-hook distance scan we would otherwise have reached for, and the two cannot collide
  because ours would carry our own origin flag. **Stand aside per item** when the source
  already uses `type: "auraeffects.aura"` — two Regions for the same Spirit Guardians is
  a stacked AE, not a geometry collision. DDB does not stamp `flags.auraeffects`; wipe +
  re-import leaves scene Regions and `fromAura` copies until deleted by hand. Live
  git.gay **2.2.1** also has a broken Wild Shape cleanup (`token.parent` typo,
  `systems/dnd5e.mjs:20`). Full re-read:
  [`stack-aura-vae-2026-08-19.md`](../_research/_audit/stack-aura-vae-2026-08-19.md).
- **Effect Macro is the one real conflict, and it is ours to fix.** Its trigger list duplicates six of
  ours by meaning (`onTurnStart`, `onTurnEnd`, `onCreate` on a status-bearing effect, and via dnd5e
  `damageActor` and `restCompleted`). It fires nothing on its own — a human must paste JS into
  `flags.effectmacro.<trigger>` — so the collision is narrow and specific: **a premade or DDB-imported
  item that already carries a macro for the trait our compiler reads off the same prose**, e.g. a
  regeneration that heals twice. Nothing on either side detects it and no setting of theirs removes it.
  Planned stand-aside, same shape as `alreadyAutomated()`: the collector skips a feature whose effects
  carry `flags.effectmacro` keys. Their executor election is `getDesignatedUser() ?? activeGM`, the
  same answer as our `rollerForActor`.
  **Still unbuilt as of 2026-08-19** (`rg effectmacro` over `src/capability` and `src/system` is
  empty). Re-audit of the live clones is
  [`_research/_audit/community-effects-stack-2026-08-19.md`](../_research/_audit/community-effects-stack-2026-08-19.md):
  Aura Effects' live remote is git.gay **2.2.1** (GitHub is still 2.1.1-3); it copies real Active
  Effects onto actors, not decorations. DAE / Aura / Effect Macro are disable-before-DDB-reimport;
  Visual Active Effects is cosmetic. None of the five change compile `gm%` — `featuresOf` walks items
  only.
- **Rest Recovery cancels dnd5e's `pre*` rest hooks and then re-enters `actor._rest()`**, so
  `dnd5e.restCompleted` still fires and is the hook to use when rest triggers are wired. It owns
  per-item recovery, so a descriptor restoring the same counter double-restores — harmless for
  set-to-max, wrong for "regain 1d4 uses".
- **DAE is trending legacy and must not be leaned on.** Foundry v14 absorbed the expiry model
  (`CONST.ACTIVE_EFFECT_EXPIRY_EVENTS`, plus `start.combatant` so source-turn versus target-turn is
  expressible natively). What it still uniquely supplies is the change-key vocabulary
  (`macro.*`, `ATL.*`, `StatusEffect`) that DDB-imported items depend on — which is the DDB finding
  already recorded below, seen from the other end. It does **not** manage exhaustion
  (`DAEdnd5e.ts:382` deletes it from its own base-value handling), so our
  `flags.dnd5e.<condition>Level` encoding is uncontested.
  - **CORRECTED 2026-08-16: "down to two corrective libWrapper patches" was wrong by a factor of
    six, and the way it was wrong is the lesson.** Two is the count in `patching.ts`, which is the
    file *named* for patching; the real total across `dae/src` is **twelve registrations and zero
    unregisters**, with `ActiveEffect.applyChange` (`DAEdnd5e.ts:551`) wrapped on the hot path of
    every effect application. Counting a category by reading the file whose name matches it is how a
    plausible number gets written down and then quoted. Full census with what each patch corrects:
    [`_research/_audit/mech-04-change-key-vocabulary.md`](../_research/_audit/mech-04-change-key-vocabulary.md) §3.
  - **`specialDuration` is midi's, not DAE's, and that inverts what it means for us.** DAE registers
    the interesting vocabulary only `if (game.modules.get("midi-qol")?.active)` (`DAEdnd5e.ts:632`)
    and evaluates exactly two leftover flags itself (`combatEnd`, `joinCombat`); `1Attack`,
    `isDamaged`, `isSkill.*`, `zeroHP`, `isMoved` are midi's. **`turnStartSource` is the exception
    that is not a sticker:** at v14.0.13 DAE migrates that deprecated name to
    `duration.expiry: "sourceStart"` on create/edit, and then **core** expires it. The 2026-08-17
    “never expires” census mixed that family with `isDamaged`/`1Attack`, which still never expire
    with midi off. Re-verified 2026-08-19: [`stack-dae-2026-08-19.md`](../_research/_audit/stack-dae-2026-08-19.md).
  - **`dae.coreExpiryAction: "none"` kills core auto-expiry world-wide**, including our Phase 4
    timed grants. Default `"update"` is aligned with `fromEffect` skipping `duration.expired`.
- Convenient Effects 9.2.6 is still a library + click, **not** “applies nothing without
  `dfreds-triggers`.” Triggers are optional event automation; the app, drop, macros, and
  Argon call `api.toggleEffect` and write ordinary AEs without that module. Exhaustion
  stays `ceEffectId`-gated, so a status we write natively never reaches it. Argon + CE
  **Dodge** skips `activity.use` (our intercept misses the click); Hide has no CE effect
  and stays on the item + `statusId` path. [`stack-ce-effectmacro-2026-08-19.md`](../_research/_audit/stack-ce-effectmacro-2026-08-19.md).
- Visual Active Effects is **cosmetic as automation** (no apply/expiry engine) and **mutable
  as a HUD** (double-click toggles `disabled`; Shift+right-click deletes). Automated
  Evocations and Polyglot stay inert with respect to everything here.

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
- **Creature auras (v0.7.15) are a standing emanation, not `create_area`.** Aura of Protection —
  and Courage, Devotion, Warding, Aura of Life — stopped applying the moment Aura Effects and DAE
  were turned off. dnd5e never emanates: the 2024 item transfers `@abilities.cha.mod` onto the
  Paladin and a Foundry Note says allies add that number by hand, because copying the formula would
  evaluate Charisma against the ally. DDB stamps `flags.ActiveAuras`; those flags are inert without
  the module. `src/system/dnd5e-auras.ts` discovers (AA flags, known identifiers, stock
  `range.units === "self"` + radius template + changes, or a known ident with no effect at all);
  `src/rules/aura.ts` copies a **resolved number** onto whoever `measureBetween` puts inside the
  radius. Skip the carrier when `transfer: true` — a second +5 doubles it. Spells wait for a live
  AE from that item. Inactive while Incapacitated. Stand aside wholesale when `auraeffects` or
  `ActiveAuras` is **active**; DAE alone does not emanate and is not a reason to stand aside.
  Regions stay Phase 4 (`on_enter_area` / Spirit Guardians). Leftover Aura Effects Regions after a
  wipe are not our job. Setting `general.auras`, default on. `noodlrHooks.surveyAuras()`.
  - **Radius is a flat jump (2026-08-21).** 2024 Paladin auras are 10 ft at 6–17 and
    30 ft at 18–20 — `@scale.paladin.aura` on the class item, type `distance`. DDB's
    feature description stays "10-foot Emanation" and its AE prose is `[[scalevalue]]-ft`,
    an unexpanded enricher. Believe the scale (or Paladin class levels), never that
    sentence. `Number("30-ft")` is NaN.
  - **Distance is polled every 6 seconds, not only on move (2026-08-21).** A walk hook
    is a courtesy: if the Paladin stands still, allies can walk out and keep the copy,
    and walking the Paladin back in does not apply until *they* move. v13+ often never
    puts `x`/`y` on the update the GM hears. The poll is the same cadence as perception
    (one combat round). It reads committed TokenDocument `_source` positions from
    `canvas.scene.tokens`, not animated placeable centres. Survey prints `poll 6s`.
  - **The copy carries a unique status, registered with `hud: false`.** Foundry only
    draws `temporaryEffects` (a duration or a status) on the upper-right of the token.
    A canned id would overlay Paralyzed / Frightened. Token HUD skips `hud: false`
    (`token-hud.mjs` `_getStatusEffectChoices`), so there is no click-toggle.
    `auraStatusId` is `noodlr-aura-of-protection`. Token icons come from
    `statuses` plus v14 `showIcon: ALWAYS` — **never** `flags.dnd5e.isTemporary`.
    That flag is dnd5e's timed-effect marker; with v14 `showIcon: CONDITIONAL`
    the token icon follows duration, and an item-parented stamp is
    `isSuppressed` when the feat is unequipped — **Unavailable Effects**.
    Icons vanished until someone walked (recreate). Protection's +Cha lives on `item.effects`
    (`transfer: true`); Courage is `transfer: false` and already gets an actor
    copy from `desired`. v0.7.19–v0.7.20 stamped the sheet AE and never found
    it on `actor.effects`. **Fixed in v0.7.21.** Host icon is now a separate actor badge: empty
    `changes`, `flags.<ns>.auraHost` (not `aura`), origin is the actor, no
    item origin. Repair unstamps / re-enables a previously disabled transferred
    AE. v0.7.19 wrote a hollow badge with the same name and origin; a
    same-origin create landed empty `changes` and our
    delete flag on the sheet AE. Allies still got copies (those are read off the
    item). The Paladin lost their own bonus when the poll deleted "ours" or when
    the merge gutted the grant. **Fixed in v0.7.20:** `looksLikeGuttedHostAura`
    restores the item numbers and drops our flag before `stripActor`.
    Automated Animations matches "Aura of Protection" as a persistent aefx —
    copies and the host badge write `flags.autoanimations.killAnim`.
    Sequencer persistents already playing need the Effect Manager once.
  - **Same identifier, highest number; different identifiers independently (user, 2026-08-21).**
    Two Paladins both hosting Aura of Protection is one bonus — the +5, not +5 and +3. Protection
    beside Courage (or any other distinct aura) both apply. The Paladin's own transferred AE
    *is* their instance: a stronger neighbour writes only the delta, or the +3 and +5 become +8.
    Hostile auras of the same kind keep the harsher number (`auraDominates`). Not Paladin-only:
    audience is already `allies | enemies | all`, and discovery is flags / self+radius / identifier
    rather than a class list.
  - **Spirit Guardians is the other family, and this layer must not eat it.** PHB 318: 15 ft
    emanation, Concentration, designate creatures unaffected, Speed halved for everyone else,
    Wisdom save when the emanation enters a space / a creature enters / they end their turn
    there, 3d8 Radiant or Necrotic (alignment), half on a success, once per turn, +1d8 per slot
    above 3rd. That is an occupying **field** (`create_area` / `on_enter_area`), not a copied
    save bonus. Stock dnd5e ships it as a Save activity plus a Half Speed AE (`mode: 1` × 0.5
    on every movement key, `transfer: false`). `isOccupyingField` refuses the identifier and
    any self-radius item with a save-and-damage activity; a hollow DDB stamp that is only
    movement multipliers is occupying residue and is also refused. Do not tack it onto
    `rules/aura.ts`. Do not add every MM aura as a name.

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

## `api.surveyX()` in this file means `noodlrHooks.surveyX()` at the console

Every diagnostic below is written as `api.something()`, which is what it is called from inside the module
and is not a name that exists in a browser console. Reported twice as the surveys "erroring", and a
`ReferenceError: api is not defined` says nothing about which module the reader was supposed to reach
through. `module.ts` therefore assigns the same object to `globalThis.noodlrHooks` beside
`game.modules.get(MODULE_ID).api`, so **`noodlrHooks.surveyEconomy()` works as typed** and tab-completion
lists the whole surface. Not `api`: a one-word global belongs to whoever assigns it last.

Two of them need something selected and say so rather than failing: `explainTurn()` wants a controlled
token in an active combat, `testMove()` wants a controlled token.

**An agent can run all of them without a human, through the GM harness** at
`C:\Project\noodlr-vtt\harness\` (`npm run watch`, then
`curl -s -X POST --data-raw "noodlrHooks.surveyEconomy()" http://127.0.0.1:3111/eval`). It answers with
the console output the call produced as well as the return value, which matters here because most of
these surveys PRINT a flat block and hand back a count — see the flat-output note under v0.6.3. Full
reasoning, the security constraint and the Playwright traps are in
[noodlr's AGENTS.md](../noodlr-main/AGENTS.md) under "The GM harness".

**Nothing this module logs reaches the Foundry server**, so `journalctl` is not an alternative: module
code is browser-only ESM. The one server-side channel that carries our own output is the **chat log**,
because chat messages are documents in the world database — the *"could not carry that out (the token
would not move)"* card that finally pinned the melee-movement bug was recoverable from there all along.

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
- **A CLEAN DEPRECATION CONSOLE PROVES NOTHING ON A dnd5e WORLD (2026-08-16).** `dnd5e.mjs:66-69`
 pushes **fourteen regexes** into `CONFIG.compatibility.excludePatterns` at `init`, and that collection
 is core's **global** suppression list — so this silences those warnings for every module in the world,
 not just for the system. Three of the fourteen cover API families we use throughout:
 `/MeasuredTemplate/` and `/MeasuredTemplateDocument/` (unanchored, so they match any message
 containing the substring) and `/CONST\.ACTIVE_EFFECT_MODES/`. Also `Scene#templates`, `core.rollMode`,
 `core.gridTemplates` and `core.coneTemplateType`.
 - **We are not drifting today, and the distinction matters:** `core/screens.ts:75` and
 `core/hazards.ts:44` read `canvas.templates.placeables`, the canvas **layer**, which is not
 deprecated; the suppressed `Scene#templates` is the document **collection**. But the placeables we
 iterate are `MeasuredTemplate` instances, so a future core that renames the class tells us nothing.
 - **Consequence for the method above: a deprecation audit of our own code cannot be run on a dnd5e
 world.** Check against `_research\ftypes14\` or a system-less world instead. This is the same trap
 as reading a clone's committed manifest for its version — a plausible-looking clean result that
 invites no second look.
- **Five Active Effect change keys are rewritten with NO warning** (`documents/active-effect.mjs:66-72`):
 `system.attributes.movement.speed` → `movement.walk`, and the four flat senses paths
 (`senses.darkvision` and friends) → `senses.ranges.*`. `_applyChangeShim` has a working
 `if (shim.warning)` branch and none of the five populates it. **Our own reads are correct either way**
 — `sheetSenses` reads the prepared `senses.ranges.*` — so this is a forecast about the operator's
 content rather than a bug of ours: every DDB-imported effect written against the old flat key works
 now and dies silently when the shims are removed in **6.0/6.1**. It is a second reason to build the
 change-key classifier already parked in `IDEAS.md`, since nothing else in the world will warn.
- **Nothing in dnd5e's open 6.0/6.1 milestones collides with any rule layer here** — no action economy,
 reactions, cover, range, Speed, hiding, dying or forced movement. The one to watch is **#5559 Aura
 Effects**. Weak evidence though, and stated as such: "What's Next" has not been published since 5.0.0,
 and the two items from that list we care most about (action tracking, range/reach/cover) never became
 milestone issues at all.
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

**The auto-crit is Paralyzed/Unconscious within 5 feet, not Incapacitated, and the damage dialog is
a second object (v0.7.10).** 2024 Incapacitated is Inactive / no Concentration / Speechless /
Surprised. The auto-crit sentence lives on Paralyzed and Unconscious only. `forceCritOnHit` used to
mutate the live attack die after `buildPost` had already serialized it onto the chat card, so
`#rollDamage` kept reading `isCritical === false` and defaulted the dialog to Normal — the UI a new
player trusts. The card is rewritten now, and `preRollDamage` defaults the dialog as well.
`src/rules/crit.ts` is the arithmetic. Do not widen `CRIT_ON_HIT_WITHIN_5` to Incapacitated.

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
2. ~~**Unseen attacker and unseen target.**~~ **BUILT in v0.4.0** — `rules/unseen.ts`. The prediction held:
   the per-creature vision answer already existed and the injection point was the same `preRollAttack`.
3. ~~**A ranged attack with a hostile within 5 feet is at disadvantage.**~~ **BUILT in v0.4.0**, in the same
   file, and it was the board query and matrix row this line said it was.
4. ~~**Dodge.**~~ **BUILT in v0.2.3** — `rules/dodge.ts` plus the matrix entry. This line survived a release
   past its own completion, which is the failure `pages.ts`'s `state` field exists to prevent: check a row's
   state before trusting a queue entry here.
5. ~~**Standing up from Prone costs half Speed**~~ **BUILT in v0.7.15** — `rules/prone.ts` plus
   `system/dnd5e-prone.ts`. Half Speed to stand; crawl while the status stays. The planner stands
   unless `keepDistance` plus no melee within 5 feet plus a stay-put plan. No new setting: it
   follows the movement cap.
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
  fight); a resolved or unable-to-act creature is skipped PAST rather than replayed, or the fight stalls
  on its corpse. **Incapacitated (and Paralyzed / Stunned / Unconscious / Petrified, which grant it) is
  unable-to-act** — `isUnableToAct` in `tactics/skip.ts`, asked by `takeTurn` and `runTurnFor`. Hold
  Person on the Assassin (2026-08-18) applied the status and then the planner walked, because the skip
  only knew about the dead. Grappled / Restrained still get a turn. Not Phase 4 duration and not a
  compiled "skip this turn" rule: the general condition is already the strategy. A turn that has
  *already started* when the status lands is not aborted — that was the opening walk before the save.
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
  - ~~**Planned, not built: Shield, Parry, Counterspell.**~~ **All three built natively, and the reasoning
    below was wrong about the hard part.** It said Shield "genuinely cannot be timed natively" because
    dnd5e never compares an attack roll to an AC, and concluded that the answer was a midi adapter
    (`midi-qol.preCheckHits`, `hitsChecked`, `isDamaged`). The premise is right and the conclusion was not:
    dnd5e stores no hit verdict, so **we compute one** — `readHits` in `rules/cards.ts` — and the "when you
    are hit" moment falls straight out of it. Shield and Defensive Duelist ship in v0.4.2 (`acBoostOf` plus
    the `incoming` trigger), Counterspell in v0.4.3. The one true sentence in the old note is the last: midi
    hooks are awaited, so an adapter would still be the way to raise *fidelity* where midi is present. It is
    not the way to get the feature. **General lesson, and it is the same one twice: "the system does not
    record X" is an argument for recording X ourselves, not for depending on whoever else does.**
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
  quarantined exactly like the concealment table.   Persistent areas only: an instantaneous Fireball leaves
  its template on the canvas long after the fire is gone, and a creature fleeing yesterday's explosion
  looks broken. **That leftover is now a Phase 4 requirement** (template lifetime, 2026-08-19) rather
  than an accepted stain — the hazard layer still ignores instantaneous templates on purpose, and
  cleanup is what makes that safe. Gated on the new tier-2 `understandsHazards`, so mindless things
  still burn where they stand.

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
  resolving two ways — Convenient Effects if it holds an effect of the same NAME (`:1147`), else **the
  actor's own item matched by localized name** (`:1111`) used through the ordinary `activity.use()`,
  falling back to a bare chat card when the actor has no such item. Route 2 is why intercepting
  `dnd5e.preUseActivity` catches the bar for free in any world carrying the PHB content, and route 1 is why
  **Dodge specifically does not arrive that way**: CE ships a "Dodge" effect and no "Hide". Argon's
  `consumeActionEconomy` is display state on its own panel objects and writes nothing to the actor.
  - **CORRECTION (2026-08-14): the status toggle is NOT a third route, and reading it as one cost a live
    bug.** This note used to describe "a bare chat card plus a direct status toggle" as the no-item
    fallback. In fact `_onLeftClick` (`:1152-1157`) does the item use and the status toggle **one after the
    other in the same branch, with the toggle outside any success test**:

    ```js
    success = this.actorItem ? await this.activity.use({ event }, { event }) : await this.createChatMessage();
    if (this.statusId) { const status = CONFIG.statusEffects.find(e => e._id === this.statusId); if (status) this.actor.toggleStatusEffect(status.id); }
    ```

    So for the two buttons whose definition names a status — Hide (`dnd5ehiding00000`, `:1605`) and Dodge —
    **vetoing the activity does not stop the status arriving.** A refused Hide stamped `hiding` anyway, and
    `hidingState` reads a status with no banked number as hiding at passive Stealth, so the player was told
    they could not hide and was then hidden for free. It is also a **toggle** and it is **not awaited**,
    which makes the other direction equally wrong: pressing Hide while already hidden switches the status
    off underneath a successful roll.
  - **The transferable rule: a `preUseActivity` veto stops the activity, not the button.** Whatever drew
    the button may write to the actor on its own account, before or after, and need not consult the result.
    So any rule that both intercepts an activity AND owns a status has to reconcile that status after the
    fact rather than assume the veto held — `reconcileHiding()` in `rules/hide.ts` is the pattern, snapshot
    taken inside the synchronous hook (the last moment before the other module's write) and applied after a
    settle. Dodge is exposed to the same thing from the other side and is left alone deliberately: our
    `rules/dodge.ts` only expires a stale marker, so the worst case is a toggle we then clean up on time.
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

## Hiding is per-watcher, and the refusal was the wrong shape entirely (v0.6.2, 2026-08-15)

v0.4.1 fixed *which* enemies count as watchers and left the surrounding rule alone. The user's report a day
later was that the rule itself is wrong: **"we should never tell the Player they simply can't Hide."** They
are right, and the reason is worth stating because it is not a preference about difficulty. A refusal makes
hiding a binary that the printed rule never intended and that no table plays — 2024's Hide is a check whose
result is a **number other creatures have to beat**, and turning it into a pass/fail against DC 15 throws
that number away. The interesting hides are the partial ones.

- **`combat.hideAlways` (world, default ON) is a house rule and is labelled as one.** Off gives the printed
 rule back verbatim. It defaults on because the printed rule is what produced the bug report, and because
 the failure modes are asymmetric: playing loose costs a player their action, playing strict costs them a
 mechanic. Same reasoning as the generous direction the economy layer errs in everywhere.
- **THE BANKED DC IS NOT THE WHOLE STATE ANY MORE.** `Banked.spotted` is a list of token ids, and it is what
 makes "hidden from some people" expressible at all. A DC alone can only answer a question about the world;
 hiding is a question about a *pair*. Everything else here follows from that one field.
 - Seeded at declaration from `HideCheck.exposed`, so hiding in front of a guard is legal, costs the
 action, and hides you from that guard not at all. That is the user's own wording implemented literally.
 - **`evades()` checks `spotted` after the absolute veils and before the contest**, and the ordering is
 load-bearing in both directions. Magical darkness beats a watcher that has already found you; a watcher
 that has already found you is not asked to roll again.
- **Losing sight is tested by SIGHT ALONE, never by re-running the contest.** `maintainSpotted` drops a
 watcher when `sightOf` says it cannot see the target, and adds one when the contest says it can. Re-running
 the contest to *remove* somebody would let a watcher forget a creature and re-find it on alternate sweeps,
 which at the table reads as the hide flickering. A watcher that leaves the scene or dies is dropped too.
- **Stealth's reveal is per-watcher; invisibility's is universal, and conflating them was the bug in (4).**
 `perceives()` no longer calls `reveal` at all, and lost its `live` parameter as a consequence — it is a pure
 predicate again, which is what the diagnostic survey always needed. The universal `reveal` still fires
 where it should: attacking, casting aloud, invisibility ending. **Do not reintroduce a reveal into the
 perception sweep**; a sentry noticing you is not you standing up and shouting.
- **EVERY SUCCESSFUL HIDE READS IDENTICALLY AT THE TABLE, and the COUNT is the leak rather than the names**
 (user's edict, 2026-08-15, correcting a first attempt of mine that whispered the names and published the
 number). "Hidden, but two of them can see you" tells a player that something is out there and how much of
 it, from a *successful* action, and they cannot un-know it — an ambush is as thoroughly spoiled by the
 tally as by the roster. v0.4.1 had already established the principle for a refusal and I applied it too
 narrowly.
 - **This is the strongest argument for `hideAlways` being the default rather than merely the kinder
 option.** A refusal cannot be delivered without explaining itself, so the printed rule is not
 enforceable at all without leaking the room; the house rule is the only version of Hide that can keep
 the GM's secret. The player learns there was a sentry by being noticed by it.
 - `hideLine` is exported **solely** so `test/hide.test.ts` can pin it, because a leaking version produces
 perfectly reasonable prose and would pass any review. Same precedent as `timeoutChoice` and
 `survivalOptions`.
- Diagnostics: `api.surveyHide()` reports `alwaysAllowed` and every watcher's verdict.

## `apply=false`: the second contamination, and it is welded to the rule (v0.6.2, 2026-08-15)

v0.6.1 stripped the hidden "Foundry Note" asides and the Troll went on shedding limbs at full health
with no exhaustion. The right move at that point was **not** to conclude the model had misread the
rule; it was to look again at what was sent. There was a second piece of tooling prose in there, one
granularity down and with no heading to notice it by:

> The troll has 1 `&Reference[Exhaustion apply=false]` level for each missing limb.

`apply=false` tells the chat card's renderer not to draw an apply button. Sitting inside the word
`Exhaustion`, read by something looking for what to emit, it is a plain-English instruction **not to
apply Exhaustion** — and that is exactly the clause reported missing. **1,128 occurrences in the
shipped corpus**, essentially all of them welded to a condition name. `unwrapEnrichers` in
`capability/prose.ts`, called from inside `plainText`, so it is upstream of the hash and a stale
descriptor recompiles.

- **UNWRAP, NEVER DELETE, and that distinction is the whole design.** The words inside an enricher
  are the rule: `Exhaustion` is the condition, `{Troll Limb}` is what gets summoned, `2d6` is the
  damage. This keeps the reading and discards the markup, which is exactly what tag-stripping does one
  line above it. Nothing here removes a word or a number, which is the standing rule for everything
  upstream of the cache key.
- **An unlabelled `@UUID[…]` is left whole (3,460 of them), and that is the conservative choice
  rather than an oversight.** It renders as a document's name, resolvable only through a Foundry
  global this file may not touch — so the options are a noisy id or deleting a noun out of the middle
  of a sentence. An unlabelled `[[…]]` roll (4,120) is left whole for a better reason: `[[/damage 2d6
  slashing]]` carries the dice, and they are the point.
- **The generic-name templating survives.** `[[lookup @name lowercase]]{monster}` unwraps to
  `monster`, not to this creature's name, so 270 creatures still share one wording and one cache
  entry. Unwrapping to the resolved name would have quietly multiplied the compile bill by 270.
- **THE LESSON IS ABOUT THE SEARCH, NOT THE STRING.** After v0.6.1 the file said, in effect, "the
  notes are handled". The honest state was "one *class* of note is handled", and nothing had asked
  whether there were others. **A scrubber is never finished; it is finished for the shapes somebody
  has looked for.** The `compendium` counterfactual recorded in `prose.ts` had to be re-measured in
  the same change and halved (2,469 → 1,336 descriptions), which is a second instance of the same
  thing: a measurement in a comment ages against edits nowhere near it.
- Requires a recompile of anything compiled before this release. The hash changes, so an enabled
  compiler does it on the next scene load without being asked.

## The compiler was reading the rulebook off the sheets (v0.6.3, 2026-08-15)

Found in a HAR and console capture of one scene load, taken to answer a different question. The compiler was
asked to read **123 "abilities" off a single wizard**, spent 292 seconds and real credit, and among what it
read were `Dash`, `Dodge`, `Hide`, `Ready`, `Stabilize`, `Underwater`, `Unarmed Strike` and `Dagger`. None of
those is a creature's own ability. They are the 2024 rules glossary, which the PHB content module and
ddb-importer put on every character sheet as items — so the compiler's premise (a creature's OWN prose is the
thing nobody has automated) was being violated by its own input. `src/system/dnd5e-glossary.ts` declines them
in `featuresOf`, and `CollectReport.declined` reports what was skipped and why.

- **THE COST IS THE LESSER PROBLEM, and the reason is worth stating because a cheaper model would hide it
  rather than fix it.** A compiled `Hide` is a rule firing beside `rules/hide.ts`; a compiled `Underwater` or
  `Fall` applies consequences nobody asked for; a compiled `Long Rest` mutates the ledger `noteRest()` owns. A
  general rule is *identical for every creature*, which is exactly why `rules/general.ts` hard-codes the ten
  worth having and refuses the rest **with reasons** — so compiling one is either a duplicate of shipped code
  or a re-litigation of a recorded refusal. This is the same boundary `general.ts` draws, enforced one layer
  earlier.
- **The two recognition signals are guarded differently, and the asymmetry is the whole safety argument.** A
  stock `system.identifier` is an assertion by whoever authored the content, so it is trusted on **any** item
  type — which is the only way `unarmed-strike` is reachable at all, since it ships as `type: weapon`
  (`equipment24/weapons/unarmed-strike.yml`) and a blanket `feat` gate missed the one glossary entry every
  creature in the game carries. A bare **name** is a coincidence waiting to happen — "Jump" and "Fall" are
  plausible titles for a homebrew spell or magic weapon — so a name is believed only on a `feat`. Getting
  this backwards does not waste a call, it **silently withholds a real ability**, which is the same
  over-match the rider table's `featOnly` guard exists to prevent. Pinned by `test/economy.test.ts`.
- **A re-identified item is never matched by name.** Same rule as the rider and declaration tables: a world
  that gave the item its own identifier has said it is not the general rule.
- **The thirteen buttons are recognised through `phbActionOf`, not re-matched here.** A second copy of that
  matching is the divergence the v0.4.1 vision bug was about.
- `flags.<ns>.compileAnyway` is the escape hatch, and it exists because every judgement in that file is a
  name or identifier match against content we do not control.
- **DELIBERATELY NOT DONE: a mundane-gear skip.** `Dagger` looked like the same waste and is not — the stock
  item's description is **empty**, so `MIN_PROSE` already skips it and stock content needs nothing. What got
  compiled was an imported dagger carrying a pasted SRD blurb, so any rule would be a guess at what
  ddb-importer writes. The tempting version (skip `weapon`/`equipment` with `rarity: ''` and no `mgc`
  property, which IS how dnd5e separates a Dagger from a `rarity: rare` Dagger of Venom) would silently skip
  a homebrew magic item that never set a rarity. Measure it in a real world first; the reasoning is recorded
  at the head of `dnd5e-glossary.ts` where somebody would go to add it.

### `api.surveyGlossary()` exists so the feat-only guard is widened on evidence or not at all (v0.6.6)

The asymmetry above has one knowable hole: an item whose **name** is a glossary entry, whose type is not
`feat`, and which states **no identifier**, is missed and gets compiled. Widening the name test to every
rule-bearing type is two lines, and it was the obvious first move. It is also the one change in this file
that cannot be checked by reading the diff, because **what it costs is silent in the direction this whole
file exists to avoid**: a homebrew feature legitimately called "Fall", or a magic weapon called "Jump",
stops being compiled with nothing anywhere saying so. `test/economy.test.ts` pins that case deliberately
(`a weapon named after a general rule is never declined`), so widening means deleting a guard somebody
wrote on purpose.

- **The number to read is `MISSED`.** Zero means the asymmetry costs this world nothing and the test must
  **not** be widened. Anything else names the exact items, their type and their identifier, so the
  widening can be argued from the population rather than from the shape of the code.
- **Gated on `isDnd5e()`, because off dnd5e nothing is ever declined** and every match would be reported
  as missed — the instrument would report a catastrophe on a world it has no opinion about.
- **`glossaryPatterns()` is exported solely so a test can pin it, and that test is the load-bearing one.**
  Both source tables are read by shape (`action.spec.name` from `PHB_ACTIONS`, `rule.name` from
  `GLOSSARY`), so a rename in either yields a shorter list, no error, and **the reassuring answer**. An
  instrument that undercounts does not fail; it closes the question on a measurement never taken. Same
  class of fault as the meta-notes census reporting 34 hidden sections when there were 848.
- **`readableActors()` moved to `src/capability/sheets.ts`** when this became its second caller, and its
 own note carries the caveat every count from it inherits: **compendia are not walked, so every number is
 a lower bound.** A private second copy is how two diagnostics come to disagree about what the world
 contains, and here neither would look wrong.
- **IT WAS RUN, AND IT WIDENED EXACTLY ONE ENTRY (v0.6.8, 2026-08-16).** `MISSED` was **4**, and every one
 of the four was **Unarmed Strike, `type: weapon`, no identifier** — so the population answered the
 question the shape of the code could not. Unarmed Strike is the sole glossary entry that ships as a
 weapon (`equipment24/weapons/unarmed-strike.yml`), which makes it the only entry the feat-only name test
 could never rescue; the full census is eight of them across 557 sheets, **six carrying
 `identifier: "unarmed-strike"` and two carrying none**, both of those holding prose (188 and 572
 characters) and therefore being compiled and paid for. **The identifier is usually present, is not
 reliable, and a sheet that dropped it is indistinguishable from one that kept it.**
 - **Widened PER ENTRY (`types` on the glossary row), not globally**, and that is the whole safety
 argument rather than fastidiousness. `test/economy.test.ts` still pins that a **spell** named Unarmed
 Strike is somebody's homebrew and that a **re-identified** weapon is not declined on the strength of
 its name. A global widening buys this one case by making every other entry's name believable on any
 rule-bearing type, which silently withholds a real ability — the failure this file exists to avoid.
 - The test that asserted the opposite was **deliberately inverted**, which is the point of having
 written it: the guard could only be removed by somebody arguing with a measurement.
- **THE FIRST RUN OF THAT SURVEY REPORTED FOUR PROBLEMS WHERE THERE WERE TWO, and the miscount looked
 like an answer.** `readableActors()` returns a world actor **and** the synthetic actor of every unlinked
 token standing on a scene, and an **ActorDelta's items keep the base item's id** — so one item on one
 creature on one scene is reached twice. Deduped by item id (ids are per-document-creation, so two
 genuinely different items cannot collide), with the occurrence count kept as `sheets` rather than thrown
 away. Same class of fault as the meta-notes census reporting 34 hidden sections when there were 848:
 **an instrument that miscounts does not fail, it reports a number, and the number gets quoted.** Any
 census built on `readableActors()` has to decide whether its unit is the item or the sheet.

## The cache was reading a key nothing wrote (v0.6.6, 2026-08-16)

The Troll's Regeneration ignoring fire, and Loathsome Limbs firing at full health, were reported five
times across three releases and diagnosed wrongly every time — as a prompt problem, then as a model
that had misread the rule, then as prose contamination. **The descriptors were correct on disk the
whole time.** A census of the live cache (`scripts/census-guards.mjs`) settled it: **576 of 693 guards
were filed under `conditions`, plural, and `CapabilityRule` declares `condition`, singular.** The
executor read an empty guard array, and an empty guard array means "fires unconditionally".

- **THE PATTERN IN THE FAILURE IS THE WHOLE LESSON, and it is about the doctrine rather than the
  model.** Every key the prompt names in dotted form — `trigger.event`, `effect.kind`, `effect.amount`
  — was correct **100%** of the time. The one key named only as an English noun ("the conditions under
  which it fires") was correct **26%** of the time. The model was writing down what it was asked for in
  the words it was asked in. **Name a field by its literal path or expect its literal path back at
  chance.**
- **A closed vocabulary only closes what it NAMES.** `validateCapability` checked `trigger.event`
  against a list and checked effect parameter *names*, and had no opinion whatever about a top-level
  key it did not recognise — so `conditions` validated cleanly, stored cleanly, and read as nothing.
  Unknown keys are now **reported and not rejected**: rejecting would throw away rules that are
  otherwise fine, and reporting is what catches the next rename on the day it happens.
- **`damage_taken.window` was required with its legal values never enumerated**, and that was the
  second half of the same bug. The two cached Regenerations said `"since_last_turn"` and `"since the
  start of its previous turn"`; one was readable. `DAMAGE_WINDOWS` is now declared beside the predicate
  that takes it — `damage-log.ts` re-exports rather than declaring, because a type living away from the
  vocabulary that closes it is how three spellings of one window got in.
- **An unreadable window is UNEVALUABLE, never a guess.** `normalizeDamageWindow` returns null and the
  guard fails closed with the operator's own string on the capability sheet. Widening it to `ever` is
  the tempting default and it is the difference between a troll that stops burning and one that never
  regenerates again.
- **The repair lives at the cache boundary, in `admit()`, and that is deliberately not at the
  consumers.** One door into `memory` means a shard read, a fresh compile, a GM edit and an imported
  cache are all normalised identically, and there is exactly one answer to "what shape is a cached rule
  in". It is idempotent, so validating a normalised copy and then storing it costs nothing.
- **Merging both keys rather than preferring one**: guards are ANDed, so merging can only make a rule
  fire *less* often. Preferring one and dropping the other is the branch that loses a guard, which is
  the failure this whole layer exists to undo.
- **A normaliser is a guard, not a substitute for fixing the prompt.** The doctrine gains a literal
  example rule object in Phase 2 and the recompile follows; this exists so that descriptors already
  paid for do not have to be bought again, and so that a prompt cannot be *relied* on.

### A cache is a record of what was once asked, not of what currently runs (v0.6.6)

Same investigation, second finding, and it invalidated a number two audit documents had built on.
`Hide`, `Dash`, `Influence`, `Unarmed Strike` and `Stabilize` were all in the cache, which both
documents read as evidence that v0.6.3's glossary skip was not working. It works — `generalRuleOf` sits
ahead of `proseOf` in `featuresOf`, so a declined item is never collected and never bound. Those are
compiles from **before** the skip existed, in a cache nothing had ever swept, and they were being
counted in the 12.4% yield baseline as though they ran.

`src/capability/hygiene.ts` answers it. **The two reasons an entry is unreachable are not equally
certain and that asymmetry is the design:**

- **`declined`** — the collector refuses this wording wherever it appears. That is a property of our own
  code, true on every sheet in every world, so it is safe to remove and `pruneOrphans()` removes it.
- **`absent`** — no sheet this sweep can see produces it. That is a guess: the sweep walks world actors
  and every scene's tokens but **deliberately not compendia**, because walking every pack means loading
  every pack. So a compendium creature's descriptor looks exactly like a dead one, and it is reported
  and left alone unless the GM passes `includeAbsent`.
- **BINDING ANYWHERE OUTRANKS BEING DECLINED SOMEWHERE.** "Unarmed Strike" is the PHB glossary item on a
  character sheet and a real ability on a monster carrying the same wording. Reading `declined` first
  deletes a working descriptor to tidy up its duplicate — silently, discoverable only by the ability
  stopping working. `classifyCache` is split out of the sweep solely so `test/hygiene.test.ts` can pin
  that ordering.
- **`locked` and `rejected` are kept whatever their reason.** Those statuses mean a human had the last
  word, and a sweep that deletes a GM's correction because the monster is off-scene is worse than the
  clutter it removes.
- **Nothing runs automatically.** A sweep on scene load would eventually delete something paid for, and
  quietly. The GM presses the button having read what it would take.

#### THE CACHE WAS PER INSTALL, AND `absent` IS ANSWERED PER WORLD (2026-08-17, fixed v0.7.4)

Found the moment a second test world appeared on the reference host — smaller, different scenes, different
PCs and NPCs, deliberately varied to make testing obvious. The shards lived under `assets/`, which is a
**sibling** of `worlds/` rather than a child of any one of them, while `findOrphans` reads only
`game.actors` and the loaded scenes. So **every wording belonging to the other world was `absent` in this
one**: `surveyOrphans()` reported 878 of 1,099, and `pruneOrphans({includeAbsent: true})` would have
deleted most of a 1,022-wording cache bought over 87 minutes of real credit. The compendium caveat above
understated it badly — it reads as a corner case about unplaced monsters, and the real exposure was
routine multi-world hosting.

- **Two faults were worse than the prune hazard and neither had been noticed, both silent.** `writeShard`
  serialises a whole shard from this client's `memory`, so **two open worlds clobber each other** — world
  B flushing shard 3 overwrites everything world A had added to it, and the loss surfaces as a descriptor
  simply not being there on the next warm. And **a world backup did not carry the cache**, so restoring a
  world restored an empty one.
- **`folder()` is `worlds/<id>/assets/<module>/capabilities`, and THE OLD SHARED TREE IS NEVER READ.**
  A one-time adoption was built and then **removed before release on the user's instruction
  (2026-08-17)**, and the reasoning is worth keeping because the arithmetic argues the other way. The
  cache key is normalised prose, so an inherited wording genuinely would answer for any world's sheets,
  and abandoning 1,022 of them is real credit and 87 minutes thrown away. **It was still the wrong
  trade: a descriptor arriving in a world that never asked for it is a rule behaving oddly weeks later
  with nothing traceable to an adoption, and a day of that costs more than the recompile.** A cache
  rebuys itself as the world is used; a cross-world contamination is diagnosed by somebody who does not
  know it happened. Do not restore it. **`noodlr` took the same decision on the same day for RAG Lite's
  silos**, so there is now no legacy read-through anywhere in either module — which also means the
  `null`-versus-`[]` distinction in `readShard` (a missing file is not a deliberately emptied one) no
  longer guards anything and is gone with it.
- **A world whose id cannot be read stores NOTHING and reads nothing**, rather than falling back. A path
  built from `undefined` scatters shards into a folder literally named "undefined", and there is no
  longer any shared tree to fall back to. `flush` clears its dirty set instead of warning on every
  attempt for ever. Pinned in `test/cache.test.ts`.
- **`includeAbsent` remains a switch for a single-world install and nothing else.** Post-v0.7.4 a
  world's `absent` count decays as the world is used, because only that world writes to it — but any
  cache that predates the move, or one imported from somebody else, holds wordings that answer for no
  sheet here. Do not add a caller that passes it, and do not put it on a button.
- **`worlds/<id>/assets/` is core's own home for a world's extracted media, and a module MAY write there —
  the FilePicker's refusal is its BROWSER UI, not the server.** Verified against the live server before
  anything moved: `createDirectory` per segment succeeds, `upload` succeeds, and the file is fetchable over
  the routed URL exactly like one under `assets/` (`world.json` fetches 200 too; every *directory* path
  301s, same as `assets/`). Do not re-derive this from the picker — the picker refuses and the API does not.
- **Survey reports moved too** (`write-file.ts`, `worlds/<id>/noodlr-hooks/`), and that one had a quieter
  version of the same fault: a census is of ONE world's sheets, the filename is fixed, so the second world
  on a host overwrote the first world's report with no warning and nothing in the file said which world it
  described. Every census number quoted in this file came out of that folder.
- **Unfixed by any of this, and it is a licensing question rather than a bug:** a shard stores the `prose`
  it was compiled from, and the Data tree is served unauthenticated, so a named shard is publicly readable
  — premium book text at a guessable URL. Moving to `worlds/` changes nothing about that (measured). The
  remedy is a narrow nginx deny or dropping `prose` from what is written; `exportable()` already strips it
  for sharing, and the capability sheet reads `feature.prose` off the live item rather than the cache, so
  the stored copy may well be droppable. Not yet decided.

#### Aging the cache: a version bump is a REPORT, never a bill (v0.7.4, `capability/age.ts`)

Asked in the same breath as the world-scoping — "we likely need a mechanism of aging out our old server
cache; how about every time there's a Foundry server version change and/or a new game system update?" —
and the answer is yes to the *trigger* and no to the *eviction*. Those are two decisions and the second
one is where the money is.

- **EVICTING ON A VERSION BUMP IS A BILL NOBODY AGREED TO.** A dnd5e patch release is routine; a patch
  release that silently starts an 87-minute unattended spend at the next scene load is not something a
  GM can consent to after the fact. `recompileWorld` is deliberately called by no hook for exactly this
  reason, and an automatic eviction is that hook wearing a different name.
- **AND IT WOULD MOSTLY BE WRONG.** Version equality is a proxy for staleness so coarse it is nearly
  useless here: almost every one of these readings is of prose that did not change and whose meaning did
  not change, so 5.3.3 → 5.3.4 would re-buy a thousand identical answers to catch the handful that moved.
- So the trigger is honoured as a **stamp and a census**. `compiledIn: {foundry, system}` is written by
  `cache.admit` and `capability/age.ts` compares it back: one italic line on the sheet row naming what
  the reading was made under, and `api.surveyCacheAge()` grouping the whole cache by stamp. **The two
  responses were already built** — Recompile buys a fresh reading for one row, and **Lock restamps for
  free**, which is the important half: a GM who has read a rule and frozen it has certified it against
  the ruleset in front of them, and that is worth as much as a fresh compile at no cost. `putOverride`
  restamps for that reason.
- **THE STAMP IS THE CACHE'S JOB, NOT THE COMPILER'S**, and that division is not cosmetic. The compiler
  answers a question about prose and knows nothing about the ruleset the answer will execute under —
  it lives in `noodlr`, which has no opinion about which game is being played. `compiledBy` (model,
  timestamp, schema) is the compiler's account of itself; `compiledIn` is ours of the world.
- **Only two callers stamp: a fresh compile and a GM save.** A warm read must not, or every page load
  would claim the whole cache was read today and this could never report anything. **An import must not
  either** — an imported descriptor was compiled on somebody else's world and its own stamp is the
  honest account of that, drift and all.
- **SCHEMA IS THE ONE AXIS THAT COULD JUSTIFY A REFUSAL AND STILL DOES NOT GET ONE.** A bump means the
  descriptor's SHAPE may be unreadable, which sounds like grounds for failing closed — but a blanket
  refusal on a bump switches every rule in the world off at once, silently, which is the failure this
  repo documents at length under "a silent stand-aside is a bug report waiting to happen". Per-rule
  machinery already covers it *with a reason*: `normalizeCapability` repairs known shape drift on the
  way in, `validateCapability` reports an unrecognised key, `isExecutable` refuses what it cannot read
  and the sheet says so. What was missing is that **`compiledBy.schema` had never been read by
  anything at all** — enforcing it means counting it, not vetoing on it.
- **Three readings that are each easy to get backwards, all pinned in `test/age.test.ts`.** An
  UNSTAMPED entry is `"unstamped"` and never a version mismatch — there is no version to mismatch and
  calling it one invents a fact. A stamp NEWER than the current schema is **not** drift: a cache
  written by a later build and read by an earlier one is a downgrade, and the normaliser is what has to
  cope, not a report. And an **unreadable world** compares as nothing-to-say rather than as drift on
  every row, or one missing global lights up the entire cache at once — the noise that teaches a GM to
  ignore the line.
- **`0` is the absence of a schema, not schema zero.** `CAPABILITY_SCHEMA` is 1 today, so
  `schema - 1` is zero and a test written against the shipped constant cannot express
  "older but stated" — it silently asserts nothing and passes. `test/age.test.ts` builds its `now` by
  hand for that reason, and pins the unstated case separately.
- **Its own module rather than part of `hygiene.ts`**, because the two answer different questions:
  hygiene is *reachability* (does any sheet still produce this) and age is *freshness* (was this read
  under the rules it will run under). A drifted entry is perfectly reachable and a locked one is
  perfectly current.
- **`util/provenance.ts` exists to avoid a cycle**, and only for that: `cache.ts` stamps and `age.ts`
  compares, so whichever owned `worldStamp()` the other would import across. A cycle between two files
  that both run at load works under ESM right up until somebody moves an initialiser to module scope.
- Deliberately absent: any automatic action, and any per-row "stale" badge styled as a warning. The
  drift line is italic and understated because **the reading is very probably still correct**, and a
  red banner on a third of a cache is a channel a GM learns to dismiss.

### The honest baseline, and the two ways 12.4% was wrong at once (v0.6.6)

`npm run census:yield -- <cache-dir>` is the measurement everything in the roadmap is scored against,
and it exists because the number it replaces was quoted for three releases while being wrong in **both
directions simultaneously** — too low because 576 guards were unread, too high as a denominator because
55 rules belonged to descriptors nothing can bind. Re-run on the swept cache: **631 reachable rules, 81
active (12.8%)** — 32 executable and 49 standing facts.

- **THE BADGE DID NOT MOVE, AND THAT IS THE FINDING RATHER THAN A DISAPPOINTMENT.** 32 rules scored
  executable before the guard fix and 32 after, because an absent guard array is *vacuously true* — so
  `isExecutable` had always called these runnable and always would. The recovery is at **evaluation**
  time, which no static count can see: 326 rules gained guards and **ten of them are rules that
  actually run**, including `Regeneration — heal` and both halves of `Loathsome Limbs`. The two oldest
  open bug reports in this repo are in that list of ten. **A yield census measures what is wired, never
  what is correct**, and reading a flat number as progress is how this was missed for three releases.
- **`other` is counted independently of every other bucket, deliberately.** An exclusive tally hid 136
  of them behind `adjudication: "gm"` and reported zero, which would have made the Phase 2 recompile
  unmeasurable — `other` going down is the *only* honest evidence a doctrine change paid for itself.
  Same for unresolvable subjects: **105 predicates in 83 rules**, and the histogram is what makes it
  actionable — `"caster"` x20 is the single commonest, and it means `self` every time.
- **The glossary exclusion is matched by LABEL and the output says so in as many words.**
  `generalRuleOf` reads an item's type, identifier and flags; a cache holds a label. So the offline
  count is a lower bound and `api.surveyOrphans()` is the authority. Stating the limit in the report is
  the point: an approximation that does not announce itself becomes a fact by being quoted.
- **It bundles the shipped predicates rather than reimplementing them**, for the reason
  `census-meta-notes.mjs` learned the expensive way — a census carrying its own copy of `isExecutable`
  measures its own copy. What this script owns is the counting and nothing else.
- The Phase 3 yield is printed per trigger, which is the ordering argument in one block: `on_hit` 36,
  `on_save_failed` 24, `on_activity_use` 14, `on_attack_roll` 4, `on_save_succeeded` 4,
  `on_long_rest` 2. The 22 `always` rules in that column are NOT waiting on a hook — they are standing
  claims whose effect kind is outside `STANDING_EFFECTS`, so they are genuinely inert.
- **THOSE NUMBERS ARE FROM THE PRE-v0.7.2 DOCTRINE. SUPERSEDED — see the whole-world census below,
  which reverses the ordering they carry.**
- **`npm run census:subset` exists because the two caches were not the same population.** A recompile
  answers only for wordings the collector still asks about, and 62 of 1,022 failed on provider 403s, so the
  post-recompile cache held 1,038 entries of which 78 of the original 223 still carried the OLD descriptor.
  Censusing that directly compares a doctrine against itself and reports an improvement. It cuts both
  caches to the ids present in both AND re-read inside `--fresh-hours`, then `census:yield` runs over each.
  **A before/after census over unequal populations is not a measurement**, and the failure is silent.
- **`recompileWorld({ since })` exists because a part-finished run had no way to be finished (v0.6.9).**
  The only tool for those 62 was to buy all 1,022 again, which is why the gap sat open for a day. A
  wording is asked about unless the cache holds an entry answered at or after `since`, so passing the
  time the run STARTED leaves exactly what it failed on. Three properties make it safe to reach for:
  a **missing** entry always asks, which is the half that matters because a first-time compile that
  failed left nothing behind to look stale; a missing `compiledBy.at` reads as 0, so an entry that
  cannot say when it was written cannot claim to be fresh; and it can only ever **shrink** the batch,
  so it cannot cost more than a bare recompile. It is therefore idempotent — run it repeatedly and it
  converges on the gap, spending nothing on what already landed. **`compiledBy.at` is stamped by
  `noodlr-main` at answer time**, not by us, so this depends on the compiler having filled it in.

### The whole world on one doctrine, and why the subset comparison read the opposite (2026-08-16)

The gap was closed — the 62 were re-asked once the key's spend guardrail was lifted, and the cache now holds
**1,022 wordings all answered by the same doctrine**, zero left on the old one. Censusing that is the first
measurement this repo has ever had that is neither a mixed cache nor a small subset, and **it reverses the
conclusion drawn from the subset that morning.**

| | pruned, pre-v0.7.2 | whole world, v0.7.2 |
| --- | --- | --- |
| reachable rules | 631 | **2,358** |
| rules that RUN | 32 (5.1%) | **163 (6.9%)** |
| standing facts | 49 | 44 |
| `other` | 136 (21.6%) | 676 (28.7%) |
| unresolvable-subject predicates | 105 in 83 rules | **23 in 22 rules** |

- **BOTH READINGS ARE HONEST AND THEY ANSWER DIFFERENT QUESTIONS, which is the whole lesson.** The subset
  is the clean controlled comparison — same 145 wordings, two doctrines — and on that population the new
  doctrine really is more conservative. But those 145 are the wordings that happened to be on scenes
  somebody had loaded, which is a bench of hand-picked test monsters with unusually rich mechanical prose;
  they are not a sample of a world. Per rule, the runnable density went **up**, 5.1% → 6.9%.
- **A CONTROLLED COMPARISON ON AN UNREPRESENTATIVE POPULATION IS STILL UNREPRESENTATIVE.** `census:subset`
  was built that morning to stop a population mismatch producing a false improvement, and it worked; what
  it could not do is stop a *biased* population producing a false regression. **Report the controlled
  delta and the absolute baseline together, or one of them will be quoted alone.**
- **`engine` is not `runs`, and conflating them is what made the subset read as fivefold.** That census
  counted `adjudication: "engine"` (137 → 29). Running additionally needs a wired trigger and an
  executable effect, and most of that 137 hung off triggers this build does not dispatch. Two different
  measures, one of them four times larger, and only one of them is what Phase 3 is scored against.
- **THE WORLD IS PART OF THE POPULATION, and the reference host has had a second one since 2026-08-17.**
  Every number above is the *first* world's roster; the cache is shared per install but which of its
  wordings are reachable is answered per world (see the hygiene note). So a re-census on the smaller test
  world is a different population and **its yield may not be read as a delta against this table** — the
  same trap `census:subset` exists to close, on an axis that tool cannot see. Record which world a census
  was taken in, or the next comparison is unfalsifiable.

**THE PHASE 3 ORDERING FLIPS.** `on_save_failed` **81**, `on_hit` **46**, `on_activity_use` 24,
`always` 16, `on_save_succeeded` 14, `on_long_rest` 9, `on_attack_roll` 6, `on_move` 4, `on_enter_area` 2,
`on_condition_applied` 2. Saves now lead hits by nearly two to one, the reverse of the 36/24 that put
`on_hit` first — and `readSave` already exists, so the cheaper build is also now the higher-yield one.
`on_long_rest` at 9 is real yield rather than the 2 that made it look like a wiring proof only.

**Phase 3 dispatch is complete as of v0.7.6.** Every trigger in that ordering except `on_enter_area`
now has a hook. `on_enter_area` stays Phase 4 — it needs `create_area`, and `create_area` now ships with
template lifetime (orphaned Fireballs and broken-concentration cones, 2026-08-19). Yield on `on_attack_roll`
is almost entirely advantage / disadvantage / modify_speed, which now write timed Active Effects
(duration job A, below). Job B — translating imported DAE `specialDuration` onto those same
fields — is a separate follow-up.

### Phase 4 duration — job A (v0.7.11, 2026-08-18)

Core v14 already expires Active Effects: `duration.{value, units, expiry, expired}` plus
`start.{time, round, turn, combat, combatant}`. `CONST.ACTIVE_EFFECT_EXPIRY_EVENTS` is
combatStart / roundStart / turnStart / combatEnd / roundEnd / turnEnd. Source-turn versus
target-turn is `start.combatant`, not a different event name — DAE's `sourceStart` is
`turnStart` plus the caster's combatant id.

Two jobs, and they must not be conflated:

- **A (this).** When we apply `grant_advantage` / `impose_disadvantage` / `modify_speed` /
  `apply_status`, write an AE with core expiry. `src/capability/duration.ts` is the payload
  (pure; no Foundry). `timed.ts` writes or stamps. `grants.ts` is the pre-roll reader.
- **B (later).** Translate existing DAE `specialDuration` on imported items into the same
  fields. 196 declarations on the second test world never expire. Do not start B until A
  has been seen at the table.

What was locked:

- **Quantity units that are time:** `rounds | turns | minutes | hours | days`.
  `{value: 10, units: "ft"}` is a distance that happened to be filed under `duration` — null,
  refuse. `apply_status` with no duration stays permanent (Hold Person until the save).
- **`until`:** `sourceStart | sourceEnd | targetStart | targetEnd | combatEnd`. Default when
  units are `turns` and `until` is unset: **`sourceStart`**. Guessing the target's turn ends
  Ray of Frost before they walk.
- **v13 fallback** still written (`duration.{rounds, turns, seconds, startTime, …}`). Module
  floor is v13.
- **`grant_advantage` on `on_attack_roll` is too late if only the executor runs.** Reckless
  Attack's first swing needs the pre-roll reader. `grants.ts` never calls `fireTrigger`.
- **`config.subject` is the Activity, not the Actor (Barb Arian, 2026-08-19).** dnd5e 5.x
  sets `rollConfig.subject = this` on the activity (`attack.mjs:128`). The first `grants.ts`
  reader took `subject` as the creature, so `bindingsFor` and `actor.effects` both walked
  the Halberd's Attack activity. Executor cards still posted ("Reckless Attack: Barb Arian
  has Advantage") because `createChatMessage` resolves the speaker. The die stayed
  `advantageMode: 0`. Unwrap `subject.actor`. Same shape as AC5e's pre-roll reader.
- **A `sourceStart` AE written mid-turn can expire immediately.** Reckless's default is
  one turn until the source's next turn start; written after the first swing, Foundry
  labelled copies "1 Turn Ago (expired)" while a live twin sat beside them. The pre-roll
  binding path is what covers the rest of the turn; `fromEffect` skips `duration.expired`
  so a dead copy cannot grant next round. `ourTimedEffect` prefers the live twin.
- **`start.combat` must be the Combat document, never its id (Ray of Frost, 2026-08-19).**
  `start.combat` is a ForeignDocumentField. `_prepareCombatBasedDuration` and
  `isExpiryEvent` both decide whose turn matters with `combat === start.combat`. A string
  id fails that, and the fallback is `getCombatantsByActor(this.actor)` — the wolf wearing
  the Slow. The executor fired (`Ray of Frost: Dire Wolf Speed changes`, change key
  `movement.walk` ADD −10); the AE expired at the first wolf's turnStart, so the sheet
  never showed 40. `worldOf` now hands over `game.combat` itself.
- **`units: "turns"` remaining is every initiative slot, not a creature's turn.** value:1
  hits remaining 0 the moment the next combatant acts. Who's-turn expiry writes
  `units: "rounds"` so the Slow lasts the rest of the round; `expiry: turnStart` plus the
  caster's combatant is what ends it.
- **Standing `always` grants stay queried.** `isExecutable` requires a wired trigger, so a
  rule cannot be both.
- **`modify_speed`:** AE changes on `system.attributes.movement.walk` (or a named
  `movementType`). Unset type → walk only. `costMultiplier` has no core key — refuse.
  Refresh rather than stack (same kind + capability + rule index).
- **Grants and Speed cuts default to one turn** when the descriptor omitted a duration.
  A stated non-time duration is still a refusal.

### Phase 4 remaining — template lifetime (user, 2026-08-19)

`create_area` is already on this phase because `on_enter_area` cannot fire without a placeable.
**Orphaned templates are a hard requirement of the same job, not a Phase 5 nicety.** An
instantaneous Fireball already leaves its MeasuredTemplate on the canvas after the fire is gone
(`dnd5e-hazards.ts` records that as why a creature fleeing yesterday's explosion looks broken).
Concentration *can* cascade a dependent — Wall of Fire's template dies with the AE — and plenty
of templates are not registered as dependents, so a broken concentration still leaves a cone
painted on the map. The user's words: they are hugely distracting, and automatic clean-up is why
these modules exist.

Two lifetimes, both sides of the table (a player's leftover Fireball is the same stain as an
Archmage's):

- **Instantaneous** (Fireball, Lightning Bolt, Cone of Cold, a breath, a Banshee wail): in
  combat the template must not outlive the six-second turn that placed it. Key off the combat
  clock, not `worldTime` — Hold Person already showed that the world clock can run minutes
  during one round. Out of combat, a short real-time TTL is the backstop.
- **Valued duration** (Wall of Fire, Darkness, Fog Cloud, Moonbeam): delete when the source
  expires **or** the caster's concentration breaks, whichever comes first. Do not trust the
  dependent-effect cascade alone; walk templates that still name an origin whose AE or
  concentration is gone.

This is bookkeeping, not tactics. It is the sibling of `create_area` rather than a new
vocabulary kind: dnd5e already places the MeasuredTemplate; we own when it leaves. Do not
conflate it with "who the template caught" (the existing planned targeting row) or with
placing one in the first place (Phase 5, below). A template that vanished before the saves
resolved is worse than one that lingered, so cleanup waits on the application having settled.

Still on this phase, unchanged: `request_save`, dice over `dnd5e-reroll.ts`, named counters,
the small kinds (reduce-to-1-HP / initiative swap / flat bonus), and duration job B
(DAE `specialDuration` → core expiry). Do not start B until Reckless and Ray of Frost have
been seen working at the table.

### Phase 5 — hostile NPCs place their own areas (user, 2026-08-19)

The planner already picks a verb, an implement and a single target, then `activity.use`
with the usage dialog suppressed. That is enough for a Halberd. It is not enough for
Fireball. dnd5e's area activities still stop for a human to place the template, and
`configure: false` does not skip that step — the same shape as the Attack Roll dialog the
Assassin's Light Crossbow sat behind. A hostile that "casts Cone of Cold" and then waits
is not an automated GM.

This is tactics, not a compiler primitive. `create_area` answers "a compiled Moonbeam
becomes a Region"; this answers "the Archmage's own Cone of Cold activity is aimed and
placed without a click." Specimens the user named: Fireball, Cone of Cold, Lightning Bolt,
Wall of Fire, breath weapons, a Medusa's gaze, a Banshee's wail. Heals that cover an area
are the same search with the scoring inverted.

**The aim is a score, not a centre-on-the-nearest-PC.** Maximise enemies (the party) inside
the shape; minimise allies (other hostiles). A Fireball that cooks three PCs and two
hobgoblins is a worse plan than one that cooks two PCs and none of ours, and a cone that
clips the caster's own front rank is the failure this exists to prevent. The board already
knows who is a friend; `core/screens.ts` already tests containment against a template
shape. What is missing is the search (candidate origins and facings) and writing the
placement into the activity so `use` does not prompt.

The existing planned row — "who a template caught" — is the *reading* half and stays
separate. Leftover `game.user.targets` are already dropped on a template use
(`rules/template-targets.ts`), so auto-saves wait rather than rolling the last Ray of
Frost. Placement without a catch-list still leaves auto-saves with nobody to roll for;
a catch-list without placement still needs a human to draw the cone.

**The click is gone (Archmage Lightning Bolt, 2026-08-20).** `tactics/aim.ts` +
`place-template.ts`: suppress `#placeTemplate`, aim at the nominated target (line/cone
from the caster, sphere/cube on the target), create the MeasuredTemplate, stamp
`flags.dnd5e.targets`, `adoptTemplateCatch` so auto-saves roll. The scored search is
still open — a Fireball that cooks two hobgoblins with the party is the next job, not
a centre-on-nearest default we already have.

**The subject whitelist worked, and what it left behind is a different shape than predicted.** 105 → 23,
and `"caster"` ×20 — the entire basis of the planned aliasing — **is gone from the histogram**. What
remains sorts into three kinds, and only the first is an aliasing job:

- **Possessives meaning `self`:** `owner` ×6, `user`, `ability user`, `source`. **Shipped as prompt
  aliases in noodlr v0.7.8** (caster / wielder / owner / user / you → `self`). Not extra subject
  values — the validator still accepts only this module's `SUBJECTS` list.
- **Role descriptors meaning `trigger`:** `saving creature` ×2, `moving creature`, `acting creature`,
  `damaged creature`. Same pass: those phrases → `trigger` in noodlr's generated half. The doctrine
  already says the creature an event is ABOUT is `trigger`.
- **NOT CREATURES AT ALL:** `rod` ×4, `weapon` ×2, `chosen location`. A genuine vocabulary gap of the
  same class as `secondary target` — a subject axis that only enumerates creatures cannot express a rule
  about the implement or the spot. Fold into the `secondary-map` work rather than aliasing it away.
- Two proper names (`Beholder Zombie`, a player character) are the model naming a specific creature from
  the prose. Nothing to alias; the doctrine's example object is the fix and it is already shipped.

### The compiler was reading the ability's own damage line back to us (v0.6.6)

Third finding of the same census, and the one that had to be fixed before `on_hit` could be wired at
all: **45 of 71 `on_hit` rules were the ability's OWN printed damage.** Fire Bolt compiled to "on a hit,
deal 1d10 fire" — which dnd5e has rolled off `damage.parts` since long before any of this existed. So
dispatching the trigger without a guard would have doubled the damage of every attack cantrip in the
world, and **the doubling is arithmetic rather than an error**: nothing throws, nothing logs, and a table
just watches a ten-damage cantrip deal twenty.

- **The doctrine now states the platform boundary and `src/capability/duplicate.ts` exists anyway,
  because A PROMPT CANNOT BE RELIED ON NEVER TO RE-EMIT SOMETHING AND A GUARD CAN.** Same instinct as
  failing closed on `other` and `custom`, and the same reason `RESERVED_STATUSES` sits beside a doctrine
  that already forbids a rule from killing.
- **AN EXACT FORMULA MATCH, AND THE STRICTNESS IS THE SAFETY ARGUMENT.** A refused rider is damage a
  player is owed with no way to see it was declined, so anything short of certainty has to pass: a
  different amount passes, a different damage type passes (1d8 piercing beside a longsword's 1d8
  slashing is a rider that happens to roll the same dice), and an activity whose damage cannot be read
  is **permission rather than suspicion** — "I could not tell" is not evidence of duplication. Same rule
  as `knownStatuses()`.
- **The item's base damage needs no separate lookup and adding one would double-count.**
  `AttackActivityData#prepareFinalData` unshifts `item.system.damage.base` into `damage.parts` when
  `includeBase` is set (`attack-data.mjs:200-205`), so a longsword's 1d8 is already in the list on any
  prepared activity — which is every activity reachable from a hook.
- **Checked before any state is read or spent**, because the refusal is about the RULE rather than the
  moment: a restated damage line will restate it on every hit for as long as the descriptor exists, and a
  limited use spent on it would be spent for nothing.
- **THE SAME QUESTION IS ASKED STATICALLY, AND THAT IS WHAT MAKES THE GUARD FINDABLE.**
  `duplicatesItemDamage` runs the check against the FEATURE with no turn in progress, so
  `surveyCapabilities()` prints `REFUSED:` and the capability sheet badges it "would double" with the
  reason underneath. A refusal that only ever appears mid-combat, once, in a console is a rule a reader
  will report as having stopped working — the same doctrine as greying "Behavioral automation" and as the
  ownership resolver, applied to a compile fault instead of a stand-aside.
- Formulas are canonicalised by what they roll rather than by how they are typed (case, spaces, and term
  order, since the compiler writes a sum in whatever order the sentence did). `types` is a `Set` on a
  prepared activity and an `Array` in raw source data; both are read, because a descriptor may be
  compared against an activity loaded from source.

### `modify_speed` had no `target`, and our own renderer already disagreed (v0.7.5, 2026-08-18)

Measured, not mined: **13 of 114 validation errors across a live 960-wording recompile were one
`unknown parameter "target"` on `modify_speed`** — a spell that slows what it hits having no way to say
whose Speed changed. `describe.ts` had been rendering `who(effect.target)` for that kind since it was
written, so **the vocabulary contradicted our own renderer** and the model was right every time. Added
to `optional`.

- **In a log a vocabulary gap and a hallucination are the same sentence, and that is the durable half of
  this.** `checkParams` names the kind now — `"modify_speed" does not take it` rather than a bare
  `unknown parameter "target" — remove it` — because the label (`rules[0].effect`) does not carry the
  kind and the parameter set is per kind. The bare message invites the conclusion that the model
  invented a field, which closes the question; naming the kind invites the right one.
- **The census is what settled it rather than a reading of the schema.** Eight other kinds also lack
  `target` (`substitute_ability`, `modify_action_cost`, `replace_action`, `spend_resource`,
  `recover_resource`, `summon_creature`, `object_statistics`, `require_prerequisite`) and **none of them
  produced an error** — so widening them would be inventing a gap. Widen on evidence, per kind, the same
  discipline as `api.surveyGlossary()`.
- The three prompt-side halves of that same census — a `gm` rule's `note` described as optional, the
  missing envelope, the unenumerated `adjudication` values — are `noodlr-main`'s and are recorded in
  [its AGENTS.md](../noodlr-main/AGENTS.md) under "three rules the validator enforced and no generated
  prompt ever stated".

## A DIAGNOSTIC THAT RETURNS AN OBJECT HAS NOT REPORTED ANYTHING (v0.6.3)

v0.6.2 added `guards` to `surveyCapabilities()` precisely so the Troll's missing "while Bloodied" would be
visible, and **the next capture still could not answer the question** — because a browser console renders a
nested return value as `Object { selected: 1, report: (1) […] }`, and what gets pasted into a bug report is
that collapsed line. The one diagnostic in the same capture that arrived intact was `testMove`, which prints
a string.

- **`renderSurvey` prints a flat block, one line per rule, and `log`s it.** The object is still returned for
  anything programmatic.
- **The empty case is printed in as many words: `guards: NONE — fires whenever the trigger does`.** An
  omitted line reads as a rule that simply has no conditions to show, which is the opposite of the finding.
- **The general rule for every survey in this module: depth is what costs you.** An object is fine; an object
  of arrays of objects is a disclosure triangle, and a report that has to be expanded by hand before it says
  anything will be pasted un-expanded. Prefer a printed string, and put the interesting fact on its own line.
- `scripts/dig-har.mjs` stays for the case where what was **sent** is in doubt rather than what was stored.
  With no needle it inventories the capture rather than searching it, deliberately: a HAR is one page load, so
  the creature in question may not be in there at all, and searching an absent exchange returns zero hits that
  read exactly like a negative finding.

## A survey that cannot show a rule's guards cannot diagnose a rule that fires too often (v0.6.2)

`surveyCapabilities()` reported the trigger, the effect, the adjudication, whether the rule runs and
what it costs — every field describing a rule that fires, and **not one describing when.** So two
rounds of "the Troll is summoning limbs at full health" were spent unable to distinguish the two
possibilities that matter: a descriptor whose `while Bloodied` went missing in compilation, versus a
predicate failing open at runtime. Those have opposite fixes.

It now carries `guards` (each condition through `describePredicate`) and `reads` (the whole rule
through `describeRule`, the same renderer the capability sheet uses, so console and window cannot
disagree). **The general form: a diagnostic that reports only what a thing does, and never what
gates it, is unable to diagnose the commonest complaint about it** — which is not "it did the wrong
thing" but "it did the right thing at the wrong time".

## A creature that meets a wall must not stop (v0.6.2, 2026-08-15)

`moveToward` offered four candidate destinations and **all four lay on the same line**, so a blocked route
was refused four times and the creature stood still for the rest of the fight. `moveAwayFrom` had had a fan
of bearings since it was written; this never did, and nothing compared the two. Reported as a Troll walking
into a wall and giving up the pursuit.

- **Candidates are ordered by ground closed — `cos(offset) × fraction` — and that single rule replaces
 arguing about preference.** The direct route wins when it is open, a shallow detour beats a short shuffle
 forward, and a wide sidestep is the last resort. Sideways steps are offered at full stretch only; half of
 a wide detour gains almost nothing and would crowd out the better straight steps.
- **Eight candidates, and that is a budget rather than a round number.** Each is a real `move()` with a
 stall watchdog behind it, so this is a list to be stingy with, not a search space.
- **Every candidate must make progress.** A step that gains nothing is worse than not moving: it spends the
 budget and ends the approach. Pinned by a test.
- **Still not pathfinding, deliberately.** A creature three corners away gets closer each turn and tries
 again, which is what the header of `core/movement.ts` has always promised. What it may never do is stop.
- The fan is deterministic rather than seeded, so identical creatures all break the same way round the same
 obstacle. Cheap to change (`positioning.ts` has the seeded-bearing precedent) and not obviously worth it.

## Two parts of one module answering "how far is that" differently (v0.6.4, 2026-08-16)

The melee stall, found with the GM harness rather than by reasoning, and it is **the same shape as the
vision bug below**: one question with two implementations, the cheap local copy quietly wrong.
`core/board.ts` asked Foundry's `grid.measurePath`, which honours the scene's diagonal rule.
`core/movement.ts` did its own `Math.hypot`. On a square grid those disagree about every diagonal.

- **`measureBetween` in `core/positioning.ts` is the one answer now**, and both callers go through it.
 The general rule is already in this file twice; this is the third instance, so treat *any* second
 implementation of a spatial question as a bug on sight.
- **The reported symptom needed BOTH halves to explain it, which is why neither was found alone.**
 The world was set to Foundry's **EXACT** diagonal rule (world setting, `core.gridDiagonals`), under
 which a diagonally adjacent creature is **7.07 ft** away — genuinely out of a 5 ft reach, so the
 planner correctly said "close the distance", and `moveToward` correctly computed a **2.07 ft** step.
 There is no square 2 ft away. Every one of the eight fan candidates snapped back to the square the
 creature already held, each costing a real `move()` round trip with a stall watchdog behind it, and
 the creature stood next to its target for the rest of the fight.
- **A gap smaller than one square is now refused once, in words, instead of attempted eight times.**
 That is the durable guard: the diagonal setting was the trigger, but any reach that does not land on
 a multiple of the grid distance reaches the same dead end. It says the grid has nothing nearer,
 which is true and is what a GM needs to hear.
- **The same-square guard sits in `stepTo`, before `occupied()`**, because a destination that snaps
 onto the creature's own square would otherwise be rejected as "square already taken" — a message
 that sends the reader looking for a token that is not there. Elevation is part of the comparison: a
 flyer rising within its own square IS going somewhere.
- **Pixels are converted along the BEARING, not by the grid scale** (`pixelsPerUnit`). At the
 EQUIDISTANT default a diagonal square costs 5 ft and spans 212 px, so the flat conversion undershoots
 every diagonal approach by 30% — the creature closes two thirds of what it meant to and the shortfall
 reads as a wall. This one only became visible *after* the diagonal fix, because under EXACT the two
 conversions agree exactly.
- **`moveTo` reports the distance travelled through the same measurement**, since that number is what
 v0.6.1's "advances N ft" card prints. A diagonal square announced as 7 ft rather than 5 makes a
 correct move read as a rules error.
- **Every scene stores `null` for `grid.diagonals` and inherits the world setting**, so this is one
 switch for the whole world and it takes effect without a reload. Worth knowing before telling anybody
 to edit eighteen scenes.

## The tracker is omniscient and the creature is not (v0.6.5, 2026-08-16)

Reported as pursuit: the rogue re-hid, broke line of sight, and the hostiles walked straight to him
anyway, "as if the Player Rogue never hid". Nothing was broken in the hiding layer — `evades` was
answering per-watcher correctly, `maintainSpotted` was dropping watchers that lost sight, the survey
said so. **The planner never asked.** `readBoard` builds `board.enemies` from the combat tracker, and
the tracker holds every combatant wherever they are standing, so `planTurn` picked the nearest one and
`moveToward` walked at it. The behaviour was correct for the board it was given, and the board was a lie.

`src/tactics/awareness.ts` is the filter, applied in `planTurn` between `readBoard` and any scoring.

- **THE TWO QUESTIONS COST DIFFERENT AMOUNTS, and that asymmetry is the whole shape of the file.**
 `evades` is arithmetic (concealment layers, then a banked DC against passive Perception) and is asked
 about **every** enemy, because it is what catches an invisible one as well as a hidden one. `sightOf`
 casts rays and is asked **only** about creatures deliberately hiding. Asking `sightOf` about everybody
 is the tempting version and it **regresses ordinary combat**: a token with vision switched off and a
 stat block stating no senses falls back to an ASSUMED 60 ft, so on a large map every archer would
 abruptly stop being able to see what it had been shooting at all fight. Nobody hiding means no vision
 source is ever built, so an ordinary fight pays nothing.
- **Stated rather than left to be found: a creature that has NOT hidden is still tracked through a
 wall.** That is unchanged behaviour and is not what was reported — somebody who never tried to be
 unfindable has not earned being unfindable — and fixing it needs a per-creature sight model whose
 fallback is trustworthy, not a wider filter here.
- **It READS the sweep's `spotted` set and never WRITES to it.** `maintainSpotted` runs only inside the
 perception sweep, which is gated on auto-engagement; so a watcher recorded from the planner on a table
 with auto-engagement off would never be cleared by anything. Reading a stale set costs a monster that
 keeps tracking; writing to an unmaintained one costs a rogue who can never hide again.
- **Fails toward SEEING at every level** — a thrown vision test, an unreadable token, stealth switched
 off. Granting free invisibility to something that never earned it is the destructive failure; a
 monster that fights normally is the status quo.
- **An enemy it never saw is DROPPED, not remembered.** `board.unseen` is populated only where `seenAt`
 holds a sighting, which is what makes an ambush an ambush. Sightings are in memory and per client, for
 the same reason the per-encounter registry is: an actor flag would follow every future copy of that
 goblin, and a creature that remembers a session-three sighting is worse than one that remembers
 nothing. Cleared on `deleteCombat`.

### And then it has to DO something, or the filter reads as the bug it fixed

A creature that loses its quarry and has no plan for it falls through to the survival floor — and
"nothing in sight" scores above 1 deliberately, so the fix on its own would have produced a hunter
bellowing for help beside the bush the rogue stepped behind. Worse to watch than the pursuit.

- **`PlanKind: "search"`** walks to the remembered spot. `PlanOption.lost` carries an `UnseenEnemy`
 rather than the `target` every other movement option uses, and that is load-bearing: a `BoardActor`
 knows where the creature IS, and anything reading `option.target` to aim at would defeat the hide.
- **Gated at tier 2 (`searchLastSeen`), and the line is object permanence rather than tactics.** A dog
 does this. Tier 1 does not get it: something hunting by smell alone has nothing to search FOR once the
 thing it was chasing stops being there.
- **`blind` in `survivalOptions` gates on BOTH lists.** Reading `enemies` alone scores the floor above
 1 in exactly the case a search exists for, and wins. Pinned by a test.
- **The public announcement names nobody** — "searches the spot where it last saw its quarry" — because
 the roster leak rule applies here as much as it does to a refused Hide. The GM sees the name in the log.
- Already standing on the spot scores 0.8 rather than 0: milling about where the trail went cold reads
 correctly, it just must not outscore a real option. `execute.ts` skips the did-not-move complaint in
 that case, since it never meant to travel.
- Diagnostic: `api.surveyAwareness()` — flat, one line per hostile, `SEES`/`lost` plus the hiding state,
 so "the planner still thinks it can see the rogue" is one command rather than an inference.

## Two parts of one module answering "can X see Y" differently (v0.4.1, 2026-08-14)

**`src/rules/sight.ts` is where that one implementation now lives** (extracted v0.6.5): `sightOf`,
`perceives`, `observersWhoSee`, the vision-source builder and cache, `withinSenses`, `hasLineOfSight`
and `separation`. It was carved out of `perception.ts` because the awareness filter needed it and
`perception.ts` imports the tactics layer, so a planner asking the vision question would have closed an
import cycle. It is a **leaf** — geometry and detection modes, nothing about starting a fight — and
anything that needs to know whether one creature can see another imports it rather than reimplementing.
`perception.ts` keeps the policy half: sweeping, engaging, surprise, `maintainSpotted`.

Reported from the first five seconds of a player smoke-test: a rogue pressed Argon's Hide button and was
refused, *"in plain view of Beholder Zombie, Dire Wolf, Dire Wolf, Archpriest, Archmage, Bandit Captain,
Bandit Captain, Bandit Captain, Bandit Captain"*, at 90–110 feet, outdoors, with walls and trees in between.
Three separate bugs in one card, and the user found the diagnosis themselves by asking the right question:
**if nine hostiles genuinely had line of sight, why had no fight started?**

- **Because they did not, and the two layers were not asking the same thing.** `rules/perception.ts`
  answers visibility properly — it builds a vision source per creature and runs its detection modes, so
  darkvision range, light, magical darkness and invisibility all apply, with a stat-block fallback of
  stated senses plus a wall test. `canHide()` asked **neither**: it tested screens and then counted
  wall-blocked corner rays, so "out of any enemy's line of sight" was implemented as "no wall between".
  Distance and darkness were absent from the rule entirely. A hundred feet of unlit woodland is exactly
  the case where those two readings diverge most, and the sweep was right: nothing on that map could see
  the rogue, which is why nothing engaged.
  - Fixed by exporting `observersWhoSee()` from `perception.ts` and having `canHide` skip any enemy it
    names. **`sightOf()` was split out of `perceives()` for this and the split is load-bearing**: the Hide
    prerequisite must ask the VISION question only, never the full `perceives`, because `evades()` reads
    what the target is doing to hide — so a creature already hiding would be invisible to the very test
    deciding whether it may hide again, and every re-hide would pass unconditionally.
  - **The generalisable rule: one question, one implementation.** Two answers to "can X see Y" is a bug
    whichever of them is right, and this one survived because the wrong copy was cheap, local and looked
    reasonable in isolation. Anything else that ever needs this question asks `perception.ts`.
  - Cover is still judged here, on the enemies that vision says are genuinely watching. That division is
    the correct one: vision decides who is a watcher, geometry decides whether they have a clear shot.
- **The refusal named the roster, on a public card.** A player pressing Hide in a prepared scene was handed
  every hostile's name, count and creature type by a failed action — a spoiler dressed as an error message,
  and unrecoverable, because a player cannot un-know it. `HideCheck` and `HideResult` now carry `reason`
  (safe for the table, names nobody) and `detail` (the same answer with the watchers named, whispered to
  GMs and printed by `api.surveyHide()`). The whisper is skipped when the two agree, which is every
  successful hide, so an ordinary session gains no noise.
  - Worth noting the ordering: fixing the vision test shrinks this leak by itself, since most of those nine
    are no longer watchers. It still had to be fixed separately — one guard around a corner would have
    leaked just the same, and a message that is only safe because another layer is working is not safe.
- **The status arrived anyway**, which is Argon writing it directly and is documented in full under the
  Argon note above.

**Fog of War and "the player can see every hostile token" are neither of these, and no module of ours or
theirs is responsible.** Both are per-scene core settings — `scene.tokenVision` and `scene.fog.exploration`
(v14 schema; `canvas.visibility.tokenVision` and `canvas.fog.fogExploration` are the live getters). With
Token Vision off, every token on the scene is visible to everyone and there is nothing for any of this to
do: no line of sight to break, no unseen attacker, no surprise, and a perception sweep that sees the whole
map at once. `sceneAdvisories()` in `integration/ownership.ts` now reports all three of Token Vision off,
Fog of War off and **a scene with no walls at all** — the last because it is the honest explanation for
hides being refused outdoors, and because a tile is not a wall: trees, rocks and furniture placed as tiles
block nothing, which is the single most common misreading of why line of sight "isn't working".

- This is the same doctrine as the ownership resolver and the greying of "Behavioral automation": a
  capability that cannot function has to say so in the interface. The advisory is the only honest form of
  it here, because the cause is outside the module and cannot be worked around from inside one.
- **What the disabled community modules actually provided, checked rather than assumed.** Vision 5e is the
  real loss and the loss is fidelity, not features: it maps stat-block senses onto detection modes for
  every actor regardless of `sight.enabled`, and without it dnd5e NPC tokens have no modes at all (the NPC
  template ships no `prototypeToken`, so core defaults sight to disabled), which drops every hostile onto
  our coarser stat-block fallback. Stealthy and Perceptive provided the *rendering* half of hiding — they
  wrap `_canDetect` so a hidden token stops being drawn — and **we deliberately do not**, so a creature our
  rules have ruled unnoticed is still visible on screen. That is a real gap, stated here rather than
  discovered again. Neither of them, and nothing else on the disable list, ever provided Fog of War.

## Nobody presses the button either (v0.4.2, 2026-08-14)

Reported from the same smoke test as the Hide bugs and it is the largest gap this module has had: a player hit
a hostile, and the GM got a chat card with an **Apply** button on it. The user's brief in reply is the standing
specification for this whole area and is worth keeping verbatim in spirit — **automate the mundane for the
players (hit points, resources, a concentration reminder, a reaction reminder) and more than that for the GM;
surface only narratively consequential decisions, and put a six-second clock on those.** Everything below is
that brief implemented, and the parts refused are refused explicitly.

### The finding, which is the fifth instance of a shape this file already documents

dnd5e decides whether an attack hit **inside its chat card's renderer** and stores the answer nowhere. So the
system has no basis on which to apply anything, and what it ships instead is the damage tray: a button per
target, pressed by a human. Same for saves — it rolls against the right DC and compares the result to nothing.
Both are deliberate (hit determination and "Range, reach, & cover" are unshipped roadmap items) and **midi-qol
is the module that has always filled the gap.** With midi permanently gone (user, 2026-08-14) every hit at the
table cost a click and a subtraction.

**What it unblocks is larger than itself, and that is the argument for having built it first.** Death saves,
instant death, Unconscious at zero and the concentration save all hang off dnd5e's own `damageActor` hook,
which fires only when somebody applies damage. Every one of those rules was already built here and **none of
them could fire on a table where the tray went unpressed.** A quarter of this module was inert for want of a
button press.

### Applying the damage — `rules/cards.ts`, `rules/damage.ts`, `rules/saves.ts`

- **`readHits` is the single answer to "did this connect", and `rules/forced.ts` was rewritten to consume it.**
  Forced movement had its own reconstruction of the same arithmetic, which is the two-implementations bug the
  v0.4.1 vision fix is about, caught before it could diverge.
- **It diverges from dnd5e's renderer on a null AC, on purpose.** The system's formula scores an unreadable AC
  as a HIT, because `total < null` coerces to `total < 0`. That is fine for a label a human reads and wrong for
  something that subtracts hit points, so a null AC is `unresolved`.
- **`margin` was added in the same release for Shield** (see below) and is recorded for hits and misses alike,
  and **absent for a critical or a fumble** — those are decided by the die, so no AC bonus reaches either.
- **Where it stands down is the shape the user asked for**: no readable AC, no recorded target, two identical
  tokens the target record cannot tell apart, a roll from no item, a sheet with no hit points. It applies
  nothing, **leaves the button exactly where it is**, and whispers why. A wrong subtraction is worse than a
  click and silence is worse than either.
- **Primary GM only.** A damage roll's message arrives on every client and two clients both calling
  `applyDamage` subtract twice. It also means the GM's permissions do the writing, so a player's hit points
  move without granting anybody rights they should not have.
- **The undo snapshots hit points before touching them**, same discipline as the mercy forfeiture: a wrong
  application mid-session has to be one click to reverse, not a reconstruction from memory.
- **Saves route by ownership rather than by a setting**, and the asymmetry people expect is therefore already
  there without one: a creature nobody but the GM can roll for has its save rolled automatically, and a
  character with a player owner does not, because that player came to the table to roll it. Same election as
  concentration (`rollerForActor`), deliberately not a second one.
- **`isRollerFor` is the skip, never a truthy `rollerForActor` (2026-08-18).** That function ALWAYS names
  someone when a GM is online — the player if one owns the creature, otherwise the GM. `rollMissing` used
  to treat a name as "leave the button", so every NPC save in a running world was skipped: Bardo's Hold
  Person posted a usage card signed as Bardo (dnd5e's activity card, which is what makes it look like the
  caster must save), the Assassin was targeted, DC 20 Wisdom was read, and `surveyDamageSaves` sat at
  `saved: null, rolledBy: <GM id>` until the planner took the Assassin's next turn unparalyzed. The
  compiled `on_save_failed → apply_status paralyzed` was bound and runnable; it had no verdict. The
  crossbow in that same fight was the Assassin's opening turn (init 29 vs 12), before the spell, not
  impatience after it. `test/gm.test.ts` pins the gate. The usage card's speaker is the system's and is
  not rewritten here; the Assassin's own save card is what tells a new player who is rolling.
- **A cancelled auto-fail is a failed save, not a missing verdict (2026-08-18).** Disintegrate vs a
  Paralyzed Assassin rolled Dex DC 20, the condition layer cancelled it (`Assassin auto-fails DEX —
  no roll`), and Apply sat on 70 force. `settle` skips `success === null`; `damage.ts` silently
  stands aside when auto-saves is on. The auto-fail card now carries `originatingMessage` and
  `route` treats `conditionAutoFail` as `success: false`. `preRollSavingThrow` is client-local, so
  the card — not the hook — is what the GM's apply path can see. Same doctrine as a clean miss:
  "we have no answer" and "the answer is no" must not share a path. Pinned by
  `test/saves-autofail.test.ts`.
- **The Assassin's Light Crossbow in that same fight was a planned turn, not a Ready.** Combat
  started at 16:32:56 (`Assassin spots Bardo`), automation took the turn at 16:33:01, Hold Person
  landed ~47 s later. The usage card posted and the Attack Roll dialog waited, because
  `activity.use({configure:false})` is only the USAGE dialog: `AttackActivity#_triggerSubsequentActions`
  then calls `rollAttack` with an empty dialog config and does not await it.
  `tactics/auto-roll.ts` sets `dialog.configure = false` on `preRollAttack` / `preRollDamage` for
  creatures we are playing, and `finishActivity` skips the subsequent call, awaits the attack, and
  rolls damage so the turn cannot advance while the dice are still a window. A player's roll is
  never silenced.
- **`if (!rollerForActor(actor))` on concentration's `preUpdateActor` is the OTHER use of a truthy
  election, and it is correct.** That line asks "is anyone elected to roll instead?" so the stock
  button can be suppressed. Flipping it to `isRollerFor` would leave the system's prompt up on every
  client that is not the roller. The scan of every `rollerForActor` call (2026-08-18) found the
  inverted skip only in `rollMissing`; sneak, Ready and reaction offers use the id to ADDRESS a
  client, which is the election doing its job.
- **A capability card names who the effect landed on, not `ctx.self`.** The same fight posted
  "Hold Person: Bardo is paralyzed" signed as Bardo, because `announce` always used the caster. The
  Assassin was the one frozen. `subjectOf(effect.target)` is the speaker and the name.
- **A spell's save riders fire only for that spell.** `fireTrigger` used to run every `on_save_failed`
  bound to the caster, so Otto's Irresistible Dance charmed the Assassin on Hold Person's failed save.
  Spell, weapon and consumable bindings must match the used item; a feat that watches any save still
  fires. `bindingAppliesToActivity` is the split, pinned in `test/saves-trigger.test.ts`.
- **What a failed save INFLICTS is not applied.** Restrained, Prone and the rest are prose on the item, which
  is the compiler's problem. Guessing at them would start an argument at the table.
- **A leftover target is not who a Fireball is for (2026-08-19).** dnd5e writes `game.user.targets`
  onto the usage card in `messageFlags` *before* `preUseActivity` and *before* `#placeTemplate`.
  Auto-saves then rolled that list immediately, so a Dire Wolf still targeted from Ray of Frost
  Dex-saved against a sphere the caster had not placed — and could have put anywhere.
  `rules/template-targets.ts` is the one door: on a template activity it empties the live
  selection *and* `messageConfig.data.flags.dnd5e.targets`. Clearing only the selection leaves
  the snapshot on the card. Never a veto (a second `preUseActivity` that returns false is how
  Hide and Dash double-charged). Skipped while `isAutomating()` so Phase 5 can set a catch-list
  and not have it wiped. `onUsage` also refuses to `noteTargets` when `placesTemplate`, because
  without a catch-list there is nobody honest to roll; Hold Person is unchanged. An
  automated turn skips the wipe (`isAutomating`) and writes the catch list *after* it
  places the area — `adoptTemplateCatch` is that second pass. Pinned by
  `test/template-targets.test.ts`.
- **A Cast wrapper has no template of its own (Archmage, 2026-08-20).** Spellcasting →
  Lightning Bolt is `type: "cast"`; `CastActivity.use` forwards to the cached spell and
  *that* activity is what `#placeTemplate` reads. `placesTemplate` follows the link.
  `configure: false` never skipped the preview. Aimed placement lives in `tactics/aim.ts`.

### The prompt primitive — `util/prompt.ts`

- **THE ONE RULE ABOUT DEFAULTS, and it is a rule rather than a preference: A TIMEOUT MAY SPEND A RENEWING
  RESOURCE AND NEVER A DEPLETING ONE.** An unused reaction is gone at the end of the round, so a free
  opportunity attack taken by the clock costs nobody anything they were saving; a fourth-level slot spent
  because somebody was refilling their drink is unrecoverable and unforgivable. `CreatureAction.depleting` is
  computed where the sheet is read (`tactics/actions.ts`) rather than guessed at in the prompt, and it errs
  towards `true` — a needless question is cheap, a spent slot is not. `timeoutChoice()` is the whole rule in
  four lines and is exported **only** so `test/reactions.test.ts` can pin it.
- **Built on a constructed `DialogV2`, not `DialogV2.wait`**, because the clock has to be able to close it and
  `wait` hands back only a promise. Everything goes through `settle`, which resolves exactly once: somebody
  pressing a button on the last tick of the countdown is a race that happens in practice, and resolving twice
  takes the reaction twice.
- **Local by design.** It draws on the client it is called from and nothing else; routing is `rules/offer.ts`.
  A dialog rather than a chat card with buttons because a card cannot be addressed to one person without a
  whisper, a whisper scrolls away under the next roll, and neither can expire.

### The reaction surface — `rules/offer.ts`, and `askUser` in `util/queries.ts`

- **The gap was invisible and it was in the gate.** `rules/reactions.ts` has detected its two triggers
  correctly since v0.4.31 and then ran every candidate through `shouldAutomate`, which **refuses player
  characters in every mode** and refuses any monster nobody opted in. So an opportunity attack was automatic
  for an automated goblin and *did not exist for anybody else*: no swing, no prompt, no line in the log.
  `watchersOf` now tags rather than filters and the caller decides whether to swing or to ask.
- **`active()` in `reactions.ts` no longer gates on combat automation**, and that conflation was half the bug:
  "do not play my monsters for me" is not "do not remind me my reaction is up". `shouldAutomate` still decides
  who gets *played* for, which is where that setting belongs.
- **Asked on the owner's client, and everything follows from that.** The question, the dice and the resource
  belong to the same person, so the far client reads the options, draws the prompt, spends the reaction and
  uses the item — a player's Shield is cast by the player's client and signed with their name. `askUser` is
  `askGm` addressed to one user id, over `CONFIG.queries` for the reasons Influence already documents (a
  promise, a timeout and a correlation id that all already exist).
- **The request is UUIDs, never objects**, because it crosses a wire, and everything is re-resolved and
  re-checked on arrival: the asking client's view of what is still available is a moment old by the time the
  answer matters, and the answering client is the one that writes.
- **The reaction is spent BEFORE the use, not after.** `useActionAt` can take seconds (a targeting
  confirmation, a roll dialog) and a second trigger arriving in that window would otherwise find the reaction
  unspent and offer it again. The ledger is turn-stamped, so an over-spend cannot leak into the next round.
- **Options are capped at four and sorted before capping.** A wizard has a dozen reaction items and a dialog
  listing all of them in six seconds is not a decision, it is a wall of text.
- **Offers are awaited in sequence, not fired in parallel.** Two dialogs at once on one client is a stack of
  windows, and a player answering the second has to be able to trust the first one's swing already resolved.
- **`offerable(actor, trigger)` takes the trigger for one reason: midi's stand-aside is PER TRIGGER.**
  `doReactions` and `gmDoReactions` both default to `"all"`, so unlike almost every other midi mechanic this
  one **is live on a stock install** — making it the one place a second offer of ours is a real double prompt.
  Midi covers "I was hit" and "I was damaged"; it declares `reactionmoved`/`isMoved` and **dispatches it from
  none of its eleven `doReactions` call sites**, so the departure has never been offered by it. Standing aside
  wholesale would leave opportunity attacks unoffered by anybody. Reported in `ownership()` with a note that
  says which half we kept, because the badge can only name one owner.

### Shield, and the moment dnd5e never had

- **Reading hits is what created it.** Shield triggers "when you are hit by an attack" and there was no such
  event: the system rolled a number and rendered a colour. Now that one answer to "did this connect" exists,
  the window falls out of it — read the verdict, ask the creature that was hit, and if the bonus arrives move
  it out of `hits` before anything is applied.
- **Only offered where it could change the answer.** A +5 against an attack that beat the AC by nine is a slot
  spent to be hit anyway, and **a player under a six-second clock reads an offer as a recommendation.** Hence
  `margin` on `HitReading`.
- **The window is registered synchronously, before anybody is asked**, and the damage path awaits it. In
  practice dnd5e posts attack and damage as two separate presses so there is a human gap; "in practice" is not
  a guarantee, and a Shield answered a moment late is a slot spent on damage that had already landed.
- **`incoming` is never answered by the clock.** Every AC boost costs something and every one of them decides
  a hit, so it is exactly the decision a person has to make. `timeoutChoice` returns null for it outright
  rather than looking at `depleting`.
- **`acBoostOf`'s Shield pattern is ANCHORED (`/^\s*shield\s*$/i`)** because "Shield" is also every buckler in
  the game; matching loosely offers a fighter their armour as a spell and then tries to cast it. Defensive
  Duelist reads proficiency off the sheet and floors at 2 — under-promising, the safe direction for a bonus
  that decides a hit. `flags.<ns>.acReaction` holds a number as the escape hatch.

### Refused explicitly, because a half-built offer is worse than none

**Counterspell** and **Silvery Barbs** were both refused in v0.4.2, and **both shipped within a day** — one in
v0.4.3 and the other in v0.5.0. Kept here rather than deleted, because the pair is the clearest evidence in
this file that a refusal note ages badly: each said truthfully that a primitive was missing, and in each case
the primitive either already existed three files away (Counterspell's veto-and-replay) or arrived as a
side-effect of unrelated work a release later (Barbs' held verdict). **A refusal has to name what it searched
and what would change its mind**, or it reads as a permanent verdict on the feature. See the two sections
below.

## Counterspell, and the note that talked itself out of a buildable feature (v0.4.3, 2026-08-14)

`rules/counterspell.ts` + `system/dnd5e-counterspell.ts`. This is worth reading as a lesson about notes as much
as about the feature, because **the paragraph above was the only thing standing between two releases and a
working Counterspell**, and it was wrong in a specific and instructive way. It said:

> `dnd5e.preUseActivity` does report a cast, but `Hooks.call` is synchronous and the veto is its return value,
> so there is no awaiting a six-second prompt and then cancelling. Building it means either vetoing first and
> asking afterwards (wrong: it cancels casts nobody countered) or holding the cast in a way core does not
> provide.

Every clause of that is true. The conclusion does not follow. **Veto first and ask afterwards is not wrong if
you put the cast back**, and this repo had already been doing exactly that for four months: the action economy's
over-budget dialog cancels a use, asks a question that takes as long as it takes, and then replays it through a
`cleared` set that stops it being charged twice. The mechanism the note declared absent was three files away and
in daily use. **The generalisable rule: a note that concludes "core does not provide X" has to name what it
searched, because the usual reason for that conclusion is that the answer was a pattern rather than an API.**

### The 2024 redesign is what makes it honest, not merely possible

Under 2014 rules the counterspeller rolled an ability check against a DC from the countered spell's level and
the countered caster **lost the slot**. Both halves fight Foundry: there is no contest primitive, and refunding
a slot means unpicking a consumption that has already happened. 2024 inverts both, and the two inversions line
up exactly with what a `preUseActivity` veto can do:

- The countered creature makes an ordinary **Constitution saving throw** against the counterspeller's ordinary
  spell save DC. dnd5e already ships the spell in that shape (`packs/_source/spells24/3rd-level/counterspell.yml`:
  a `save` activity, `save.ability: con`, `dc.calculation: spellcasting`, `identifier: counterspell`), so the DC
  is the system's to compute and never ours — which also means a table's homebrew DC is respected for free.
- On a failure the slot **"isn't expended"**. So stopping the cast *before* dnd5e's consumption step is not a
  workaround for the platform, it is the literal rule.
- Upcasting does nothing, so there is no "at higher levels" scaling to read.

**What a countered caster loses, and where each half comes from, is the part most likely to be broken by a
later edit.** The Action is charged by `police()` in the ordinary course of allowing the cast, so by the time
the window opens it is already spent — correct. The slot is never touched, because the veto precedes
consumption — correct. Both are consequences of *where* `holdForCounterspell` is called from, and neither is
implemented in `counterspell.ts` at all. Moving that call earlier or later silently changes the rule.

### Gambit's Premades does this, and reading it confirmed the approach rather than replacing it

`gambits/scripts/automations2024/spells/counterspell2024.js` is a complete and careful implementation — 60 feet,
enemies only, sight, the reaction, the V/S/M test, a timed dialog, and the counter-the-counterspell chain. Two
things came out of reading it:

- **It aborts midi's workflow AFTER the cast and then refunds the slot** by replaying
  `flags.dnd5e.use.consumed` in reverse (`refundSpellSlot`). That is the only option available once consumption
  has happened, and it is exactly what vetoing at `preUseActivity` avoids. Independent confirmation that the
  earlier interception point is the better one.
- **`gambitsOwnsCounterspell()` requires Gambit's AND midi**, and that conjunction is the point rather than an
  aside. Its entry point is `MidiQOL.Workflow.getWorkflow()` and every step routes through `MidiQOL.socket()`,
  so with midi absent — which is this table — its automation cannot fire at all. Standing aside for an
  installed-but-inert module would have left Counterspell unimplemented while a settings row claimed somebody
  had it, which is the exact failure the ownership resolver exists to prevent. Note also that theirs fires only
  for creatures carrying its own flagged Counterspell item; ours reads whatever Counterspell is on the sheet.
- Its **Deafened rule is worth having and is an interpretation rather than a printed clause**: a spell with
  Verbal components and neither Somatic nor Material has nothing to *see*, and the rule says "when you see a
  creature casting", so a Deafened creature cannot notice it. `CounterableCast.vocalOnly` carries it.

### Invariants

- **Unreadable components mean COUNTERABLE.** The veto is synchronous, so a monster casting through a feat that
  points at an unloaded compendium spell cannot have its properties read here at all (`fromUuidSync` returns an
  index stub with no `system`). Assuming components costs the occasional pointless offer; assuming their absence
  would make most of the bestiary silently immune to being countered, with nothing anywhere saying why. A
  property set that IS readable and names none of the three is the one honest "no", and the two cases must stay
  distinguishable — `test/counterspell.test.ts` pins both.
- **Whether a slot is spent is asked of `CONFIG.DND5E.spellcasting[method].slots`, never hardcoded.** An
  at-will or innate caster has no pool, and refusing it for want of a resource it does not use would disqualify
  exactly the creatures most likely to be holding this.
- **The DC is a hard requirement, not a best guess.** Without one there is no contest to adjudicate, and the
  failure to avoid is spending somebody's third-level slot on a save nobody can judge. Read from
  `save.dc.value` after data preparation rather than recomputed.
- **The contest is resolved on the client holding the cast**, which by construction owns the caster. That is
  what keeps it out of `rules/saves.ts` — that layer runs on the primary GM only, and a player's held spell
  would need its verdict shipped back across a wire before the cast could be resumed. It is also why the
  legendary resistance offer lands in the right place with no routing: the only creature that has one is an
  NPC, and an NPC's cast was pressed by the GM. `savesSkip()` is the stand-aside; two layers settling one save
  would race, and the visible symptom would be two resistance prompts for one counter.
- **The clock never picks Counterspell.** `timeoutChoice` refuses the `casting` trigger outright rather than
  leaving it to `depleting`, because that field is read off a sheet and a sheet can be wrong; a third-level
  slot spent by a timer is unforgivable and there is no free version of this spell anywhere.
- **In combat only, deliberately.** The reaction ledger is turn-stamped, so outside a fight there is nothing to
  stop one creature countering every spell in a scene. A rule that cannot count the resource it spends should
  not pretend to.
- **At most two creatures are asked** (`MAX_ASKED`). RAW there is no limit, and the counter-the-counterspell
  moment is one of the best in the game, but every ask costs the caster six seconds of staring at a button that
  did nothing. Stated in the announcement rather than hidden.
- **The cast is announced before anybody is asked.** Without it the caster's client does nothing for six
  seconds, which reads as the button being broken — and "X begins casting Y" is also the fiction the rule
  describes, so the honest fix and the good one are the same fix.
- **A window that cannot be opened lets the spell through.** Every failure path — unreadable vision, a thrown
  error, no replay wired — resumes or never holds. Losing a cast to our own bug is far worse than missing a
  counterspell.
- Diagnostics: `api.surveyCounterspell()`.

### Two known imperfections, stated rather than discovered later

- **The Counterspell card carries a Con save button nobody needs to press.** We roll that save ourselves so we
  can read it and offer a legendary resistance against it; dnd5e's save activity also renders its own enricher
  button. Pressing it produces a second, ignored roll. Gambit's has the same redundancy for the same reason
  (its `syntheticSave`), and removing ours would mean waiting on a human press, which is the automation being
  asked for.
- **A cast held and then abandoned at the level dialog has still been announced.** The veto fires before that
  dialog, so a player can press Fireball, be announced, wait, and then cancel. The Action was already lost in
  that case before this feature existed — `police()` charges at `preUseActivity`, ahead of the dialog — so what
  is new is the announcement rather than the cost.

### The legendary resistance, and the general lesson about automating around a pause

`rules/legendary.ts` + `system/dnd5e-legendary.ts`. **This is a regression the three features above would have
introduced, which is why it shipped with them rather than after them**, and the shape generalises well beyond
this rule: **automation that closes a window the system left open is a bug however correct each of its pieces
is.** Nothing in the damage or save layers was wrong; together they deleted a pause somebody was using.

dnd5e models this mechanic almost completely and — unusually for the findings in this file — even draws the
button. `resources.legres` is a real NPC schema field with `max` and `spent` (`data/actor/npc.mjs:113`, value
derived at `:446`, both refilled on a long rest at `:477`); `NPCData#resistSave` (`:557-563`) spends one and
stamps the save; and `_enrichSaveTooltip` (`documents/chat-message.mjs:637-670`) renders **Resist** on any
failed NPC save where one remains and the reader owns the creature. What it waits for is a human. That was
harmless while a human was also applying the damage by hand, because the same pause served both.

- **`forceSuccess` is read by the RENDERER and by nothing else.** `BasicRoll#isSuccess` is still the
 arithmetic against the DC, so a layer that asks the roll whether it succeeded is blind to a resistance a GM
 spent by hand — and would apply full damage on the one roll of the evening they had intervened in, beside a
 card reading "Resisted". `readSave` reads the flag, and reads it as authoritative even when the DC is
 unreadable, because somebody paid for that success explicitly.
- **A resistance pressed by hand arrives as an `updateChatMessage`, not a new message.** The button stamps the
 existing save. Hence the second hook in `registerSaveResolution`, narrowly gated on the flag.
- **The offer has to be RARE to be read.** A prompt on every failed save teaches a GM to dismiss prompts, and
 then the one that mattered is dismissed too. `worthAsking()` is the judgement and is exported precisely
 because it is a judgement: a fifth of what the creature has left, or anything lethal, or any failure whose
 consequence is not damage at all. That last case is the important one and is why `Activation.deals` exists —
 a Banishment has no damage roll coming, so waiting for one to price the stake would mean never asking about
 the failures a legendary creature actually spends resistances on.
- **`onSave: "full"` is priced as UNKNOWN, not as zero.** A save that changes nothing about the damage does not
 make the resistance pointless; it makes its value unreadable, because whatever else the failure inflicts is
 prose on the item. Scoring it zero would have silently never asked.
- **The default is to decline**, which is the prompt layer's one rule (a timeout may spend a renewing resource
 and never a depleting one) applied to the most depleting resource in the game. It is also what already
 happens on every table where nobody notices the button.
- **The window is the same shape as the shield window and for the same reason**: `Activation.asking` is
 registered before anybody is asked and `settle` awaits it, so an answer cannot arrive after the damage has
 landed. `offered` is set *before* the await, which is what makes a re-entrant `settle` raise one dialog
 rather than two.
- Asked locally on the primary GM rather than routed through `askUser`, because `active()` already restricts
 this layer to that client and legendary creatures are GM-run by definition. If a player-owned legendary
 creature ever matters, route it the way `offer.ts` does.
- Not split by audience, deliberately: `legres` is on the NPC data model, so a PC column could never fire and
 a setting with an inert half reads as a broken setting.

### The resource inventory, measured rather than assumed (2026-08-14)

Item 2 of the brief listed twelve resources. Checked against dnd5e 5.3.3 source, most of them are the system's
and already work; **do not build any of these without checking what it already spends.**

- **The system's, and working:** ammunition (consumed on the attack roll itself, `documents/activity/attack.mjs:210`,
 with the consumed item's data stashed on the message so a miss can put it back), spell slots and every other
 `consumption` target, per-day / per-short-rest / per-long-rest uses via `uses.recovery`, and **legendary
 actions** — `resources.legact` is the one pool `activityActivationTypes` declares a `consume` for, and
 `NPCData#recoverCombatUses` (`:544-549`) zeroes `spent` at the end of the creature's turn or the start of the
 encounter.
- **Ours, and built:** actions, bonus actions, reactions, movement, Dash, the light-weapon swing
 (`rules/economy/`), and now legendary resistances.
- **Ours, default automatic, and we still do not write dnd5e's setting (v0.7.15).** Recharge is
 `combat.autoRecharge` (`no` | `silent` | `yes`), default **`silent`**, on the Combat page under
 Rolling and reporting. The die is the system's (`UsesField.rollRecharge`); we call it from
 `dnd5e.postCombatRecovery` when the periods include `turnStart`, NPCs only, matching
 `activities.mjs:334`. When `dnd5e.autoRecharge` is already `yes` or `silent` we stand aside —
 two d6s on a failure would let the second succeed. An unreadable system setting stands aside
 too, for the same reason. The advisory now fires only when **both** switches are off. A spent
 recharge feature is still not offered as a turn option; once the die succeeds the planner sees
 it again. Diagnostics: `api.surveyRecharge()`.
- **Corrected the same day:** this note originally said `noteRest()` needed no callers "while the system owns
 rests", which confused two different ledgers and left compiled per-day uses permanently spent. It is wired
 to `dnd5e.restCompleted` now — see the rest-scoped-use note under the wired-triggers section.

## The Ready action, and the first rule whose trigger is written at the table (v0.5.0, 2026-08-14)

`rules/ready.ts`, `rules/ready-events.ts`, `system/dnd5e-ready.ts`, `integration/watch.ts`. The user's own
framing is the specification: every module that has attempted this offered a dropdown of half a dozen canned
conditions, and **the reason nobody used it is that the interesting readied actions are exactly the ones the
dropdown does not contain.** "If the Cutpurse flees, I Dash after them" is not a distance and not a status; it
is a reading of what a movement meant. So the trigger is a SENTENCE, 140 characters, in the player's own words,
and the module that reads sentences reads it.

**This is the same trade `noodlrHooks.compile` makes, arriving from the other direction.** There the rules
module knows the game and noodlr holds the key; here the rules module knows what happened and noodlr reads what
it meant. `integration/watch.ts` is the contract: protocol 1, two verbs (`compile` a sentence into a
descriptor, `judge` one event against it), the vocabulary on the request, `validateWatch()` as the gate.
**Nothing in it knows D&D** — the events are Foundry's, the sides are dispositions — for the same reason
`src/capability/` does not, and a `noodlr-hooks-pf2e` would reuse it unchanged.

- **The economy is the half people get wrong, and getting it right fixed a bug that was already here.**
 Readying costs the ACTION on your own turn at declaration; releasing costs the REACTION on somebody else's.
 Two slots in two turns for one effect, which is also why a readied Attack is ONE attack — Extra Attack says
 "when you take the Attack action on your turn", and a release is neither. Before this, a readied swing reached
 the ledger claiming an Action and was checked against the tally from *the turn the creature spent readying*,
 so the player was asked to confirm going over budget for something paid for a turn earlier. `clearNextUse()`
 in `enforce.ts` waves the release through and the Reaction is billed in `ready.ts` instead.
- **THE CLOCK IS ALLOWED TO FIRE IT, and this is the one place the prompt layer's rule bends.** That rule is
 that a timeout may spend a renewing resource and never a depleting one, and a readied Fireball is a spell
 slot. It fires anyway, because **the declaration IS the answer**: the player said in writing, on their own
 turn, that this is what they wanted to happen. Defaulting the other way would cost them the Action *and* the
 effect for being slow to click. Aborting is the deliberate act, and it loses the Action and nothing else —
 the user's wording.
- **Held spells diverge from RAW deliberately, in the generous direction.** RAW spends the slot at declaration
 and wastes it if concentration breaks. Foundry cannot represent that: `activity.use()` resolves the whole
 spell, so charging at declaration means placing Fireball's template a turn before it goes off, and there is
 no supported way to spend a slot without resolving the activity that spends it. So the slot is spent on
 release and a trigger that never comes costs the Action only. **Stated in the announcement**, because a
 divergence nobody is told about is a rules argument waiting to happen.
- **Expiry is the action ledger's trick and needs no cleanup.** The record carries the turn it belongs to and
 `live()` reads a stamp from another turn as absent, so every client computes the same answer with no write and
 no race. The sweep on `updateCombat` exists purely for legibility — a declaration that silently stops
 existing is indistinguishable from one that never fired, and **the player will report the second when they saw
 the first.** Out of combat there is no next turn to lose it at, so it stands until released, the scene
 changes, or a fight starts: `combatStart` clears every stampless record, because carrying one into initiative
 would hand its owner a free reaction before round one.
- **Detection is on the primary GM; release is routed to the owner.** The same split as damage and saves:
 notice centrally, act where the resources are. Without it every client independently decides a trigger fired
 and every client asks the owner about it — N dialogs for one goblin's step.
- **The event vocabulary is closed at the point where Foundry stops telling us things.** Each member of
 `WATCH_EVENTS` is something a hook we already listen to reports, so a compiled trigger is expressed in terms
 of things that will genuinely be noticed, and a sentence about something outside it compiles to no events and
 is **reported as unwatchable at declaration time** rather than silently never firing.
- **`narration` is the escape hatch and the reason the AI module earns its place.** "If I hear shouting ahead"
 has no mechanical signal whatsoever; the only thing at the table that knows it happened is whoever described
 it. So a GM's chat message — or an AI game master's narration — is an event, and it is the one event kind that
 is ALWAYS judged, because there is no predicate that can read prose.
- **Predicates first, judge second, human third, and that ordering is what makes it affordable.** A
 `judge: false` descriptor costs nothing at all. Where a clause cannot be EVALUATED it passes rather than
 fails, because a wrong fire is caught by the judge or the release prompt while a silent refusal is invisible.
 `JUDGE_BUDGET` (12 per declaration) stops a badly compiled trigger billing somebody for a session; running out
 falls through to asking the human, which is the same escalation an unanswered judge takes.
- **A null verdict is NOT a no.** An unanswered judge means nobody was listening, and reading that as "the
 trigger did not fire" costs the player their Action for nothing. It falls through to the release prompt.
- **The readied action is chosen FROM THE SHEET, not from a picker.** The sheet is the only thing that knows
 which of a creature's forty activities are prepared, in range and off cooldown; reproducing that judgement in
 a dropdown is how a picker ends up offering a spell nobody has prepared. So the Ready button is intercepted
 (`interceptReadyActivity`, the fifth member of the intercepted set — `test/economy.test.ts` asserts it) and
 **whatever the player presses next is captured and cancelled** (`captureReadied`, called from the very top of
 `police()`, before the rider and Incapacitated rules, because none of those are about to happen).
- **A bonus action pressed during capture is cancelled and refused rather than let through.** The player is
 picking, and letting it resolve for real would spend it for nothing.
- **The tier gate is the user's own pseudocode**, `(INT + WIS) / 2 > READY_MENTAL_MIN` with the constant at 5.
 Player characters are never gated. An unreadable sheet is ALLOWED, the same direction the planner errs in: a
 missing number should not turn a lich into a beetle.
- **The prose field is offered only when something is listening.** A field whose contents nothing can read is
 worse than no field, because the player writes a careful trigger and gets a shrug. Same doctrine as greying
 "Behavioral automation". With no listener the canned list is the whole feature and works.
- **Player clients do not call the model.** `requestWatchCompile` relays through `askGm` when the caller is not
 a GM (`registerWatchRelay`), and noodlr's own listener declines off the GM client — otherwise a player
 pressing Ready spends the world's credit from their own browser. `watchAvailable()` still answers correctly
 everywhere, because the hook is registered on every client.
- Diagnostics: `api.surveyReady()`.
- **Watch event/side/sense aliases live in noodlr's generated half (v0.7.9), filtered by the
  names this module sent** — the same shape as the v0.7.8 subject aliases on `noodlrHooks.compile`.
  Fusion asked this module to ship the rows; putting 5e `flee → creature_moves` text here would
  have meant a hooks release for prompt copy noodlr already filters. A vocabulary that omitted
  `creature_moves` must not be taught to write it. Schema and `WATCH_EVENTS` did not move.

### The planner chooses it too, at random, and random is only safe because of the pairing rule (v0.5.1)

The note here used to say the planner does not Ready and that teaching the utility scorer to value a
conditional future action was a separate problem. Half right: **scoring the CONDITION is the hard problem
and scoring the SHAPE is not.** "There is nothing in range and I have a bow" is a board fact the planner
already computes for `advance`, and it is the case where waiting is strictly better than walking — the turn
ends where it started and buys a shot as the enemy arrives, before the enemy has acted. So the strategic
judgement was never needed for the common case, and the user's own framing was the way in: pick at random
and let the pairing rule keep it sane. `src/tactics/ready-plan.ts`.

- **THE PAIRING RULE IS THE WHOLE THING.** A random choice reads as a bug the moment a scimitar is held for
 "an enemy comes into view", because the trigger fires ninety feet away and the held action cannot answer
 it. Melee waits for `reach`; ranged waits for `appears`, `near` or `casts`. Every workable pairing is
 built and **one** draw is taken from the lot, rather than drawing an action and then a trigger — two draws
 make the outcome depend on the order the sheet happens to be in. `test/ready.test.ts` asserts that every
 id `triggersFor` returns is a real canned trigger and that its `inReach` matches the weapon.
- **`leaves` is deliberately in neither list.** The opportunity-attack layer already answers a departure for
 free, so readying for one spends an Action to buy a reaction the creature had anyway.
- **`depleting` is excluded, and that is a rule rather than caution.** The release prompt fires on a
 six-second clock, so a dragon that readied its breath weapon spends it on the first goblin through the
 door. It is `util/prompt.ts`'s rule from the other end — a clock may spend a renewing resource and never a
 depleting one — and the asymmetry with a player is the point: a player readying a slot said so in writing,
 and a random choice has said nothing.
- **Its own random stream (`turnRandom(id, "ready")`).** Sharing the tactics stream would mean switching
 readying off shifts every subsequent number and silently changes what creatures *do*. Same reason banter
 has one.
- Scores, and each is a claim about the board rather than a tuning knob: **1.15** with nothing in range and
 something to shoot with (above `advance`); **0.7** with nothing in reach and only a blade (below
 `advance`, so it happens sometimes and reads as an ambusher when it does); **0.55** with a target already
 in reach, and only at `holdResources` (tier 7), whose own description is holding an action for a predicted
 opening. At tier 7's sharpness that is a couple of per cent.
- **`declareReadied()` is the entry point rather than the planner writing the flag**, because a declaration
 is a payment plus a write plus an announcement and a second copy of that sequence would eventually
 disagree about who is billed. It re-checks the gate and the budget rather than trusting the caller, for the
 same reason `offer.ts` re-resolves everything on arrival: by the time the turn executes the creature may
 have spent its Action elsewhere.
- **The declaration is whispered and the public line names nothing.** What a creature is waiting for is
 exactly what the party is meant to discover by walking into it. `commit`'s `Announce` parameter carries
 that (`public` | `gm` | `none`), and the expiry sweep whispers too for anything not player-owned — a
 monster's readied action coming to nothing is still GM information.
- **`execute.ts` reports no `used` for this plan**, deliberately: nothing resolves now, and reporting a
 swing would put a hit in the log that never happened. `MOVING_PLANS` excludes it, so the
 did-not-move check cannot flag a turn that was never meant to move.

### A LOW SCORE IS NOT A FLOOR AT HIGH NOISE (v0.6.1, 2026-08-14)

Reported as the Troll's severed limbs "sitting in place calling for help" instead of closing to melee. It
was a scoring bug, not a movement one, and the mechanism is the planner's central design working exactly
as documented in a place nobody had thought about.

`noise` is **0.85 at tier 1** precisely so that a stupid creature does not play optimally, and what noise
does is FLATTEN the distribution. So the call-for-help floor at 0.35 against advancing's 0.9 was close to
a coin flip, and a Troll Limb spent about half its turns bellowing for help beside the limb it was
standing next to. The comment above it said "rarely the best choice" while the arithmetic said otherwise —
the two had never been reconciled because the option had only ever been read at high tiers, where 0.35 is
genuinely unreachable.

- **The fix is not to lower the number.** Noise flattens whatever spread it is given, so *any score
  reachable by consideration is reachable by choice*. **An option that must never beat a real one has to
  be ABSENT, not cheap.** `advanceOptions` had this right from the start — it takes `hasBetter` and
  declines outright — and the floor now takes `hasAny` for the same reason.
- **The general form, worth applying before adding any new option: decide whether it competes on merit or
  is a fallback, and implement fallbacks by absence.** Fleeing deliberately keeps its score, because a
  badly hurt creature *should* sometimes run instead of swinging — noise is what makes that a temperament
  rather than a threshold. That is the distinction to test each new option against.
- **"Nothing in sight" stays offered on its own terms** (score 1.2), because that is the case the option
  exists for rather than a floor. Note `readBoard` does NOT filter enemies by perception, so an empty
  `board.enemies` means an empty tracker, not an unseen foe.
- `survivalOptions` is exported solely so `test/planner.test.ts` can pin this without a scene, the same
  precedent as `timeoutChoice`. `planTurn` needs canvas, a combat and a placed token; this needs neither.

### An advance that does not say how far is indistinguishable from standing still (v0.6.1)

The other half of the same report, and the same lesson as the heal that announced fifteen hit points at
full health: **a layer that reports what it INTENDED rather than what it DID reads as a broken layer.**
"Troll Limb advances on Rogwiz Ardue, still too far to strike" appeared three times in one fight and was
read as a creature sitting in place; it had in fact walked its full Speed each time and was being outrun
by a Dashing rogue. One number tells those two apart and nothing else does.

- `TRAVEL_ONLY` is the set of plans whose entire content is the movement, and `amend()` in `npc-turn.ts`
  rewrites the card with `performed.moved` once the move has resolved. `close` and `kite` are excluded
  when they land a use: the swing is the news. **A close that never reached is rewritten** — see
  below — because leaving "and attacks with Bite" on the card after a failed walk is a lie.
- **A close that cannot reach must not swing (Dire Wolves, 2026-08-19).** Reported as a 50-foot
  Bite. The sheet is `range.reach: 5` and the chat flavor says so. Both wolves announced
  "closes 33 ft … and attacks with Bite", `moveToward` threw then shortened to nothing (walls),
  and `performPlan` used the activity anyway. Attack cards had empty `targets`; auto-damage
  said nobody was targeted; nothing applied. `meleeReached` gates the use; the public card
  becomes "still too far to strike" / "covers no ground at all". Not a reach bug.
- **A thrown weapon's `range.value` is not its melee reach (Assassin, 2026-08-20).** Lycan Spear
  is `reach: 5`, `value: 20`, `long: 60`, `thr`. One Attack activity, `attack.type: melee`. Reading
  `value` as the close distance made `meleeReached(20, 20)` true after a 30 ft walk, then used the
  melee activity from 20 ft. Attack and damage cards posted with empty `targets` — the same empty
  list the Dire Wolves had, for the opposite reason: they never arrived, this one arrived at the
  thrown range and stabbed. Melee now reads `reach` only; `thr` emits a second offering that rolls
  with `attackMode: "thrown"`. KeepDistance already prefers that throw over a close.
- **Arcane Burst is melee *or* ranged with no Thrown property (Archmage, 2026-08-20).**
  `range.reach: 5`, `range.value: 150`, `properties: []`. After the spear fix, melee
  read `reach` only and no second offering was emitted, so a 150 ft cantrip became a
  5 ft poke and the planner hid instead. `innateRangedOf` emits `Name (Ranged)` /
  `attackMode: "ranged"` when `value > reach` and there is no `thr`. Hide is not
  offered when a ranged attack already reaches the nearest player.
- **`rollAttack` reads `game.user.targets`, not the name on the card (Archmage, 2026-08-20).**
  Three Arcane Burst cards named nobody while the announcement named Barb Arian.
  `withTarget` now `setTarget`s as well as `updateTokenTargets`, and `finishActivity`
  writes `flags.dnd5e.targets` onto the attack message so the card does not depend on
  the live Set. `tokenIdOf` is the single read of a BoardActor / Token / document.
- **Amended rather than followed by a second message**, because announcing first is deliberate (narration
  has to read ahead of the dice) and a separate "it moved 30 ft" line would double the log for every
  advance. A failed edit leaves a card that is merely vague, so it is logged and nothing else.
- Appended as a trailing clause rather than spliced in: these plans produce differently-shaped sentences,
  and a regex that has to find the right clause in each is one more thing to break when a phrasing changes.
- `noteDossierEvent` records the settled text, not the speculative one.
- **This does not close the open melee-movement item below.** One of the five advances in that log reported
  a genuine refusal ("the token would not move"), which is still undiagnosed; what changed is that a
  refusal is now distinguishable from a creature being outpaced, which it was not before.

## Silvery Barbs, and what changed to make the third answer yes (v0.5.0, 2026-08-14)

`rules/barbs.ts`, `system/dnd5e-barbs.ts`, `system/dnd5e-reroll.ts`. Refused twice, and **both refusals named
the same missing thing**: it needs a d20 we did not roll to be taken back after the fact, and an offer that
cannot be honoured spends a slot and changes nothing. Neither half is missing any more, and **neither was
built for this spell** — which is the argument for having built the boring infrastructure first.

1. **The verdict is held.** `readHits` answers "did that connect" and `readSave` answers "did that save", and
 both answers are now held open through a window while somebody is asked about a reaction. A reaction that
 changes a verdict needs somewhere to stand between the roll and its consequences; the Shield window and the
 legendary-resistance window are exactly that.
2. **The die can be made worse honestly.** `dnd5e-reroll.ts` appends a second result and strikes out the loser,
 which is **the shape dnd5e already draws for disadvantage** — so a reader recognises it without being taught
 anything, and every downstream reading comes right for free. `D20Roll#isCritical` asks the DIE's total, which
 sums its ACTIVE results, so discarding a 19 in favour of a 3 stops the roll being a critical with nothing
 here saying so.

- **Patched through `toJSON`, never on the live roll.** `Roll#total` is a cached `_total` recomputed only by
 evaluation, and re-evaluating an evaluated roll is not a supported operation — it would either throw or reroll
 every die in the formula including the ones nobody touched. `toJSON` carries `total` and `evaluated` and
 `fromData` restores both. `active` is the only field that has to be exactly right; the rest is presentation.
- **The loser is marked `discarded`, not deleted**, and anything already struck out stays struck out. A
 struck-through 19 beside a live 3 says what happened; a bare 3 says a wizard rolled badly.
- **Crit thresholds are read off the die's own options, not assumed to be 20 and 1.** A Champion crits on 19.
 A non-numeric threshold is `null`, which is what `D20Die` reads as "this roll has no critical", and that must
 stay distinguishable from "did not reach it".
- **A failed message update is a logged line, not an abandoned reaction.** The arithmetic is still right and
 the caller can still act on it; what is lost is the card telling the truth. The slot has already been spent by
 then.
- **`MAX_ASKED` is 1, tighter than Counterspell's 2.** Barbs fires on every hit and every made save, the
 busiest pair of events in a fight, and unlike a counter-the-counterspell chain there is nothing a second ask
 could win: the die has been rerolled and RAW a second Barbs on the same test does nothing.
- **`victim` is for keying the guard and is NOT the creature the spell is aimed at.** That is `roller`, and
 pointing Barbs at the victim is the natural mistake here — it would offer the reaction to the attacker's own
 allies, who have no interest in spoiling their side's hit.
- **Two of the three d20 tests, said out loud.** Attack rolls and saves are offered; ability checks are not,
 because nothing here holds a check's verdict open — a check produces information a GM interprets, with no
 pending consequence for a window to stand in front of. A player whose Barbs never fires on a Stealth check is
 owed the reason.
- **The reroll is automated; the Advantage half is not.** "One creature you can see gains Advantage on its next
 attack roll, ability check, or saving throw" is a promise about a roll nobody has made, which is the same
 thing that keeps the Help action unbuilt. Where the table's copy of the spell carries an Active Effect for it,
 the ordinary activity pipeline applies it exactly as the sheet says.
- **In combat only, and the reaction ledger is why**, exactly as with Counterspell. Outside a fight nothing
 stops one creature spoiling every roll in a scene, and a rule that cannot count the resource it spends should
 not pretend to.
- **Two orderings, and both are rules interactions rather than preferences.** In the damage window Barbs is
 offered before Shield, because Barbs attacks the die and Shield attacks the number: a spoiled roll may miss
 everything, and asking for a slot to raise an AC against an attack that is about to vanish is a slot wasted.
 In the save pass successes are spoiled before failures are resisted, because **the two sets are disjoint at
 any instant but not across the pass** — a save spoiled by Barbs becomes a failure, and a legendary creature is
 then entitled to buy it back. Asking about resistances first would deny it that silently, on exactly the
 creatures where the interaction comes up.
- **A bought success is not spoilable.** A legendary resistance says the creature succeeds full stop, so the
 die is no longer what decided it and rerolling would spend a slot to change a number nobody reads.
- **The verdict is RE-READ after a reroll, never inferred from the reroll's own arithmetic.** The card has been
 rewritten, so `readHits`/`readSave` are the authority on what it now says — the same discipline the damage
 layer already uses, and the thing that keeps one answer to "did that connect".
- **Stands aside for Gambit's Premades, and only when midi is also active** (`gambitsOwnsBarbs`), because
 Gambit's implementation is carried by midi and does nothing without it. Same shape and same reasoning as the
 Counterspell stand-aside.
- `dnd5e-spells.ts` holds `spendsSlot` and `slotAvailable`, and `rules/candidates.ts` holds `reactorsAgainst` —
 both extracted from Counterspell rather than copied, because two implementations of "who could react to this"
 is the divergence the v0.4.1 vision bug was about.
- Diagnostics: `api.surveyBarbs()`.

## What the finished corpus caught (v0.4.0, 2026-08-13)

The first complete `noodlr-rules-corpus` run — 77,039 atoms over nine books — was read against this
module rather than filed. Four rules here were **wrong**, three were **absent**, and every one was
verified against the source before being believed; the corpus names a suspicion, it does not diagnose.
None of the seven was ever reported from a table, which is the argument for doing this again after the
next book: a rule that silently refuses a legal action is invisible until somebody argues about it.

**Read the atoms, never the counts.** Two of the seven leads dissolved on inspection — the same trap
the corpus repo records for `coverage.json` — and the four that survived did so because the atom said
something the code demonstrably did not do.

### Four that were wrong

- **`system/dnd5e-jump.ts` — a jump had no modifiers at all.** `jumpDistances` read Strength and
  nothing else, so every jump-altering effect in the game produced a **false refusal**, which is the
  failure mode this module tries hardest to avoid. Four shapes exist and all four are now read:
  a fixed distance stated in prose ("its Long Jump is up to 25 feet"), an ability substitution
  (Second-Story Work jumps off Dexterity), a multiplier (Jump, Step of the Wind), and the "with or
  without a running start" clause, which needs no arithmetic and fixes the commonest case on its own.
  - **A stated distance stands alone.** A creature whose ability scores are unreadable but whose trait
    states a distance gets a number; only nothing-readable is `unreadable`. Gating on the score would
    have thrown away the one thing the prose was explicit about.
  - **Halving happens before the bonus and the multiplier.** Step of the Wind doubles the jump being
    made, not the score it derives from, and the order is the difference between 20 and 25 feet.
  - `movement.jump` is still never read as either distance — see the older jump note above.
- **`system/dnd5e-reactions.ts` — Flyby exempted nothing.** "Doesn't provoke Opportunity Attacks when
  it flies out of an enemy's reach" was prose nobody read. Table-matched by identifier then name, like
  every other system table here. **A creature-level exemption is checked in `provoke()`, not at the
  Disengage mark**, because it is a permanent property rather than a spent action — putting it beside
  Disengage would have made it clearable.
- **Thirsting Blade grants Extra Attack as an INVOCATION**, so it carries no `extra-attack` identifier
  and a Pact of the Blade warlock read as having one attack, with the second swing refused as over
  budget. Devouring Blade is checked **first**, because it requires Thirsting Blade and a level 12
  warlock carries both — first match wins, so the order is the answer. The pact-weapon restriction is
  deliberately unmodelled: a warlock swinging a longbow twice is a worse turn, a refused legal attack
  is a bug report.
- **`system/dnd5e-two-weapon.ts` — the Light property was uncounted.** `Tally.light` is separate from
  `attack` on purpose: the off-hand swing is not bought by the Attack action, so folding it in charges
  it against a budget it does not draw on, and leaving it out entirely makes the Nick case unlimited.
  **Free and unlimited are not the same thing** — Nick costs nothing and is still once per turn, which
  is why `takeLightSwing` takes a nullable slot and always increments the counter.

### Three that were absent

- **`rules/repeat-save.ts` — an effect that ends on a save now gets one**, at the end of each of the
  afflicted creature's turns. 408 atoms say "repeats the saving throw", `end_effect` is the fourth
  largest effect kind at 4,008, and nothing in the world was doing it.
  - **State lives on the afflicted creature, and the watcher is a separate `updateCombat` listener on
    every client.** The capability executor is GM-gated and fires on the creature whose descriptor
    produced the effect; the save belongs to whoever is being poisoned, on a turn that may be nowhere
    near the caster's.
  - **Stands aside per-effect for midi's `OverTime` flag**, not per-module. A world may run midi with
    one imported item carrying its own timer and forty that do not; standing aside wholesale would
    switch the rule off for the forty.
  - **A status removed by anything else clears the pending save.** The effect is the state, exactly as
    with hiding — a pending save for a condition nobody has is a dialog with no cause.
- **`rules/unseen.ts` — unseen attacker, unseen target, and shooting beside an enemy.** Advantage,
  Disadvantage, Disadvantage. Visibility is answered per-creature through `rules/stealth.ts`'s
  `evades()` plus Blinded and a line-of-sight test, never through `token.isVisible`, for the reason the
  perception note above gives at length.
  - **`visibilityAttackRulesOwned()` and `rangedNearbyFoeOwned()` are separate predicates** because
    AC5e and midi own these two rules through *different* settings and either may be on alone. AC5e's
    `autoRangeChecks` is a Set in some versions and an Array in others, so it is probed both ways and
    an unreadable setting means "I could not tell", i.e. keep enforcing — same rule as `util/modules.ts`.
- **`capability/standing.ts` — the compiler's read side.** 27,425 of 77,039 atoms are
  `trigger.event: "always"` (35.6%, second only to `on_activity_use`), and `always` is not in
  `WIRED_TRIGGERS` and never will be, because there is no hook for "this is permanently true". Correct,
  and it made the capability sheet badge a third of everything the operator paid for as **inert** —
  which reads as the compiler having wasted the money rather than as the executor asking the wrong
  question. A standing property is a FACT, and facts are queried.
  - **`STANDING_EFFECTS` lives beside `WIRED_TRIGGERS` in `integration/capability.ts`**, so the sheet's
    badge and the query layer's answer come from one list. `other` is excluded despite being the
    largest `always` bucket (10,059) — it is by definition unreadable — as are `restrict_action` and
    `require_prerequisite`, which are guards on something else rather than properties.
  - **A grant is consumed at the point of use and never written to the actor.** An Active Effect
    written from a descriptor would double whatever the sheet already states: dnd5e applies
    `system.traits.dr` itself, so a compiled resistance that also wrote one halves the damage twice.
  - **The sheet wins where it speaks.** `sheetSenses` fills gaps from compiled senses rather than
    merging, so a stated Darkvision 60 is not overwritten by a model reading "sees in the dark".
  - **The fail-closed rule bites harder here than in the executor.** A guard on an `always` rule is the
    qualifier that makes it true ("while raging", "against nonmagical damage"), so an unevaluable guard
    means the grant might be false right now: it is returned `active: false` with a reason, which puts
    it on the sheet as needing a human instead of into the accessors as a fact.
  - Diagnostic: `api.surveyStanding()`.

### Two leads that dissolved, recorded so nobody re-opens them

- **`grant_capability` (2,356 `always` atoms) is not a build queue.** It is where the corpus put every
  true statement about a creature that nobody has wired — "breathes water", "cannot be surprised". It
  is exposed as free text for the survey and for noodlr's prompt, and wiring one means picking a phrase
  and owning the match, which is a decision per capability rather than a feature.
- **`on_activity_use` at 29,974 is not a gap**, it is the corpus describing what an activity does when
  used, which is the system's own job. The trigger being the largest bucket says nothing about coverage.

## What the first play test of automatic damage found (v0.6.0, 2026-08-14)

A Rogue against one Troll, and three bugs in ninety seconds. Two are one lesson twice: **a layer that
reports what it INTENDED rather than what it DID is indistinguishable from a broken layer**, and both
were reported as runaway behaviour rather than as wrong wording.

- **`healActor` returns the DELTA now, not a boolean, and the executor reports that.** Regeneration
 announced "regains 15 hit points" every turn including at full health, which the user read — entirely
 reasonably — as a creature accumulating hit points without limit. The clamp was never wrong: healing
 has always gone through `applyDamage` with `type: "healing"` precisely so dnd5e's ceiling, hook and
 dying layer all apply. What was wrong was announcing the request. A heal that restores **0 is not a
 firing**: `applyEffect` returns `ok: false`, so no chat line is posted and — because `spendUse` runs
 only after `ran.ok` — no limited use is spent on a heal that could not land. An unreadable hit-point
 pool still answers with the requested amount, since there is nothing better and `hasHitPoints` already
 screens that case out everywhere it matters.
- **A COMPILED RULE MAY NOT KILL.** The Troll announced "Troll is dead" mid-fight from an
 `on_turn_start → apply_status dead` rule: its stat block says it dies *only if* it ends its turn at 0
 hit points having taken fire or acid, and the compiler read the restriction as the instruction.
 Whether that particular wording is repairable is beside the point — **removing a creature from play is
 the one outcome nobody can argue with after the fact**, `rules/dying.ts` already owns it, and a
 descriptor should never be able to reach it. `RESERVED_STATUSES` + `isTerminal()` in
 `integration/capability.ts` make such a rule *valid but inert*: it still validates (the model is
 allowed to have read that sentence), `isExecutable` refuses it so the capability sheet badges it as
 needing a human, and `runRule` checks `isTerminal` **before** `isExecutable` so the refusal names the
 real reason instead of the generic one. Same doctrine as the fail-closed rule for `other` and `custom`,
 applied to an effect that is expressible rather than one that is not.
- **A CLEAN MISS IS A VERDICT.** `remember()` in `rules/damage.ts` discarded any reading with no hits
 and no unresolved targets, so an attack that rolled 14 against AC 15 left nothing filed and the damage
 roll that followed reported "no attack roll was recorded for it" and handed over the Apply button —
 for an attack that demonstrably did not land. Players roll damage after a miss every round, so this
 fired constantly. Every reading is filed now and `resolveTargets` draws all three distinctions: no
 verdict at all (`NoAttack`), a verdict about nobody (`NoTargets`, an attack that named no target), and
 a verdict that resolved to no hits (silent, nothing to apply — the branch that already existed and was
 unreachable). **The general form: "we have no answer" and "the answer is no" must never share a code
 path**, and an early return that conflates them will always surface as the wrong message rather than as
 a crash.
- Untested, and stated rather than discovered later: `remember`/`resolveTargets` have no harness, because
 `consider()` needs most of the Foundry globals. The `cards.ts` half is pinned; the filing is not.

### The same fight's second half: the Troll that would not stop (v0.6.0)

The dead Troll then summoned a limb a round for the rest of the encounter, the limbs died of their own
Regeneration, and the population passed the sheet's four per day by a wide margin. Four separate faults,
and **only one of them was the compiler being wrong** — the other three were guards this module should
have had whatever the compiler produced, which is the reason they were fixed here rather than reported
upstream to a prompt.

- **A CREATURE THAT IS OUT OF THE FIGHT DOES NOT RUN ITS STAT BLOCK.** `POSTHUMOUS` in `executor.ts` is
 the exemption list and it holds exactly `on_damage_taken` and `on_zero_hp`, because those two are
 *about* being at zero and cannot be gated on not having dropped. Everything else stops. Regeneration
 survived this on its own because it carries an `hp_at_least` guard; Loathsome Limbs carried nothing,
 and nothing in the schema requires it to. **Read `isDefeated`, not hit points alone**: the status is
 the dying layer's marker and a GM can lift it, whereas a hit-point test alone would keep a creature
 running that everyone at the table has agreed is finished.
- **A SUMMONED CREATURE MAY NOT SUMMON, and this is the one that actually closes the loop.** Measured
 rather than reasoned: `actors24/giant/troll-limb.yml` carries **Troll Spawn**, whose profile is
 `Compendium.dnd5e.actors24.Actor.mmTroll000000000` — the limb turns into a whole Troll, which has
 Loathsome Limbs. The real rule is "if the limb isn't destroyed within 24 hours, roll 1d12; on a 12",
 with `activation.type: ''` and `uses.max: ''`, i.e. not independently usable and unlimited. A compiler
 has nothing to hang that on but a turn, and once it fires per turn the population is exponential.
 **No allowance can fix it**, which is the important part: `uses` is per-actor and every new Troll gets
 a fresh ledger, so a correct 4/day on both rules still diverges. Refusing the second link is the only
 guard that holds, it costs nothing a GM cannot do by hand, and it is the same fail-closed doctrine as
 `RESERVED_STATUSES` — the one effect whose output becomes another input gets the strictest treatment.
- **`MAX_STANDING` (8) is the runaway brake**, in the same spirit as `RUNAWAY_LIMIT` in the turn hooks
 and for the same reason: a miscompiled allowance should fill a corner rather than the map.
 - **It could never have fired before, and the reason is a two-implementations bug.**
 `summonCreature` stamped the summoner's **token** uuid and the executor counted with its **actor**
 uuid, which for an unlinked token is a longer string *containing* the first — so nothing ever
 matched, every standing count read zero, and the count in the chat line was silently always absent.
 `summonerKey()` is now the single answer used by both sides, which is the v0.4.1 vision lesson
 arriving in a third place: **one question, one implementation.**
- **AN EMPTY POOL IS A REFUSAL, NOT A SPEND OF NOTHING.** `adjustUses` clamps, so a 4/day item at zero
 went on returning "0 left" with `ok: true` forever. That matters because a descriptor may split an
 ability into a `spend_resource` rule and a separate effect rule, and then that success is the only
 thing between the sheet's allowance and an unlimited one. Same shape as the heal that restored nothing
 and announced fifteen, and worth stating as the general form: **a primitive that clamps must report
 the clamp, because its caller is deciding whether the rule fired.**
- **The compiled Loathsome Limbs fired with neither of its guards and no exhaustion, and it WAS fixable
  here — the cause was in our own prose extraction (v0.6.1).** The older note in this place said the
  descriptor had to be repaired one creature at a time on the capability sheet, which was wrong and cost a
  release. dnd5e's 2024 stat blocks put authoring asides in `<section class="secret">` (core's own
  convention, stripped for players by `enrichHTML`), and the Troll's says: *"Foundry Note: The Exhaustion
  levels from missing limbs must be applied manually."* **A model reading that has been told in plain
  English not to emit the effect the rule states**, and it obliged — so the descriptor came back with no
  exhaustion at all and, having been steered off the clause, no condition either. `src/capability/prose.ts`
  is the scrubber, called before the hash, so editing or removing a note correctly invalidates the cache
  entry. Do NOT re-add a local `plainText` to `collect.ts`: two implementations of "what did we send"
  would differ, and a cache keyed on one of them is keyed on nothing.
  - **The transferable rule: prose about the SOFTWARE must never reach the compiler.** That is the whole
    predicate, and it is narrower than "notes addressed to a human" — see the census below for why the
    wider version deletes rules.
  - **And the lesson about the note itself: "the compiler read it wrong, repair it on the sheet" is a dead
    end that should be the LAST conclusion, not the first.** Check what was actually sent before blaming
    what came back. Requires a recompile of any creature compiled before this release.

#### The scrubber, and the two mistakes measured out of it (v0.6.1)

`scripts/census-meta-notes.mjs` (`npm run census:notes`) runs the real predicate over dnd5e 5.3.3's
`packs/_source`: **31,845 descriptions, 848 hidden sections (793 notes, 55 rules), 5 descriptions with
tooling prose in the open (2 distinct sentences, both true positives).** It exists because both of the
obvious designs are wrong in a way that is invisible without a corpus, and both were live for a while.

- **793 of 848 hidden sections open with the literal words "Foundry Note", and that is ONE distinct
  opening across the entire corpus.** dnd5e's content team is completely consistent about this, which is
  what makes the structural half of the scrubber cheap and reliable. It is also the answer to "where did
  that Troll instruction come from": it is authored, upstream, in the system's own compendium.
- **Stripping every `<section class="secret">` deletes rules.** The first version did, and it is the
  reading the section's own name invites. **55 of the 848 are game text** rather than asides — every
  monster-feature description that uses `[[lookup @name]]` templating, the cursed-item clauses on
  Berserker Axe and Demon Armor, Aberrant Ground's difficult terrain, Intoxicating Touch's whole attack
  line, Tentacle Disease's progression, Sneak Attack's "Once per turn." Not small per creature: for
  several of those it is the whole of what the ability does. `isMetaAside()` therefore decides per
  section, and a hidden section holding rules is kept and compiled like any other prose.
- **`compendium` cannot be a tooling word.** It was, and it matched `@UUID[Compendium.dnd5e...]`
  enrichers — which appear in ordinary rule sentences — so the scrubber was classifying legitimate
  hidden sections as notes and dropping them whole. The census is what found it, in the "kept" column,
  and it is the reason that column is printed in full rather than merely counted: **a scrubber can only
  be checked by looking at what it spared.** Re-read the kept list by hand after any change to `TOOLING`.
- **THE CENSUS ITSELF WAS WRONG BY A FACTOR OF 25, AND IT REPORTED A REASSURING NUMBER RATHER THAN AN
  ERROR (found 2026-08-15).** Its first two runs said 34 hidden sections and zero open-prose hits; the
  truth is 848 and five. Two file-format faults in the extractor, neither of which touches the shipped
  scrubber — by the time `prose.ts` runs, Foundry has parsed the YAML and the description is one clean
  string — so both were the instrument measuring a file format instead of the thing that ships.
  - **CRLF, and `.` does not match `\r` in JavaScript.** `\r` is a line terminator alongside `\n`, so a
    folded-scalar continuation of `(?:\1\s+.*\n?)+` matched exactly ONE line and stopped. Every
    multi-line description — which is nearly all of them, and every single one carrying a hidden
    section — was truncated to its opening clause. The fix is to normalise line endings before
    matching, rather than sprinkling `\r?` through the pattern and leaving the next author the trap.
  - **A folded scalar (`>`) joins with spaces, a literal one (`|`) keeps its newlines.** Leaving the
    newlines in split sentences mid-clause, so the open-prose hits first appeared as fragments ending
    in "and" — which is what exposed the bug, because a scrubber cannot produce a fragment.
  - **The transferable rule: a census that reads a file format is a census of the file format.** This
    one bundles the real `prose.ts` precisely so it cannot certify its own copy of the predicate, and
    it still certified nothing for two runs because the *input* was wrong. When a corpus measurement
    comes back suspiciously clean, cross-check the raw count with `rg` before believing it — `rg -l
    "Foundry Note"` over the same tree returns 200+ files, against the 34 the census claimed, and that
    one-line comparison is what should have been run first.
- **Two known false NEGATIVES in the kept list, both harmless and both left alone.**
  `items/poison/potion-of-poison.yml` says "you can use these enrichers ([[/damage 2d6 poison]]…) to
  perform the damage roll", and Deflect Energy's "The Reduce activity can be used to heal yourself".
  Both are tooling prose that the vocabulary misses. Neither instructs the reader NOT to do something,
  which is what made the Troll's note destructive, so neither can suppress an effect. Adding `enricher`
  to `TOOLING` would catch the first with no false-positive risk; `activity` would catch the second and
  is too common a word to be safe.
- **The predicate is Foundry's own vocabulary, not the shape of the sentence.** "Manually", "Active
  Effect", "the effects tab", "macro", "midi-qol", "DAE". Not "the DM decides", not "at the GM's
  discretion" — those are *rules* text, they are all over the books, and a wide predicate would eat the
  clause it appears in. Ordinary game words that read like tooling are pinned by tests: "dragged 10
  feet", "Feather **Token**", "**automatically** fails", "**enchantment**".
- **In the open, a hit is removed sentence-by-sentence and REPORTED by ability name** (`Feature.removed`
  → `CollectReport.scrubbed` → a `warn`, and the `removed` column of `api.surveyScene()`). Zero of these
  exist in dnd5e, so any occurrence is an imported or homebrew sheet and the GM is the only one who can
  judge whether the sentence mattered. Inside a hidden section it is silent, because a note there is
  expected — reporting the expected case is how a report becomes noise.
- **Whole section in, whole section out.** A hidden aside is one authored unit ("Foundry Note" as a
  heading, then the instruction), and taking out only the sentence with the trigger word leaves the
  heading and any follow-on behind — which reads to a model exactly like the note it came from.

### A capability's rules are not independent, and the fifth limb proved it (v0.6.1)

Reported as the Troll exceeding its own 4/day. v0.6.0's "an empty pool is a refusal, not a spend of
nothing" was correct and changed nothing at the table, because **the allowance and the effect were
separate rules** — `uses` is per-rule, so the summon rule beside the spend rule had no allowance of its
own to run out. The spend reported "no uses left" and the limb appeared next to it.

- **If it cannot be paid for, none of it happens.** `spend_resource` rules run FIRST within a capability,
  whatever order the descriptor listed them in (a stable sort, so everything else keeps its order), and a
  failed spend marks the rest of that capability unpaid rather than letting it fire.
- **Deliberately narrow: only a failed SPEND stops its siblings.** Other failures are ambiguous — a status
  that was already present must not stop the damage that accompanies it — whereas a failed spend is
  unambiguously "cannot pay".
- **`MAX_STANDING` could never have fired, and it was a two-implementations bug.** `summonCreature`
  stamped the summoner's **token** uuid and the executor counted with its **actor** uuid; for an unlinked
  token the second is a longer string *containing* the first, so nothing ever matched and every standing
  count read zero — including the one printed in the chat line. `summonerKey()` is the single answer both
  sides use now. Same lesson as the v0.4.1 vision bug: **one question, one implementation.**
- **A guard shaped like "refuse a recurring summon that has neither a condition nor a `uses` limit" was
  written, tested, and backed out — do not rebuild it.** It reads as reasonable and it takes over the job
  of two guards that already cover this from better angles: `MAX_STANDING` is the documented runaway brake
  *for exactly that shape*, and the summoned-may-not-summon rule is what actually breaks the exponential.
  Its only effect was to shadow both of their messages and to badge a legitimately-running rule as inert
  on the capability sheet. Three existing tests fail if it comes back, which is the intended warning.
- **Anything that is not a finite number in `effect.initiative` means "behind me".** `Number("after_summoner")`
  is NaN and NaN reached `createEmbeddedDocuments` as an explicit initiative, which Foundry rejects
  outright (`[Combatant5e] validation errors: initiative: must be a number`) — so the limb was never
  enlisted there and the perception sweep enlisted it later with a rolled initiative instead. Visible
  symptom: three console errors and a creature that should act immediately after its summoner turning up
  in a random slot. `insert_combatant` had the `Number.isFinite` guard all along; this branch never did,
  and `addCombatants` now refuses a non-finite one as well.

## The Damage button waits for a verdict (v0.6.0, 2026-08-14)

`rules/gate.ts`, `system/dnd5e-graze.ts`. Reported as an interface complaint — the cards are too tall
and too easy to misclick — and the second half of it is a rules problem wearing a UI costume. dnd5e
draws Attack and Damage side by side and leaves both live from the moment the card appears, because
**the system has no verdict to gate on**: it decides whether an attack hit inside the card's RENDERER
and stores the answer nowhere. So the two commonest mistakes at a table are the two the interface
invites, and neither was fixable before `readHits` existed. This is what that reading buys at the
other end, and it is the third feature in three releases to fall out of it (Shield, Silvery Barbs,
now this).

- **THE LOCK FAILS OPEN, AND THAT IS THE WHOLE SAFETY ARGUMENT.** A button that never unlocks is far
 worse than a player rolling damage on a miss: the first is indistinguishable from the module being
 broken and has no way out, the second is an ordinary table correction. Every uncertainty resolves to
 open — no active GM, an attack against nobody, an unresolvable target, a card older than `PATIENCE`,
 a GM who says so, or simply nobody answering in thirty seconds. **Never add a branch here that locks
 on "I do not know."**
- **`gateActive()` is composed entirely of WORLD settings and connected-user facts**, so a player's
 client reaches the same answer as the GM's without asking. That symmetry is what makes it safe to
 draw a lock on a client that cannot see the verdict machinery: where the machinery is not running,
 nothing is drawn. `game.users.activeGM` is the term people forget — the verdict is written by the
 primary GM, so with no GM connected every damage button in the log would be dead with no
 explanation.
- **The age test is what keeps the chat LOG usable.** A card with no flag is a fresh attack *and*
 every card in the world from before this feature existed. Without `stale()`, scrolling back and
 re-rolling damage from an old card would be impossible on every client at once. `relented` handles
 the same case live by forcing a re-render when the wait runs out; the age test handles it for cards
 nobody was watching when the clock ran.
- **AND WE DECORATE ONE PASS TOO EARLY, which is safe today by accident (found 2026-08-16).** All five
  of our chat decorators — `gate.ts:82`, `damage.ts:109`, `forced.ts:107`, `dying.ts:754`,
  `encounter.ts:75` — listen on core's `renderChatMessageHTML`, and `ChatMessage5e#renderHTML` fires
  that inside `super.renderHTML()` at `chat-message.mjs:119` **before** its own five passes at
  `:121-133` (`_displayChatActionButtons`, `_highlightCriticalSuccessFailure`, `_enrichChatCard`,
  `_collapseTrays`, `activateChatListeners`). Nothing breaks because `_displayChatActionButtons` only
  sets `button.hidden = true` (`:187-193`) and replaces no nodes, so our `disabled`, classes and
  capture-phase listener survive — **but that is dnd5e's current implementation, not a contract**, and
  a future pass that rebuilt `.card-buttons` would erase the lock and leave a button that looks
  pressable. **dnd5e fires its own `dnd5e.renderChatMessage` (`:142`) after all five passes and listens
  to no core chat hook**; that is the safer point and it is where dnd5e draws its own legendary-
 resistance button. Two consequences of the ordering, both invisible from our source: our Unlock
 button is appended before dnd5e's visibility loop iterates `.card-buttons button`, so it survives
 only because `isCreator` is true for a GM, and dnd5e hands our button to
 `getAssociatedActivity()?.shouldHideChatButton()`, a third-party method receiving an element it has
 never seen.
 - **THE ATTRIBUTE IS `data-visibility="all"`, NOT `"gm"` — corrected 2026-08-16, having recorded the
 wrong one the day before.** `_displayChatActionButtons` (`chat-message.mjs:187-193`) `continue`s
 out of the loop **only** for `"all"`; `"gm"` falls through into a single `||` chain, so it is still
 tested against `!isCreator` *and* still handed to `shouldHideChatButton`. Setting `"gm"` therefore
 buys nothing at all — it does not skip the `isCreator` dependency it was written here to remove.
 - **And `"all"` is safe on our button for a reason worth stating, because it looks unsafe.** It
 means "show this to everyone", which is the opposite of the Unlock button's intent — but
 `offerOverride` is called only under `game.user?.isGM` (`gate.ts:226`), so the element is never
 appended on a player's client in the first place. **Gating at creation is stronger than gating at
 render**, and it is what makes the permissive attribute correct here. A button added
 unconditionally must NOT take `"all"`.
- **THE HARD HALF IS THE VETO, not the `disabled` attribute.** Disabling a button stops a mouse; it
  does not stop a macro, a keybind, or a client whose render ran before the flag arrived.
 `dnd5e.preRollDamage` is the refusal with teeth and it is registered on **every** client, because the
 client that must be stopped is the one whose mouse is on the button. Both `dnd5e.preRollDamage` and
 `...V2` fire for the same roll (`basic-roll.mjs:101-104`), so listen to exactly one — the
 `rollSkill`/`rollSkillV2` trap again.
- **The card is identified from `config.event`, which is the same reading dnd5e itself uses** to stamp
 `originatingMessage` (`BasicRoll.buildPost`, `basic-roll.mjs:173`). A damage roll with no event came
 from a macro, a sheet or our own graze and has no gate to check, so it passes. Guessing at an
 attribution would refuse legitimate rolls with no way for anybody to see why.
- **The verdict is filed AFTER the reaction window, not after the attack roll.** A Shield answered
 inside that window moves a creature out of `hits`, and a button that opened on the earlier reading
 would be green for an attack that no longer landed. `settleAttack` is called from the `await window`
 branch in `damage.ts` for exactly that reason; moving it earlier silently reintroduces the bug.
- **`open` and `hit` are different verdicts and both unlock.** `hit` means a verdict arrived and it was
 yes; `open` means none is coming and the human decides. Only one of them is green.
- **One press is enforced twice, and the local half is the one that works.** The flag is the durable
 record, written by the GM, but it arrives over the wire and a determined double-click does not wait
 for it. The `pressed` set is the same answer half a tick earlier, on the one client where the second
 press is going to happen.
- **A GM gets an Unlock button; a player does not.** Never blocked, only asked — the same doctrine as
 the action economy. The lock reflects a reading this module made, and a GM who disagrees needs a way
 past it that is not "turn the feature off". For a player, the lock IS the feature. An override is
 recorded on the flag so `noteVerdict` cannot quietly close it again.
- **`combat.damageGate` is deliberately its own setting rather than riding on `autoDamage`.** They ask
 different questions: `autoDamage` is what happens TO a creature, and a table may reasonably want the
 arithmetic done and the button left alone. It is world-scoped because a lock only half the table can
 see is not a lock.
- Diagnostics: `api.surveyGate()`.
- **THE LOCK AND THE VETO MUST SHARE ONE PREDICATE, and they did not (v0.6.1).** `decorate` asked whether
  the card also carries an Attack button; `refuse` asked nothing at all. So every card with a Damage
  button and no Attack button — a rogue's **Sneak Attack**, every Heal activity, every standalone Damage
  activity, the damage half of a Save — was judged `waiting` and refused, with **nothing drawn on it**: no
  lock for a player to see, no Unlock for a GM to press, and a warning that read as noise. Reported as
  Sneak Attack having stopped working, which it had.
  - `gatedCard()` is now the single answer and both halves call it. **A veto must never be able to reach a
    card the lock was not drawn on** — the general form of the fail-open rule above, since an invisible
    refusal has no way out by construction.
  - Read off the DOM rather than by resolving the activity: that would be a uuid lookup per card per
    render, and midi renames activities without removing the system's buttons.

### Graze, and why the answer was to keep the button shut

The obvious fix for "a miss should sometimes still deal damage" is to unlock the button, and it is
wrong. Pressing Damage rolls the weapon's dice; Graze deals **the ability modifier alone, no dice**,
and the rule says so twice (in the sentence and again in the clause about how it can be increased).
So the button stays locked and `applyGraze` pays out the flat amount directly.

- It is the same finding as everything else in `documentation-signals.md`:
 `CONFIG.DND5E.weaponMasteries` gives every mastery exactly `{label, reference}`, and `graze` as a
 whole word appears nowhere in `module/**.mjs` outside those config lines. The mastery is chosen on
 the attack dialog, recorded on the attack message, and read by nobody.
- **Read the mastery off the ATTACK MESSAGE (`flags.dnd5e.roll.mastery`), not off the weapon.** A
 weapon can be mastered and the mastery declined on the dialog; the message is the record of what was
 actually chosen for this swing.
- **A modifier of zero or less deals nothing and returns null.** That is a real case (Strength 10 with
 a Greatsword) and posting "takes 0 bludgeoning" would be noise on every miss.
- An unreadable damage type is `""` rather than a guess. `Actor5e#applyDamage` treats unknown as
 untyped, which skips resistance rather than inventing an immunity — the correct failure.
- `unresolved` targets get no graze, for the same reason they get no hit: "there are two of these on
 the scene and the record cannot say which" is exactly as unanswerable here.

### Compact cards, and the Bloodied status

- **`compactCards` is CLIENT-scoped and lives in Foundry's own settings list**, beside `debugLogging`
 and for the same reason: it is a display preference rather than a rule, each person at the table
 wants their own answer, and it should be findable without knowing which of our three windows to
 open. It toggles one class on `document.body` and every rule keys off that; **font sizes are
 deliberately untouched**, which was the user's explicit constraint — the height comes out of padding,
 margins, avatar dimensions and `min-height`, not out of legibility.
- Every rule carries `!important`. dnd5e's card styles are specific and shift between patch releases,
 which is the same lesson `noodlr`'s stylesheet records about `user-select`.
- **dnd5e already owns Bloodied and we should not build one.** `Actor5e#updateBloodied` applies the
 status below `CONFIG.DND5E.bloodied.threshold` (0.5). What matters for us is that its visibility
 setting has a **`none`** position, and at that setting **the status is never created at all** — so a
 compiled ability guarded on `bloodied` silently never fires, which reads as the compiler being
 broken. `systemSettingAdvisories()` reports it and `pages.ts` carries a `system`-state row saying who
 owns it. We do not write another module's settings; we say where the switch is. Recharge left
 this family in v0.7.15 — we roll it ourselves and still never write `dnd5e.autoRecharge`.
- **Every setting read in `systemSettingAdvisories()` is independently guarded and none of them returns
  early (fixed v0.6.1).** The first two were chained, so on any dnd5e without `autoRecharge` the Bloodied
  warning below it could never be reached. **A missing setting means "a version that does not have this
  one", which says nothing about the next one** — and an advisory that silently disappears on some versions
  is worse than no advisory, since the whole point is to explain a rule that is not firing.

## Configuration, not code: what to tell a GM

Problems reported as module bugs that were world configuration, or another module's defaults, instead.
Recorded because they will be reported again.

- **A teleport whose destination is occupied is cancelled silently, and it is not ours (2026-08-14).**
  Reported as Misty Step spending a 2nd-level slot, playing its mist and sound at the target square, and
  leaving the caster where they stood. Read from source rather than inferred:
  - At `movementAutomation: "full"` **dnd5e's** `constrainMovementPath` override truncates a path at the
    first grid space held by a creature within one size step of the mover
    (`canvas/layers/tokens.mjs:isOccupiedGridSpaceBlocking`), and it truncates **to the origin** when the
    very first step is the blocked one — which for a teleport is the destination, since there are no
    intermediate squares.
  - **Chris's Premades** calls exactly that as a pre-check and returns early on a path that goes nowhere
    (`cat_tokenUtils.mjs:58`, `moveToken` with `action: 'displace'`), while its `postAnimation` and
    `postTeleport` passes run regardless. Hence the effects without the movement.
  - Neither half is wrong on its own and neither is fixable from here, so `systemSettingAdvisories()`
    says so whenever Movement Automation is Full and a teleporting module is present. **Our own
    `preMoveToken` handlers are not implicated**: every path in `economy/speed.ts` gates on
    `movement.method` being `dragging` or `keyboard`, so an API move never reaches any of them.
  - The remedy for a GM is a clear destination square, or Movement Automation set to Difficulty Only.

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
  - **SHARPENED 2026-08-16 — the failure is quieter than "stored and ignored", and it is diagnosable
    statically.** Two corrections from [`mech-04`](../_research/_audit/mech-04-change-key-vocabulary.md):
    - An unmatched key is not dropped. `_applyLegacy` (`active-effect.mjs:378-424`) casts the value
      and **`mergeObject`s the path onto the live actor**, landing in `actor.overrides`. That is the
      same mechanism `flags.dnd5e.*` and `flags.dae.*` ride on, which makes `flags.<ns>.*` the
      *supported* carrier rather than a hack — and it means the sole `console.warn` on that path
      (`:397`) fires on a **cast** failure only. There is no code anywhere in core that could ever say
      "nobody consumes this key".
    - **Every `macro.*` change is mode CUSTOM (0), and CUSTOM is a total no-op without DAE.**
      Searching `dnd5e/module` for `applyActiveEffect` returns only the unrelated `applyActiveEffects`
      *methods*; neither dnd5e nor core registers a listener. So the mode itself is the dead end, not
      the key name, and the value never appears in any dropdown either.
    - **Therefore this is checkable at load with no hooks and no runtime cost**: classify every
      `changes[].key` on every item against the documented grammar and report the families whose
      consumer is not installed. Sketched as a capability in
      [`mech-02` §3.10](../_research/_audit/mech-02-the-scaffold.md). It converts the single most
      likely false bug report we will ever receive into a line a GM can read. **The midi namespace
      has to be matched as a grammar, not a list** — `setupMidiFlags()` generates several thousand
      keys by looping attack types × abilities × damage types.

### And in the reference world it is CHRIS'S PREMADES, not DDB Importer (measured 2026-08-16)

The note above is correct about DDB Importer and it sent the investigation to the wrong module. The
operator's reasonable fear — every DDB-imported object in the world was fetched while Midi QoL was
enabled, so all of it is now inert and everything must be re-imported and re-compiled — **is not
supported by that world's data, and the re-import would have fixed nothing.** Measured live through
the harness rather than inferred:

- **4 actors carry a DDB flag and ZERO of 2,430 items do.** The four are the player characters.
  **Chris's Premades has replaced essentially every item on them**: 47 of 48, 131 of 135, 74 of 76,
  134 of 138 carry `flags["chris-premades"]`, and 441 CPR items exist world-wide. So the DDB
  provenance was overwritten on the items, and a DDB re-import would replace CPR's versions rather
  than repair them.
- **The whole midi residue on actors is 22 items, 20 of them CPR's.** The other two are the
  Legendary Resistance feature on the Adult White Dragon and the Beholder, which `rules/legendary.ts`
  now automates natively. Nothing there is DDB's.
- **`character-update-policy-add-midi-effects` is ALREADY `false`.** The two still on are the
  *munching* policies, and nothing in the world was munched: 202 of 206 actors have no DDB flag and
  came from the active premium modules (`dnd-monster-manual`, `dnd-players-handbook`, …). Flipping
  them is cheap hygiene for future munches and repairs nothing already present.
- **The nine world items named `Class Features` / `Conditions` / `Magic Items` / `Other` / `Spells`
  plus their `- Backup` copies are DFreds Convenient Effects libraries**, type `weapon`, `prose=0`.
  Their midi change keys are inert exactly as this file already records for CE 9.2.5; their
  `statuses` arrays are real and uninvolved.
- **THE COMPILE CACHE IS UNAFFECTED, which is the expensive half of the fear.** `surveyScene()` on a
  scene holding the Troll and the 135-item rogue reports **109 distinct wordings, 109 cached, 0
  would ask**. The cache key is normalised prose and CPR does not rewrite descriptions, so the 1,022
  compiled wordings need no re-scrutiny.
- **THE REAL INERTNESS IS CPR'S AND IT IS NOT FIXABLE BY ANY IMPORT.** Its entry points route
  through `MidiQOL.Workflow.getWorkflow()` and `MidiQOL.socket()`, so with midi gone 441 items'
  automation does nothing. The remedies are reinstalling midi or this module covering the rules,
  which is the project. Every stand-aside here that gates on `chris-premades` AND midi
  (`gambitsOwnsCounterspell` and friends) is right for exactly this reason.
- **The transferable lesson is about attribution, not about either module.** "Content was imported by
  X and X writes Y's flags" is an inference; `Object.keys(item.flags)` is a measurement, and the two
  disagreed here because a *third* module had rewritten the items in between. **Read the flag
  namespaces off the documents before believing any provenance story** — including one told by the
  person who did the importing. And check the spelling: DDB Importer's actor namespace in this world
  is `ddb-importer`, not the `ddbimporter` the first probe looked for, so the first census reported a
  reassuring zero for the wrong reason. Same class of fault as the meta-notes census.
- Consequence for the compiler's read side: **the Hold Person asymmetry is CPR's doing.** The copies
  on the two casters are CPR items with an EMPTY `statuses` array and a `flags.midi-qol.OverTime`
  change, while stock dnd5e's Hold Person carries `[paralyzed]` natively. So a refusal predicate for
  `apply_status` has to be **per item**, like `duplicatesActivityDamage` — a per-descriptor refusal
  would decline the one copy that is the only thing applying the condition.

### A second world answered the same question the opposite way round, and found the real residue (2026-08-17)

The reference host now carries **two** worlds. `noodlr-test` is smaller and deliberately varied — different
scenes, 13 freshly DDB-imported player characters (one per class), **and a different module set: midi off,
Chris's Premades ABSENT, AC5e absent, DAE and Convenient Effects and Token Magic active.** So the reassuring
answer above does not transfer: there is no CPR here to have overwritten anything, and all **1,823 items on
those 13 sheets carry a DDB flag**. This is the world the original fear described, and it was re-measured
from scratch rather than assumed to be covered.

- **THE MIDI RESIDUE IS COSMETIC, AND THE NUMBER THAT SETTLES IT IS `OverTime` = 0.** 1,302 of 1,823 items
  carry `flags["midi-qol"]`, which is what makes the namespace count so alarming and so useless. Censusing
  the KEYS rather than the namespace: `removeAttackDamageButtons: "default"` ×1,176 and `forceCEOff: true`
  ×1,476 are the whole of it, and neither is a rule. **The load-bearing residue is SIX items** — four
  `reactionCondition`, one `effectCondition`, one `effectActivation` — which are inert and are gates rather
  than effects, so their failure mode is a reaction offered slightly too readily. **A re-import buys back
  six conditions and costs every sheet plus the RAG corpus.** Not worth it, and now measured in two worlds
  by two independent routes.
- **Generalise the method, not the verdict: `Object.keys(flags)` is a provenance question and the KEYS
  INSIDE are the capability question, and only the second one can tell you whether anything is broken.**
  Both censuses of this family have been wrong at first pass by reading the outer layer — the previous world
  by attributing CPR's items to DDB, this one by reading 1,302 namespace hits as 1,302 inert automations.
- **THE ACTUAL LOSS IS DAE `specialDuration`, 196 DECLARATIONS — not fixable by re-importing *while DAE is still on*.**
  DDB writes that key whenever DAE is present. Confirmed at runtime rather than inferred:
  **`DAE.daeSpecialDurations` is an empty object** with midi off, because the interesting labels register
  only when midi is active (`DAEdnd5e.ts:632`). Split after the 2026-08-19 DAE re-read: `isSkill.*` /
  `1Attack` / `isDamaged` still never expire (Guidance is that family); **`turnStartSource` ×59 can
  migrate to native `sourceStart` when DAE is on** and then core expires it. Wipe + re-import with DAE
  **off** is what stops DDB writing the key; disable alone leaves the residue on disk.
  - This is the first measured justification for the Phase 4 `duration` task rather than an argued one.
    Core v14 owns the expiry model natively (`CONST.ACTIVE_EFFECT_EXPIRY_EVENTS` plus `start.combatant`,
    so source-turn versus target-turn is expressible), so the fix is a translation of a vocabulary we can
    read into one core already enforces — and it repairs imported content nobody has to re-import.
  - The 31 `macro.tokenMagic` changes are the exception that proves the split: mode CUSTOM, consumed by
    DAE, which IS active, and Token Magic FX is installed. Those work. Purely visual either way.
- **Ownership in this world is `us` for all 22 rules, `enabled=true`, with ZERO conflicts and no scene
  advisories** (Token Vision on, fog on, 31 walls). That makes it the cleanest test configuration this
  module has ever had — nothing stands aside, so every layer here is the only thing enforcing its rule, and
  a failure cannot be another module's. The single advisory is dnd5e's `autoRecharge`, still off.
- **Two operational facts to read before trusting any census taken here.** `capabilities.compile` is
  **off** in this world, so placing tokens binds cached wordings and asks for nothing — an "ingestion
  works" conclusion drawn from a quiet scene load would be drawn from a switch. And **884 of the 1,105
  wordings these 39 sheets produce are uncached** (1,099 cached, 221 of them reachable here), so turning it
  on is roughly the previous world's 87-minute bill again. Decide that deliberately rather than by ticking
  a box.
- **The `absent` hazard is now measured, not predicted: 878 orphans, every one `absent`, `prunable` 0.**
  Those 878 are the first world's paid-for wordings, and `pruneOrphans({includeAbsent: true})` run from
  here would delete them. See the hygiene note above.

### The clean-world smoke test, and the refusal predicate finally firing in the field (v0.7.3, 2026-08-17)

13 DDB-imported player characters plus the Troll, dropped one at a time onto a scene with no combat, on the
world described above — the first test of this module against content that has never met midi-qol or Chris's
Premades. **1,696 features read off 14 creatures, zero errors from either noodlr module in the whole session.**
The only errors in the log are Polyglot failing to parse its own fonts. Worth recording because the question
the world was built to answer — does any of this need those modules — is now answered by a run rather than by
an argument.

- **The `on_hit` refusal predicate fired on live imported content, four times, and this is its first
  confirmation outside a test.** `Fire Bolt`, `Create Bonfire` and `Infestation` each compiled to a rule
  restating the damage the activity already rolls, and each is refused by `duplicatesActivityDamage` with the
  reason on the capability sheet; `Sneak Attack` is refused by `sneakClaimedNatively` because we deal it. That
  is 45-of-71 damage restatement, met and declined in the wild. **The whole `on_hit` dispatch rests on this
  guard**, and a doubling is arithmetic rather than an error, so a live confirmation is worth more here than
  in most places.
- **DDB IMPORTER GIVES UNARMED STRIKE THE FINESSE PROPERTY, so it qualifies for Sneak Attack.** Measured:
  `Unarmed Strike | type=natural | props=fin`. RAW it has neither Finesse nor a ranged attack, so this is
  content drift and not a reading error — `qualifyingWeapon` is doing exactly what this file says it must,
  believing the sheet over the book. **Consequence to expect reported: a rogue is offered Sneak Attack on a
  punch.** Left alone deliberately. The alternative is a hard-coded exception for one item name, which is the
  opposite of every other judgement in `system/`, and the sheet is the authority the whole module is built on.
  If a table objects, the property comes off the item.
- **`hits` in `CollectReport` counted OCCURRENCES where every other number in this layer counts WORDINGS.**
  Twenty goblins sharing one cached Pack Tactics reported `hits: 20`, and `distinct` was derived as
  `hits + misses`, so the same scene reported twenty distinct wordings as well. Live, that read as
  **1,252 distinct / 438 known** against `surveyScene`'s honest **997 / 183** — a cache covering a third of
  the scene when it covered all of what it had been asked. Functionally nothing: `misses` was always a Map and
  was always the thing bought. **But the number goes straight into a log line, and this file's own second-world
  census quotes collector output.** Counted through a Set now, and pinned — the existing hit test used ONE
  creature, so it passed with the bug in place and certified nothing.
- **A diagnostic list is joined with ` | `, not `, `.** dnd5e weapon names contain commas, so two hand
  crossbows rendered as `Crossbow, Hand, Crossbow, Hand` and read as four weapons. Same doctrine as the
  flat-output rule: a list that cannot be counted has not been reported.
- Noted and left: `qualifyingWeapons` filters on `equipped` and the runtime predicate does not, so a stowed
  dagger is absent from the survey and would still qualify on a swing. Under-reporting raises a false alarm
  somebody investigates; over-reporting answers the question wrongly and closes it. The doc comment says so.
- **`DAE | Deprecated special duration: turnStartSource` is DAE warning about ITS OWN vocabulary**, on the 196
  inert `specialDuration` entries above. It is not addressed to us and there is nothing here to change; it is
  the same finding arriving as a console line.

## Three combat bugs from the Archmage fight (2026-08-21)

- **Opportunity attacks were silent, not absent.** `moveToken` carries `destination`; we were
  ending the route on `_source`. Watcher distance added the footprint on top of `centerOf`.
  `watchersOf` required `token.center` (placeable-only) and skipped `combat.combatant` as well
  as the mover. Skip only the mover. Do not auto-Disengage to "fix" a missing OA — hide and
  flee are supposed to provoke. Every early return now logs.
- **Flee is a run-off, not an instant resolution.** `resolveCombatant("fled")` on the first
  step ended combat while the Hostile token stayed; perception re-started the fight. Stamp
  `flags.<ns>.fled` on the token, keep playing them, despawn after three own turns or at the
  scene edge, then resolve. `isHostile` ignores the flag even after `deleteCombat`.
- **Arm's Reach's GM door exemption is the default.** `globalInteractionDistanceForGMOnDoors`
  false means every GM click is unrestricted. Native `preUpdateWall` on every client: one
  square, selected/assigned token, GM-with-no-token may stage. Do not stand aside.
- **Prone never cleared, and he walked full Speed.** Planner had no stand. API moves use
  walk/fly, so crawl rates never applied. Default stand. Stay down only when keepDistance,
  no melee within 5 feet, and the plan does not travel. `core/` still names no D&D status
  — crawl is `intent.action` from execute.

## Mount riding (v0.7.23, initial slice)

`src/system/dnd5e-riding.ts` + `src/rules/riding.ts`. No Rideable dependency. Stands aside when
`Rideable` is active. Do **not** delete `x`/`y` in `preUpdateToken` — that is Rideable's trick and
why `move() === true` is not evidence of movement. A rider who tries to walk is refused
(`preMoveToken` returns false). Follow uses `options.noodlrRiding === "follow"`, which
`isForcedMovement` treats as displacement so it does not provoke a second OA.

- **Who can mount:** same disposition or Neutral; player characters also mount Friendly. Mount at
  least one size larger (`sizeRank`). Unreadable size refuses. No riding loop.
- **Several riders (house rule, not RAW).** The printed rule is written for *a* rider and never
  forbids a second. Capacity is the **token footprint** plus remaining carry weight. Seats =
  `max(1, floor(width×height / 2))` — a Large 2×2 horse is two (the real-world two-up the table
  already plays); Huge 3×3 is four; Gargantuan 4×4 is eight, so a Wild Shaped Brontosaurus takes
  a party of 4–6 Medium/Small. Each rider costs `max(1, round(their squares))`. Small and Medium
  are both one square on the board; **weight** is what distinguishes them. Token dimensions win;
  missing width/height falls back to the size-category default (1 / 4 / 9 / 16). `"occupied"`
  now means no seats left, not "anyone is already up there."
- **Carrying:** if both `encumbrance.max` and this rider's burden are readable, `already + this`
  must fit (`already` = other riders' readable burdens; a null burden counts as 0 in the sum).
  Unreadable max or this rider's burden still allows — do not invent body-weight tables.
- **Seats offset** inside the mount so tokens do not stack. A new mount or dismount reseats the
  whole pack.
- **2024 cost:** half Speed, round down, stamped on **each** creature that mounts or
  dismounts **by choice** and subtracted from `budgetFor`. Speed 0 cannot mount. An
  involuntary fall-off (mount too small, seats gone, mount deleted) skips the stamp —
  they did not spend the movement. Gemini's "controlled mount gets a free Dash" is
  **false** — Dash is one of three actions, not an extra. Do not implement a free Dash.
- **Riders re-check the mount every 6 seconds (2026-08-21).** A linked Wild Shape revert
  keeps the token id and only shrinks it, so `deleteToken` never runs. `judgeStayMounted`
  is `judgeMount` with reach, Speed and "already riding" skipped — those are doors for
  getting on, not for staying. Size, seats, carrying and disposition still refuse for
  ordinary shrinks. **A revert to original form dumps every rider** (`revertDumpsRiders`),
  even those the humanoid could still carry: a Small rider on a Medium Druid is a legal
  seat and is also the token stacked inside the footprint that nobody can click.
  `isPolymorphed` going false or a linked `actorId` swap onto a non-polymorphed actor
  is the signal — the sheet Restore button is covered, not only our icon. Immediate
  courtesy on `width` / `height` / `actorId` and after our own restore; the poll is the
  backstop. Primary GM writes. The mount's Token HUD can dump the pack. Announces a
  fall-off, not a chosen dismount.
- **Controlled:** Neutral/Friendly default trained. Initiative matches the **first** rider only;
  a passenger does not steal the driver's init. Hostile is independent. Action limits (Dash /
  Disengage / Dodge only) and falling-off saves are **parked**.
- Setting `general.riding`. `noodlrHooks.surveyRiding()` / `.mount()` / `.dismount()` /
  `.dumpRiders()`.
- OA "you or the mount" and drag-onto-token automount stay parked.

## Open items carried over from noodlr

- ~~**OPEN BUG — melee-only hostiles still move oddly (reported 2026-08-05).**~~ **DIAGNOSED and fixed in
 v0.6.4** — it was the two answers to "how far is that", above. Three notes that stood here for ten days
 were all wrong and are worth knowing about as a category:
 - **"All four movement-veto modules are active in that world" was read off a census and is FALSE as of
 2026-08-15.** Measured live through the harness: `Rideable`, `monks-active-tiles`, `tokenwarp` and
 `NotYourTurn` are all **installed and disabled**. A census records what is installed; only a runtime
 read says what is running, and ten days of suspicion pointed at four modules that could not have
 been involved.
 - **The prime suspects named here (`reachableElevation`, the 3D separation check, `maxCost`) were all
 innocent.** None of them was ever measured; they were the plausible candidates, and writing plausible
 candidates into a durable note turns them into received facts. Name what was measured.
 - The one still-live residue: **`movement: core allowed X's move but its position was stripped before
 saving`** appeared in the same logs with all four documented culprits off, so that message's
 advice used to name Rideable and Monk's Active Tiles even when they were disabled. `strippedAdvice`
 in `core/movement.ts` (v0.7.6) names what is actually active, plus grappled/restrained/etc. and
 the token's region count. Active modules that touch movement in that world are
 `terrainmapper@14.0.1`, `patrol@4.0.3`, `about-face@3.29.1`, `item-piles@3.3.4` and
 `routinglib@1.1.0` — **suspect Terrain Mapper first**, since it is the one with region
 behaviours that intercept a move. Not yet reproduced since the measurement fix, and it may simply
 have been the v0.6.4 sub-square step being refused in a second way. Diagnosis is not a release
 blocker; the log line is now honest about who could have done it.
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
- ~~**`attacksPerAction` probably misses Thirsting Blade**~~ — **CONFIRMED and FIXED in v0.4.0**, with
  Devouring Blade alongside it. The inference was right; the corpus is what turned it into a certainty.
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
