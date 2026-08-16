# Changelog

## 0.6.8

**Unarmed Strike is no longer read as one of your creature's own abilities.** The rules glossary that
gets stamped onto every sheet is skipped, because those rules are the same for every creature and are
already built in - but Unarmed Strike is the one glossary entry that arrives as a weapon rather than a
feature, so it was only skipped on sheets that happened to keep its stock identifier. Measured on a real
world: eight of them, and two had lost the identifier, so both were being read and paid for.

**`noodlrHooks.surveyGlossary()` counts each item once.** It was reaching an item through the world
actor and again through its token on a scene, so two of these read as four.

## 0.6.7

**Improving how abilities are read now has a way to reach the abilities you already have.** Compiled
abilities are remembered by their wording, which is what keeps a scene of twenty goblins cheap — but it
also meant that every improvement to how prose is read was invisible to any sheet that had been read
once already. `noodlrHooks.recompileWorld()` asks about every wording in the world again.

**It spends money, so nothing calls it for you.** One compile per distinct wording, typed by you when
you want it, never on a scene load. Anything you locked by hand is left alone; anything that was
rejected gets another go, which is the point. Progress and the bill are logged before anything is sent.

Also: the previous release's changelog named two console commands that do not exist. They are
`noodlrHooks.surveyOrphans()` and `noodlrHooks.pruneOrphans()`.


## 0.6.6

**The Troll stops regenerating through fire, and stops shedding limbs at full health.** Both rules had
been read correctly and compiled correctly the whole time; the conditions attached to them were being
filed under one name and looked up under another, so every guard was silently discarded and the abilities
fired whenever their trigger did. 576 conditions across your compiled abilities come back with this
update. **Nothing needs recompiling** — this is money you have already spent, being read.

**An ability no longer deals its damage twice.** A compiled rule that repeats damage the game already
rolls for that ability is skipped rather than dealt again, and the compiled-abilities window says
"would double" on it so you can see why. A genuine extra-damage rider on the same attack is unaffected.

**Two new things in the compiled-abilities window.** A rule whose guard could not be understood now says
so in English instead of quietly firing unguarded, and a rule that would double damage is badged.

**Housekeeping for the compiled-ability cache.** Abilities you no longer have — a monster deleted, a
feature renamed, or one of the general rules the module now declines to compile — leave entries behind
that nothing could ever use. `noodlrHooks.surveyOrphans()` lists them and
`noodlrHooks.pruneOrphans()` removes them. Nothing is deleted without being asked, and anything you
locked or rejected by hand is never touched.

New diagnostics: `noodlrHooks.surveyOrphans()`, `noodlrHooks.pruneOrphans()`,
`noodlrHooks.surveyGlossary()`.


## 0.6.5

**Monsters no longer track a hidden creature through a wall.** A rogue who hid, broke line of sight and
moved was still pursued square by square. The hiding rules were working the whole time — it was the
turn planner that never consulted them, because it reads the combat tracker, and the tracker knows
where everybody is standing. A creature now plans against what it can actually perceive.

**A creature that loses its quarry goes and looks where it last saw them.** Anything with the wits of a
dog or better; below that, losing you means losing you. The announcement deliberately does not name who
it is looking for, so watching a monster search gives nothing away. A creature that never saw you in the
first place does not come looking at all, which is what makes an ambush an ambush.

**A creature that is not hiding is still tracked normally.** This changes nothing for ordinary combat,
and costs nothing in a fight where nobody is sneaking.

New diagnostic: `noodlrHooks.surveyAwareness()` prints, for the selected creature, every hostile in the
tracker and whether it can see them.


## 0.6.4

**Creatures close to melee again.** A monster would walk to within one square of its target, stop, and
spend the rest of the fight standing there — the commonest thing this module does, and it had been
broken by two halves of the module measuring distance differently. One asked Foundry, which honours
your scene's diagonal rule; the other used Pythagoras. On a square grid they disagree about every
diagonal, so the planner would judge a creature out of reach and the mover would then try to close a
two-foot gap that has no square in it. Everything measures distance the one way now.

**A gap smaller than one square is refused once, out loud.** Previously it was attempted eight times
in eight directions, every one of them landing back on the square the creature already occupied. If
your world uses the "Exact (√2)" diagonal rule, a diagonally adjacent creature really is 7 ft away and
genuinely cannot be reached with a 5 ft reach; the log now says the grid has nothing nearer instead of
falling silent. The default "Equidistant" rule has no such gap.

**A move announced as "advances 7 ft" for one diagonal square now says 5 ft**, or whatever your scene
says a diagonal costs.


## 0.6.3

