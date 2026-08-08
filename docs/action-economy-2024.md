# Action economy — D&D 5e (2024) reference and Noodlr's coverage

Two things live here. The first half is the rules as written, recorded verbatim from the GM's own
breakdown (2026-08-05) so that later work has one authority to check against instead of somebody's
memory of a PHB. The second half is an honest audit of which of those rules Noodlr actually models,
which it models partly, and which it does not touch — because the gap between the two is where the
bugs are.

**System-specific.** This document is D&D 5e (2024). Noodlr is otherwise system-agnostic by design, and
the enforcement code in `src/combat/economy/` is written against activation types rather than against
5e, but the numbers below and the Extra Attack detection are 5e's.

---

## Part 1 — The rules

### 1. On your turn

Movement may be split around the action: move, act, move again.

#### A. Movement

| Thing | Cost |
| --- | --- |
| Standard move | Up to your speed |
| Difficult terrain | 1 extra foot per foot |
| Climb / swim | 1 extra foot per foot, unless you have that speed |
| Crawl (moving while Prone) | 1 extra foot per foot |
| Drop Prone | Free |
| Stand up | Half your speed |
| Mount / dismount | Half your speed |
| High jump | Requires a 10 ft run-up, or the height is halved |
| Long jump | Requires a 10 ft run-up, or the distance is halved |

#### B. The Action — one per turn

The 2024 rules codified these as a closed keyword list.

- **Attack** — a melee or ranged attack. Unarmed Strikes now explicitly include **Grapple** and
  **Shove** as options: there is no separate Shove action, you take the Attack action and choose the
  option for one of your attacks.
- **Magic** — the new keyword for casting a spell with a casting time of 1 action, or using a magic item.
- **Dash** — extra movement equal to your speed this turn. **Not always an action:** a Rogue's Cunning
  Action (level 2) and a Monk's Step of the Wind both make Dash a *bonus action, for free*, and the Monk
  may spend 1 Focus point to Dash and Disengage together. Expeditious Retreat (Sorcerer / Wizard /
  Warlock) grants a bonus-action Dash for the spell's duration. Some species and general feats do the
  same. Noodlr reads these from the sheet — see `src/combat/systems/dnd5e-dash.ts` — and prefers the
  bonus action whenever one is available.
- **Disengage** — your movement provokes no opportunity attacks this turn.
- **Dodge** — attacks against you have disadvantage; you have advantage on Dexterity saves.
- **Help** — give an ally advantage on their next check or attack roll, or assist a task.
- **Hide** — a Stealth check, DC 15 minimum, to gain the Invisible condition.
- **Ready** — hold an action to release as a reaction on a stated trigger.
- **Search** — a Wisdom check (Perception, Insight, Medicine or Survival) to discern something not obvious.
- **Study** — an Intelligence check (Arcana, History, Investigation, Nature or Religion).
- **Influence** — a social check (Animal Handling, Deception, Intimidation, Persuasion).
- **Utilize** — the new name for Use an Object.

#### C. The Bonus Action — only if a feature grants one

- **Drink a potion** — new in 2024, a bonus action for everyone.
- **Off-hand attack** — with the Light property. The **Nick** mastery moves this onto the main action instead.
- Class features: Bardic Inspiration, Rage, Cunning Action, and the rest.
- Spells with a casting time of 1 bonus action: Misty Step, Healing Word.

#### D. Free interaction

One object interaction is free during your move or action — drawing a sword, opening a door. A **second**
interaction in the same turn costs the Utilize action.

### 2. Between turns — the Reaction

One per round, **refreshing at the start of your turn**.

- **Opportunity attack** — when an enemy leaves your reach. 2024 allows an Unarmed Strike, so Grapple and
  Shove are now legal opportunity attacks.
- **Cast a spell** with a casting time of 1 reaction: Shield, Counterspell, Hellish Rebuke.
- **Release a Readied action.**
- Class features, e.g. the Rogue's Uncanny Dodge.

### 3. Monsters only

