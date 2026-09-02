# Changelog

## 0.7.44

**A demanded off-turn roll cannot be walked past.** A save, skill check,
contested ability check, or concentration check that sits on a chat-card
button now prompts on the owner's client. If they do not roll, Foundry
rolls against that sheet. There is no Skip. Initiative will not advance,
and that token cannot walk or use an activity, until every target of the
demand has a die — Mass Suggestion on four characters holds until all
four exist. Legendary actions fire after the tracker has already moved,
so the hold sits there before the new combatant acts.

Two clocks on the Combat page (Rolling and reporting): **GM** defaults to
0 (roll immediately, no dialog — a Fireball on five goblins still costs
no presses) and **Players** defaults to 6. Either can go to 120. 0 means
full automation for that audience. Who is elected to roll picks the
clock, not sheet type.

Opportunity attacks and damage stay on their own layers (the reaction
prompt, and auto-damage). This gate is the demanded check that used to
sit unpressed while the fight moved on.

**Melee Advantage against a stunned Large creature.** A single
centre-to-centre wall ray was inventing Disadvantage ("unseen target")
and cancelling the stunned Advantage highlight. Sight now walks occupied
squares and fails toward "can see."

## 0.7.43

**Using an ability is not the verdict.** Stunning Strike wrote Advantage on the
Monk the moment the button was pressed, so it was already sitting there after
the Beholder bought the save with Legendary Resistance. Contest-contingent
riders (Advantage, Speed, statuses, damage) now wait for a hit or a save
result on attack and save activities. Reckless Attack is unchanged — it is a
Utility. An item that only declares `onSave: false` no longer applies compiled
2024 consolation on a success. A bought save also strips leftover use-time
effects. No world recompile. Delete any leftover Advantage already on a sheet
by hand (or the next bought save will).

## 0.7.42

**A known-but-uncast spell is not a live effect.** Feast of Flesh granted
Advantage to the caster on any damage while it sat unprepared on the sheet,
and Investiture of Wind / Beast of Ragnarok put Disadvantage on every
attack. Compiled riders now run only for feats, equipped weapons, or a
spell/consumable the creature is concentrating on or actually wearing.
Armor of Agathys-style damage while concentrating is unchanged. No world
recompile.

**Lightning Bolt leaves after six seconds.** Player-placed instant templates
often arrived unstamped (dnd5e writes the origin after our create hook), so
the cleanup clock restarted every poll and the line sat through the rest of
the turn. Unstamped ability templates are adopted from their created time,
and an instant vanishes after 6 s even if that turn is still live.

**Calendaria no longer floods the player console.** Riding read Foundry's
`updateSetting` arguments in the wrong order, so every world-time tick
threw `key.endsWith is not a function`.

## 0.7.41

**A wall is not line of sight, even if nobody hid.** Awareness only asked
vision about creatures that were deliberately hiding, so a Monk who dashed
through two closed doors stayed on the Beholder's board. The Beholder then
fired a Disintegration Ray at 50 ft and hid from someone who already could
not see it. Walls and closed doors now drop a target from `enemies` for
everyone — legendary Eye Rays and the planned turn share that filter.
Someone seen earlier becomes a search, not a ray. Darkness and sense range
are still only applied to hiders, so an archer on a large map is not
suddenly blind at 61 ft.

## 0.7.40

**Glare actually fires an Eye Ray.** A DDB Beholder's legendary "Glare" is
prose that says to use Eye Rays; using the utility spent a legendary action
and stared. The module now follows that pointer (and Chomp → two Bites):
spend the utility so dnd5e decrements the pool, roll a real 1d10, then use
the matching ray. A utility that points at nothing is not offered.

**dnd5e's Legendary Action refill is not RAW, and we do not override it.**
The book and dnd5e's own flavour text restore uses at the start of the
monster's turn; the system zeroes `spent` at the end of that turn. Same
number of rays in a round if it cannot spend on its own turn. A RAW
start-of-turn override is listed under Combat → Not built yet — expected
request, not a hotfix. Legendary resistances still refill only on a long
rest.

## 0.7.39

**Legendary creatures we play use one legendary action at the end of another
creature's turn.** dnd5e already tracks the pool and spends it on use; nobody
pressed the button at the right moment. After a player (or anyone else) ends
their turn, an automated Beholder fires one Eye Ray it can reach — not all
three, and not at the end of its own turn (that is when the pool refills).
Stun / Incapacitated uses the same walk that skips the turn and the
Opportunity Attack. Melee options that cannot reach are skipped; a legendary
action does not walk. Lair actions are still unbuilt. A creature you are
driving by hand is untouched. `noodlrHooks.surveyLegendaryActions()`.

## 0.7.38

**A Stunned creature no longer takes Opportunity Attacks.** The planner already
skipped their turn (`isIncapacitated` walks Active Effects). Reactions only
asked `actor.statuses.has` and treated a missing or array-shaped bag as "can
react", so a Stunned Beholder bit the Monk who walked away to test RAW Stun.
Reactions now use the same status walk, log why a watcher is held, and re-check
before the swing. Grappled still reacts; dead does not.

