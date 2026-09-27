# Official Rules Reference

> Transcribed from the official Exploding Kittens rulebook + Survival Guide PDFs.
> This file is the authoritative specification the engine is built against.

## Summary

CORRECTION TO THE TASK PREMISE: "Survivor: The Tribe Has Spoken" is published by **Exploding Kittens**, not Big Potato Games. Designers: Ian Clayman, Elan Lee, and Jeff Probst. ©2024 Exploding Kittens; TM & ©2024 Survivor Productions, LLC; released January 2025. 3-6 players, ages 8+, 30-60 minutes. I found and downloaded the two OFFICIAL PDFs from Exploding Kittens' own CDN and transcribed both in full (text extraction plus reading the rendered pages as images, so nothing is missed by column-order scrambling): the 2-page rulebook ("THE RULES") and the 2-page "SURVIVAL GUIDE" card reference. Everything below marked as quoted is verbatim from those two documents.

Retail contents: 67 Action Cards, 12 Survivor Character Cards, 1 Voting Box (the game box lid/tray itself), 1 Survival Guide, 1 Instruction Manual. There is also a **68th card, the Idol Nullifier, physically hidden inside the box** (under the card holder and a fake cardboard bottom). It appears NOWHERE in the official rulebook or Survival Guide — it is a deliberate Easter egg, so its rules text below comes from third-party documentation, not an official source.

The 67 Action Cards break down as: 9 Tribal Council (4 Single Elimination + 5 Double Elimination), 6 Vote, 7 Extra Vote, 4 Immunity Idol, 7 Sorry For You, 2 Control the Vote, 3 Goodwill Gamble, 1 I'm the Leader Now, 3 Camp Raid, 3 Knowledge is Power, 3 The Spy Shack, 4 Let's Form an Alliance, 6 Inheritance, 3 Do or Die, 3 Power Pair, 3 It's a Numbers Game. That sums exactly to 67.

STRUCTURAL NOTE, HISTORICAL: the PRE-REWRITE code (`src/game/cardlist.json`, now deleted) was missing four entire card types that the physical game depends on — Vote (6), Tribal Council (9, in two variants), Inheritance (6), and the Survivor Character Cards (12) — and shuffled the Idol Nullifier in as a normal card, which is not how the physical game works. That is audit #74/#93/#122. The current engine builds its deck from `src/engine/cards.ts`, whose `CARD_CATALOG` is a `Record<CardKind, CardDefinition>` covering all sixteen Action Card types plus the Vote, Tribal Council, Inheritance and Survivor Character cards, and `validateCatalog()` asserts the census sums to the printed 67 (+1 hidden). The old `lives = 2` is now two real Survivor Character Cards per player; there are no "torches" as a component — the flip side of a Survivor Character Card reads "VOTED OUT" and shows a snuffed torch, which is why the renderer draws lives as 🔥/🕯️.

## Setup

PLAYER COUNT: 3-6. Ages 8+. 30-60 minutes. (Some retail listings say "13+" / "30-45 min"; the box and rulebook say 8+ and 30-60.)

Verbatim from the rulebook, steps 1-7:

1. "Each player chooses a color and the **2 Survivor Character Cards** of that color. Place these Survivor Character Cards face up in front of you. Think of them as your tribe! Put any extra Survivor Character Cards away, you won't need them."
   Sidebar (Probst): "As long as you have at least one Survivor Character Card, you're still in the game. When both your Survivor Character Cards are gone, you're out, but you'll still play an important role at the end of the game."
   → 12 Survivor Character Cards = 6 colors x 2. These are the "lives"/torches. There are exactly 2 per player, always, regardless of player count. Getting voted out = turn ONE of them over to its "VOTED OUT" side.

2. "Gather all **67 Action Cards** and remove the **9 Tribal Council** and **6 Vote Cards**. Give each player 1 Vote Card, and put the extras away – you won't need them."
   → Each player starts with exactly 1 Vote Card. Surplus Vote Cards (6 minus player count) are removed from the game entirely.

3. "Shuffle the remaining Action Cards, then deal **3** of them **face down** to each player. (You can look at your cards, but keep them secret.)"
   → STARTING HAND = 3 Action Cards + 1 Vote Card. Note the Vote Card is dealt before the shuffle-and-deal, so it is not part of the 3.

4. "Gather each of the Tribal Council Cards you'll need based on the number of players:"

   | Players | 3 | 4 | 5 | 6 |
   |---|---|---|---|---|
   | Single Elimination Tribal Council | 4 | 2 | 2 | 0 |
   | (AND) Double Elimination Tribal Council | 0 | 2 | 3 | 5 |
   | TOTAL Tribal Council cards used | 4 | 4 | 5 | 5 |

   "Put away any unused Tribal Council Cards – you won't need them."
   (I read this table off the rendered rulebook page directly; the raw PDF text extraction scrambles it. Geeky Hobbies independently reproduces the same numbers.)

5. TRIBAL COUNCIL CARD PLACEMENT — verbatim: "Shuffle the Tribal Council Cards you gathered, then place **1 face down at the bottom** of the Action Card deck. Insert the remaining Tribal Council Cards **face down** into the deck, spacing them **evenly(ish)** throughout."
   Sidebar: "Tribal Council Cards are intentionally bigger than the rest of the Action Cards so you always know when the next Tribal Council is coming."
   The official how-to-play video (Jeff Probst) restates it: "The first Tribal Council card is always placed on the bottom of the deck, and the remaining cards are spaced throughout the rest of the deck."
   Geeky Hobbies describes an equivalent deterministic procedure that a digital implementation can copy directly: split the remaining Action Card deck into N roughly-equal piles (N = number of Tribal Council cards in use), then alternate — Tribal Council card, pile, Tribal Council card, pile — building the deck from the bottom up. This guarantees one TC card is the literal bottom card of the draw pile.

6. "Place the assembled deck **face down** in the middle of the table. This is the **Draw Pile**. Place the **Voting Box** next to it, and leave room for a **Discard Pile**."
   THE VOTING BOX: "Your game box is actually used in the game! Remove the lid and put the box on the table so the voting slots are facing up." Each slot corresponds to a player color.

7. "Pick a player to go first."

Play proceeds clockwise ("Play continues clockwise around the table" / "continue play with the player on your left").

## Turn Structure

Verbatim, "TAKING YOUR TURN": "There are 3 parts to your turn:"

**1. Steal a Card** — "Pick a player and steal a random card from them. (You can't avoid making enemies in Survivor!)"
   MANDATORY. Random (i.e. drawn blind from their hand), not chosen. The victim may respond with Sorry For You, which cancels the steal and forces the stealer to discard 1 card.

**2. Play a Card (Optional)** — "Play 1 card from your hand if you'd like to. When you play a card, place it **face up** on the Discard Pile. Then, follow the instructions on the card. You can check the **Survival Guide** at any time to learn more about your cards."
   Exactly zero or one card. The video is explicit: "You don't have to play a card, but you can't play more than one."
   Cards played *outside* your turn (Sorry For You as a reaction; Immunity Idol / Idol Nullifier / Tribal Advantages at Tribal Council; Inheritance on an elimination) are not constrained by this limit.

**3. Draw a Card** — "End your turn by taking the top card from the Draw Pile into your hand."

Rulebook footer: "Remember: Steal, Play (or don't), then Draw!"

TRIBAL COUNCIL CARD TRIGGER — verbatim: "When you draw a Tribal Council Card, IMMEDIATELY place it **face up** in front of you to start a Tribal Council. This happens at the **end of your turn**, so make sure you Steal, then Play (if you'd like to), and **THEN** Draw the Tribal Council Card."
   → A Tribal Council always fires at the very end of the drawing player's turn, never mid-turn. Whoever drew it becomes the Tribal Council Leader.

"TIME TO STRATEGIZE" — the three hard restrictions on table talk, verbatim:
"During the game, you can do anything you'd like (make a promise, break a promise, communicate secretly with another player, etc.) EXCEPT:
 • You CAN'T give another player a card unless a card makes you.
 • You CAN'T show another player your cards unless a card makes you.
 • You CAN'T hide how many cards you have."
   → Hand SIZE is public information at all times; hand CONTENTS are private. There is no stated maximum hand size and no discard-down step.

There is no reshuffle rule. The Draw Pile is never rebuilt from the Discard Pile.

## Tribal Council

TRIGGER: A Tribal Council begins the moment a player DRAWS a Tribal Council Card at step 3 of their turn. Verbatim: "When you draw a Tribal Council Card, IMMEDIATELY place it face up in front of you to start a Tribal Council. This happens at the end of your turn, so make sure you Steal, then Play (if you'd like to), and THEN Draw the Tribal Council Card."

LEADER: "If you are the player who drew the Tribal Council Card, you are the Tribal Council Leader. This means you are responsible for starting the voting process, tallying the votes, and resolving ties (a very useful advantage)." The Leader can be usurped by the single "I'm the Leader Now" card, played before voting begins.

The rulebook prints a four-phase Leader script. Verbatim:

