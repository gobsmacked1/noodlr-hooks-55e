# Changelog

## 0.2.0

Three settings windows, three new rules, and a way for a creature's own abilities to be read off its
sheet instead of hand-coded here.

### Settings you can actually read

The module's rules used to sit as a flat list of checkboxes in Foundry's own settings, which could
show you a value but never tell you whether anything was acting on it. That was a real problem: when
Automated Conditions 5e is installed it takes over conditions entirely, and midi-qol takes over
concentration and dying, so a switch could read ON while nothing happened.

There are now three windows — **House Rules**, **Mechanics** and **Combat** — and every rule in them
says who is enforcing it right now: this module, another module, the game system, or nobody. Four
presets set the whole lot in one click: narration only, rules assistant, full enforcement, or
alongside Midi QoL. Rules that are not built yet are listed too, folded away, saying who covers them
in the meantime, so you can tell the difference between a gap and a bug.

Two cross-cutting warnings appear when they apply. Midi-qol's range and wall checks are live at stock
settings and cancel an item use with nothing but a log line, which looks exactly like this module
failing to fire — the windows now say so. And if Weapon Mastery 5e is running alongside our forced
movement, you are warned that a Pike or Warhammer hit may push twice.

### Creature abilities are compiled from the sheet

Hand-coding the rules was abandoned: the finished survey found six thousand distinct engines needed
to cover thirty-six thousand rules, and most of the queue turned out to be facts about individual
creatures rather than rules of the game. Instead, with **Noodlr** installed and the switch turned on,
each creature's own ability text is read once when a scene loads and turned into something the module
can execute; deterministic code then runs it every turn, with no AI in the fight itself. Twenty
goblins sharing one trait cost one reading, and the result is cached, so a scene is usually free the
second time.

Nothing is required. With Noodlr absent, or the switch off, no abilities are compiled and the module
behaves exactly as it did before. Anything the compiler is unsure of is dropped rather than guessed
at, and a **Creature Abilities** window lets you read, correct, lock or reject anything it produced.

### New rules

- **Jumping.** Long jumps and high jumps are measured and capped, with the run-up accounted for. Also
  fixes an interaction that quietly collapsed a whole turn's movement to a few feet when the jump
  movement action was selected.
- **Influence.** The 2024 social action, with Friendly, Indifferent and Hostile attitudes, the right
  skill on the right sheet, the DC the rules actually specify, and the day-long lockout after a
  refusal. Whether the creature is willing, unwilling or hesitant is always asked, never guessed.
- **Administer First Aid.** A button for the stabilisation nothing in the system offered one for.

## 0.1.0

First release. Everything here was previously part of [Noodlr](https://github.com/gobsmacked1/noodlr)
and has been split out into a module of its own, so that a table wanting D&D 5e (2024) rules
automation does not have to install an AI game master to get it — and so that the rules work can grow
without weighing down a module that is meant to be game-system agnostic.

If you are upgrading from Noodlr 0.4.x, install this alongside it. Your combat settings are copied
across automatically the first time a GM loads the world, and every actor flag you have already built
into an Active Effect keeps working.

### What this module does

- **Action economy.** One action, one bonus action and one reaction per turn, counted properly.
  Attacks and actions are separate currencies, so a fighter's second swing is never blocked; Extra
  Attack is read from the sheet and Multiattack is parsed from the stat block. Extra damage riders
  like Sneak Attack cost nothing, because they are not actions.
- **Speed.** A creature's Speed limits how far it can be dragged in a turn, with difficult terrain
  costing what core says it costs. Dash is charged when the line is crossed — as a bonus action for
  anyone with Cunning Action, Step of the Wind or Expeditious Retreat.
- **Conditions.** Advantage and disadvantage, auto-failed Strength and Dexterity saves, critical hits
  within five feet of a Paralyzed or Unconscious creature, and the refusal to act while Incapacitated.
  Stands aside entirely when Automated Conditions 5e is installed and enabled.
- **Dying and death.** Unconscious at 0 hit points, Dead on massive damage, death-save failures from
  damage taken while down, and stabilisation. NPCs marked Important get death saves like characters.
  Every ruling is undoable from the card it posts.
- **Concentration.** The save is rolled on the client that owns the creature — the player's own
  browser for a character — and a failure actually ends the spell, as does being Incapacitated, dying
  or reaching 0 hit points. Stands aside when midi-qol's concentration handling is on.
- **Stealth and surprise.** Declared hiding is contested against each observer's passive Perception,
  accounting for walls, fog banks, magical darkness, illusions and every sense on the stat block.
  Attacking reveals you — unless you have Skulker and missed. Creatures caught unaware are marked
  Surprised before initiative is rolled.
- **Forced movement.** Pushes, pulls, shoves and the Push weapon mastery move the target, respecting
  walls, scene edges, creature footprints and where it would land. Reversible from every card.
- **Reactions.** Opportunity attacks when a creature leaves your reach, and hitting back when hurt
  off-turn. Native, with no module required, and it stands aside for Gambit's Premades.
- **Hostile creatures that start their own fights.** A sentry that notices the party rolls
  initiative, shouts for whoever is within earshot, and begins the encounter — without waiting for
  the GM to press anything.
- **Monster turns without an AI.** A deterministic tactical planner reads a creature's real sheet and
  picks a plausible action for what it actually is. Nine cognition tiers derived from Intelligence and
  Wisdom decide what it can conceive of, how reliably it acts on the best idea, and how many options
  it weighs at all. Choices are seeded, so a turn replays identically and nothing can be reroll-shopped.
- **Encounters that end without a body count.** Flight, surrender and mercy are real outcomes, with
  experience awarded for what is left on the field and a one-click undo on anything a mercy took.

### Notes

- Every setting is in Foundry's own **Configure Settings → Module Settings**.
- Diagnostics live on the module API: `api.explainTurn()`, `api.testMove()`, `api.surveyEconomy()`,
  `api.surveyPerception()`, `api.surveyActions({ saveToFile: true })` and one survey per rules layer.
- Installed alongside Noodlr, the two find each other automatically: rulings, behaviour requests and
  turn announcements cross on `noodlrHooks.*` hooks so the AI can narrate, voice and overrule.