**A legendary creature we are playing spends Resistance on Stun.** The clock
still declines when the GM is driving (a 3/day resource). Automated, it spends
on stunned / paralyzed / petrified / unconscious / incapacitated, and a
fight-ending status outranks chip damage. Legendary *actions* (Eye Rays at the
end of someone else's turn) are still unbuilt.

## 0.7.37

**A Large creature already next to you stops trying to close, and Polearm Master
fires once.** v0.7.36 fixed reaction distance and left the planner measuring
centres, so a Beholder adjacent to a Medium monk still "needed to close 3 ft",
found no nearer square, and never Bit. Token-to-token distance is now the same
closest-squares reading everywhere a swing or a step uses it. The same walk
then offered Reactive Strike twice: Foundry fires `moveToken` per square, and
both offers started before the reaction was spent. Entering a given enemy's
reach is now claimed once until your next turn, waypoint hooks run one at a
time, and a second dialog for the same creature is refused. You still have one
reaction, however many combatants walked past. Declining Reactive Strike does
not eat the Opportunity Attack if that same creature then leaves.

## 0.7.36

**A Large creature next to you is in your melee reach, and Polearm Master's Reactive Strike
fires when they step in.** Opportunity attacks measured centre-to-centre, so a Large Beholder
adjacent to a Medium monk read as ~8 ft away and never left a 5 ft Quarterstaff. Distance is
now the closest occupied squares — adjacent is 5 ft for any size. Reactive Strike was never
listened for: we only watched leaving reach, and the feat's own activity is a utility the
action reader skips. Entering the polearm's reach now offers that weapon's melee attack
(Quarterstaff, Spear, or Heavy+Reach). Disengage and Flyby still cancel opportunity attacks
only. A Quarterstaff stays 5 ft — 2024 Polearm Master does not extend it.

## 0.7.35

**Templates leave when the effect does.** An instantaneous Fireball, breath or wail is removed
once the placing turn is over and the saves have had a few seconds to land. A Wall of Fire
requires concentration *and* has a maximum duration: a concentration break or that duration
ending — whichever first — removes the parent effect and every child template. You cannot hold
the same slot forever by concentrating. Extend Spell and other riders are read off the live
activity when the template is placed. A missing concentration effect is not treated as a break
(that is how a one-minute wall would have vanished after four seconds). A successful
Counterspell vetoes the cast before any effect or template exists. Out of combat the clock is
real time; placing a wall to block a door does not start a fight. In a fight already underway
it is rounds (1 minute = 10). A hand-drawn ruler is left alone. Switch defaults on, Combat page,
under saving throws. `noodlrHooks.surveyTemplates()`.

## 0.7.34

**Innate flyers and burrowers now use height on purpose, and changing height spends Speed.**
Automated dragons no longer fight on the floor: they rise out of melee (hover), pass and strike
(fly-by), or a bulette dives and comes up next turn. Hover height is one reach plus one square —
the size tax is what takeoff *costs*, not how high they go, so a Huge dragon pays 30 feet of Speed
to sit at +10. Fly equal to walk is now flight (an 80/80 adult dragon was jogging). Players pay
the same vertical + size tax on fly / climb / swim / burrow / high jump; walk, crawl and the GM's
own dragging do not. We still do not guess indoor / water / dirt. Spell Fly and Levitate are not
in this release.

## 0.7.33

**Movement polish: riders stop hitching, burrowers vanish, and fly / burrow out of
vertical reach no longer provoke.** The jerky Wild Shape + riders walk was a second
animation on every `updateToken` — Foundry already restarts at each grid square, and
a rider playing its own walk on top of that made it obvious. Riders now stick to the
mount's interpolated position and snap with `animate: false` when it lands. A burrower
is invisible for the move and reappears at the destination (mesh alpha, not the Hidden
flag). Opportunity attacks use a reach cylinder: if the elevation difference exceeds
the watcher's melee reach, walking by at +10 or −10 does not provoke; taking off from
adjacent still does. Flyers get a few pixels of hover; Foundry has no stock per-token
wind effect (scene weather is global, and the `wind` transition is a texture swap).

## 0.7.32

**Tokens animate at their sheet Speed, and fly / climb / jump / burrow can cross a wall at the
matching height.** Foundry slides every token at the same 6 squares per second and treats every
wall as an infinite slab, so a 30-foot walk finishes in about 2.5 seconds and a flyer at 10 feet
still stops at a maze hedge. Sheet pace reads the live movement value for the selected action
(Haste and Slow already write that) and takes the time a 6-second round implies. Mode-traverse
treats untagged walls as 10 feet tall (0 at the base) unless a wall or the scene says otherwise;
outdoors those four modes go over or under when the token's feet clear the slab, indoors the
three over-modes cannot, and burrow still can if the floor is natural. Walk and swim never. A
later taller wall still stops the path. Reads Wall Height's top/bottom when present and never
writes that namespace. Both switches default on, under House rules.

## 0.7.31

**Leftover Wild Shape Actors are deleted after the loot comes home.** A player revert never
removes the copy — dnd5e only deletes when the user is a GM, and granting Delete Actor does
not change that. After items and coin are copied, that character's spent leftover is deleted
(locally if this client can, otherwise by the GM). Other players' live forms in the same
folder are left alone; the folder itself is never emptied. If no GM is connected the leftover
stays — the copy already landed.

## 0.7.30

**Wild Shape loot now lands on the original character, including gold.** v0.7.29 copied items onto
the leftover owl in the Player folder when a second transform (or a leftover that still held
`originalActor`) overwrote the destination. Gold never moved at all: a MappingField wrapper
(`{value: 20}`) read as zero, so the currency half of the plan was empty. The stamp and the copy
now walk leftover → character, a revert also carries every other leftover for that character, and
coin is written as `system.currency.gp`. A form that landed beside the original is moved into
`Wild Shape (temp)` after create; older leftovers already in the Player folder are left for the
GM to delete.

## 0.7.29

**Loot picked up in a Wild Shape comes back with you, and the leftover copies leave the
Player Actors folder.** dnd5e creates a new Actor for a linked transform and on revert
copies only hit points and spell slots, so a potion or coin grabbed as the owl stayed on
`Drew Id (Giant Owl)` and vanished if a GM deleted it. The form is now stamped at create;
Restore Transformation copies anything new onto the original, and a later delete of a
leftover does the same if that step was skipped. Copies go in an Actors folder (default
`Wild Shape (temp)`) instead of sitting beside the real character. Ownership is unchanged
— players open the form from their token. Periodic GM clean-up of that folder is expected.

## 0.7.28

**The Wild Shape restore icon is gone.** Revert from the character sheet — that path already
worked. The token-corner / effects-panel badge never became a reliable click, so it is no
longer created, leftover `noodlr-transformed` effects are deleted on load, and Paladin aura
icons are untouched. Riders still fall off when the form reverts.

## 0.7.27

**The restore icon in the top-right effects panel is now the one that works.** Two releases were
spent fixing clicks on the token-corner sprite, and that was never the icon being pressed: Visual
Active Effects draws its own strip of effect icons in the screen's top-right, outside the canvas
entirely, so nothing there was listening. A left-click on the Wild Shape row now restores the
original form, and a click on the mounted row dismounts — plus a labelled button in each row's
tooltip. VAE's own gestures are untouched (double-click still toggles, right-click still deletes).
`noodlrHooks.surveyTransform()` now names every effect strip on screen and says which rows it
answers, so an icon that does nothing reports where it is drawn instead of leaving you guessing.

## 0.7.26

**The restore icon's click now lands, and reverting dumps every rider.** v0.7.25 hit-tested
screen coordinates against world-space sprite bounds, so the wrap ran and the click still
selected the token. Clicks now use the interaction origin (canvas space) and match the
Active Effect's own art when the texture 404s to a fallback. A revert to original form —
sheet header, our icon, or a linked actor swap — ejects the whole pack, even riders the
humanoid could still carry. Leftover tokens stacked inside a Medium footprint cannot be
clicked to dismount. Ordinary shrinks still drop only who no longer fits. The mount's Token
HUD has a dump-all control.

## 0.7.25

**The Wild Shape restore icon actually restores, and riders fall off a mount that can no longer
carry them.** Foundry never delivers pointer events to token-corner effect sprites — the click is
on the token — so the restore badge looked pressable and did nothing. Clicks are now hit-tested
inside `Token#_onClickLeft`. A linked Wild Shape revert keeps the same token id and only shrinks
it, so the old "mount deleted" path never dumped the party. Each rider is re-checked when the
mount changes size, and every six seconds; anyone who no longer fits falls off without spending
Speed.

## 0.7.24

**A mount can carry more than one rider, and Wild Shape no longer draws two restore icons.** How
many fit is the token's grid space (half its squares — a Large horse seats two, a Gargantuan
dinosaur a party) plus remaining carry weight. Riders spread across the mount; a controlled
mount still matches initiative to the first rider. The printed "one rider" reading was a v1
lock, not RAW.