**The rulebook is no longer read off your sheets.** The 2024 rules glossary ships as pressable items — Dash,
Dodge, Hide, Ready, Stabilize, Jump, Long Rest, Underwater, Unarmed Strike and the rest — and the PHB content
module and DDB Importer put them on every character. So a single wizard presented 123 "abilities" to be read,
and reading the general rules cost real time and real credit once per new wording. Worse than the bill: a
compiled Hide is a rule firing beside the Hide this module already implements, and a compiled Long Rest edits
a ledger that already has an owner. Those items are now declined before anything is asked, with a line in the
console saying which and why. A homebrew feature that happens to share one of those names is still read
normally, and `flags.noodlr-hooks-55e.compileAnyway` forces a reading of anything.

**Diagnostics print instead of returning.** `surveyCapabilities()` gained each rule's conditions last
release and it made no difference, because a browser console shows a nested result as `Object { … }` and
what gets copied out of a bug report is that one collapsed line. It now prints a flat block, one line per
rule, and says **"guards: NONE"** in as many words when a rule has no conditions — which is the whole
question when something fires at the wrong moment, and an omitted line reads as a rule that simply has none
to show.


**A troll sheds a limb when it is bloodied, and gains the exhaustion for it.** Last release removed the
GM-only notes that were talking the compiler out of rules; a second kind of tooling text was still getting
through, and it was welded to the rule rather than sitting in a note beside it. The troll's own stat block
reads "1 Exhaustion (apply=false) level for each missing limb" — that switch tells the chat card not to
draw a button, and read as an instruction it says plainly not to apply the exhaustion. There are 1,128 of
these across the books, almost all of them attached to a condition. The compiler now reads the words and
not the markup, which fixes the missing exhaustion and any other condition that came through disarmed.
Anything compiled before this release is re-read automatically the next time its scene loads.

**Diagnostics say when a rule fires, not just what it does.** `surveyCapabilities()` listed a rule's
trigger, effect and cost and never its conditions, so "this ability keeps going off at the wrong time" —
which is the usual complaint — was the one thing it could not help with. It now prints each guard and the
whole rule in plain English.

**Hiding never refuses you again.** Pressing Hide used to be answered with "you cannot hide" whenever an
enemy had line of sight or the roll came in under 15, which is the printed 2024 rule and is not how most
tables play it. Now the roll always happens and always sticks: whatever you rolled becomes the number an
enemy has to beat to notice you. Anything that was already looking straight at you simply starts out
having noticed — so hiding in plain sight of a guard costs you the action and buys you nothing *from that
guard*, while still hiding you from everyone further down the corridor. Break line of sight with the guard
and it loses you like everyone else. The old behaviour is one switch away, under House Rules.

**And the card never says who noticed you, or how many.** A hide reads the same to the table whether the
corridor is empty or four guards are watching. Telling a player "hidden, but two of them can see you" hands
them the presence and the size of a group they had no way to know about, from an action that succeeded, and
there is no taking it back. The GM gets the names in a whisper; the player finds out by being noticed.

**Being spotted by one enemy no longer reveals you to all of them.** This is the substantive half. Stealth
and invisibility were being ended the same way, and they are not the same thing: a sentry seeing you should
not hand your position to the four guards around the corner. Each enemy now has its own answer, tracked
per watcher and updated as people move — found when one of them beats your number, lost again when it can
no longer see you. Attacking, casting aloud and invisibility ending still reveal you to everybody at once,
which is correct and is the difference.

**A monster that meets a wall walks round it.** It walked into the wall and stood there for the rest of the
fight instead — reported with a Troll, and it was every creature. When the direct line was blocked the only
alternatives tried were shorter steps along the same blocked line. It now fans out to either side and takes
whichever legal step closes the most ground. Still not pathfinding: a creature three corners away gets
closer each turn rather than solving the maze, but it no longer stops.

## 0.6.1

**Sneak Attack applies again, and so does every heal.** The damage lock from 0.6.0 was reaching cards it
had no business on. It was drawn only on attack cards, correctly — but it *refused* on any card with a
Damage button at all, so a rogue's Sneak Attack, every Heal and every standalone Damage activity was
blocked with no lock visible to explain it and no way to press past it. One rule now decides both, so a
refusal cannot land on a card the lock was never drawn on.

**A troll's severed limbs stop at four.** Two separate faults, and between them the count ran away. Where
a compiled ability keeps its allowance on one rule and its effect on another — which is how the Troll's
Loathsome Limbs came back — an empty pool reported "no uses left" and the summon beside it went ahead
anyway. Paying now comes first, whatever order the rules are written in, and nothing else in that
ability happens if the creature could not pay. Separately, the summoned limbs were never being counted
against the standing cap at all: the two halves of that check were identifying the summoner by different
names, so the tally always read zero.