- **Legendary actions** — taken immediately after another creature's turn.
- **Legendary resistance** — turn a failed save into a success, limited uses per day, usually 3.
- **Lair actions** — largely folded into legendary actions or static environmental effects in 2024,
  though some creatures still act on initiative count 20.

---

## Part 2 — What the platform enforces

Verified in dnd5e 5.3.3 source, not assumed.

**Nothing, for actions, bonus actions and reactions.** `CONFIG.DND5E.activityActivationTypes`
(`module/config.mjs:994-1093`) gives each activation type an optional `consume` property naming an actor
resource pool. Exactly three declare one: `legendary` and `mythic` (both `resources.legact`) and `crew`
(`attributes.actions`, vehicles). `action`, `bonus`, `reaction` and `lair` carry a label, a header and a
group and nothing else.

The consequence is at `module/documents/activity/mixin.mjs:540`, where the entire consumption block —
including the `DND5E.ACTIVATION.Warning.NoActions` and `NotEnoughActions` errors the system already
ships — is gated on `activationConfig?.consume`. For an ordinary action that is `undefined`, so the
block never runs and those warnings are unreachable. There is no per-turn counter anywhere in the data
model; the only `spent` fields in the system are limited uses, hit dice, `resources.legact`,
`resources.legres` and vehicle crew actions.

This is intentional and acknowledged. The system's own JSDoc
(`module/documents/activity/_types.mjs:35`) documents the flag as *"Should action economy be tracked?
Currently only handles legendary actions."* **"Action tracking"** is listed under API/Automation in the
dnd5e 5.0.0 release notes roadmap and has not shipped in any 5.x release.

**Core Foundry offers nothing to build on.** The Combatant schema has no budget concept; `Combatant#resource`
is a single display-only actor property path chosen by the GM for the tracker. A turn is an ordering
mechanism, nothing more.

**What the system does enforce**, correctly and hard: spell slots, limited uses, and recovery periods —
*when they are configured*. An activity's `consumption.targets` defaults to an empty array, and an empty
array consumes nothing, silently. This is the usual explanation for "my once-per-day thing never runs
out". Note also that SRD Shield ships with no limited uses and no consumption targets
(`packs/_source/spells24/1st-level/shield.yml`): it is gated by a 1st-level spell slot and nothing else.

**One trap worth knowing.** Clicking Attack again on an *already posted* chat card re-rolls with no
consumption at all (`mixin.mjs:1009`). That path is intended — it is how you re-roll — but it looks
exactly like a missing action limit, and no module can stop it.

**No module enforces it either.** Midi QoL is the only one that resists: `enforceReactions` and
`enforceBonusActions`, both defaulting to `"none"` (verified, midi 14.0.11 `src/module/settings.ts:177-178`),
and even when set they raise a "proceed anyway?" confirmation rather than blocking. There is no
`enforceActions` setting. Argon displays action pips but its author documents plainly that it prevents
nothing and its state resets when the HUD is closed.

---

## Part 3 — Noodlr's coverage

### Enforced

`src/combat/economy/` counts one action, one bonus action and one reaction per creature, refreshing at
the start of that creature's own turn. The veto point is dnd5e's own `dnd5e.preUseActivity` hook, which
cancels a use cleanly when a handler returns false, so nothing is patched and midi still works (midi's
activity `use()` calls `super.use()`, so the hook fires under it too).

- **Automated creatures are hard-blocked, always**, and the setting does not reach them.
- **Players** follow the Text Generation setting: `off`, `warn` (ask, then log every "continue" to
  public chat) or `block`. Default `warn`.
- **The GM is never hard-blocked**, only asked. Overruling the rules is the job.
- **Extra Attack is read, not guessed.** dnd5e class features carry stable `system.identifier` values, so
  `extra-attack`, `two-extra-attacks` and `three-extra-attacks` give 2, 3 and 4 attacks per Attack action.
- **Multiattack is parsed** from the feature's prose for a number word, defaulting to 2 when unparseable
  — deliberately generous, because blocking a legal attack is a bug report while allowing one too many
  is a bad turn.