The restore badge is now a keepId (`noodlrTransform0`) written by the roller, not every owner.
Player and GM both own a PC, so the old check-then-create raced two identical icons.

## 0.7.23

**Wild Shape gets a token icon, and tokens can ride.** A transformed creature shows a restore
badge in the same token corner as a Paladin's aura — click it (or the Token HUD control) and
dnd5e restores the original form without spending a Wild Shape use. Argon's Wild Shape button
is still not intercepted, so beast-to-beast stays legal.

A creature may mount a larger willing token (same disposition or Neutral; player characters
also mount Friendly), follow it, and dismount from the saddle icon or the HUD. Mounting or
dismounting on your turn costs half Speed. Rideable, if active, keeps the layer. A rider
cannot walk independently; follow does not provoke. Controlled-mount action limits and
falling-off saves are not in this first slice. The 2024 rule does not grant a free Dash.

## 0.7.22

**Wild Shape no longer counts as a walk, and a trail rider no longer burns the walker.** A Land
Druid turning into a Giant Owl recentered the token (Medium → Large). Compiled Investiture of
Flame and Spike Growth then fired as `on_move` damage aimed at `trigger` — which on that event
is the mover — and wrote the hits through to the original sheet. Changing size, swapping the
actor, or landing a polymorph flag is not locomotion. Damage that does not name anyone, or names
`trigger`, is refused; an explicit `self` still runs. Revert stays on dnd5e's sheet header
(Restore Transformation). The Argon Wild Shape button is not intercepted.