**Notes written for you are no longer read as rules.** The 2024 stat blocks carry authoring asides in
a hidden section, and the Troll's says in plain English that its exhaustion has to be applied by hand.
The compiler was reading that instruction and obliging — which is why the ability came back with no
exhaustion in it and no condition on when it fires. Anything addressed to the reader rather than to
the game is now taken out before an ability is compiled, and the game's own words are left where they
were: the Troll's own text says it has an Exhaustion level per missing limb in the sentence right
above the note. **Your Troll needs recompiling to pick this up:** open the capability sheet and clear
its Loathsome Limbs entry, or purge the cache.

Two things worth knowing about how that works. A hidden section holding real rules is **kept** — a
monster's curse or disease that the players are not meant to read is still a rule, and 55 of those
ship with the system. And where an instruction about Foundry turns up in the open, in the middle of
the rule text itself, the sentence is removed and **you are told about it by name**, so you can judge
whether it mattered. All of it was measured against every one of dnd5e's 31,845 ability descriptions:
848 hidden sections, of which 793 are authoring notes and every single one opens with the words
"Foundry Note", and five descriptions carrying a note out in the open (Wild Shape and a fighting-style
pick, both telling you to drag something onto your sheet).

**Monsters stop bellowing for help within arm's reach of each other.** A creature of animal intelligence
is *meant* to choose badly — that is what makes it read as an animal rather than a chess engine — but
calling for help was competing on those terms against walking toward the enemy, and winning about half
the time. It is a last resort again, offered only when there is genuinely nothing else the creature can
do.

**"Advances on you" now says how far.** An advance is entirely its movement, so a line that omits the
distance reads the same whether the creature crossed forty feet or stood still — which is exactly how a
pack of limbs being outrun by a Dashing rogue came to look like a pack of limbs sitting in place. The
announcement is amended with the ground actually covered, or says plainly that none was.

**Two console errors gone**, both the same one: a summoned creature whose initiative was described in
words rather than numbers was rejected by Foundry outright, so it was never slotted in behind its
summoner and turned up later in a random place in the order instead.

**Two advisories added** for things outside this module that look like it. A teleport whose destination
is occupied is cancelled by the system silently, after the spell slot has been spent and the visual
effects have played — if a Misty Step costs a slot and nothing moves, the settings page now names the
cause. And a missing setting can no longer stop a later advisory from being shown, which was hiding the
Bloodied warning on some versions.

## 0.6.0

**The Damage button waits its turn.** The two commonest mistakes at a table are the two the chat card
invites: rolling damage on a miss, and rolling it twice because the first press produced no visible
change. Damage is now held until the attack has been rolled and everybody who might turn it aside has
had their say — a Shield cast in reply turns a hit into a miss, so the button cannot open before that
window closes. It goes **green** when the attack landed, and one press closes it. A GM who disagrees
with any of this gets an "Unlock" button beside it; a player does not, because for them the lock is
the point.

It fails open, on purpose. No GM online, no verdict the module could reach, an attack against nobody,
or simply nothing arriving within thirty seconds, and the button hands itself back the way it always
worked. A lock with no way out would be far worse than the mistakes it prevents. Switch the whole
thing off in Combat settings if you would rather press it yourself.

**Graze does the right thing on a miss.** A Greatsword and the other Graze weapons deal their ability
modifier to a creature they missed — flat, no dice — and nothing in Foundry has ever applied it.
Pressing Damage would roll the weapon's dice, which is not what Graze deals, so the button stays shut
and the correct amount is applied for you.

**Chat cards, half the height.** Same fonts, much less air. There is a per-client toggle in Foundry's
own settings list, so each person at the table decides for themselves.

**The Bloodied status.** It turns out you already have one — dnd5e applies it at half hit points and
several compiled abilities key off it. What it also has is an off switch, and with it off the status
is never created, so those abilities silently never fire. The settings page now says who owns this
and warns you when it has been switched off.

**Fixes from the first play test of automatic damage.** Six, and two of them are about a Troll that
would not stop.

**A dead creature no longer runs its stat block.** A Troll marked dead kept summoning a limb a round
for the rest of the fight. Nothing a creature's abilities say is acted on once it is out of the fight,
with the deliberate exception of rules that are *about* being at zero hit points.

**A summoned creature may not summon.** The published bestiary closes a circle by itself: a Troll's
Loathsome Limbs makes a Troll Limb, and a Troll Limb's Troll Spawn makes a Troll. Read as instructions
rather than as the once-a-day and the one-in-twelve-after-24-hours they really are, that is a loop with
no end and no per-creature allowance can close it, because every new Troll gets a fresh one. The second
link is now refused. There is also a ceiling of eight summoned creatures standing per summoner, however
often its ability says it may fire.