PHASE 1 — TRIBAL ADVANTAGE CARDS. Leader says: "Welcome to Tribal Council. If anyone has a Tribal Advantage Card, you may play it now or anytime before we vote."
   Sidebar: "If any votes are gained from a Tribal Advantage Card, they MUST be used during the current Tribal Council."
   Sidebar: "You can play as many Tribal Advantage Cards as you would like during this discussion, but NOT once voting has started!"
   → The three Tribal Advantages (Control the Vote, Goodwill Gamble, I'm the Leader Now) all have the same window: any time from the start of the council until voting begins. There is NO one-card limit here — you may play multiple.

PHASE 2 — DISCUSSION. Leader says: "Now let's discuss who should be voted out. We can ask questions, form alliances, tell the truth, lie, and speak in private."
   "Allow discussion until you decide…" — the Leader alone decides when discussion ends. There is no fixed timer in the physical game. (The repo's TribalCouncil class implements a discussion timer; that is an app-level addition, not an official rule.)

PHASE 3 — VOTE. Leader says: "All right, that's enough discussion. It is… time to vote! Here's how it works. During the vote, we're all going to close our eyes and tap on the table in rhythm."
   Sidebar explaining why: "Why? So no one can hear how many votes are being cast."
   "When the Voting Box is in front of you, open your eyes and put your Vote Card in the slot representing the player you are voting for. Then, pass the box to the player on your left (even if they don't have a Vote Card), tap them on the shoulder, and close your eyes. Everyone must vote. I'll go first."
   Sidebar: "Or you can put the Voting Box in another room and let players vote in private."
   Sidebar: "If you have Extra Vote Cards, you can use them against the same player, a different player, or save them for later."
   → The Leader votes FIRST, then the box passes clockwise (to the left). The box passes to every seat including players holding no Vote Card (e.g. a victim of Control the Vote). Voting is mandatory for anyone holding a Vote Card. Each Voting Box slot corresponds to a player color.

PHASE 4 — TALLY THE VOTES. Leader says: "Everyone, open your eyes. If anyone has an Immunity Idol and wants to play it, now would be the time to do so. Okay, I'll open the box and tally the votes!"
   Sidebar: "Any votes for a player who plays an Idol DO NOT count!"
   → IMMUNITY IDOL WINDOW is strictly: after every vote is in the box, before the box is opened. Idols may be played for yourself or for another player. IDOL NULLIFIER WINDOW (unofficial/hidden card) is after an Immunity Idol is played and still before votes are counted.

VOTING SOMEONE OUT:
   Single Elimination — "The player with the most votes must turn over one of their Survivor Character Cards to indicate that they have been voted out."
   Double Elimination — "The 2 different players with the most votes must each turn over one of their Survivor Character Cards to indicate that they have been voted out."
   Sidebar (Probst): "As players are voted out, don't miss your chance to say 'The Tribe Has Spoken!'"
   Elimination: "If both of your Survivor Character Cards have been turned over, you are eliminated from the game. When this happens, put your cards face up on top of the Discard Pile. But don't go too far, as you'll have an important role to play during the Final Tribal Council." (Their hand goes to the Discard Pile unless someone plays the matching Inheritance card.)

TIES — verbatim:
   SINGLE ELIMINATION TRIBAL COUNCIL: "The Tribal Council Leader gets to decide which of the tied players is voted out."
   DOUBLE ELIMINATION TRIBAL COUNCIL:
   • "If 3 or more players are tied with the most votes, the Tribal Council Leader gets to decide which 2 of the tied players are voted out."
   • "If 2 players are tied with the most votes, both are voted out."
   • "If 1 player gets the most votes, and 2 or more are tied with the second most, the player with the most votes is voted out first. Then, the Tribal Council Leader decides which of the tied players is also voted out."
   • "If there are only 3 players left and 2 players would be eliminated at the same time (leaving you with only 1 player left in the game), the Tribal Council Leader decides which of the tied players is eliminated. Immediately begin The Final Tribal Council."

UNCLEAR WHO IS VOTED OUT? — verbatim: "If it's unclear who is voted out (because too many players tied, some players got no votes, and/or some players played Immunity Idols), the Tribal Council Leader must decide who to vote out using these criteria:
 • First, always choose from the (non-immune) players who got votes. If there aren't any…
 • Choose from the (non-immune) players who got no votes. Finally, if there's not enough of them…
 • Choose from the players who played Immunity Idols."
   → This is a strict 3-tier priority ladder and it is the key correctness rule an implementation must encode: an Immunity Idol is NOT absolute protection. If every non-immune candidate is exhausted, an idol-playing player can still be voted out.

CLEANUP AND TURN ORDER AFTER A TRIBAL COUNCIL — verbatim: "After voting has ended, return 1 Vote Card to every player who still has at least one Survivor Character Card left in the game. Discard all other cards used during the Tribal Council (including the Tribal Council Card) face up in the Discard Pile. After Tribal, continue play with the player on your left."
   → Every surviving player is reset to exactly one Vote Card. Surplus Vote Cards are discarded. Play resumes with the player to the LEFT of the Tribal Council Leader (i.e. left of the drawer) — EXCEPT when "I'm the Leader Now" was played, in which case that card overrides: "It's your turn when the Tribal Council ends (or the player after you if you are eliminated)."

## Final Tribal Council

TRIGGER — verbatim: "The moment there are only 2 players left in the game, regardless of how many Survivor Character Cards they have left, it's time to IMMEDIATELY start the Final Tribal Council to determine the winner of the game."
   Sidebar: "This could happen when you get to the bottom of the Draw Pile, at a Single Elimination Tribal Council, or at a Double Elimination Tribal Council after just the first player is voted out."
   → It is player count, not Survivor Character Card count, that ends the game. A finalist may still hold 1 or 2 character cards. It can interrupt a Double Elimination mid-resolution.

JURY AND LEADER — verbatim: "The Jury is made up of all the players who were voted out, and the final two players must each persuade the Jury that they outplayed their opponent and should win the game. The player most recently eliminated is a member of the Jury AND the Final Tribal Council Leader."
   → The Jury is every fully-eliminated player (both character cards turned over). The most recently eliminated player is both a voting Jury member and the Leader who runs the proceeding and breaks a tie.

PROCEDURE — verbatim: "To start, the Final Tribal Council Leader should ask the final two players these three questions:
 • What was your strategy coming into the game?
 • What was your best move in the game?
 • How did you outplay your opponent?"

"The final two players should take as much time as they need to make their cases. They can't play any cards, but they can reveal their hands as evidence."
   Sidebar (Probst): "Making it to the final two with an unused Immunity Idol or both of your Survivor Character Cards takes a lot of skill!"
   → No cards function at the Final Tribal Council. Immunity Idols, Extra Votes, everything is inert; the hand is purely rhetorical evidence.

"The final two players can respond to each other's statements. Each member of the Jury can also ask additional questions, or make their own cases for who deserves to win."

THE VOTE — verbatim: "When each member of the Jury is ready to vote, they will raise a finger in the air. When every member of the Jury has a finger in the air, the Final Tribal Council Leader will say: 'The winner of Survivor is…3…2…1…' Then, every member of the Jury SIMULTANEOUSLY points at the player they think should WIN. The player with the most votes is declared the Sole Survivor and winner of the game!"
   → The Voting Box is NOT used. Voting is a simultaneous public point, not a secret ballot, and it is a vote FOR rather than against. Only Jury members vote; the two finalists do not.

BREAKING A TIE — verbatim: "If both players in the final two get the same number of votes, the Final Tribal Council Leader breaks the tie by choosing the winner. They DON'T have to pick the player they originally voted for."
   → With an even-sized Jury a tie is possible; the most-recently-eliminated player decides, and may switch.

## Card Reference

### Tribal Council — Single Elimination (4 (of 9 Tribal Council cards total). Number USED depends on player count: 3p=4, 4p=2, 5p=2, 6p=0)

**Rules text:** Survival Guide (shared text for both Tribal Council variants): "When you draw this card, you must put it on the table in front of you IMMEDIATELY. You are the Tribal Council Leader. Start the Tribal Council by encouraging players to talk about who they might be voting for. You decide when it's time to vote, and you are responsible for breaking ties. Place this card in the Discard Pile after the Tribal Council is finished." Rulebook: "With a Single Elimination Tribal Council Card, players will vote out 1 player." Resolution: "The player with the most votes must turn over one of their Survivor Character Cards to indicate that they have been voted out."

**Timing:** Not playable from hand — it is a deck card that resolves the instant it is DRAWN, at the end of the drawer's turn (after Steal and Play). Physically oversized so the next Tribal Council is visible coming.

**Edge cases:** The drawer becomes Tribal Council Leader (starts voting, tallies votes, breaks all ties) — the rulebook calls this "a very useful advantage." One TC card is always the literal bottom card of the Draw Pile. The TC card goes face up to the Discard Pile once the council ends. Open question (BGG thread 3513552, "Camp Raid with Tribal Council"): if a Camp Raid is in front of the player who draws the Tribal Council card, who becomes the Leader? Camp Raid says the raider takes the drawn card "no matter what it is," but the Tribal Council card says the drawer becomes Leader immediately. I could not read the thread's answers — BGG is behind a Cloudflare bot challenge that blocks headless browsers, WebFetch, curl, the XML API, and reader proxies alike.

### Tribal Council — Double Elimination (5 (of 9 Tribal Council cards total). Number USED depends on player count: 3p=0, 4p=2, 5p=3, 6p=5)

**Rules text:** Same Survival Guide text as Single Elimination (see above). Rulebook: "With a Double Elimination Tribal Council Card, players will vote out 2 different players." Resolution: "The 2 different players with the most votes must each turn over one of their Survivor Character Cards to indicate that they have been voted out."

**Timing:** Same as Single Elimination — resolves on draw, at the end of the drawer's turn.

**Edge cases:** "2 DIFFERENT players" — one player cannot lose both Survivor Character Cards at a single Double Elimination. Special case, verbatim: "If there are only 3 players left and 2 players would be eliminated at the same time (leaving you with only 1 player left in the game), the Tribal Council Leader decides which of the tied players is eliminated. Immediately begin The Final Tribal Council." The Final Tribal Council can also trigger mid-council: "at a Double Elimination Tribal Council after just the first player is voted out" — i.e. if the first of the two eliminations reduces the game to 2 players, stop and go to Final Tribal Council.

### Vote (6 in the box; 1 dealt to each player at setup; extras removed from the game)

**Rules text:** Verbatim: "Every player gets 1 Vote Card at the start of the game. When voting during a Tribal Council, you MUST place this card in one of the slots in the Voting Box. You must vote for a player in the current Tribal Council."

**Timing:** Tribal Council, during the vote. Mandatory — "Everyone must vote."

**Edge cases:** After every Tribal Council: "return 1 Vote Card to every player who still has at least one Survivor Character Card left in the game. Discard all other cards used during the Tribal Council (including the Tribal Council Card) face up in the Discard Pile." So Vote Cards are recycled, each surviving player is reset to exactly one, and any surplus (e.g. Vote Cards accumulated via Control the Vote) is discarded rather than kept. A player reduced to 1 Survivor Character Card is still "in the game" and still gets a Vote Card back. Vote Cards are NOT part of the shuffled Action Card deck and are never drawn.

### Extra Vote (7)

**Rules text:** Verbatim: "When voting during a Tribal Council, you MAY place this card in one of the slots in the Voting Box (or save it for later). You must vote for a player in the current Tribal Council." Rulebook sidebar: "If you have Extra Vote Cards, you can use them against the same player, a different player, or save them for later."

**Timing:** Tribal Council, during the vote (cast into the box alongside your Vote Card). Optional, and bankable across Tribal Councils.

**Edge cases:** Unlike a Vote Card, it is NOT returned to you after the council — if you cast it, it is spent and goes to the Discard Pile. If you don't cast it, you keep it in hand indefinitely. Multiple Extra Votes may be cast in one council, at the same target or split across targets.

### Immunity Idol (4)

**Rules text:** Verbatim: "Can only be played at Tribal Council AFTER all players have voted, but BEFORE votes are tallied. Any votes cast for you (or the player you choose) do not count." Sidebar: "If you're feeling secure and want to make (or protect) an ally, you can use this card for another player instead of yourself." Rulebook Leader script: "If anyone has an Immunity Idol and wants to play it, now would be the time to do so." Rulebook sidebar: "Any votes for a player who plays an Idol DO NOT count!"

**Timing:** Strictly the window between the last vote being cast and the box being opened. Not on your turn; does not consume your one-card-per-turn play.

**Edge cases:** May be played on YOURSELF or on ANY OTHER PLAYER. Playing it is a public act done before the votes are read, so it is a blind gamble. An immune player's votes are zeroed, not redirected. Immune players are the LAST resort in the "unclear who is voted out" ladder — i.e. an idol can still fail to save you if literally nobody else is eligible. Making the final two with an unused Immunity Idol is called out by the rulebook as jury-persuasion evidence: "Making it to the final two with an unused Immunity Idol or both of your Survivor Character Cards takes a lot of skill!" Open question (BGG thread 3487916, "Immunity Idol"): "Can one player play more than 1 immunity idol. Aka 1 for themselves and one for an Ally?" — nothing in the official text forbids it, and the one-card-per-turn limit does not apply at Tribal Council, but it is not explicitly permitted either. Thread answers unreadable (Cloudflare).

### Idol Nullifier (1 — and it is NOT one of the 67 Action Cards. It is a hidden 68th card sealed inside the game box (under the card holder on the side of the box, beneath a fake cardboard bottom). It is not in the deck at setup; a player must physically discover it.)

**Rules text:** NOT DOCUMENTED IN ANY OFFICIAL SOURCE. It is absent from both the official rulebook and the official Survival Guide — deliberately, since finding it is an Easter egg. Third-party description (Geeky Hobbies): "Should another player play an Immunity Idol Card, you can play the Idol Nullifier in order to cancel out the Immunity Idol that was played. That player can once again be voted out. You must play the card before any votes are counted though." I could not locate a photograph or transcription of the actual card face, so the exact printed wording is unverified.

**Timing:** Tribal Council, after an Immunity Idol has been played but before the votes are tallied/counted.

**Edge cases:** Everything about this card is under-specified: whether it nullifies one specific idol or all idols played that council; whether it can nullify an idol played FOR a third player; whether a second Immunity Idol can be played in response after a nullification; whether it can be played at a council where you hold no other stake. The repo's cardlist.json currently treats it as an ordinary shuffled deck card with quantity 1, which does not match the physical game — physically it is not in the deck at all until someone tears the box apart. NOTE: the game also contains an unrelated cipher puzzle at the bottom of Survival Guide page 1 ("I HAVE A BIG HAND POINTING AT A NUMBER AND A LITTLE HAND POINTING AT A NUMBER. ADD THEIR VALUES. 1=A AND 27=A") plus a QR code captioned "WANT JEFF PROBST TO BE YOUR TRIBAL COUNCIL LEADER?" — these are separate Easter eggs, not the Nullifier.

### Sorry For You (7)

**Rules text:** Verbatim: "Play ANY time someone tries to take cards from you. Instead, they get nothing from you and must discard 1 card (regardless of how many cards you owe them)." Sidebar 1: "This includes any card they attempt to steal from you at the start of their turn or any cards they would steal from you as an effect of another card (like the Do Or Die Card)." Sidebar 2: "If you play a Sorry For You after a card that would allow more than 1 player to take cards from you, each of those players gets nothing, and must EACH discard 1 card instead."

**Timing:** REACTIVE — any time, on anyone's turn, in response to an attempted take. Does not consume your own turn's card play.

**Edge cases:** One Sorry For You blanks a multi-stealer effect entirely (e.g. both partners of a Let's Form an Alliance targeting you get nothing AND each discards 1). It cancels the take completely regardless of how many cards were owed. The Inheritance entry notes it is a useful thing to hand over when forced to discard. Ambiguity: the rules say "take," and it is not stated whether it blocks Knowledge is Power (which says the target "must GIVE you 1") or The Spy Shack ("look at any player's cards and TAKE one" — "take" is used, so it should be blockable). It is also not stated whether it can block Camp Raid taking your freshly-drawn card.

### Tribal Advantage: Control the Vote (2)

**Rules text:** Verbatim: "Play this card during a Tribal Council before voting begins to take any player's Vote Card. You MUST use that Vote Card in addition to your Vote Card during the Tribal Council at which this card is played." Sidebar: "If the player you pick has more than 1 Vote Card, you only take 1."

**Timing:** Tribal Council, during the discussion phase, BEFORE voting begins. Never after voting has started.

**Edge cases:** The stolen Vote Card MUST be used this council — you cannot bank it. The victim loses their vote entirely for this council (they get a fresh Vote Card back after the council if they still hold a Survivor Character Card). You end up casting at least 2 votes; they may go to the same or different targets. Rulebook sidebar covering all Tribal Advantages: "If any votes are gained from a Tribal Advantage Card, they MUST be used during the current Tribal Council." Undefined: what happens if the chosen player has zero Vote Cards (already stolen from).

### Tribal Advantage: Goodwill Gamble (3)

**Rules text:** Verbatim: "Give this card to another player during a Tribal Council before voting begins. This card counts as 1 vote, and MUST be used during the Tribal Council at which it is played (just like a Vote Card). They can use it to vote for any player they want."

**Timing:** Tribal Council, during discussion, before voting begins.

**Edge cases:** You surrender control of the vote entirely — hence "gamble." Geeky Hobbies adds the (unstated but logical) clarification that the recipient may use it to vote for ANY player "including the player that gave the card to them." The recipient cannot save it. The card itself goes into the Voting Box as a vote and is discarded with the rest of the council's cards afterward.

### Tribal Advantage: I'm the Leader Now (1)

**Rules text:** Verbatim: "Play this card during a Tribal Council before voting begins to become the Tribal Council Leader. It's your turn when the Tribal Council ends (or the player after you if you are eliminated)."

**Timing:** Tribal Council, during discussion, before voting begins.

**Edge cases:** This is the single most powerful card in the game: it transfers both tie-breaking authority AND the "unclear who is voted out" decision AND turn order. It also overrides the default post-council turn order — normally play resumes with the player to the LEFT of the drawer, but the new Leader takes the next turn themselves. If the new Leader is eliminated by this very council, the next turn goes to the player after them. Only 1 copy exists. Undefined: whether it can be played after another player has already played... (moot, only 1 copy), and whether the ORIGINAL drawer of the Tribal Council card still discards it.

### Camp Raid (3)

**Rules text:** Verbatim: "Place this card face up in front of any player. you take the next card they draw at the end of their turn, no matter what it is, but only after they look at it. Then, place this card in the Discard Pile." Sidebar: "You can't play this card on a player who already has a Camp Raid in front of them."

**Timing:** Played on your turn as your one card play. Resolves later — at the end of the victim's next turn, when they draw.

**Edge cases:** A persistent, delayed-effect card that sits face up on the table rather than going straight to the Discard Pile. The victim SEES the card before handing it over, so the raider gains information as well as the card. "No matter what it is" is the phrase that creates the Tribal Council conflict (BGG thread 3513552). Only one Camp Raid per player at a time. Not stated: whether the drawn card counts as being "taken" for Sorry For You purposes; whether an eliminated victim's pending Camp Raid resolves.

### Knowledge is Power (3)

**Rules text:** Verbatim: "Ask any player for a card by name. If they have it, they must give you 1." Sidebar: "You can refer back to this Survival Guide if you forget the name of a card."

**Timing:** Your turn, as your one card play.

**Edge cases:** Go-Fish style. If they hold multiples of the named card you get exactly one. If they don't have it, nothing happens — you've burned the card. Because the wording is "give" rather than "take," it is genuinely unclear whether Sorry For You blocks it; the official text does not say. The sidebar implicitly confirms card names are public knowledge (the Survival Guide is a shared reference at the table).

### The Spy Shack (3)

**Rules text:** Verbatim, in full: "Look at any player's cards and take one."

**Timing:** Your turn, as your one card play.

**Edge cases:** The only card that grants full hand information plus a CHOSEN (not random) steal, which makes it the strongest single-target card. Note it is one of the two exceptions to "You CAN'T show another player your cards unless a card makes you."

### Let's Form an Alliance (4)

**Rules text:** Verbatim: "Pick a player to be your partner. You and your partner EACH steal 1 card from any other player (for a total of 2 cards stolen). You can steal from the same player, but you can't steal from each other."

**Timing:** Your turn, as your one card play.

**Edge cases:** Official text notably does NOT say "random" here, unlike Power Pair ("1 random card"), Do or Die ("2 random cards") and It's a Numbers Game ("2 random cards"). Geeky Hobbies also just says "steal one card." So whether the steal is random or chosen is genuinely ambiguous from the sources I could reach. THIS PORT: `houseRules.allianceStealIsRandom`, default **true** (random, matching the pre-rewrite code and the sibling cards). With it off each ally gets a real `card_choice` window against the victim's hand and picks; the two windows are opened against the hand as it then is, so an ally can never take the card their partner has already taken ("you can't steal from each other"). You and your partner cannot steal from each other; both may target the same third player. This is the card the Sorry For You multi-stealer sidebar explicitly covers: if the target plays Sorry For You, BOTH partners get nothing and BOTH discard 1.

### Inheritance (6 — 1 of each player color (the Survival Guide prints six color icons: dark-red triangle, orange square, magenta swirl, green leaf, teal wave, yellow sun))

**Rules text:** Verbatim: "Each Inheritance Card targets a different color player. When that player is eliminated from the game (by having both of their Survivor Character Cards turned over), you can IMMEDIATELY play this card. You get all of the cards in their hand instead of their cards going in the Discard Pile." Sidebar: "It can be useful to have the Inheritance for a player that isn't in the game. You can discard it if someone plays a Sorry For You against you!"

**Timing:** REACTIVE — the instant a player is fully eliminated (second Survivor Character Card turned over), which is normally at a Tribal Council. Not on your turn; does not consume your card play.

**Edge cases:** A potentially enormous swing — you take their ENTIRE hand. Inheritance cards for colors not in the game (any of the 6 colors nobody chose, since 3-6 players means up to 3 dead colors) are pure chaff, useful only as discard fodder. The repo's cardlist.json omits this card type entirely. Not stated: what happens if the Inheritance holder is eliminated in the SAME Double Elimination Tribal Council as their target, or if a player holds the Inheritance card matching their own color.

### Reward Challenge: Do or Die (3)

**Rules text:** Verbatim: "This is a game of trust. Pick any player to play a single game of Rock Paper Scissors against. If you tie, you each swap 1 card of your choice. BUT if either player wins, they steal 2 random cards from the loser." Sidebar: "You can strategize with the other player before you play! If you want to be nice you can both agree to play the same thing (and discuss which cards you want to swap), OR you can be sneaky and tell them one thing but do another!"

**Timing:** Your turn, as your one card play.

**Edge cases:** A SINGLE round of RPS — no replay on a tie; a tie is its own outcome (mutual 1-for-1 chosen swap). The winner may be the player who played the card OR the target. Explicitly named in the Sorry For You sidebar as a card whose steal can be blocked ("any cards they would steal from you as an effect of another card (like the Do Or Die Card)"). Pre-deal negotiation is explicitly non-binding — lying is endorsed by the rules.

### Reward Challenge: Power Pair (3)

**Rules text:** Verbatim: "Pick 2 other players. On the count of three, all 3 players (including you) hold out 1, 2, or 3 fingers. If EXACTLY 2 players show the same number of fingers, they each steal 1 random card from the 3rd player. If ALL players show the same number, each player discards 1 card. If everyone shows a different number of fingers, play again." Sidebar: "You can discuss what you're going to do before starting, but you don't have to tell the truth!"

**Timing:** Your turn, as your one card play.

**Edge cases:** Exactly 3 participants (you + 2 chosen), regardless of table size. Three distinct outcomes: exactly-2-match → the pair each steal 1 random card from the odd one out; all-3-match → all three discard 1; all-different → replay (repeat until a decision; note 1/2/3 with three players means all-different happens only on a full permutation). This is the multi-stealer case the Sorry For You sidebar covers: if the odd-one-out plays Sorry For You, BOTH stealers get nothing and BOTH discard 1.

### Reward Challenge: It's a Numbers Game (3)

**Rules text:** Verbatim: "On the count of three, all players (including you) will show 1-5 fingers. The player who shows the lowest UNIQUE number gets to steal 2 random cards from any player. If necessary, repeat until there's a single winner."

**Timing:** Your turn, as your one card play.

**Edge cases:** EVERY player in the game participates, not just chosen ones. "Lowest unique" means a number shown by exactly one player; if every number shown is duplicated there is no winner and the whole challenge replays. The winner may be any player, including one who didn't play the card. The winner chooses the victim; the 2 cards are random. Blockable by Sorry For You.

## Ambiguities

- TASK PREMISE IS WRONG: the publisher is Exploding Kittens (©2024, released Jan 2025), not Big Potato Games. Designers are Ian Clayman, Elan Lee and Jeff Probst; licensed from Survivor Productions, LLC. I found no Big Potato Games edition of this title at all. Also, there are no 'torches' as a component — the lives are 2 Survivor Character Cards per player, whose reverse side reads 'VOTED OUT' and depicts a snuffed torch.
- IDOL NULLIFIER IS UNDOCUMENTED. It appears nowhere in the official rulebook or the official Survival Guide, and is not one of the 67 Action Cards. It is a physically hidden 68th card (under the box's card holder, beneath a fake cardboard bottom) that players must discover. Its rules text above comes only from Geeky Hobbies, not from Exploding Kittens. Unresolved: the exact printed card wording; whether it cancels one specific Immunity Idol or all idols played that council; whether it can cancel an idol played for a THIRD player; whether an Immunity Idol can be played in response to a nullification; whether it returns to the deck or the Discard Pile. Any implementation is inventing a rule here, and should say so in-app.
- DRAW PILE EXHAUSTION. One Tribal Council card is always the literal bottom card of the deck, so the final draw of the game is always a Tribal Council. But the rules never say what happens if that last Tribal Council resolves and 3+ players remain with an empty Draw Pile. There is no reshuffle rule, no 'shuffle the Discard Pile' rule, and no 'game ends in a draw' rule. The rulebook only notes in passing that the Final Tribal Council 'could happen when you get to the bottom of the Draw Pile.' With 6 players and 5 Tribal Council cards (0 single + 5 double = up to 10 eliminations' worth), it is arithmetically possible to reach the bottom with more than 2 players alive if idols and ties reduce the eliminations. THIS IS A REAL GAP AN IMPLEMENTATION MUST FILL.
- CAMP RAID vs. TRIBAL COUNCIL CARD. Camp Raid says the raider takes the next card the victim draws 'no matter what it is.' The Tribal Council card says whoever draws it places it in front of themselves immediately and becomes Leader. These directly conflict. This is an open, explicitly-asked community question — BoardGameGeek thread 3513552 'Camp Raid with Tribal Council': 'If you play a camp raid on a player who gets tribal council, who gets to be the leader?' I could NOT read the answers: boardgamegeek.com sits behind a Cloudflare bot challenge that blocked the headless browser, WebFetch, curl with a browser UA, the BGG XML API (both v1 and v2, 'Unauthorized'), and the r.jina.ai reader proxy. Treat the thread as evidence the question is genuinely open, not as an answer.
- MULTIPLE IMMUNITY IDOLS BY ONE PLAYER IN ONE COUNCIL. Open community question — BoardGameGeek thread 3487916 'Immunity Idol': 'Can one player play more than 1 immunity idol. Aka 1 for themselves and one for an Ally?' The official text neither permits nor forbids it. The one-card-per-turn limit does not apply at Tribal Council, which argues for 'yes.' Thread answers unreadable (same Cloudflare block).
- LET'S FORM AN ALLIANCE — RANDOM OR CHOSEN STEAL? The official Survival Guide says 'You and your partner EACH steal 1 card from any other player' with no 'random,' while Power Pair, Do or Die and It's a Numbers Game all explicitly say 'random.' Geeky Hobbies also omits 'random.' I could not find a photo of the card face to settle whether the omission is deliberate (chosen steal) or just terse. Flagging because the two readings are meaningfully different in power level. RESOLVED AS A TOGGLE: `houseRules.allianceStealIsRandom` / `ALLIANCE_STEAL_RANDOM`, default true.
- SORRY FOR YOU SCOPE. It triggers when someone 'tries to TAKE cards from you.' Knowledge is Power uses 'GIVE' ('they must give you 1'), so it is unclear whether Sorry For You blocks it. The Spy Shack uses 'take,' so it presumably is blockable — but then it is unclear whether the Spy Shack player still got to LOOK at the hand before being blocked. Also unstated: whether Sorry For You can block Camp Raid taking your freshly-drawn card (Camp Raid says 'you take the next card they draw'), and whether it can be played more than once in response to a single multi-stealer effect.
- STEALING FROM AN EMPTY HAND. Step 1 of the turn is mandatory ('Yes, you must steal a card'), but nothing says what to do if the chosen player, or every other player, has zero cards in hand. This is reachable — Sorry For You forces discards, Power Pair can force all-three discards, and Inheritance/Spy Shack can strip a hand.
- HAND SIZE. No maximum hand size is stated and there is no discard-down step. Inheritance can hand a player an entire second hand at once.
- VOTING FOR YOURSELF. The rule is 'You must vote for a player in the current Tribal Council' — it does not say 'another player.' Whether self-voting is legal (and whether the Voting Box has a slot for every color including yours) is not stated. Likewise unstated: whether you may vote for a player who has already been fully eliminated (their color slot presumably still physically exists on the box).
- 'I'M THE LEADER NOW' AND TURN ORDER. The card says the new Leader takes the next turn, which overrides the default 'continue play with the player on your left [of the drawer].' Unstated: after the new Leader's turn, does the rotation continue clockwise from THEM (almost certainly yes) or snap back to the original drawer's seat? Also unstated whether the original drawer still performs the physical discard of the Tribal Council card.
- CONTROL THE VOTE ON A PLAYER WITH NO VOTE CARD. The card says 'take any player's Vote Card' and clarifies only the >1 case ('you only take 1'). It does not say what happens if the chosen player has zero Vote Cards, which is reachable when both copies of Control the Vote are played at the same council.
- INHERITANCE EDGE CASES. Unstated: what happens if the Inheritance holder is themselves fully eliminated in the same Double Elimination Tribal Council as their target; what happens if a player holds the Inheritance card matching their OWN color; and whether the eliminated player's Vote Card / Extra Votes / in-play Camp Raid transfer with the hand or are discarded.
- DISCUSSION HAS NO TIMER. The physical game gives the Leader unbounded discretion ('Allow discussion until you decide…'). The pre-rewrite code's fixed discussion timer was an app-level invention with no rules basis. THIS PORT: the Leader advances every phase by hand and nothing else does. The only clocks are SAFETY BACKSTOPS (`config.engine.timings.*SafetyTimeout`), which exist because a Discord table is not a physical one and one player who closes the app must not be able to freeze a council forever; every one of them is named in config and announced as a deadline the client renders as a live countdown, never as a duration baked into a sentence (audit #64).
- AGE/TIME RATING CONFLICT. The box and rulebook say 'Ages 8+ | 30-60 Mins.' Several retail and review listings say 13+ and 30-45 minutes. Trust the rulebook.
- OFFICIALGAMERULES.ORG ERROR. That third-party page says a voted-out player flips a Survivor Character Card 'face down.' The official rules say you TURN IT OVER to its printed 'VOTED OUT' side, which stays visible. Minor, but it is the kind of detail a reimplementation copies by mistake.

## How this implementation resolves each gap

Every one of these is a **named toggle in `src/config.ts`** with an env override, not a quiet
choice, and when a house rule actually decides something the bot says so in the channel
(`house_rule_applied`). Defaults are the reading that matches the pre-rewrite behaviour or the
most-supported community answer, so a table that never touches config plays the game it expects.

| Gap                                                    | Toggle                                | Default          |
| ------------------------------------------------------ | ------------------------------------- | ---------------- |
| Does Sorry For You block Knowledge is Power ("give")?  | `sorryForYouBlocksKnowledgeIsPower`   | `true`           |
| Does it block The Spy Shack?                            | `sorryForYouBlocksSpyShack`           | `true`           |
| …and did the spy still get to LOOK first?               | `spyShackLookHappensBeforeBlock`      | `true`           |
| Does it block Camp Raid's taking of the drawn card?     | `sorryForYouBlocksCampRaid`           | `true`           |
| Does it block Control the Vote?                         | `sorryForYouBlocksControlTheVote`     | `true`           |
| Camp Raid vs a drawn Tribal Council card                | `campRaidTakesTribalCouncilCard`      | `true` (raider leads) |
| May you vote for yourself?                              | `allowSelfVote`                       | `true`           |
| May you vote for an eliminated player?                  | `allowVotingForEliminatedPlayer`      | `false`          |
| Two Immunity Idols from one player in one council?      | `allowMultipleIdolsPerPlayerPerCouncil` | `true`         |
| Let's Form an Alliance: random or chosen steal?         | `allianceStealIsRandom`               | `true` (random)  |
| Does an Idol Nullifier cancel ALL idols or just one?    | `nullifierCancelsAllIdols`            | `false` (one)    |
| Is the Idol Nullifier in the deck at all?               | `deck.includeIdolNullifier`           | `true`           |
| May the mandatory steal name an empty-handed player?    | `allowStealFromEmptyHand`             | `true`           |
| Is a Vote Card stealable by an ordinary steal?          | `voteCardIsStealable`                 | `false`          |
| Tie-break tier 3: only idol PLAYERS, or those protected? | `tieBreakIdolTierIncludesProtected`  | `false`          |
| An exhausted draw pile with 3+ players alive            | `drawPileExhaustionPolicy`            | `"final_council"`|

Three gaps the rulebook leaves open are decided in the ENGINE rather than by a toggle, because
no reading of the printed rules supports the alternative:

- **Camp Raid on yourself is legal.** "Place this card face up in front of **any player**"; the
  only printed restriction is the sidebar's one-marker-per-player rule, which the engine checks.
  It is self-defeating, not illegal, and forbidding it left a player holding a permanently
  unplayable card once every opponent already carried a marker.
- **Knowledge is Power can only name a card that is IN this game's deck.** With
  `deck.includeIdolNullifier` off, no Idol Nullifier is ever minted, so offering it as a name
  would be a guaranteed miss that burns one of only three copies — and the "no" is public.
- **The compulsory vote has a forfeit.** "Everyone must vote" governs a table where the box is
  handed to the next seat. When the voting backstop expires with casts outstanding the engine
  forfeits them out loud, by name, and closes the box; there is no reading under which the
  correct answer is that the game stops forever.

## Community Clarifications & Edge Cases

PUBLISHER CORRECTION: the game is by Exploding Kittens (2025), designed by Ian Clayman, Elan Lee and Jeff Probst — not Big Potato. Searching for "Big Potato" errata will find nothing.

Two authoritative primary documents exist and both are public PDFs: the instruction booklet (SURV-CORE_Instructions_29AUG2024_Web.pdf) and, more importantly for edge cases, the SURVIVAL GUIDE (SURV-CORE_SurvivalGuide_07AUG024_Web.pdf) — a publisher-written per-card FAQ whose entire stated purpose is "Read this if you have questions about specific cards." It already answers most of the interactions in the task brief. There is NO published errata sheet, no publisher FAQ page beyond these two PDFs, and no support-page rules Q&A.

Community discussion is thin. The BGG Rules forum for this game has only 8 threads / 13 posts total; boardgamegeek.com is entirely Cloudflare-blocked to automated fetching (403 for WebFetch, headless browse, and r.jina.ai), and the BGG XML API now returns 401. I read the threads I could locate through the open, unauthenticated api.geekdo.com JSON API (/api/threads/<id> and /api/articles?threadid=<id>); thread IDs had to be harvested from web search, and I could only surface 2 of the 8 Rules threads. Reddit and Amazon Q&A are both bot-blocked and yielded nothing.

TWO FINDINGS THAT DIRECTLY AFFECT src/game/cardlist.json:
1. The repo is MISSING the INHERITANCE card entirely — 6 copies, one per player colour. The card counts prove it: the box says 67 Action Cards, of which 9 are Tribal Council and 6 are Vote, leaving 52 playable action cards. The repo's 14 card types sum to 46; adding Inheritance's 6 gives exactly 52.
2. The IDOL NULLIFIER is NOT part of the 67 and is NOT shuffled into the deck. It is a physical easter egg hidden inside the game box, under the card holder and a fake cardboard bottom. It appears in neither the instruction booklet nor the Survival Guide (I grepped both: zero mentions). Its only rules text is what is printed on the card itself. The repo currently deals it as a normal deck card, which is a real rules divergence and a design decision the bot has to make explicitly.

Third, smaller divergence: the repo's Immunity Idol text is correct (it does protect another player), but its Extra Vote timing is loose. Extra Vote is played DURING the vote, when the box is in front of you. Tribal Advantages are played BEFORE voting starts. These are different windows and the rulebook is emphatic about it.

TRIGGER: a player draws a Tribal Council Card as step 3 of their turn and places it face up in front of themselves IMMEDIATELY. That player is the Tribal Council Leader.

LEADER'S POWERS (rulebook): "you are responsible for starting the voting process, tallying the votes, and resolving ties (a very useful advantage)." The leader also resolves the whole "unclear who is voted out" cascade below.

PHASE 1 — TRIBAL ADVANTAGES + DISCUSSION. The leader's script: "Welcome to Tribal Council. If anyone has a Tribal Advantage Card, you may play it now or anytime before we vote." Then: "Now let's discuss who should be voted out. We can ask questions, form alliances, tell the truth, lie, and speak in private."
- Sidebar: "You can play as many Tribal Advantage Cards as you would like during this discussion, but NOT once voting has started."
- Sidebar: "If any votes are gained from a Tribal Advantage Card, they MUST be used during the current Tribal Council."
- The three Tribal Advantages are Control The Vote, Goodwill Gamble and I'm The Leader Now. Extra Vote is NOT a Tribal Advantage and is NOT played in this window.
- Discussion is unlimited and unrestricted (private side conversations in other rooms are explicitly endorsed) subject only to the three standing social rules: no giving cards, no showing cards, no hiding hand size.

PHASE 2 — VOTING. The leader decides when discussion ends: "All right, that's enough discussion. It is... time to vote!"
- All players close their eyes and tap the table in rhythm. Sidebar explains why: "So no one can hear how many votes are being cast."
- The Voting Box starts with the leader ("Everyone must vote. I'll go first.") and travels clockwise.
- When the box is in front of you, you open your eyes, place your Vote Card in the slot for the player you are voting for, optionally add any number of Extra Vote Cards (same target or different targets), then "pass the box to the player on your left (even if they don't have a Vote Card), tap them on the shoulder, and close your eyes."
- Voting is compulsory. Every player with a Vote Card must cast it, at this council, for a player.
- Alternative offered by the rulebook: "Or you can put the Voting Box in another room and let players vote in private." (This is the natural model for a Discord port — private DM voting.)

PHASE 3 — IDOLS. "Everyone, open your eyes. If anyone has an Immunity Idol and wants to play it, now would be the time to do so."
- Immunity Idol window: after ALL votes are cast, before ANY are tallied. It may protect the player who plays it OR any other player of their choice.
- Idol Nullifier window: after an Immunity Idol is played, still before tallying. It cancels that specific idol, re-exposing that player to their votes.
- Sidebar: "Any votes for a player who plays an Idol DO NOT count!"

PHASE 4 — TALLY AND ELIMINATION. "Okay, I'll open the box and tally the votes!" Votes for any player protected by a live (non-nullified) Immunity Idol are discarded.
- Single Elimination: the player with the most votes turns over ONE Survivor Character Card.
- Double Elimination: the two DIFFERENT players with the most votes each turn over ONE Survivor Character Card.
- Say "The Tribe Has Spoken!"
- Any player whose SECOND Survivor Character Card is now turned over is eliminated: they put their hand face up on the Discard Pile (unless a matching Inheritance card is played immediately, in which case that player takes their whole hand), and they become a Jury member.

TIES — SINGLE ELIMINATION: "The Tribal Council Leader gets to decide which of the tied players is voted out." No further constraint.

TIES — DOUBLE ELIMINATION (rulebook, all four cases):
- "If 3 or more players are tied with the most votes, the Tribal Council Leader gets to decide which 2 of the tied players are voted out."
- "If 2 players are tied with the most votes, both are voted out." (No leader discretion here — this case is automatic.)
- "If 1 player gets the most votes, and 2 or more are tied with the second most, the player with the most votes is voted out first. Then, the Tribal Council Leader decides which of the tied players is also voted out."
- "If there are only 3 players left and 2 players would be eliminated at the same time (leaving you with only 1 player left in the game), the Tribal Council Leader decides which of the tied players is eliminated. Immediately begin The Final Tribal Council."

UNCLEAR WHO IS VOTED OUT (this is the rule that answers "what if every vote is nullified?"). Rulebook: "If it's unclear who is voted out (because too many players tied, some players got no votes, and/or some players played Immunity Idols), the Tribal Council Leader must decide who to vote out using these criteria:
- First, always choose from the (non-immune) players who got votes. If there aren't any...
- Choose from the (non-immune) players who got no votes. Finally, if there's not enough of them...
- Choose from the players who played Immunity Idols."
A Tribal Council can therefore NEVER end with nobody voted out. If every single vote is nullified by idols, the cascade falls to tier 2 (non-immune players who got no votes) and, if the whole table played idols, to tier 3 — an idol holder gets voted out anyway. Geeky Hobbies states tier 1 slightly more permissively: "If everyone received the same number of votes or no votes, pick one of the players that received a vote (that didn't play an Immunity Idol)."

CLEANUP. Rulebook: "After voting has ended, return 1 Vote Card to every player who still has at least one Survivor Character Card left in the game. Discard all other cards used during the Tribal Council (including the Tribal Council Card) face up in the Discard Pile. After Tribal, continue play with the player on your left."
- Vote Cards reset every council, so a Control The Vote theft lasts exactly one council.
- Spent Extra Votes, Goodwill Gambles, played idols, the nullifier and the Tribal Council card all go to the Discard Pile.
- Turn order resumes to the LEFT of the Tribal Council Leader — unless I'm The Leader Now was played, in which case that player takes the next turn (or the player after them if they were just eliminated).

### Tribal Council (Single Elimination)

Survival Guide: "When you draw this card, you must put it on the table in front of you IMMEDIATELY. You are the Tribal Council Leader. Start the Tribal Council by encouraging players to talk about who they might be voting for. You decide when it's time to vote, and you are responsible for breaking ties. Place this card in the Discard Pile after the Tribal Council is finished." Rulebook: "The player with the most votes must turn over one of their Survivor Character Cards to indicate that they have been voted out."

**Timing:** Resolves immediately on being drawn, at the end of the drawer's turn (after Steal and Play).

**Edge cases:** Only ONE player loses ONE Survivor Character Card, never two. The drawer becomes Tribal Council Leader, which is described in the rulebook as "a very useful advantage" — the leader controls when voting starts, tallies the votes, and unilaterally breaks every tie. The card is physically oversized, so in the tabletop game every player can see a Tribal Council coming; a Discord port loses that signal. The Tribal Council card itself is discarded after the council, along with every other card used during it.

### Tribal Council (Double Elimination)

Rulebook: "The 2 different players with the most votes must each turn over one of their Survivor Character Cards to indicate that they have been voted out."

**Timing:** Same as Single Elimination.

**Edge cases:** The word "different" is load-bearing: one player can never lose both Survivor Character Cards at a single Double Elimination, no matter how the votes fall. If only 3 players remain and a Double Elimination would leave a single player, the rulebook overrides it: "the Tribal Council Leader decides which of the tied players is eliminated. Immediately begin The Final Tribal Council." A Double Elimination is also one of the three explicit ways the Final Tribal Council can start — "at a Double Elimination Tribal Council after just the first player is voted out" — i.e. if flipping the first player's card brings the game to two players, you stop and go straight to the Final Tribal Council rather than resolving the second elimination.

### Vote

Survival Guide: "Every player gets 1 Vote Card at the start of the game. When voting during a Tribal Council, you MUST place this card in one of the slots in the Voting Box. You must vote for a player in the current Tribal Council."

**Timing:** During the voting phase of a Tribal Council, when the Voting Box reaches you.

**Edge cases:** Voting is COMPULSORY — the leader's script says "Everyone must vote. I'll go first." You cannot abstain or hold your Vote Card back. The Vote Card is not part of your hand: it cannot be stolen by the mandatory turn-start steal, by Spy Shack, or by Knowledge Is Power — only Control The Vote takes it. Consequently a player with an EMPTY HAND still votes normally. The box is passed to every player in turn "even if they don't have a Vote Card" (i.e. even if Control The Vote took it), so the pass order does not change. After the council: "return 1 Vote Card to every player who still has at least one Survivor Character Card left in the game" — Vote Cards recycle each council, stolen ones come back, and eliminated players get none.

### Extra Vote

Survival Guide: "When voting during a Tribal Council, you MAY place this card in one of the slots in the Voting Box (or save it for later). You must vote for a player in the current Tribal Council."

**Timing:** DURING the voting phase, at the moment the Voting Box is in front of you — NOT during the pre-vote Tribal Advantage window. This is a different window from every Tribal Advantage card.

**Edge cases:** Rulebook sidebar: "If you have Extra Vote Cards, you can use them against the same player, a different player, or save them for later." You may hold any number and play any number in one council. Because votes go in secretly with everyone's eyes closed and players tap the table in rhythm specifically "so no one can hear how many votes are being cast," the number of extra votes cast is hidden information until the tally. Unlike votes GAINED from a Tribal Advantage, an Extra Vote in your hand carries over to future councils freely.

### Immunity Idol

Survival Guide: "Can only be played at Tribal Council AFTER all players have voted, but BEFORE votes are tallied. Any votes cast for you (or the player you choose) do not count." Sidebar: "If you're feeling secure and want to make (or protect) an ally, you can use this card for another player instead of yourself."

**Timing:** A narrow window: after the last vote is cast and before the leader opens the box. The leader's script prompts it: "If anyone has an Immunity Idol and wants to play it, now would be the time to do so."

**Edge cases:** YES, an Immunity Idol can protect another player — this is explicit in the Survival Guide and is the single most-asked question about the card. The protection is total for that council: "Any votes for a player who plays an Idol DO NOT count!" An idol played on a player who received zero votes is simply wasted. An idol is not a shield against being CHOSEN by the leader as a tie-breaker: the rulebook's unclear-elimination cascade explicitly ends with "Choose from the players who played Immunity Idols," so an idol holder can still be voted out if nobody else is eligible. COMMUNITY (NOT OFFICIAL): a BGG Rules thread asks "Can one player play more than 1 immunity idol. Aka 1 for themselves and one for an Ally?" — the single reply says "Yep!" but reasons purely from a famous moment on the TV show, not from the rulebook. The printed rules neither permit nor forbid it. Treat as unresolved. Because idols are played after voting, a player who reveals an idol before the vote has effectively announced it; the whole point of the timing is the blindside.

### Idol Nullifier

Card text (transcribed by Geeky Hobbies and matching the repo's cardlist.json): "Can only be played after an immunity idol, but before votes are tallied. Cancels that immunity idol."

**Timing:** After an Immunity Idol is played, before the leader tallies. Geeky Hobbies: "You must play the card before any votes are counted though."

**Edge cases:** THE BIG ONE: this card is a physical easter egg, not a deck card. Geeky Hobbies: "This is a secret card in Survivor The Tribe Has Spoken. It is hidden inside the box... The Idol Nullifier card is hidden underneath the card holder on the side of the box. You have to remove the holder along with a fake cardboard bottom. The card is underneath the fake bottom." I grepped both official PDFs: the words "nullif" and "Inheritance" appear ZERO times in the instruction booklet, and "nullif" appears zero times in the Survival Guide. The box's stated contents (67 Action Cards) exclude it. So there is no official rule for how it enters play, who owns it, or whether it is reshuffled — a player simply finds it and now has it. The Survival Guide does carry an unexplained cipher hint near the Immunity Idol entry — "i have a big hand pointing at a number and a little hand pointing at a number. Add their values. 1=A and 27=A" — a clock/letter puzzle that appears to be part of the hunt. It cancels exactly one specific Immunity Idol, not all idols played that council; with 4 idols and 1 nullifier, multiple idols in one council cannot all be cancelled.

### Sorry For You

Survival Guide, verbatim: "Play ANY time someone tries to take cards from you. Instead, they get nothing from you and must discard 1 card (regardless of how many cards you owe them). This includes any card they attempt to steal from you at the start of their turn or any cards they would steal from you as an effect of another card (like the Do Or Die Card). If you play a Sorry For You after a card that would allow more than 1 player to take cards from you, each of those players gets nothing, and must EACH discard 1 card instead."

**Timing:** Reactive, at any time, on your own turn or anyone else's. It is not your once-per-turn card play.

**Edge cases:** MULTI-CARD TAKES: one Sorry For You cancels the whole take and the thief discards exactly ONE card — "regardless of how many cards you owe them." So it blocks all 2 cards from Do Or Die or It's A Numbers Game at the cost of a single discard from the thief. MULTI-PLAYER TAKES: a single Sorry For You played against Let's Form An Alliance (or Power Pair) stops BOTH stealers and forces EACH of them to discard 1 — a 1-for-2 trade. Geeky Hobbies gives the Let's Form An Alliance case as its worked example. IT BLOCKS THE MANDATORY TURN-START STEAL — explicitly called out. The thief still had to declare the steal, so their turn's steal step is spent. The Survival Guide's own strategy note pairs it with dead cards: "It can be useful to have the Inheritance for a player that isn't in the game. You can discard it if someone plays a Sorry For You against you!" WHAT IT DOES NOT SAY: whether "tries to take cards from you" covers Knowledge Is Power (whose text is "they must GIVE you 1", not take), The Spy Shack ("look at any player's cards and TAKE one" — the take is explicit, but does the player still see your hand?), or Camp Raid (a delayed take of a card you have not drawn yet). See ambiguities.

### Let's Form An Alliance

Survival Guide: "Pick a player to be your partner. You and your partner EACH steal 1 card from any other player (for a total of 2 cards stolen). You can steal from the same player, but you can't steal from each other."

**Timing:** As your one card play on your turn.

**Edge cases:** The partner is not consulted and cannot decline — you "pick" them. Neither of you may target the other, so with only 3 players left the two allies must both steal from the single remaining player. Geeky Hobbies spells the targeting out: "Player A picks Player C as their teammate. Player A can pick anyone except player C to steal a card from. Player C can steal from any player other than Player A." Both steals are random. This is the card the Survival Guide uses as its canonical example of the multi-player Sorry For You clause: one Sorry For You from the target stops both allies and makes each of them discard 1.

### Reward Challenge: It's A Numbers Game

Survival Guide: "On the count of three, all players (including you) will show 1-5 fingers. The player who shows the lowest UNIQUE number gets to steal 2 random cards from any player. If necessary, repeat until there's a single winner."

**Timing:** As your one card play on your turn.

**Edge cases:** EVERY player still in the game participates, not just you — and the winner may well not be you. The winner then picks any player to steal 2 random cards from, which can be you. "Lowest unique" means a number nobody else showed: if the shows are 1,1,2 then 2 wins. If every number is duplicated (e.g. 1,1,2,2) there is no winner and you replay the whole challenge, repeating until someone wins; the challenge cannot end without a winner. Geeky Hobbies: "If there is no way to determine a winner, you will keep playing rounds until one player wins the challenge." This card is also the clearest reason Sorry For You says "regardless of how many cards you owe them" — the victim blocks both cards for one discard.

### Reward Challenge: Power Pair

Survival Guide: "Pick 2 other players. On the count of three, all 3 players (including you) hold out 1, 2, or 3 fingers. If EXACTLY 2 players show the same number of fingers, they each steal 1 random card from the 3rd player. If ALL players show the same number, each player discards 1 card. If everyone shows a different number of fingers, play again." Sidebar: "You can discuss what you're going to do before starting, but you don't have to tell the truth!"

**Timing:** As your one card play on your turn.

**Edge cases:** Exactly 3 participants, chosen by you. The two matching players can be the two opponents, in which case they steal from YOU — playing this card can lose you a card. The all-same outcome makes all three (including you) discard 1 each, with no steal at all. All-different replays indefinitely until one of the two resolving outcomes occurs. Because it can produce two simultaneous steals from one player, the multi-player Sorry For You clause applies here as well.

### Reward Challenge: Do Or Die

Survival Guide: "This is a game of trust. Pick any player to play a single game of Rock Paper Scissors against. If you tie, you each swap 1 card of your choice. BUT if either player wins, they steal 2 random cards from the loser." Sidebar: "You can strategize with the other player before you play! If you want to be nice you can both agree to play the same thing (and discuss which cards you want to swap), OR you can be sneaky and tell them one thing but do another!"

**Timing:** As your one card play on your turn.

**Edge cases:** "if EITHER player wins" — you can lose your own card and hand 2 random cards to your opponent. Only ONE round of Rock Paper Scissors is played; a tie is a real, defined outcome (a mutual chosen-card swap), not a replay. On a tie each player chooses which of their own cards to give, so it is the only non-random card exchange in the game. This card is the Survival Guide's named example of Sorry For You blocking a card-effect steal, so the loser can Sorry For You out of the 2-card loss and make the winner discard 1 instead. Prior agreements are explicitly non-binding.

### Camp Raid

Survival Guide: "Place this card face up in front of any player. You take the next card they draw at the end of their turn, no matter what it is, but only after they look at it. Then, place this card in the Discard Pile. You can't play this card on a player who already has a Camp Raid in front of them."

**Timing:** Played as your one card play on your turn; RESOLVES later, at the end of the target's next turn, after they have seen the drawn card.

**Edge cases:** The target gets to LOOK at the card before losing it — deliberate, so they gain the information even though they lose the card. "No matter what it is" is doing real work: it includes a Tribal Council Card. A BGG Rules thread asks exactly this — "If you play a camp raid on a player who gets tribal council, who gets to be the leader?" — and the answer, quoting the Survival Guide's "no matter what it is" clause, is: "You do!... they would draw the card, but then you take it, making you Tribal Council Leader." That is community consensus (one reply, unrefuted), not publisher errata, and it sits in real tension with the rulebook's instruction that the DRAWER must place a Tribal Council card in front of themselves IMMEDIATELY. It only ever takes the end-of-turn DRAW, not cards gained any other way. Camp Raids cannot be stacked on the same player, but different players can each hold one, and one player can have a Camp Raid in front of them while also holding Camp Raid cards in hand. Note the card sits in front of the TARGET but is owned by the raider — a state a bot must model as a persistent per-player marker, not a hand card.

### The Spy Shack

Survival Guide, in full: "Look at any player's cards and take one." Geeky Hobbies: "you will choose another player. You will look at their hand and choose one card to steal from their hand."

**Timing:** As your one card play on your turn.

**Edge cases:** The only card in the game that gives you a full look at a hand, and the only steal that is CHOSEN rather than random — which makes it the reliable way to take a known Immunity Idol. The Survival Guide entry is a single sentence with no clarifications at all, which is itself notable: the publisher wrote FAQ text for almost every other card and none for this one. Unresolved: if the target plays Sorry For You, have you already "looked"? The look and the take are one sentence, and the rules give no ordering.

### Knowledge Is Power

Survival Guide: "Ask any player for a card by name. If they have it, they must give you 1." Sidebar: "You can refer back to this Survival Guide if you forget the name of a card." Geeky Hobbies: "If they have multiple of the card, they will only give you one of the card."

**Timing:** As your one card play on your turn.

**Edge cases:** You must name a card exactly; a wrong guess gets you nothing and the card is spent. If they hold three copies you get exactly one, and they choose which (all copies are identical, so this only matters mechanically for hand-count tracking). The card is a strict information-gain even on a miss: a "no" tells the whole table that player lacks that card. The published review by Room Escape Artist flags that the timing differs from the Knowledge Is Power advantage on the TV show and that this trips up Survivor fans: "the timing of when you play that card was different from the advantage. This one change caused me to make a minor fool of myself in-game." Unresolved and heavily arguable: the card says the target must GIVE, not that you TAKE, so whether Sorry For You blocks it is genuinely open. Also unresolved: whether you may name the Idol Nullifier (a card most players do not know exists) or a Vote/Extra Vote card.

### Inheritance

Survival Guide: "Each Inheritance Card targets a different color player. When that player is eliminated from the game (by having both of their Survivor Character Cards turned over), you can IMMEDIATELY play this card. You get all of the cards in their hand instead of their cards going in the Discard Pile." Sidebar: "It can be useful to have the Inheritance for a player that isn't in the game. You can discard it if someone plays a Sorry For You against you!"

**Timing:** Reactive and immediate, at the moment the matching-colour player's SECOND Survivor Character Card is turned over — i.e. mid-Tribal-Council, before the eliminated player discards. Not your once-per-turn card play.

**Edge cases:** Triggers only on full elimination (both character cards), never on the first flip. You take their ENTIRE hand, including any Immunity Idols, Sorry For Yous or Tribal Advantages they were holding — potentially a huge swing, and the reason the rulebook has eliminated players place their hand "face up on top of the Discard Pile" otherwise. An Inheritance for a colour nobody is playing (any game under 6 players ships 6 Inheritance cards but only 3-6 colours are live) is a permanently dead card whose only use is as Sorry For You discard fodder — the publisher's own sidebar tells you to use it that way. Room Escape Artist's review calls this out as a design weak point: "At almost all times, any inheritance card felt like a dead card in my hand. Playing without them could speed up the game." On a Double Elimination that eliminates two players at once, two different Inheritance cards could trigger simultaneously; no ordering rule is given. Note the instruction booklet never mentions Inheritance at all — it exists only in the Survival Guide.

### Tribal Advantage: Control The Vote

Survival Guide: "Play this card during a Tribal Council before voting begins to take any player's Vote Card. You MUST use that Vote Card in addition to your Vote Card during the Tribal Council at which this card is played. If the player you pick has more than 1 Vote Card, you only take 1."

**Timing:** During the Tribal Council discussion, strictly BEFORE voting begins. Rulebook sidebar: "You can play as many Tribal Advantage Cards as you would like during this discussion, but NOT once voting has started."

**Edge cases:** Playing it is public — everyone sees whose vote you took. You MUST cast both votes this council; you cannot bank the stolen vote. The victim is left with no Vote Card, and the rulebook explicitly keeps them in the pass order anyway: the box is passed "to the player on your left (even if they don't have a Vote Card)." That preserves the rhythm and hides the fact that a vote was skipped. The "more than 1 Vote Card" clause exists because a player could already have taken someone else's with the other copy of Control The Vote — two copies exist, so a chain is possible. Your two votes may go to two different players. After the council, Vote Cards are redistributed one per surviving player, so the theft lasts exactly one council.

### Tribal Advantage: Goodwill Gamble

Survival Guide: "Give this card to another player during a Tribal Council before voting begins. This card counts as 1 vote, and MUST be used during the Tribal Council at which it is played (just like a Vote Card). They can use it to vote for any player they want."

**Timing:** During the Tribal Council discussion, before voting begins.

**Edge cases:** The "gamble" is that the recipient is under no obligation to you — Geeky Hobbies is explicit that "They can use the vote on any player, including the player that gave the card to them." The recipient MUST use it this council; they cannot decline it or save it. Effectively it is a forced Extra Vote handed to someone else. Combined with Control The Vote a player could theoretically be voting three or more times in one council. Unresolved: whether it can be given to a player whose own Vote Card was just taken by Control The Vote (nothing forbids it, and it would restore their voice).

### Tribal Advantage: I'm The Leader Now

Survival Guide: "Play this card during a Tribal Council before voting begins to become the Tribal Council Leader. It's your turn when the Tribal Council ends (or the player after you if you are eliminated)."

**Timing:** During the Tribal Council discussion, before voting begins.

**Edge cases:** Two separate effects, and the second is the one people miss. (a) You become Tribal Council Leader for this council: you decide when voting starts, you tally the votes, and — the real prize — you unilaterally break every tie and make every "unclear who is voted out" decision. (b) It rewrites the turn order: normally play resumes with the player to the LEFT of the leader, but this card makes the next turn YOURS. If you are voted out of the game at the very council you seized, the turn passes to the player after you instead. Only one copy exists, so it cannot be contested or re-stolen within a council. The rules do not say what happens to the original leader beyond losing the role, nor whether the original drawer still discards the Tribal Council card — presumably yes, since the Tribal Council card is discarded with everything else used that council.

### Survivor Character Cards (the two torches)

Rulebook: "As long as you have at least one Survivor Character Card, you're still in the game. When both your Survivor Character Cards are gone, you're out, but you'll still play an important role at the end of the game." And: "If both of your Survivor Character Cards have been turned over, you are eliminated from the game. When this happens, put your cards face up on top of the Discard Pile."

**Timing:** Flipped at the moment a Tribal Council resolves against you.

**Edge cases:** FIRST TORCH vs SECOND TORCH: losing the first is purely cosmetic in mechanical terms — you keep your hand, your Vote Card, your turns, and you can still win outright. Losing the second removes you from turn order and from voting, sends your entire hand face up to the Discard Pile (or to whoever holds your colour's Inheritance card), and makes you a Jury member. Character cards are FACE UP in front of you at all times, so who has one torch left versus two is public knowledge and is a major driver of vote targeting. The most recently eliminated player becomes the Final Tribal Council Leader, which means the last person voted out gets the single most decisive role in deciding the winner. Note that the number of remaining torches is irrelevant to the endgame trigger: the Final Tribal Council starts the moment two PLAYERS remain, even if one has two torches and the other has one.

### Unresolved

- SORRY FOR YOU vs KNOWLEDGE IS POWER — unresolved. Knowledge Is Power reads "they must GIVE you 1", while Sorry For You triggers when "someone tries to TAKE cards from you". The Survival Guide's list of what Sorry For You covers names only the turn-start steal and "any cards they would steal from you as an effect of another card (like the Do Or Die Card)" — it never mentions Knowledge Is Power, Spy Shack or Camp Raid. No official or community ruling found. Reading it as blockable is the broader, more consistent reading ("Play ANY time someone tries to take cards from you"); reading it as unblockable makes Knowledge Is Power the only guaranteed steal in the game.
- SORRY FOR YOU vs THE SPY SHACK — unresolved, and with a second-order problem. Spy Shack is one sentence: "Look at any player's cards and take one." If Sorry For You blocks it, does the Spy Shack player still get to LOOK at the hand before the block, or is the whole card cancelled? Nothing in the printed rules orders the look against the take. A bot must pick one; the information leak is significant either way.
- SORRY FOR YOU vs CAMP RAID — unresolved timing. Camp Raid is a delayed take of a card the victim has not drawn yet. There is no ruling on whether the victim may play Sorry For You when the Camp Raid is PLACED in front of them, only when it RESOLVES at the end of their next turn, or not at all (since at placement time no card is actually being taken).
- IDOL NULLIFIER: no official rules exist for it at all. It is absent from both the instruction booklet and the Survival Guide (grepped: zero hits in each), and excluded from the box's 67-card contents list, because it is a physical easter egg hidden under a fake bottom in the box. Nothing says who owns it once found, whether it enters the deck, whether it can be stolen out of a hand once revealed, whether Knowledge Is Power can name it, or what happens in a group where nobody ever finds it. Every digital implementation has to invent this. The repo currently shuffles it into the deck as an ordinary card, which is a deliberate divergence worth documenting rather than a bug.
- MULTIPLE IMMUNITY IDOLS IN ONE COUNCIL: the rules neither permit nor forbid one player playing two idols (e.g. one on themselves, one on an ally). The only source is BGG Rules thread 3487916, where the single reply says "Yep!" but argues from the TV show rather than the rulebook. Unofficial.
- TIE-BREAKER WHO IS THEMSELVES TIED: the rulebook says only "The Tribal Council Leader gets to decide which of the tied players is voted out" and imposes no restriction. Nothing stops a tied leader from simply sparing themselves, which makes the leader role close to full immunity in any tie. Whether that is intended or an oversight is unclear; the rulebook does call the role "a very useful advantage".
- VOTING FOR YOURSELF: the Vote Card entry says "You must vote for a player in the current Tribal Council" and the Voting Box physically has a slot for every colour including your own. Nothing explicitly permits or forbids self-voting. It matters mechanically because the unclear-elimination cascade prefers players who received votes.
- A PLAYER WITH AN EMPTY HAND: completely unaddressed. The turn-start steal is MANDATORY ("Yes, you must steal a card"), but no rule says what happens when the only legal targets have zero cards, or whether you may/must target a player with an empty hand and simply get nothing. Related unaddressed cases: a Reward Challenge winner stealing 2 cards from a player who holds 1 or 0; Power Pair's all-same outcome forcing a discard from a player with an empty hand; Sorry For You forcing a discard from a thief whose hand is now empty. Note that the empty-hand player is still fully functional at Tribal Council — the Vote Card is not part of the hand and "Everyone must vote" — so only the steal/discard interactions are open.
- DRAW PILE EXHAUSTION: partially answered by construction. Setup guarantees the BOTTOM card of the deck is a Tribal Council Card, and the rulebook lists "when you get to the bottom of the Draw Pile" as one of the three ways the Final Tribal Council can begin. So the last card drawn always triggers a final council. But nothing says what happens if that last council still leaves THREE or more players alive (possible if idols and the unclear-elimination cascade minimise flips): there is no reshuffle rule, no draw-pile-empty rule, and no instruction to jump to the Final Tribal Council with more than two players. The card math makes this unlikely at every player count but it is not formally closed.
- CAMP RAID STEALING A TRIBAL COUNCIL CARD: the community answer (BGG thread 3513552) is that the raider takes it and becomes Tribal Council Leader, quoting the Survival Guide's "no matter what it is". That is one unrefuted reply, not publisher errata, and it directly contradicts the instruction booklet's "When you draw a Tribal Council Card, IMMEDIATELY place it face up in front of you" — which reads as the DRAWER becoming leader. Flagging as unresolved: it is exactly the kind of thing a bot must hard-code and players will argue about.
- DOUBLE INHERITANCE ON A DOUBLE ELIMINATION: if a Double Elimination eliminates two players simultaneously and two different players hold the matching Inheritance cards, no ordering or simultaneity rule is given. Also unresolved: whether an Inheritance can be played on a player eliminated by the leader's tie-break/cascade decision rather than by raw vote count (nothing suggests otherwise, but the card says "when that player is eliminated", which the rules never define as vote-driven only).
- I'M THE LEADER NOW vs THE ORIGINAL LEADER: the card transfers the leader role and the next turn, but says nothing about the original drawer. Does the original leader still discard the Tribal Council card? Does anything else transfer? Also unresolved: whether it can be played after the original leader has already made some procedural decision but before voting formally begins.
- GOODWILL GAMBLE TO A PLAYER WITH NO VOTE CARD: nothing forbids giving a Goodwill Gamble to a player whose Vote Card was just taken by Control The Vote, which would restore their vote. Probably legal, not stated.
- AGE RATING INCONSISTENCY: the rulebook, box and Geeky Hobbies say Ages 8+; several retailer listings and officialgamerules.org say 13+. The rulebook is authoritative at 8+. Cosmetic, but worth noting if the repo's docs quote a rating.
- GEEKY HOBBIES' TRIBAL COUNCIL PLACEMENT PROCEDURE (split the deck into N equal piles, alternate Tribal Council card / pile) is a paraphrase and does not match the printed rule ("place 1 face down at the bottom... Insert the remaining Tribal Council Cards face down into the deck, spacing them evenly(ish) throughout"). Both put a Tribal Council card on the bottom; the printed rule leaves the rest genuinely random within even-ish spacing. THIS PORT implements the printed rule in `src/engine/deck.ts`, and `limits.tribalCouncilCardsAtDeckBottom` names the bottom-of-deck guarantee (audit #7: the old builder guaranteed it at 6 players only).
- BGG FORUM COVERAGE IS INCOMPLETE. boardgamegeek.com is entirely Cloudflare-blocked to automated access (403 to WebFetch, headless Chromium and r.jina.ai; the XML API returns 401). The game's Rules forum has 8 threads / 13 posts; I could only recover 2 of them (via the open api.geekdo.com JSON API, using thread IDs harvested from web search). Six Rules threads, roughly 9 posts, remain unread and could contain further clarifications. Reddit and Amazon Q&A are both bot-blocked and produced nothing. Anyone with a browser session on BGG should read https://boardgamegeek.com/boardgame/435367/survivor-the-tribe-has-spoken/forums/66 directly.

## Sources

- https://www.explodingkittens.com/products/survivor — official product page (contents, player count, age, playtime, links to both PDFs)
- https://www.explodingkittens.com/pages/how-to-play-survivor — official how-to-play landing page
- https://cdn.shopify.com/s/files/1/0345/9180/1483/files/SURV-CORE_Instructions_29AUG2024_Web.pdf — OFFICIAL RULEBOOK PDF (2 pages, ©2024 Exploding Kittens). Downloaded and read in full, both as extracted text and as rendered page images. This is the primary source for setup, the Tribal Council card table, turn structure, the Leader script, ties, the 'unclear who is voted out' ladder, and the Final Tribal Council.
- https://cdn.shopify.com/s/files/1/0345/9180/1483/files/SURV-CORE_SurvivalGuide_07AUG024_Web.pdf — OFFICIAL SURVIVAL GUIDE PDF (2 pages). Downloaded and read in full. This is the primary source for every card's verbatim rules text and quantity.
- https://www.youtube.com/watch?v=90ATLUjmcWQ — official 'How to play' video narrated by Jeff Probst; full transcript pulled. Corroborates setup, the 3-step turn, one-card-per-turn, and the Final Tribal Council.
- https://www.geekyhobbies.com/survivor-the-tribe-has-spoken-rules/ — Geeky Hobbies full rules writeup (Eric Mortensen, Jan 2025). Source for the deck-construction procedure phrased as an algorithm, the full component breakdown including the hidden Idol Nullifier, designer credits, and independent confirmation of the Tribal Council card table.
- https://www.geekyhobbies.com/survivor-the-tribe-has-spoken-card-meanings/ — Geeky Hobbies per-card reference. THE ONLY source I could reach for the Idol Nullifier's rules text and its physical hiding place.
- https://officialgamerules.org/game-rules/survivor-the-tribe-has-spoken-rules/ — third-party rules paraphrase; used only for corroboration (contains at least one error, noted in ambiguities).
- https://boardgamegeek.com/boardgame/435367/survivor-the-tribe-has-spoken — BGG entry. BLOCKED by a Cloudflare bot challenge; I could not read it directly.
- https://boardgamegeek.com/thread/3513552/camp-raid-with-tribal-council — BGG rules thread, 'If you play a camp raid on a player who gets tribal council, who gets to be the leader?' Title/question recovered from search snippets only; page body BLOCKED by Cloudflare.
- https://boardgamegeek.com/thread/3487916/immunity-idol — BGG rules thread, 'Can one player play more than 1 immunity idol. Aka 1 for themselves and one for an Ally?' Title/question recovered from search snippets only; page body BLOCKED by Cloudflare.
- Local files written during this research (all absolute paths, in the session scratchpad): /private/tmp/claude-501/-Users-michaelcortese-Developer-repos-github-com-michaelcortese-survivorengine/ab3f7fdb-6023-4835-aa04-c34093e03337/scratchpad/instructions.pdf, .../survivalguide.pdf, .../inst_raw.txt, .../sg_raw.txt, .../inst_hi-1.png (rulebook side 1), .../inst_p-2.png (rulebook side 2), .../sg-1.png and .../sg-2.png (Survival Guide sides 1 and 2). Keep these — they are the authoritative reference for implementing the card texts, and the two rulebook PNGs contain the Tribal Council count table that text extraction scrambles.
- https://cdn.shopify.com/s/files/1/0345/9180/1483/files/SURV-CORE_Instructions_29AUG2024_Web.pdf?v=1733873585 — OFFICIAL instruction booklet (Exploding Kittens). Primary source for setup, turn structure, Tribal Council script, tie rules, unclear-elimination cascade, Final Tribal Council.
- https://cdn.shopify.com/s/files/1/0345/9180/1483/files/SURV-CORE_SurvivalGuide_07AUG024_Web.pdf?v=1733873582 — OFFICIAL Survival Guide ("Read this if you have questions about specific cards"). The publisher's own per-card FAQ; the authoritative source for nearly every edge case in this report.
- https://www.explodingkittens.com/pages/how-to-play-survivor — publisher's how-to-play hub; where both PDFs above are linked from.
- https://www.youtube.com/watch?v=90ATLUjmcWQ — official how-to-play video narrated by Jeff Probst. Confirms the mandatory steal, one-card-per-turn limit, and that the first Tribal Council card always goes on the bottom of the deck.
- https://www.geekyhobbies.com/survivor-the-tribe-has-spoken-rules/ — Geeky Hobbies full rules writeup. Source for the complete component/quantity list (including the 6 Inheritance cards and the hidden Idol Nullifier) and the Ties/unclear-elimination restatement.
- https://www.geekyhobbies.com/survivor-the-tribe-has-spoken-card-meanings/ — Geeky Hobbies per-card meanings. Source for the Idol Nullifier's physical hiding place, the Knowledge Is Power multiples clarification, the Let's Form An Alliance targeting example, and the Goodwill Gamble "can vote for the giver" clarification.
- https://officialgamerules.org/game-rules/survivor-the-tribe-has-spoken-rules/ — independent rules transcription; corroborates the rulebook on setup, ties and the Final Tribal Council.
- https://boardgamegeek.com/thread/3487916/immunity-idol — BGG Rules forum: "Can one player play more than 1 immunity idol... 1 for themselves and one for an Ally?" Answer is affirmative but unofficial. Content read via https://api.geekdo.com/api/articles?threadid=3487916 (boardgamegeek.com itself is Cloudflare-blocked).
- https://boardgamegeek.com/thread/3513552/camp-raid-with-tribal-council — BGG Rules forum: Camp Raid played on a player who then draws a Tribal Council card. Community answer: the raider takes it and becomes Tribal Council Leader. Read via https://api.geekdo.com/api/articles?threadid=3513552
- https://boardgamegeek.com/thread/3442540/new-final-tribal-ideas — BGG: detailed community critique of Final Tribal Council jury math per player count, plus two house-rule variants. Read via https://api.geekdo.com/api/articles?threadid=3442540
- https://boardgamegeek.com/thread/3444011/survivor-card-game-challenges — BGG General forum thread on the absence of physical challenges. Read via https://api.geekdo.com/api/articles?threadid=3444011
- https://api.geekdo.com/api/forums?objectid=435367&objecttype=thing — BGG forum index for the game; shows the Rules forum (forumuid 4815436) holds only 8 threads / 13 posts.
- https://roomescapeartist.com/2025/09/23/exploding-kittens-survivor-tribe-spoken-review/ — review noting the Knowledge Is Power timing trap for TV-show fans and that Inheritance cards play as near-dead cards.
- https://boardgamegeek.com/boardgame/435367/survivor-the-tribe-has-spoken — BGG game page: publisher Exploding Kittens, 2025, designers Ian Clayman, Elan Lee, Jeff Probst.
