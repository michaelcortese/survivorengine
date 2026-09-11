# Audit Findings

A multi-agent audit of the pre-rewrite codebase found **129 confirmed defects** (157 raw findings, deduped to 156, each then adversarially verified; 27 refuted).
This file is the checklist the rewrite was built to satisfy.

## How many of the 129 does the rewrite close?

**All 129.** That sentence needs three qualifications to be honest, because "closed" does not
mean the same thing for every row.

**97 of the 129 are cited by number somewhere in `src/`, `tests/`, `scripts/`, `.github/` or
`docs/ARCHITECTURE.md`** — a comment naming the finding sits on the line that prevents it, a
test asserts the behaviour it asked for, or a lint rule / CI step makes it a build failure. That
is the strong form: there is something in the repository that fails if the defect returns. The
32 that are not cited individually are closed by CONSTRUCTION — the file, the command or the
whole mechanism they describe no longer exists (`/give`, `checkForError`, the busy-wait
interruption loop, `cardlist.json`, the blanket `*.js` in `.gitignore`, the missing `tsx` and
`prettier` dependencies, the missing eslint config). Nothing re-derives them, so there is
nothing for a guard to stand over.

**Four of them had partially COME BACK in the rewrite and were only closed in the final pass.**
This is the part worth stating plainly, because the rewrite's own claim of structural immunity
was overstated in exactly four places:

| #             | It came back as                                                                                             |
| ------------- | ----------------------------------------------------------------------------------------------------------- |
| 86            | `render.handEmbeds()` built the `/hand` header description with no `truncate`, so a 44-card hand threw out of `setDescription` and the player saw none of their cards. |
| 88            | `ui.componentsForLegalActions()` minted ENABLED `abandon_game` and `transfer_host` buttons that nothing could act on (latent: no production caller used the affected mode). |
| 16/42         | `Responder.announce()` shared the interaction's promise chain with the auto-defer, so a slow `channel.send` pushed the acknowledgement past Discord's 3-second deadline. |
| 66/43         | An unguarded `sink.publish` let one failed send abandon every remaining event in the batch, including private deliveries queued behind it. |

Each now has a test that fails against the old behaviour (`tests/render-audience.test.ts`,
`tests/customid.test.ts`, `tests/interaction-ack.test.ts`).

**Some rows are closed by a decision rather than by code.** #113 ("card reference data diverges
from the printed text") is closed for all 67 Action Cards, whose text in `CARD_CATALOG` is
verbatim from the official Survival Guide — but NOT for the hidden 68th card, the Idol
Nullifier, whose printed wording no reachable source records at all. `docs/RULES.md` says so,
`deck.includeIdolNullifier` lets a table play without it, and the bot announces it as a
divergence rather than pretending it is official. That is the most honest available answer, not
a fix.

Every item below is addressed by the current code.