**An ability with no uses left now refuses instead of firing for free.** A 4/day feature counted down
to zero and then went on reporting "0 left" and working, which is how four limbs became a great many.

A creature with Regeneration announced the full amount every turn whether or not it had anywhere to put
it, so a Troll at 84 out of 84 hit points read as gaining 15 a round forever. It was never actually
gaining them — the healing has always stopped at the maximum — but the chat line said otherwise, which
is indistinguishable from a bug. It now reports what it restored, and says nothing at all when there was
nothing to restore.

**A compiled ability can no longer kill anything.** The same Troll announced that it was dead in the
middle of a fight it was winning, because its own stat block says it dies only if it ends its turn at 0
hit points with fire or acid damage on it, and the restriction was read as the instruction. Rules
compiled from a stat block may now heal, harm, summon and apply any condition except the ones that
remove a creature from play — those belong to the dying rules and to you, where they can be argued with.

Damage rolled after a **missed** attack was handed back to you with an Apply button and the message "no
attack roll was recorded", which was not true: the attack was recorded, and it missed. A miss is now
recognised for what it is and quietly applies nothing. An attack that named no target at all still asks
you to press the button, and now says so in those words.

## 0.5.1

**Monsters lie in wait.** The Ready action shipped last release for the party and for a GM driving a
creature by hand; nothing chose it on its own. A monster clever enough to ready one — the same
intelligence gate as before, so beasts and oozes are not asked — will now sometimes hold an attack for
something to happen instead of spending its turn walking towards you. An archer with nobody in range is
the case it gets right most often: waiting costs it nothing and buys a shot the moment you come round the
corner, before you have acted. A creature with only a blade holds a corridor now and then and closes the
rest of the time, which is roughly how an ambusher plays.

What it is waiting for is picked from the same short list of common triggers the party sees, paired with
an attack that can actually answer it: something in reach for a melee weapon, something arriving at a
distance for a bow or a spell. **It never holds anything it cannot get back** — no breath weapons, no
limited-use abilities, no spell slots — because the release prompt runs on a clock and a dragon should not
spend its breath on the first goblin through the door. The declaration is whispered to you rather than
announced, so what the creature is waiting for stays yours to know; the party sees only that it is
waiting.

## 0.5.0

**The Ready action, with a trigger you write yourself.** Everybody knows this rule and almost nobody uses
it, because a held action is a promise nothing at the table keeps track of: you tell the GM what you are
waiting for, six things happen, and either you remember or you do not. Pressing Ready now asks what you
are waiting for, spends your Action, and then watches the round for you — movement, damage, a creature
going down, a spell being cast, an attack, a condition landing, something coming into view, a door, the
end of a turn, and anything the GM narrates. When it happens you are asked to confirm on the usual
six-second clock, and **this is the one prompt the clock says yes to**, because you already said this is
what you wanted. Letting it go is the deliberate choice and costs you the Action and nothing else.

Releasing spends your Reaction, so a readied Attack is one attack — Extra Attack wants the Attack action
on your own turn. If nothing triggers it before your next turn it is lost, and being knocked out loses it
too. You can hold movement instead of an action. Held spells diverge from the letter of the rules in the
generous direction: the slot is spent when the spell goes off rather than when it is readied, so a
readied spell that never fires costs the Action and keeps the slot.

**If Noodlr's AI game master module is installed you can write the trigger in your own words** — "if a
goblin I can see approaches an ally, I shoot it", "if I hear the sound of weapons being drawn behind that
door, I hide" — and you are shown how it was read before anything is spent. Without it, a list of the
common triggers is offered instead, which is what monsters use in any case: a creature clever enough to
lie in wait gets the picker, and the rest are not asked. That AI reading is only paid for where words are
genuinely needed; everything that can be answered by measuring a distance or reading a condition is
answered here, for nothing.

**Silvery Barbs works, along with anything else that spoils a roll after it lands.** The spell is famously
hard to run because the die is on screen and the consequence follows immediately, so playing it means
asking the whole table to hold on. A made saving throw and a landing attack are now held for a moment
when an opposed creature within 60 feet can see the roller, is holding the spell and still has its
reaction; the d20 is rerolled and the lower result kept, shown on the card the way any roll made with
disadvantage is shown. Only the reroll is automated — the ally who gains Advantage is whatever your copy
of the spell carries, because that is a promise about a roll nobody has made yet. **The clock never casts
it for anybody:** the fresh die may be higher and the roll stands anyway, which makes it a slot spent on
a gamble. Ability checks are not offered, since nothing here holds a check's verdict open.

Two new switches, both on: **Hold a success open for Silvery Barbs** and **Hold an action for a trigger
you name**. Barbs stands aside for Gambit's Premades wherever Midi QoL is installed to carry it.