## 0.7.21

**The Paladin shows Aura of Protection as well as Courage, and the icons stay.** Allies
already received both copies. The Paladin only showed Courage, because Protection's +Cha
lives on the feat (`item.effects`, `transfer: true`) and the last two releases stamped
the token icon onto that document — which they then looked for on `actor.effects`, where
it never is. Courage is `transfer: false` and already had an actor copy. Those stamps
also set `flags.dnd5e.isTemporary`, so dnd5e filed them as timed effects. They landed in
Unavailable Effects and dropped off the token until someone walked and recreated them.

Protection's icon is now a separate actor badge: empty changes (no second +Cha), its own
flag, no item origin. The feat's transferred bonus is left alone, and a previously
disabled one is re-enabled. Copies no longer carry the temporary flag. A leftover twin
from v0.7.20 is deleted.

## 0.7.20

**The Paladin no longer loses his own Aura of Protection.** v0.7.19 created a hollow
badge effect with the same name and origin as the sheet-transferred +Cha, so the token
would show an icon without doubling the bonus. A same-origin create — or DAE merging
by name — could land that empty payload and our delete flag on the real grant. The
next poll then stripped the Paladin's aura while allies kept theirs, because those
copies are read off the item. Presentation is now stamped onto the existing
transferred effect. A gutted one is restored from the item before anything is
stripped. There is no second document.

## 0.7.19

**The Paladin sees the aura icon too, without a second save bonus.** The sheet already
transfers Aura of Protection onto the Paladin, so a copy with changes would double
Charisma. A badge copy — same icon, empty changes — is what Foundry draws on the token.
Allies still get the real bonus copy. The status is now registered with `hud: false`, so
it appears beside Concentration and conditions and is not a click-toggle on the Token HUD.

**Walking back in no longer posts the Automated Animations Sequencer tip.** AA matches
"Aura of Protection" by name and plays a persistent animation on every copy we write.
Each copy now carries AA's own off switch (`killAnim`). Automated Animations is not
required and is not called; without it the flag does nothing. Persistents already
playing from an earlier version need one pass through the Sequencer Effect Manager.

## 0.7.18

**Auras recheck every six seconds, not only when the Paladin moves.** Allies could walk
infinitely far and keep Aura of Protection so long as the Paladin stood still; walking
the Paladin back in did not apply until the others moved. A v13+ walk often never puts
`x`/`y` on the update the GM hears, so an on-move refresh ran at the wrong times.
Distance is now polled once per combat round against committed token positions.
`noodlrHooks.surveyAuras()` prints `poll 6s`.

**Recipients see the aura icon on their token.** Foundry only draws temporary effects
(a duration or a status) on the upper-right strip. Each copy now carries a unique
status such as `noodlr-aura-of-protection` — not Frightened, Paralyzed, or
Concentration, and not registered as a HUD toggle — so the feature's own icon sits
beside those without replacing them.

## 0.7.17

**A Paladin's aura drops when you walk out of it.** Walking the party away from the Paladin
left every ally's save bonus in place at any distance. Refresh only watched `x`/`y` on
`updateToken`; Foundry v13+ walks often diff `movement` instead, so the copies applied at
scene load never cleared. Walks now retrigger the same way opportunity attacks already do.

**The radius is 10 ft or 30 ft, not whatever the description says.** 2024 Paladin auras jump
from 10 ft (levels 6–17) to 30 ft (18–20) — one table on the class item, not a curve.
DDB's feature text stays "10-foot Emanation" and its Active Effect writes
`[[scalevalue]]-ft`, an unexpanded enricher. `Number("30-ft")` is NaN, so a unit-bearing
string used to fall through to 10 on an 18th-level Paladin. The reader now believes the
scale (or Paladin class levels when the scale is missing), never that sentence.
`noodlrHooks.surveyAuras()` prints the formula, the Paladin level, and each recipient as
`N ft IN|out`.

## 0.7.16

**Two Paladins do not stack the same aura.** Two Aura of Protection write the higher bonus,
not both. Protection beside Courage (or any other distinct aura) still both apply. The
Paladin's own transferred bonus counts as their instance, so a +3 Paladin standing in a
+5 neighbour's aura gets +5, not +8. Hostile auras of the same kind keep the harsher
number. Not Paladin-only — any grant that shares an identifier collapses this way.

**Spirit Guardians is not a copied save bonus.** It is an occupying field (Speed halved
inside, Wisdom save when the emanation enters or a creature enters or ends its turn there,
damage once per turn). The grant layer now refuses it — including a hollow DDB stamp that
is only movement multipliers — so a Half Speed effect cannot be mistaken for Aura of
Protection. The field itself is still Phase 4.

## 0.7.15