| # | Sev | Area | Defect | Was at |
|---|-----|------|--------|--------|
| 1 | critical | rules-fidelity | The Final Tribal Council jury vote can never be cast — the endgame is unreachable | `src/commands/game/final_tribal_council.ts:94` |
| 2 | critical | missing-features | The jury vote is uncastable: nothing ever writes to finalTribalCouncil.votes, so the game can never be won | `src/commands/game/final_tribal_council.ts:100` |
| 3 | critical | missing-features | /cast_vote hard-rejects the FINAL state it is advertised for | `src/commands/game/cast_vote.ts:52` |
| 4 | critical | async-state | `TribalCouncilState.FINAL` is a terminal state with no writer for the jury votes — the game can never end | `src/commands/game/final_tribal_council.ts:94` |
| 5 | critical | ux-polish | Final Tribal Council tells jurors to run /cast_vote, which is hard-coded to reject them, and /reveal_votes always answers "0/N voted" | `src/commands/game/final_tribal_council.ts:110` |
| 6 | high | rules-fidelity | Tribal Council single/double counts do not match the official player-count table at any player count | `src/game/deck.ts:59` |
| 7 | high | rules-fidelity | No Tribal Council card is guaranteed to be the last card drawn (3/4/5 players) | `src/game/deck.ts:118` |
| 8 | high | rules-fidelity | Inheritance has no timing window, never consumes the card, and skips half the inherited hand | `src/commands/game/inheritance.ts:71` |
| 9 | high | rules-fidelity | The official 3-step turn (mandatory Steal, at most one Play, then Draw) is not enforced at all | `src/game/game.ts:166` |
| 10 | high | rules-fidelity | Turn rotation does not skip eliminated players | `src/game/game.ts:130` |
| 11 | high | rules-fidelity | Eliminated players are not removed from play and their hand is never discarded | `src/game/tribal_council.ts:75` |
| 12 | high | rules-fidelity | A Double Elimination can eliminate the second-to-last player, leaving one survivor and no Final Tribal Council | `src/game/tribal_council.ts:356` |
| 13 | high | rules-fidelity | A Double Elimination where only one player receives votes produces "Unexpected tie scenario" and only one elimination | `src/game/tribal_council.ts:448` |
| 14 | high | rules-fidelity | The "2 players remain" Final Tribal Council trigger fires on only one of four elimination paths | `src/game/tribal_council.ts:80` |
| 15 | high | rules-fidelity | Tribal Advantage cards are playable in every council phase, including after voting has closed | `src/commands/game/control_the_vote.ts:33` |
| 16 | high | rules-fidelity | Voting is not mandatory and votes are not validated: self-votes, votes for eliminated players, and silent no-shows all pass | `src/commands/game/cast_vote.ts:52` |
| 17 | high | rules-fidelity | "High-value" cards are never shuffled and land at fixed periodic slots, making idol timing deterministic | `src/game/deck.ts:143` |
| 18 | high | missing-features | Game.finalTribalLeader is assigned on exactly one code path, so reaching the final two via a tie or a double-elim second pick locks /final_tribal_council out permanently | `src/game/tribal_council.ts:82` |
| 19 | high | missing-features | There is no way to reset, abandon, or end a game — a wedged game requires restarting the process | `-` |
| 20 | high | missing-features | Draw pile exhaustion dead-ends the game: no reshuffle, no forced final council, and no guaranteed bottom tribal card below 6 players | `src/commands/game/draw.ts:34` |
| 21 | high | missing-features | A double elimination can reduce the game to one player, which no code path handles | `src/game/tribal_council.ts:357` |
| 22 | high | missing-features | Turn order is display-only: every action command can be run by any player at any time | `src/game/game.ts:166` |
| 23 | high | missing-features | nextPlayer() does not skip eliminated players, and /end_turn is owner-gated, so a dead or absent player permanently blocks turn advancement | `src/game/game.ts:130` |
| 24 | high | missing-features | No way to remove, replace, or drop a player mid-game | `-` |
| 25 | high | missing-features | Every tribal-council phase is a fixed sleep with no way to end it early — 10m30s minimum, and the UI text lies about it | `src/game/tribal_council.ts:56` |
| 26 | high | missing-features | /inheritance calls interaction.reply() twice and never removes the Inheritance card, so it always visibly fails and can be replayed | `src/commands/game/inheritance.ts:82` |
| 27 | high | missing-features | /resume restores tribalCouncilState without a TribalCouncil object, bricking the game; campRaid and all council state are silently dropped | `src/game/persistence.ts:112` |
| 28 | high | async-state | Sorry For You is silently dropped: the poller can exit its loop normally while `stopped` is true | `src/commands/game/sorry_for_you.ts:80` |
| 29 | high | async-state | `Game.stopInterruption()` is dead code; sorry_for_you never clears the 15s timer, which later clobbers an unrelated interruption | `src/commands/game/sorry_for_you.ts:91` |
| 30 | high | async-state | sorry_for_you's forced-discard collector is channel-wide, so two concurrent discards both handle the same button click and one crashes the process | `src/commands/game/sorry_for_you.ts:118` |
| 31 | high | async-state | Tribal council has no exit from the tie path: the state machine wedges in `Reading` with no timeout, no abort, and no admin reset | `src/game/tribal_council.ts:114` |
| 32 | high | async-state | `/break_tie` has no re-entrancy guard: two invocations inside the followUp window each decrement lives | `src/game/tribal_council.ts:489` |
| 33 | high | async-state | `/resume` restores `tribalCouncilState` while forcing `tribalCouncil = null`, producing an unrecoverable state | `src/game/persistence.ts:112` |
| 34 | high | async-state | A thrown followUp inside `waitForIdol`/`init` leaves `interruption.active = true` and the council state non-terminal, forever | `src/game/tribal_council.ts:529` |
| 35 | high | async-state | Reaching the final two via `/break_tie` never sets `Game.finalTribalLeader`, dead-ending the endgame | `src/game/tribal_council.ts:495` |
| 36 | high | async-state | `Game.active = false` in reveal_votes leaves `tribalCouncilState = FINAL`; the next `/start` produces an unplayable game | `src/commands/game/reveal_votes.ts:58` |
| 37 | high | async-state | `finalize` is registered on two collectors that expire simultaneously, so a timed-out forced discard removes two cards | `src/commands/game/sorry_for_you.ts:241` |
| 38 | high | async-state | An interrupted camp raid deletes the drawn card from the game and leaves the raid armed for unlimited retries | `src/commands/game/draw.ts:79` |
| 39 | high | async-state | 60-second component collectors splice by an index captured before the hand could be mutated, crashing the process when out of range | `src/commands/game/discard.ts:141` |
| 40 | high | async-state | Vote-granting cards are gated only on `!= NotStarted`, so votes can be gained after voting has closed | `src/commands/game/extra_vote.ts:29` |
| 41 | high | async-state | No `unhandledRejection`/`uncaughtException`/signal handlers, and login failure does not exit — every collector throw kills the game silently | `src/index.ts:75` |
| 42 | high | discord-api | /break_tie never acknowledges its own interaction — always shows "The application did not respond" | `src/commands/game/break_tie.ts:135` |
| 43 | high | discord-api | No process-level rejection handler; the error handler's own awaits are unguarded, so one dead webhook kills the bot and all in-memory game state | `src/events/interactionCreate.ts:32` |
| 44 | high | discord-api | Tribal Council burns 10m30s of fixed sleeps on a 15-minute interaction token, leaving ~3.5 min for a human tie decision | `src/game/tribal_council.ts:56` |
| 45 | high | discord-api | /control_the_vote calls followUp as its first interaction response — throws InteractionNotReplied every time | `src/commands/game/control_the_vote.ts:62` |
| 46 | high | discord-api | /inheritance calls interaction.reply() twice — guaranteed InteractionAlreadyReplied on every invocation | `src/commands/game/inheritance.ts:82` |
| 47 | high | discord-api | sorry_for_you attaches a channel-wide component collector filtered only by customId, so concurrent/prior forced discards cross-wire | `src/commands/game/sorry_for_you.ts:118` |
| 48 | high | code-quality | Game is a process-wide singleton with zero guild/channel scoping — one bot process can host exactly one game, and a second server silently corrupts the first | `src/game/game.ts:71` |
| 49 | high | code-quality | checkForError() mutates player hands during validation — every command that rejects after calling it permanently destroys the player's card with no rollback | `src/game/game.ts:270` |
| 50 | high | code-quality | Four interactive commands apply a hand mutation using an array index captured up to 60 seconds earlier against a live, concurrently-mutable array | `src/commands/game/discard.ts:141` |
| 51 | high | code-quality | The 15-second interruption countdown is a hand-copied 28-line busy-wait loop in three files (plus a fourth commented-out copy) and the three copies have already diverged in behavior | `src/commands/game/steal_random.ts:62` |
| 52 | high | code-quality | Game.stopInterruption() is dead code; the only teardown path is hand-rolled in sorry_for_you.ts and never clears the armed 15-second timer | `src/game/game.ts:155` |
| 53 | high | code-quality | The two-boolean interruption protocol has a lost-wakeup race: the poller can exit the loop normally on an interrupted action and apply the effect anyway | `src/commands/game/sorry_for_you.ts:79` |
| 54 | high | code-quality | Zero tests, zero CI, and the rules engine is not testable as written — every algorithm is reachable only through a live discord.js interaction and a module-level singleton | `package.json:6` |
| 55 | high | code-quality | inheritance.ts calls interaction.reply() twice, mutates the array it is iterating, and never consumes the Inheritance card | `src/commands/game/inheritance.ts:72` |
| 56 | high | code-quality | The Final Tribal Council exists as three mutually-unreachable implementations, one of which is a never-instantiated class with visibly broken structure | `src/commands/game/final_tribal_council.ts:11` |
| 57 | high | code-quality | tsconfig module:esnext against package.json type:commonjs makes the compiled build unrunnable, and the loader's hardcoded .ts filter makes it fail silently rather than loudly | `tsconfig.json:3` |
| 58 | high | code-quality | Deck.shuffle() never shuffles the high-value cards — it interleaves them in fixed cardlist.json order at a deterministic period | `src/game/deck.ts:145` |
| 59 | high | persistence-ops | applySnapshot restores tribalCouncilState but forces tribalCouncil = null, producing a permanently wedged game | `src/game/persistence.ts:112` |
| 60 | high | persistence-ops | The only save trigger is /end_turn, so every mid-turn mutation — and every Tribal Council — is lost on crash | `src/commands/game/end_turn.ts:30` |
| 61 | high | persistence-ops | `npm run build` produces output that cannot execute: ESM emit under "type": "commonjs" | `tsconfig.json:4` |
| 62 | high | persistence-ops | tsx and prettier power 4 of 6 npm scripts but are not dependencies; a clean `npm ci && npm start` fails | `package.json:7` |
| 63 | high | persistence-ops | No test script, no typecheck script, no test files, and no CI — for a project whose entire value is rule correctness | `package.json:6` |
| 64 | high | ux-polish | Tribal Council announces "8 minutes (30 seconds for testing)" then silently blocks the game for a real 8 minutes with no countdown and no way to end discussion early | `src/game/tribal_council.ts:53` |
| 65 | high | ux-polish | /control_the_vote always shows the player "There was an error while executing this command!" even though the vote steal succeeded | `src/commands/game/control_the_vote.ts:62` |
| 66 | high | ux-polish | When a Camp Raid is blocked by Sorry For You, the drawer is told "You drew a X" and the table is told they drew a card — but the card is deleted and never enters any hand | `src/commands/game/draw.ts:84` |
| 67 | high | ux-polish | /inheritance always visibly errors, and its messages read "You received Card A,Card B" and "Alice inherited 3 from bob" | `src/commands/game/inheritance.ts:77` |
| 68 | medium | rules-fidelity | handleDoubleElimination decrements lives inside the read/handle function, desynchronizing the tie path | `src/game/tribal_council.ts:425` |
| 69 | medium | rules-fidelity | Extra Vote is playable in any council phase, including phases where the gained vote can never be spent | `src/commands/game/extra_vote.ts:40` |
| 70 | medium | rules-fidelity | "I'm the Leader Now" implements only half the card — it never grants the next turn | `src/commands/game/im_the_leader.ts:59` |
| 71 | medium | rules-fidelity | Camp Raid can be stacked on one player, and never resolves on a Tribal Council draw while staying armed | `src/commands/game/camp_raid.ts:90` |
| 72 | medium | rules-fidelity | Hardcoded 8-minute discussion and 60-second vote windows replace the leader's authority; UI text contradicts the code | `src/game/tribal_council.ts:56` |
| 73 | medium | rules-fidelity | Sorry For You has no window against Knowledge is Power and is refused outright during Tribal Council | `src/commands/game/knowledge_is_power.ts:11` |
| 74 | medium | missing-features | 13 of the 47 deck cards have no command implementation at all | `src/game/cardlist.json:32` |
| 75 | medium | missing-features | There is no discard pile — every played and discarded card is permanently deleted from the game with no record | `src/game/deck.ts:9` |
| 76 | medium | missing-features | No command shows lives/torches remaining — the most important public state in the game is invisible | `-` |
| 77 | medium | missing-features | The tie path leaves the council permanently open with no timeout, no reminder, and no override | `src/game/tribal_council.ts:114` |
| 78 | medium | missing-features | /start never rebuilds the deck or clears tribal state, so a second game in the same process is impossible | `src/commands/game/start.ts:74` |
| 79 | medium | missing-features | checkForError never checks isAlive, so eliminated players keep playing cards, stealing, and being targeted | `src/game/game.ts:166` |
| 80 | medium | missing-features | /knowledge_is_power takes a free-text, case-sensitive card name with no autocomplete, and burns the card on a typo with no reply on one path | `src/commands/game/knowledge_is_power.ts:25` |
| 81 | medium | missing-features | There is no autocomplete/button/modal branch in the interaction dispatcher, capping what any command can offer | `src/events/interactionCreate.ts:17` |
| 82 | medium | missing-features | The README TODO list is the only design doc and five of its items are genuinely unimplemented, while one is stale | `README.md:4` |
| 83 | medium | async-state | TOCTOU on the single global interruption slot: two steals can be armed at once and one Sorry For You cancels both | `src/commands/game/steal_random.ts:51` |
| 84 | medium | async-state | `player.campRaid` can be overwritten during the 15-second draw window, redirecting the stolen card to a different raider | `src/commands/game/draw.ts:58` |
| 85 | medium | async-state | spy_shack's `collector.on('end')` fires 60s later and overwrites the public outcome with a false "timed out" | `src/commands/game/spy_shack.ts:231` |
| 86 | medium | discord-api | /hand builds a single content string that exceeds Discord's 2000-character limit at 12 distinct card kinds | `src/commands/game/hand.ts:57` |
| 87 | medium | discord-api | spy_shack's select-collector 'end' handler overwrites the public result message 60s after the action already resolved | `src/commands/game/spy_shack.ts:231` |
| 88 | medium | discord-api | Every component UI leaves its buttons/selects enabled after the 60s collector expires, producing "This interaction failed" | `src/commands/game/discard.ts:160` |
| 89 | medium | discord-api | /reveal_votes has no reply/defer on any success path — every terminal branch uses followUp | `src/commands/game/reveal_votes.ts:40` |
| 90 | medium | discord-api | Card art is pasted as bare URLs in message content, so it vanishes without the Embed Links permission and has no fallback | `src/commands/game/hand.ts:54` |
| 91 | medium | discord-api | /knowledge_is_power takes a free-text card name with no choices or autocomplete, and the card is consumed before the name is validated | `src/commands/game/knowledge_is_power.ts:25` |
| 92 | medium | discord-api | Tribal Council voting, idol plays and tie-breaking are slash commands with mention arguments where ephemeral component UIs are strictly better | `src/commands/game/cast_vote.ts:18` |
| 93 | medium | code-quality | checkForError's 7-positional-parameter signature is called with 5, 6, and 7 arguments across 19 files, with the same slot named three different ways and defaults silently load-bearing | `src/game/game.ts:166` |
| 94 | medium | code-quality | discard.ts and give.ts are ~90% byte-identical, and the copy already carries a stale label reference | `src/commands/game/give.ts:13` |
| 95 | medium | code-quality | Every duration is a hardcoded literal scattered across seven files, with no config module and no way to shorten a council for testing — and the UI text already contradicts the code | `src/game/tribal_council.ts:56` |
| 96 | medium | code-quality | control_the_vote.ts calls interaction.followUp() as the first response, which throws — after the card is consumed and the votes already moved | `src/commands/game/control_the_vote.ts:62` |
| 97 | medium | code-quality | The command/event directory walk is copy-pasted verbatim into two entry points, so every loader fix must be applied twice | `src/index.ts:27` |
| 98 | medium | code-quality | The save format has no schema version, no validation, and restores tribalCouncilState while forcing tribalCouncil to null — an unrecoverable state | `src/game/persistence.ts:112` |
| 99 | medium | code-quality | Turn ownership is enforced in exactly one command out of 26, and nextPlayer() hands turns to eliminated players | `src/game/game.ts:130` |
| 100 | medium | persistence-ops | Inheritance cards in a hand lose their inheritancePlayer link whenever the target player appears later in the players array | `src/game/persistence.ts:95` |
| 101 | medium | persistence-ops | Player.campRaid is absent from SerializedPlayer, so a pending Camp Raid silently evaporates across save/load and the raider's card is gone for nothing | `src/game/persistence.ts:16` |
| 102 | medium | persistence-ops | Snapshots carry no schema version and are applied with zero validation; the two files on disk already prove silent format drift | `src/game/persistence.ts:136` |
| 103 | medium | persistence-ops | Even with the module format fixed, the compiled bot silently loads ZERO commands because the loader filters for .ts | `src/index.ts:33` |
| 104 | medium | persistence-ops | .gitignore's blanket `*.js` and `*.d.ts` silently swallow every root tool config and any hand-written ambient types | `.gitignore:13` |
| 105 | medium | persistence-ops | Live game snapshots containing real Discord user IDs sit untracked at the repo root and are not covered by .gitignore | `.gitignore:36` |
| 106 | medium | persistence-ops | `npm run lint` fails outright: no eslint config exists and `--ext` is a removed flag | `package.json:11` |
| 107 | medium | persistence-ops | An 8-month-stale dist/ holds the live bot token in plaintext and there is no clean script | `package.json:9` |
| 108 | medium | ux-polish | There is no /status or /help command, and a player can never see how many lives/torches anyone has | `-` |
| 109 | medium | ux-polish | The tie prompts tell the leader to type /break_tie @player, which Discord will not accept — the option is named player1 | `src/game/tribal_council.ts:101` |
| 110 | medium | ux-polish | Losing your FIRST life is announced as "the 1st person voted out of Survivor" and "they have 1 lives left" — wrong drama, wrong grammar | `src/game/tribal_council.ts:312` |
| 111 | medium | ux-polish | /steal_random tells the thief exactly what they took but never tells the victim anything — unlike every sibling command, which DMs | `src/commands/game/steal_random.ts:102` |
| 112 | medium | ux-polish | After Spy Shack's Cancel, a "spy attempt timed out" message overwrites the result 60 seconds later; selecting-but-not-confirming leaves the public message stuck forever | `src/commands/game/spy_shack.ts:231` |
| 113 | low | rules-fidelity | Card reference data is incomplete and diverges from the printed card text | `src/game/cardlist.json:1` |
| 114 | low | async-state | The idol and nullifier windows announce themselves before arming `interruption.active`, so plays in that gap are spuriously rejected | `src/game/tribal_council.ts:523` |
| 115 | low | async-state | `/cast_vote` decrements the vote budget and then discards the vote through an optional chain when the council object is missing | `src/commands/game/cast_vote.ts:58` |
| 116 | low | discord-api | Deprecated `ephemeral` option used alongside MessageFlags, emitting Node process warnings | `src/commands/game/idol_nullifier.ts:149` |
| 117 | low | discord-api | interactionCreate handles only chat-input commands; there is no autocomplete, button, select or modal branch anywhere | `src/events/interactionCreate.ts:17` |
| 118 | low | discord-api | The interruption countdown busy-waits with an editReply per second per site, three copies, with no rate-limit or error handling | `src/commands/game/draw.ts:103` |
| 119 | low | discord-api | Guard replies are non-ephemeral in some commands and ephemeral in the very next guard of the same function | `src/commands/game/hand.ts:14` |
| 120 | low | discord-api | Council prompts advertise durations that do not match the hardcoded sleeps, and the windows cannot end early | `src/game/tribal_council.ts:53` |
| 121 | low | code-quality | Deck's constructor pushes the SAME Card object for every copy of a card, so no card in the game has an identity — which is the root cause of every index-based selection bug | `src/game/deck.ts:31` |
| 122 | low | code-quality | Three different numbering schemes for the same concept, with enum members compared as bare integers and one magic number chosen specifically to dodge a check | `src/commands/game/break_tie.ts:122` |
| 123 | low | code-quality | A substantial dead-code surface: nine never-called members, a write-only Player field, an unread Card field, and four blocks of commented-out logic | `src/game/game.ts:113` |
| 124 | low | persistence-ops | /resume reads an arbitrary caller-supplied filesystem path and requires no authorization at all | `src/commands/game/resume.ts:23` |
| 125 | low | persistence-ops | Debug console.log fires for every Tribal Council card on every load | `src/game/persistence.ts:83` |
| 126 | low | ux-polish | Public-by-rule information (hand sizes, turn order, upcoming councils) is sent ephemerally, so the table cannot see it | `src/commands/game/card_count.ts:34` |
| 127 | low | ux-polish | Playing an Immunity Idol on yourself announces "to protect <@you>" via a ternary whose two branches are identical | `src/commands/game/immunity_idol.ts:107` |
| 128 | low | ux-polish | "Discard Privately" lets a card leave the game with nobody knowing — discards are face-up public information in the physical game | `src/commands/game/discard.ts:66` |
| 129 | low | ux-polish | The /give confirmation says 'Click "Confirm Give"' but no such button exists | `src/commands/game/give.ts:134` |