## 0.4.3

**Counterspell works.** It is the reaction spellcasters most expect to exist and the one that has never
worked: catching a cast means noticing it in the half-second before the damage card appears, so in practice
it is played by asking the table to rewind. A spell with Verbal, Somatic or Material components is now held
open for a moment when an opposed creature within 60 feet can see it, is holding Counterspell, and still has
its reaction. Everyone else's casts are untouched, and nothing is held at all when no such creature exists —
which is nearly every cast, so an ordinary turn is exactly as fast as it was.

The 2024 rules are what make this honest rather than a workaround. The caster makes a Constitution save
against the counterspeller's spell save DC, and a countered spell **costs the action but not the slot** —
which is precisely what happens when the cast is stopped before the system charges for it. On a success the
spell goes off as cast, having lost nothing but a few seconds. A boss can spend a legendary resistance to
push through, and is asked on the same clock as everywhere else.

At most two creatures are asked, on the six-second clock, and **the clock never spends the slot for them** —
a third-level slot taken by a timer is unforgivable, and there is no free version of this spell. A creature
that cannot hear is not offered a cast that has nothing to see: verbal components and nothing else means the
only way to notice it is to hear it. New switch, **Hold a cast open for Counterspell**, split by the
*caster* rather than the counterspeller — what this costs is a pause on somebody's cast, so the side whose
spells may be delayed is the side that governs it. Both start on. It stands aside for Gambit's Premades,
which does this properly wherever Midi QoL is installed to carry it.

Still not offered: **Silvery Barbs**. It needs a d20 somebody else already rolled to be taken back, and an
offer that cannot be honoured spends the slot and changes nothing.

## 0.4.2

Damage lands by itself now, saving throws settle what they are worth, and a reaction is offered to whoever
plays the creature. All three were reported from the same smoke test: a player hit a hostile with a ranged
weapon, the fight started and the monsters rolled initiative on their own — and then the GM got a chat card
with an Apply button on it.

**Rolled damage is applied, and the whole chain behind it switches on.** The 5e system works out whether an
attack hit inside the chat card it draws and then stores the answer nowhere, so it has nothing to act on; what
it gives you instead is a button, once per target, for every hit at the table. That button is now pressed for
you. Resistance, vulnerability, immunity, damage properties and temporary hit points are all resolved by the
system itself — none of that arithmetic is redone here — and a whispered receipt says what moved, with a "Put
it back" control on it. This is also what turns on every rule that was already built and could never fire:
death saves, dropping to Unconscious at zero, instant death, and the concentration check all hang off the
system's damage hook, which only fires when somebody's hit points actually change.

Where the answer is genuinely unclear it applies nothing, leaves the button exactly where it was, and says
why: no readable AC (total cover, or a sheet it cannot read), two copies of a creature the target record
cannot tell apart, a roll that came from no item, or a sheet with no hit points. A wrong subtraction is worse
than a click, and silence is worse than either.

**Saving throws are joined back to the spell that asked for them.** The system rolls a save against the right
DC and then compares it to nothing, so the result is a number in chat and a person works out half of 24. A
save now settles the damage — half, none, or the full amount, whichever that spell says a success is worth.
Creatures nobody but you can roll for roll their own saves the moment the spell is used, so a fireball on five
goblins costs you no presses at all; characters with a player owner are left alone, because that player came
to the table to roll their own dice. What a failed save *inflicts* beyond damage is not applied — that is
written as prose on the item, and guessing at it would start an argument.

**A reaction is offered when one comes up, on a six-second clock.** A reaction is the one resource in the game
that is lost by not noticing it, and nothing in the stack tells anybody theirs has come up. The creature's own
options are now put in front of whoever plays it — the player who owns the sheet, or you for a monster — once
per round, and whatever they choose is rolled on that person's own client.

What the clock is allowed to pick by itself is deliberately narrow, and it is the rule this feature lives or
dies by: a free swing with the weapon already in hand, yes, because an unused reaction is gone at the end of
the round anyway. A spell slot or a limited use, never, whatever the clock says. Creatures this module is
playing for you are not asked at all — they have a planner to decide — so this never becomes a queue of
dialogs about goblins.

**Shield works, which it never has without Midi QoL.** It triggers "when you are hit by an attack", and until
now there was no such moment: the system rolled a number and rendered a colour. Reading hits created the
moment, so the spell is offered to the creature that was hit — and only when it would actually change the
answer. A +5 against an attack that beat your AC by nine is a slot spent to be hit anyway, and an offer under
a clock reads as a recommendation.