**Leaving melee without Disengage now offers the opportunity attack.** The Archmage
walked out of the barbarian's Halberd reach to hide and to flee, and nobody was asked.
Three measurement bugs stacked: the route used the token's `_source` instead of
Foundry's `destination`, the start point added the footprint twice so a 10 ft reach
looked empty, and the watcher list required a placeable `.center` that TokenDocuments
do not have. It also skipped whoever the tracker was pointing at, so a fighter whose
turn it was could not swing at a goblin walking past. None of those is a Disengage —
the planner never takes one, and a hide or a flee is supposed to provoke. The console
now names every silent return, so the next miss is a sentence rather than an absence.

**A fleeing creature leaves the scene instead of starting a new fight.** The first flee
used to record the outcome immediately. Combat ended, the Hostile token stayed put, and
sixty seconds later perception spotted it again. It now runs for up to three of its own
turns (or until it reaches the map edge), then the scene token is removed. Perception
ignores a fled token even after combat is gone. `noodlrHooks.surveyFlee()` lists who is
still running.

**A Prone creature stands (half Speed) or crawls.** The Archmage was knocked Prone and
never lost the condition, then walked his full Speed on later turns. Core only charges
crawl rates when Crawl is selected, and it never charges standing at all. Automated
creatures now stand unless staying down is a real tactic — keepDistance, no melee
within 5 feet, acting from here. Players who walk or fly while Prone are asked to
crawl or stand first. `noodlrHooks.surveyProne()` reports the cost.

**A Paladin's aura reaches nearby allies again.** Aura of Protection — and Courage, Devotion,
Warding, Aura of Life — stopped applying the moment Aura Effects and DAE were turned off.
dnd5e never emanates: the feature's Active Effect stays on the Paladin, and clicking it posts
the prose. DDB stamps `flags.ActiveAuras` for a module that is no longer there. This module
now copies a resolved number (the Paladin's Charisma, not the ally's) onto whoever is inside
the moving radius, and skips the Paladin when the sheet already transfers the bonus onto them
so it cannot double. Stands aside when Aura Effects or Active Auras is running. DAE alone does
not emanate and is not a reason to stand aside. `noodlrHooks.surveyAuras()` lists who is in
range.

**Doors only open from within one square.** Arm's Reach was on, and its default leaves
every GM door click unrestricted — including a GM playing a character and clicking from
across the map. This module now refuses that click when a token is selected. A GM with
no token selected is staging and is not restricted. The settings window says so, because
a module whose default is the bug is not a module we stand aside for.

**The Archmage shoots, and does not Counterspell a greataxe.** Two bugs in one fight. Arcane Burst
is a melee *or* ranged attack (reach 5 ft or range 150 ft) with no Thrown property — the same
empty `attack.type` every natural weapon uses. After the spear fix below, that 150 ft was
dropped, so a genius caster walked twelve feet and hid instead of firing. Hide also scored
"somewhere to shoot from" and then never shot; it is no longer offered when a ranged attack
already reaches. Separately, Protective Magic (Counterspell) was spent as the answer to being
hit. Counterspell is "when you see a creature casting." A melee swing is not that. The wrapper
feat is now recognised and refused on the hurt path.

**Lightning Bolt actually lands.** An automated area still stopped for a human to draw the
template — `configure: false` skips the usage dialog, not `#placeTemplate`. The slot went,
the line never appeared, and a Dex save you allowed by hand had nothing to apply. The turn
now aims the area at the creature the planner already named, places the MeasuredTemplate,
and stamps who is in it so auto-saves have someone to roll. Fireball, Cone of Cold, and
breaths use the same path. Choosing the angle that misses the caster's own front rank is
still Phase 5.

**Arcane Burst names who it is shooting.** The planner said Barb Arian; the attack card
named nobody, so auto-damage left the Apply button. dnd5e reads `game.user.targets` at
roll time, and `updateTokenTargets` is not a guarantee the Set is populated before
`rollAttack`. The token is targeted with `setTarget` as well, and `flags.dnd5e.targets`
is written onto the attack message so the card does not depend on the live Set.

**A spear is stabbed from 5 feet or thrown from 20, not stabbed from 20.** The Assassin closed
toward Bardo, still could not reach, and then rolled a melee Attack and Damage with Lycan Spear
anyway. dnd5e keeps a thrown weapon's reach and its thrown range on the same `range` object
(`reach` 5, `value` 20, `long` 60). We were reading the thrown number as melee reach, so the
planner treated 20 feet as "close enough" and used the melee activity. Empty target lists on
those cards were the giveaway. Thrown is now a separate option, and that is the one the
planner picks when walking into melee is not required.

**Rechargeable abilities roll themselves.** A spent Recharge 5–6 (a breath, a gaze, a swallow)
rolls its d6 at the start of that monster's turn instead of waiting for you to remember. Default
is automatic with no chat card — the die is not a fun roll, and a table of several dragons should
not dump a card each. Switch to Announce if you want the system's recharge card, or Off to roll
by hand. If you already turned dnd5e's hidden Auto-recharge on (Combat Settings → Monsters), that
one wins and this stands aside so the die is not rolled twice. The planner already stops offering
a spent breath; once the die succeeds, it comes back.

## 0.7.14

