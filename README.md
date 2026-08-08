# Noodlr Hooks 5.5e

Rules automation for **D&D 5e (2024)** in Foundry VTT.

The D&D 5e system is an excellent character sheet and a superb content platform. What it deliberately
is not is a referee. It tracks concentration and never ends it; it computes a death-save DC and never
rolls one; it colours the movement ruler red and lets you keep walking; it knows a creature is
Paralyzed and still lets it make Dexterity saves. Those are not bugs — the system's own release notes
list "action tracking", "range, reach & cover" and "ruler integration with movement rules" as
unshipped work, prefaced with *"neither can we promise any firm timelines"*.

This module finishes those sentences.

## What it does

| | |
|---|---|
| **Action economy** | One action, one bonus action, one reaction, counted properly — with attacks and actions as separate currencies, so a fighter's second swing is never blocked. Extra Attack is read from the sheet; Multiattack is parsed from the stat block. |
| **Speed** | A creature's Speed actually limits how far it can be dragged in a turn. Difficult terrain costs double because core already knows the multiplier. Dash is charged when you cross the line — as a bonus action for a Rogue, a Monk or anyone under Expeditious Retreat. |
| **Conditions** | Advantage, disadvantage, auto-failed saves, critical hits within 5 feet of a Paralyzed creature, and the refusal to act while Incapacitated. |
| **Dying and death** | Unconscious at 0, Dead on massive damage, death-save failures from damage taken at 0, and stabilisation. Important NPCs get death saves like characters. |
| **Concentration** | The save is rolled on the client that owns the creature, and a failure actually ends the spell — as does being Incapacitated, dying, or reaching 0 hit points. |
| **Stealth and surprise** | Hiding is contested against passive Perception per observer, through walls, fog, magical darkness and illusion. Attacking reveals you, unless you have Skulker. Creatures caught unaware are marked Surprised. |
| **Forced movement** | Pushes, pulls, shoves and the Push weapon mastery move the target, respecting walls, scene edges, creature footprints and hazardous landings. Every one is undoable. |
| **Reactions** | Opportunity attacks when something leaves your reach, and retaliation when you are hurt off-turn. No dependency on any other module. |
| **Monster turns** | A deterministic tactical planner — no AI, no API key, no per-turn cost — that reads a creature's real sheet and picks a plausible action for what it actually is. Nine cognition tiers derived from Intelligence and Wisdom, so an owlbear mauls what is closest and a lich does the clever thing. |

Every one of those is a rule nothing else in the stack enforces. Each was verified against the D&D 5e
system source, core Foundry source, and the relevant community modules before a line was written.

## What it will not do

It never re-implements work another module already does well. Where **midi-qol**, **Automated
Conditions 5e**, **Gambit's Premades** or **Chris's Premades** is installed and configured to own a
mechanic, this module detects that and stands aside rather than double-applying it. Nothing here is a
dependency, and nothing here requires anything but Foundry and the D&D 5e system.

It also renders no visual or audio effects. Those are somebody else's craft.

## Installation

Paste this manifest URL into Foundry's **Add-on Modules → Install Module**:

```
https://github.com/gobsmacked1/noodlr-hooks-55e/releases/latest/download/module.json
```

Requires Foundry v13 or later and the D&D 5e system 5.0.0 or later.

## Configuration

Every setting lives in Foundry's own **Configure Settings → Module Settings**. All sixteen default to
on, or to the least surprising choice. The one worth reading before your first session is **Hold
players to one action per turn**, which defaults to *ask, and log it publicly* rather than to a hard
refusal — because the rules break their own general case constantly, and a system with no way to say
yes turns Haste into a bug report.

## Working with Noodlr

[Noodlr](https://github.com/gobsmacked1/noodlr) is an AI game master for Foundry: chatbots backed by a
real vector memory, scene art, portraits, maps, music and voice. It owns no rules; this module owns no
narration. Install both and each finds the other:

- every ruling this module makes is announced on `noodlrHooks.ruling`, so the AI knows what happened
  and can adjudicate, undo or overrule it;
- a creature deciding to flee, surrender or show mercy asks for that scene to be played out through
  `noodlrHooks.behavior`;
- an automated creature's turn goes out on `noodlrHooks.turn` before it is announced, carrying
  everything a taunt needs, so monsters can talk in their own voices.

Neither module needs the other. The hook names are prefixed `noodlrHooks.` rather than by module id on
purpose, so a future `noodlr-hooks-pf2e` speaks the same protocol.

## Diagnostics

When something behaves oddly, ask rather than guess. From the console, with a token selected:

```js
const api = game.modules.get("noodlr-hooks-55e").api;

api.explainTurn();        // what the planner read off this creature, and how it scored every option
api.testMove();           // really move it one square, reporting what core said at each stage
api.surveyEconomy();      // what every combatant has left this turn
api.surveyPerception();   // who can see whom, with distances, senses and each verdict
api.surveyActions({ saveToFile: true });   // census every sheet in the world
```

`api.surveyActions()` is the important one. Three shipped bugs were found by running it against a real
world, and each of them had been written from documentation that was correct and incomplete.

## Licence

MIT.