Not offered, and honestly rather than quietly: **Counterspell** and **Silvery Barbs**. One triggers on a
creature beginning to cast and the other on a d20 somebody else rolled, and neither event is reported by
anything we can listen to. An offer that cannot be honoured spends the resource and changes nothing.

**A legendary resistance is offered before the damage lands.** This one is a regression the three features
above would have introduced, so it ships with them. The system already draws a "Resist" button on a failed
monster save and waits for someone to notice it — which worked fine while you were also applying the damage by
hand, because the same pause served both. A save that now rolls itself and settles its own damage in one
breath leaves that button sitting on a card whose consequences have already happened. So you are asked
instead, on the same six-second clock, before anything is applied; and if you press the system's own button
during the pause, that is now read and honoured rather than ignored.

You are only asked where it changes something worth changing: a failure that does anything other than damage,
or damage worth a real share of what the creature has left. A lich is not asked about a Firebolt — a prompt on
every failed save teaches you to dismiss prompts, and then the one that mattered gets dismissed too. If the
clock runs out the creature takes it, because three resistances a day is the most depleting resource in the
game and no timer should spend one for you.

New switches: **Apply rolled damage without the button** and **Offer a reaction when one comes up**, both per
side and both on; **Let saving throws settle the damage** and **Offer a legendary resistance on a failed save**
for the table as a whole. Everything stands aside where Midi QoL is doing the same job — including its reaction
prompts, which unlike most of its mechanics ship switched on, so if you run midi you keep its prompt for hits
and damage and this module's for opportunity attacks. The rules windows say who owns which.

**Compiled per-day and per-rest abilities come back after a rest.** A bug rather than a feature, and only
reachable by tables running the capability compiler: an ability read off a creature's own prose as "1/day" or
"recharges on a short rest" recorded the use correctly and then never gave it back, because nothing was
telling that ledger a rest had happened. Once per campaign instead of once per day, silently. Resting now
restores it, and a rest marked as a new day restores the daily ones whether it was long or short. Nothing
that dnd5e recovers on its own — uses printed on a sheet, spell slots, hit dice — was ever affected.

**One thing the system ships switched off, now said out loud.** dnd5e can roll a monster's Recharge 5-6 at the
start of its turn and defaults to not doing it, in a setting that is not in Foundry's settings list at all
(Configure Settings → dnd5e → Combat → Monsters → Auto-recharge). Nothing here does it instead, so a spent
breath weapon stays spent until somebody remembers. The rules windows now say so rather than leaving you to
notice.

## 0.4.1

Three bugs in one chat card, all reported from the first few seconds of playing as a player, and all in the
Hide action.

- **Hiding was refused by creatures that could not see you.** "Out of any enemy's line of sight" was being
  tested as "no wall is in the way", which left out distance, darkness and darkvision range entirely — so a
  rogue a hundred feet away in unlit woodland was told they were in plain view of nine hostiles that could
  not, in fact, see them. The clue was that no fight had started: the part of this module that decides
  whether a monster notices you had already worked out the truth, and the Hide check was asking a different
  question. It now asks the same one, and only judges cover against enemies that can genuinely see you.
- **A refused hide listed every hostile in the scene, publicly.** Pressing Hide and failing handed the whole
  table the names, the count and the creature types of everything waiting for them. The card now says only
  that there is nowhere to hide from here; the GM gets the details in a whisper, and `api.surveyHide()`
  still prints everything.
- **You became Hidden even when the action was refused.** Argon's action bar stamps the Hiding status itself,
  immediately after the action and regardless of what the action decided, so a player was told they could
  not hide and was hidden anyway — at their passive Stealth, for free. The status is now made to agree with
  the ruling. The same fix covers the opposite case: pressing Hide while already hidden used to switch the
  status off underneath a successful roll.

Also: the rules windows now warn when the **scene** makes these rules meaningless. A scene with Token
Vision switched off shows every token to everybody, so nothing can hide from anything; a scene with no walls
has nothing to break line of sight with. Both are core Foundry scene settings, in the scene's Vision tab —
no module sets them and none can work around them. If players can see every hostile token and there is no
Fog of War, that is where to look.

## 0.4.0

The whole of D&D 5e (2024) was mined into a machine-readable corpus and this release is what reading it
found: four rules this module was getting wrong, and three it was not attempting. Nothing here was
noticed at a table — the corpus named each one, and then each one was checked against the actual code
before being believed.

### Four things that were wrong

- **Jumping ignored everything that changes a jump.** A character with Jump cast on them, a Bullywug,
  a Grasshopper, a monk spending Focus, an Athlete or a Jumper was still measured against their bare
  Strength score, so a legal leap was refused. Fixed distances ("its Long Jump is up to 25 feet"),
  ability substitutions, doubling, and the "with or without a running start" clause are all read off
  the sheet now, and `api.surveyJump()` names which of them applied.