**A magic item handed to a creature already on the scene is compiled.** Dropping loot, dragging from
a pack, or a loot generator creating an item used to leave that wording unread until somebody
reloaded — Coat of Many Eyes on the Aboleth sat inert for exactly that reason. Foundry has no
"received inventory" event; `createItem` on the sheet is that event. Only items that can carry a
rule are watched. Equipping, spending a use, or changing quantity does not spend a compile.
Losing an item is ignored.

**Wild Shape, Polymorph and Shapechange compile the new form.** Those spells do not drop a new
token. A linked transform points the existing token at a new actor; an unlinked one rewrites the
sheet in place. Both now schedule the same cache-first collect a dropped token does. Summons
already did — they place a token, and that hook was already wired.

**A compile the GM just paid for reaches the other clients without a reload.** The cache is
re-read on every collect, not only the first warm of the session, so a player who was already in
the world binds the new wording instead of staring at an inert item until they refresh.

## 0.7.13

**A scene of high-level characters is no longer cut off after 120 abilities.** Dropping thirteen
level-20 player tokens compiled the first 120 distinct wordings and stopped, with 872 still unread.
120 is still the size of one compile request — a save-point if a request fails — but the scene now
keeps asking until every unread wording is done.

**A packed map cannot post an unbounded bill.** One pass will read at most 32,768 distinct unread
wordings. Past that the first 32,768 are still compiled and the GM gets an error naming how many
were skipped, so the leftover is visible rather than silent. Thirteen level-20 PCs measured 992
distinct; 32,768 is the runaway brake, not a target.

## 0.7.12

**A leftover target no longer makes a Fireball.** Casting a spell that places a template
(Fireball, Cone of Cold, a breath) now drops whoever you last clicked. A Dire Wolf still
targeted from Ray of Frost is not forced to Dex-save before the sphere is on the map — you
could have put that Fireball anywhere. Auto-saves wait until someone is actually in the
area. "Who a template caught" is still unbuilt; waiting is the honest state, not a guess.

**Ray of Frost's Slow now lasts until the caster's next turn.** The Speed cut was applied
and then expired on the next wolf's turn, because the combat was stored as an id string
(Foundry compares the Combat document itself) and "1 turn" was counted as the next
initiative slot. The sheet stayed at 50 ft the whole time.

**A close that cannot reach no longer swings.** Two Dire Wolves announced a 33-foot close
and Bite, walked into a wall, and used the activity anyway. Attack cards named nobody.
The use now waits until the creature is actually in reach; the card becomes "still too
far to strike".

**Reckless Attack's first swing now has Advantage on the die, not only on the card.**
v0.7.11 wrote the timed effect, but dnd5e hands the Attack *activity* as `config.subject`.
Reading that as the creature walked an empty effect list, so the card said Advantage and
the die stayed Normal.

## 0.7.11

**Reckless Attack's first swing of the turn now has Advantage, and Ray of Frost now actually
slows.** Compiled `grant_advantage` / `impose_disadvantage` / `modify_speed` write a timed Active
Effect that Foundry expires — default one turn, until the *source's* next turn starts, so a slow
lasts through the target's walk rather than ending when they begin their turn. A second Ray of Frost
in the same turn refreshes the cut instead of stacking it. Advantage is also applied on the roll
itself, because waiting for the attack card would miss the swing that triggered it.

Hold Person with no duration still stays until the save; that was never a one-turn effect. Compile
must be on, and the feature has to have compiled as `engine` — a `gm` badge means this release never
sees it.

## 0.7.10

**A melee hit on a Paralyzed creature now offers critical damage the same way a natural 20 does.**
The rule was already being applied to the live attack die; the damage dialog reads the *stored*
chat card, which had already been posted as a normal hit. The card is rewritten, and the dialog
defaults to Critical. Incapacitated, Stunned and Petrified still do not auto-crit — only Paralyzed
or Unconscious, and only within 5 feet.

**A Paralyzed (or Unconscious) creature's auto-failed Dexterity or Strength save now settles
damage.** Disintegrate against a held Assassin left the 70-damage Apply button sitting there
because cancelling the roll produced no verdict, and auto-damage stands aside whenever auto-saves
is on. The auto-fail card is now a failed save. A cancelled roll is "they failed", not "nobody
has answered yet".

## 0.7.9

**An automated creature that cannot act no longer takes a turn.** Hold Person applied Paralyzed (and
nested Incapacitated) and the Assassin still walked, because the planner only skipped the dead. A
creature that is Incapacitated — or Paralyzed, Stunned, Unconscious, or Petrified, even when the
sheet forgot the nest — is now skipped past immediately, the same as a corpse. Grappled and
Restrained still get their turn. Hold Person's one-minute clock stays the spell's own concentration
duration; this is not a second timer.

## 0.7.8

**A compile request now names the model Noodlr will ask.** The slug lives in Noodlr's Text Generation
window, not here — this module just reads it so a batch can say which model is about to stamp the
answer. No new setting and nothing on any window here changed.

## 0.7.7

**NPC saving throws now roll themselves.** Hold Person on a monster posted the usage card and then
waited forever for a GM to press the Wisdom save, because the module treated "someone is elected to
roll" as "leave the button". Someone is always elected when a GM is online — the player if they own
the creature, otherwise the GM — so every NPC save in a running world was skipped. The Assassin sat
unparalyzed with a compiled Hold Person rule that never saw a verdict. Player characters still leave
the dice for their owner.