- **Overrides** are Active-Effect-shaped: `flags.noodlr.extraAction`, `extraBonus`, `extraReaction`
  (mode Add) and `flags.noodlr.attacksPerAction` (Override). Haste is `extraAction` +1.
- Diagnostics: `game.modules.get("noodlr").api.surveyEconomy()`.

Deliberately **not** counted: legendary, mythic and crew actions, which dnd5e already tracks properly.

### Modelled elsewhere in Noodlr

| Rule | Where | State |
| --- | --- | --- |
| Movement budget | `auto/movement.ts`, via `constrainOptions.maxCost` | Enforced |
| Difficult terrain | Core Foundry movement cost | Core's |
| Walk / fly / swim / burrow / climb | `auto/locomotion.ts`, read from the sheet | Modelled |
| Opportunity attacks | `auto/reactions.ts`, by walking the move route | Modelled |
| Disengage | `auto/reactions.ts`, matched loosely on status and effect names | Modelled |
| Teleports don't provoke | `auto/reactions.ts`, via the waypoint `displace` action | Modelled |
| Hide / Stealth vs Perception | `auto/stealth.ts`, `systems/dnd5e-concealment.ts` | Modelled |
| Invisible, Ethereal, concealment spells | `systems/dnd5e-concealment.ts`, `auto/screens.ts` | Modelled |
| Legendary actions and resistance | dnd5e's own `resources.legact` / `legres` | System's |

### Known gaps

Ordered roughly by how likely each is to be noticed at a table.

1. **Movement is not split around the action.** A turn moves, then acts. Move–attack–move is the
   commonest real pattern and we cannot do it. Parked in IDEAS.md as a turn-script refactor.
2. **Climbing and swimming without the matching speed do not cost double.** Core's movement cost models
   terrain, not the 5e rule, and we do not add it.
3. **Prone is not modelled at all** — no drop (free), no stand (half speed), no crawl (double cost). This
   also means a flyer knocked prone does not fall.
4. **Jumps are not modelled.** High and long jump, and the 10 ft run-up rule. Parked in IDEAS.md.
5. **Mount and dismount are not modelled.**
6. **Free object interaction is not counted**, so the second one does not demand the Utilize action.
   There is no reliable signal for "interacted with an object" to hook.
7. **Ready is not modelled.** No held action, therefore no readied release as a reaction.
8. **Grapple and Shove as Attack options** are not distinguished from an ordinary attack, so an
   opportunity attack never chooses them.
9. **Study, Influence, Search and Help** are not planner options — the automated planner has no reason
   to pick a social or investigative action mid-fight, but Help in particular is a real tactical choice
   we do not make.
10. **Lair actions on initiative 20** are not driven.
11. **Haste's extra action is limited to Attack, Dash, Disengage, Hide or Utilize** in the rules. Our
    `extraAction` flag grants a general action, so a hasted caster could be allowed two spells. The
    override log makes it visible; enforcing the subset would need per-effect action whitelists.
12. **Reaction triggers we cannot see.** Shield and Counterspell need an "about to be hit" and "a spell
    is being cast" moment. Without midi, dnd5e never compares an attack roll to an AC, so there is no
    such moment to hook. Noted in `auto/reactions.ts`.

### Assumptions worth re-checking

- **Attacks and actions are separate currencies** in the ledger, related by `attacksPerAction`. A
  creature that has spent its action on a spell cannot then attack, which is correct, but the arithmetic
  is the part most likely to be subtly wrong under multiclassing or unusual effects. `surveyEconomy()`
  exposes the raw tally for exactly this reason.
- **The turn stamp is derived, not stored.** A creature's budget belongs to the round in which its own
  turn most recently began, computed from its index in `combat.turns`. Reordering initiative mid-combat
  moves that index, and a creature whose initiative changes between turns could see its budget refresh
  early or late. Judged acceptable; noted so it is not rediscovered as a mystery.
- **Bonus-action attacks** (off-hand, Nick) arrive with `activation.type === "bonus"` and so draw on the
  bonus slot rather than the attack allowance. Believed correct, not yet play-tested.