- **Flyby was not exempting anything.** A creature whose sheet says it "doesn't provoke Opportunity
  Attacks when it flies out of an enemy's reach" was provoking them. Flyby and its relatives — Agile
  Flyer, Wing Flap, the Mobile feat's version — are now honoured.
- **A Pact of the Blade warlock got one attack.** Thirsting Blade grants Extra Attack as an invocation
  rather than as a class feature, so it carries none of the identifiers the action economy was reading
  and the warlock's second swing was refused as over budget. Devouring Blade's third attack was missing
  for the same reason.
- **Two-weapon fighting had no accounting at all.** The Light property's extra swing costs the bonus
  action and may be taken once per turn; the Nick mastery makes it free. Neither was tracked, so a
  fighter could take it every round for nothing and a rogue's Cunning Action was still available after
  spending the bonus action on an off-hand attack.

### Three things it was not doing

- **An effect that ends on a save now gets its save**, at the end of each of the afflicted creature's
  turns, with the effect removed on a success and the whole thing announced. This is the single most
  common shape in the game after "roll to hit" and nothing in the world was doing it — if Midi QoL is
  running its own `OverTime` timer for a particular effect, this stands aside for it. There is a switch
  in Combat Rules, and `api.surveyRepeatSaves()` lists what is pending.
- **Attacking something you cannot see, and being something that cannot be seen.** Disadvantage for the
  first, Advantage for the second, worked out per-creature against real vision rather than against what
  your own screen happens to show. It stands aside when Automated Conditions 5e or Midi QoL are
  configured to do it.
- **Shooting with an enemy next to you is now at Disadvantage.** Same stand-aside rules.

### The capability sheet was calling a third of its own work useless

Of everything the ability reader extracts, the largest single category by far is properties that are
permanently true — a sense, a resistance, an extra attack, "it can breathe water". Those have no
moment at which they happen, so nothing fires them, and the sheet was badging every one of them **not
run**. That read as the reader having wasted your credit. They are now badged **always true** and, more
to the point, they are actually consulted: a compiled sense fills a gap in what the sheet states rather
than sitting in a cache. `api.surveyStanding()` shows what a creature has.

## 0.3.0

### The settings windows work now, and there are no tabs

The Combat page had three navigation tabs and they were broken: whichever pane was showing could not be
left, so the other two were unreachable. The cause was a name collision — `tab` is a word Foundry
reserves for its own use, and it was quietly handling every click before this module got a look in.

Rather than fix the tabs, they are gone. **The NPC and player settings are drawn side by side**, which
is what they should always have been: choosing death saves for the party and a clean kill for the mooks
is one decision, and a tab strip turned reading it into an act of memory.

- **Three rules are now set separately for monsters and for player characters** — dying and death
  saves, concentration, and the action economy. Your existing setting is copied to both sides on
  upgrade, so nothing changes at your table until you change it.
- Which side a creature falls on is decided by its sheet, not by who owns the token. A world set to
  "All Players: Owner" makes every goblin player-owned, and that must not put the bestiary under the
  party's settings.
- The rules that read the same for everybody — shoving, the Speed cap, opportunity attacks — stay full
  width. The Speed cap already exempts the GM and every creature this module plays, so splitting it
  would have offered a switch whose other half does nothing.
- The Combat page is also reorganised: staying upright and what one turn allows, then taking a turn,
  then resources, then the whole rolling-and-reporting workflow that this module deliberately leaves to
  a human. Nothing was removed.

### Save, and legibility

- **A "Save" button in the title bar**, which turns amber the moment you change anything — the same
  button, in the same place, as the main Noodlr module's settings. Changes are now written when you
  save rather than the instant you click a checkbox. That is what lets the ownership badges beside each
  rule stay honest: turning concentration off changes what the row next to it reports, and the window
  can only recompute that after a write.
  - The exposure is the usual one and is why the button changes colour: close the window without
    saving and your edits are lost.
- **The fonts are readable.** They had been rendering far smaller than intended.
- Text in these windows can be selected and copied again, which matters most for the hints that name
  another module's setting.

## 0.2.3

### Four more buttons that were doing nothing

Last release fixed the Hide button. That turned out to be one instance of a pattern rather than a bug
on its own: several rules this module implements were reachable only by typing a command into the
browser console, while the button for the same action sat on the action bar doing something else. So
every one of the thirteen Player's Handbook actions was checked against what pressing it actually does,
and the list is now on the record — `api.surveyActionButtons()` prints it for your own characters.