**A compiled rider now names who it landed on.** "Hold Person: Bardo is paralyzed" was signed as the
caster. The card now names the creature the effect hit.

**A caster's other spells no longer fire on this save.** Otto's Irresistible Dance was charming the
Assassin because every `on_save_failed` bound to Bardo ran when Hold Person's save failed. Spell,
weapon and consumable riders now only fire for the item that was used. A feat that watches any save
still fires.

**Automated attacks no longer wait on the Attack Roll window.** Full Automation posted the Light
Crossbow usage card and then opened the system's roll dialog, because skipping the usage dialog does
not skip the attack that follows it — and that follow-up is not even waited for, so the turn could
advance while the dice were still a window. Automated creatures now roll the attack (and the damage)
without a GM at the dialog. A player's own roll is never silenced.

The Assassin's opening crossbow in that same fight was a planned turn after initiative, not a Ready
action before combat. Hold Person landed about forty-five seconds later.

## 0.7.6

**Compiled abilities now fire when a save fails or succeeds.** Hold Person restraining what failed
its save, a rider that lands only on a successful save — those were sitting on the capability sheet
as live and doing nothing, because nothing was listening for the save's verdict. They run now, after
Silvery Barbs and legendary resistance have had their say, so a bought success does not also apply
the failure half. A save with no damage still counts: Hold Person never rolls damage.

**Compiled abilities also fire on the attack roll, on a new condition, and on a move.** Reckless
Attack and Pack Tactics are the attack-roll case: they care that you rolled, not that you hit, so
they do not wait on automatic damage. Nature's Ward clearing poison when poison lands is the
condition case. Walking while Ashardalon's Stride is up is the move case.

Two honest limits, both visible on the capability sheet rather than silent:

- Most attack-roll rules grant Advantage or change Speed. Those still wait on a later release; they
  are now marked as waiting on the effect, not as unheard.
- A move rule that deals damage but never says *who* is refused rather than guessed. The live
  reading of Ashardalon's Stride left that blank, and guessing would have burned the caster.

The log line that said a token's position was stripped after a successful move now names the
modules that are actually on, instead of blaming four that were installed and switched off.

## 0.7.5

**A spell that slows what it hits could not say whose Speed it changed.** The vocabulary Noodlr hands
the AI listed no target on a speed change, so every ability that slowed its victim was rejected and had
to be asked again - 13 of 114 problems in a full-world compile. The capability sheet had been showing a
target for those rules all along, so the vocabulary was contradicting our own display. Fixed.

When a rule does use a parameter that genuinely does not exist, the message now names which kind of
effect refused it, so a gap in our vocabulary reads differently from the AI inventing a field.

## 0.7.4

**Each world now keeps its own compiled abilities.** They were previously stored beside the module rather
than inside a world, which meant every world on one Foundry server shared a single set - so two open worlds
could overwrite each other's readings, a world backup did not include them, and the clean-up tool saw the
other world's abilities as dead and offered to delete them. They are now written under
`worlds/<your world>/assets/`, so a backup carries them and nothing crosses between campaigns. **Nothing is
inherited from the old shared location, deliberately**: abilities compiled before this release are not
adopted, and a world that wants them reads its sheets again. If you have paid for a large cache and want to
keep it, copy `Data/assets/noodlr-hooks-55e/capabilities` into
`Data/worlds/<your world>/assets/noodlr-hooks-55e/capabilities` before loading.

**Survey reports are world-scoped too.** They wrote to one fixed filename beside the module, so on a server
with two worlds the second census silently overwrote the first, and nothing in the file said which world it
described.

**Every compiled ability now records which rules version it was read under**, and the capability window
says so when that no longer matches - "read under dnd5e 5.3.2, Foundry 14.360". It is a note rather than a
warning, because the reading is very probably still correct: the ability's wording has not changed, and a
system update rarely touches the ability in front of you. Nothing is deleted, nothing is re-read, and
nothing is spent. Where an update *did* change a rule, Recompile buys a fresh reading of that one ability;
Lock records that you have checked it and clears the note for free. `noodlrHooks.surveyCacheAge()` prints
the whole picture, grouped by what changed.

**The Sneak Attack report lists weapons that can be counted.** Two hand crossbows read as four weapons,
because dnd5e weapon names contain commas and the list was joined with one.

**Scene ingestion reported the wrong numbers.** Twenty goblins sharing one trait were counted as twenty
distinct abilities rather than one, so a fully cached scene could report a third of itself as unknown.
Nothing was bought or lost by it - only the log line was wrong.

## 0.7.3

**Compiled abilities now work after simply loading the world.** They were only ever bound when you
changed scene or dropped a token onto the canvas, so a GM who logged in onto a scene that was already
populated got none of them - every regeneration, every rider, every compiled Multiattack sat on disk and
did nothing, with nothing anywhere saying so. It went unnoticed because the way anybody tests one of these
abilities is to place the creature that has it, which quietly fixed the problem it was measuring. Nothing
needs recompiling; the descriptors were correct the whole time.

**Two diagnostics were reporting the opposite of the truth.** "What would this scene ask about" read a
full cache as empty, so it announced that every ability on the scene still needed compiling, and the
cache clean-up tool reported nothing to tidy however much was there. Both now load the cache before
answering. Nothing was ever deleted by this - the clean-up sweep over an empty list does nothing - but the
numbers were alarming and wrong.

**The Sneak Attack report says whether the dice and the weapons are there.** It could previously show a
rogue as perfectly healthy while nothing would ever be offered, because the two things most likely to be
missing - a damage amount to roll, and a Finesse or Ranged weapon to qualify - were not among the facts it
printed. It now names both, and resolves the dice to what they come out as at this character's level, so a
reference that points at nothing says so.

**The console and the capability window agreed to disagree about one ability.** A compiled Sneak Attack
rule was badged as declined in the window and printed as fine in the console, from the same descriptor in
the same session. Both now ask the same question.

## 0.7.2

**Sneak Attack is offered when it is earned, and only then.** Foundry has always shipped the feature with
working dice; what it has never done is check whether the rogue qualified, or remind anyone the moment has
arrived. Now a hit that carries Advantage, or that lands beside one of the rogue's conscious allies, with a
Finesse or Ranged weapon, puts a short timed prompt on the rogue's own screen. Taking it rolls the dice on
that player's client, under their own name, and the damage is applied with the usual receipt and undo. The
prompt defaults to yes, because the dice come back next turn either way.

**Once per turn, counted properly.** A rogue who has already dealt Sneak Attack this turn is not asked
again - including when they dealt it by pressing the feature on their own sheet, which is watched for. A
fresh turn in the initiative order restores it, so an opportunity attack on somebody else's turn is a new
opportunity. Out of combat it is not limited, because there is no turn to restore it.

**It stands aside for Chris's Premades, per rogue, and says so.** Where that module has claimed a
particular rogue's Sneak Attack, we do not offer a second one. A rogue it has not claimed is still offered.
And if automatic damage is off, or Midi QoL is applying damage, nothing here can read whether an attack
connected - the settings window now warns that the switch is on and no rogue will ever be asked, rather
than leaving it to be discovered at the table.

**A compiled Sneak Attack rule no longer stacks on top of it.** The same protection that stops a compiled
ability restating the weapon's own damage now covers this: while we are dealing the dice, a compiled damage
rule on the same feature is declined and the capability sheet says why. If the offer is switched off and
nothing else is handling it, the compiled rule is left to do its job.

## 0.7.1

**A compiled ability that does something when it hits now does it.** This is the largest group of
compiled rules there is - a bite that poisons, a claw that grapples, a tentacle that restrains - and
until now every one of them was stored, badged as working, and silently inert. They fire against each
creature the attack hit, once, after any reaction has been answered, so a Shield that turned the hit
aside takes the poison with it. Misses fire their own rules the same way.

**A rule that merely restates the weapon's own damage is refused rather than doubling it.** Many
compiled abilities describe the damage the system already rolls; applying that again would quietly
deal twice as much. Such a rule is declined at the moment it would fire, and the capability sheet says
so and why. A genuine extra damage rider on the same weapon is unaffected.

**These are only offered by the creature doing the hitting.** A rule of the shape "when a creature hits
me, it takes fire damage" is understood and stored but does not yet fire, because the two readings need
opposite handling and running them together would apply the effect to the wrong creature.

**The settings windows now say when on-hit rules cannot fire.** They ride on the automatic damage layer,
which is the only thing that knows whether an attack connected - so if automatic damage is off, or Midi
QoL is applying damage instead, a warning appears rather than the rules simply doing nothing.

## 0.7.0

**Abilities that recharge on a rest now do.** A compiled rule saying "regains its uses after a short
rest" was stored, shown on the capability sheet, and never run, because nothing was listening for a
rest. Both rest events are wired: a short rest fires the short-rest rules, and a long rest fires those
as well as its own, which is what the rules say a long rest includes. Recovering something twice over is
harmless - a pool already full stays full.

**An ability that both recharges on a rest and is itself limited to a few uses a day gets the order
right.** The counter that decides which day it is is advanced before any rule looks at it, so such an
ability no longer refuses itself on the very rest that renews it.

**A player resting recovers the same things the GM's monsters do.** Some of what Foundry tells us happens
only on the computer of the person who did it, and one internal guard was treating those the same as the
events every computer hears - so a rule that worked perfectly when the GM tested it on a monster did
nothing at all when a player rested their own character. Nothing was reported, which is what made it
worth finding before the rest of the trigger work is built on the same path.

**A rest type from another module works with no change here.** Which of our rules a rest fires is read
from the rest's own definition rather than from its name, so a homebrew nap that recharges short-rest
resources fires short-rest rules.

## 0.6.9

**A part-finished world recompile can be finished.** Reading every ability in a world is the expensive
operation in this pair, and until now a run that lost its last few to a provider refusal could only be
put right by buying the whole world again. `noodlrHooks.recompileWorld({ since: <time> })` asks only
about wordings that have not been answered since that moment, so passing the time the run started leaves
exactly the ones it failed on. It can only ever ask about less than a plain recompile, never more, and
running it twice costs nothing the second time.

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