- **Influence** now asks the GM the one question software cannot answer — is the creature willing,
  hesitant or unwilling — and then rolls the real check on the influencing character's own sheet: DC 15
  or the creature's Intelligence score, Advantage if it is Friendly, Disadvantage if it is Hostile, and
  a failed attempt closes that approach for 24 hours. A player can press it; the GM's client answers.
  With no GM connected it says so and costs nothing, because no ruling means no action was taken.
- **Stabilize** administers first aid: a DC 10 Wisdom (Medicine) check on whatever you have targeted,
  announced whether it lands or not, and the Action spent either way.
- **Disengage** now stops opportunity attacks. It never did before. The item applies no condition of
  its own, and the only thing this module could previously look for was an effect *named* something
  like "disengage", which stock D&D 5e never creates — so the Action was spent and the creature was
  struck at anyway as it walked away.
- **Dodge** now grants what it says: attacks against you at Disadvantage while you can see the
  attacker, Dexterity saves at Advantage, and both lost if you are Incapacitated or your Speed drops
  to zero. **And it ends at the start of your next turn**, which nothing in the stack was doing —
  D&D 5e ships the Dodging condition and reads it nowhere, so a Dodge taken in round one was still lit
  in round nine.

Help, Ready and Search remain unbuilt on purpose, and now say so rather than looking broken: Help is a
promise about a roll somebody else makes later, Ready is a trigger written in prose, and a Search is one
of four skills whose result is the GM's to interpret.

Nothing else changed. Rogues keep Cunning Action intact — Dash, Disengage and Hide are still three
separate things, and pressing one does not press the others.

## 0.2.2

### The Hide button on your sheet now actually hides you

Reported from play, and worse than it looked. Everything Noodlr Hooks does for the Hide action — the
cover and line-of-sight check, a real Stealth roll on your own sheet, and the DC that anyone
searching has to beat — could only be reached by typing a command into the browser console. There is
no toolbar button and no keybind.

So the Hide button you actually press, the one from the Player's Handbook that Argon puts on your
action bar, spent your Action and did nothing else. No check on whether you had anywhere to hide, no
roll, and no number for the guard to beat. If the item applied the Hiding condition at all, anyone
looking for you rolled against your passive Stealth instead of the check you never made.

Pressing Hide anywhere now runs the same rule. One Action, or a bonus action if you have Cunning
Action, Nimble Escape or Shadow Stealth. Rogues keep the rest of Cunning Action untouched: Dash and
Disengage behave exactly as before.

**Pressing Hide again does not un-hide you**, and is not meant to — that is a second Hide action with
a new DC. To stop hiding, remove the Hiding condition from the token, which is the one place the
module reads it from. It also clears itself when you attack, cast a spell out loud, or the fight ends.

### Not us: a console error from Token Note Hover

If you see `canvas.hud.tokenNoteHover is undefined` in the console, that is Token Note Hover 4.1.2,
and it throws whenever you select a token before hovering over one. It is harmless and nothing of
ours is affected. Hover any token once after a reload to silence it.

## 0.2.1

Two fixes, both found by looking at what the 2024 Player's Handbook module actually puts on a
character sheet.

### Pressing Attack no longer costs you your action

The Player's Handbook ships all thirteen actions as items, so your sheet and Argon's action bar can
offer them as buttons. Two of them — **Attack** and **Magic** — only announce what you are about to
do; the weapon or the spell that follows is the thing that actually costs an Action. Both were being
charged, so a character without Extra Attack could press Attack, swing once, and be told the action
was already spent.

The buttons are now free and the follow-through pays, which is how the ledger always counted a
fighter's swings anyway. Pressing Attack and then thinking better of it costs nothing.

Dash and Hide are deliberately left alone: they are charged in one place already, and the Dash
button has to record itself so the movement cap knows the extra Speed is paid for.

### The capability sheet stops calling dead rules alive

Compiled abilities are badged active or inert on the capability sheet. The badge looked at whether
the effect could run but never at whether anything listens for the trigger, so a perfectly good
"heals at the end of a long rest" was shown as active while nothing would ever fire it. Five of the
seventeen trigger events are wired in this build, and the sheet now says so honestly.

### Two new warnings in the settings windows

**Monk's Token Bar** suppresses the game system's own chat card for group and contested rolls, so
those rolls carry none of the data this module reads. A Stealth check requested through the token bar
will not hide anybody. Roll from the sheet when the result has to be enforced.

**Hurry Up** advances the turn when its timer expires without asking whether a turn is still being
played out, which can skip or double-advance an automated creature's turn. Turning off its "Run for
NPCs" scopes the timer to players and removes the conflict.

Cover was also removed from the list of rules planned here: Simple Cover 5e already sets the cover
status and adjusts Armor Class and Dexterity saves, so a second implementation would apply it twice
rather than fill a gap.

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
