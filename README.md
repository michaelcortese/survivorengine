# Survivor Engine
## in typescript with Discord.js

A Discord bot for playing **Survivor: The Tribe Has Spoken** (the official Survivor card game) with friends over Discord.

## Setup

1. Create a Discord application with a bot user, and invite it to your server with the `bot` and `applications.commands` scopes. It needs to be able to send messages, embed links and attach files in the game channel.
2. Create a `.env` file:
   ```
   TOKEN=your-bot-token
   CLIENT_ID=your-application-id
   GUILD_ID=your-server-id
   ```
3. Install dependencies: `bun install` (or `npm install`).
4. Register the slash commands: `bun run deploy`. Run this again whenever commands are added or changed.
5. Start the bot: `bun run start` (or `bun run dev` to restart on changes).

The tribe board image is drawn with [`@napi-rs/canvas`](https://github.com/Brooooooklyn/canvas), which ships prebuilt binaries for Linux, macOS and Windows. If it can't load on your machine, the board falls back to a text version.

## How to play

### Setting up a game

- **`/setup`** opens a lobby. Players click **Join**, then **Pick Castaways** to choose the two Survivor players who are their lives. The host clicks **Start Game** once 3–6 players have joined.
- Anyone who doesn't pick gets two random legends. **`/castaways`** also picks them (with autocomplete) and can attach a photo for each one, in the lobby or mid-game.
- **`/start @player1 @player2 @player3 ...`** is a quick start that hands out random castaways.
- Both take an optional `discussion_minutes` for Tribal Council discussion time (default 3).

### Lives and the tribe board

Each player has two castaways. Every time you're voted out, one of them is grayed out on the tribe board (castaway #1 goes first). Lose both and your torch is snuffed: you join the jury. Your hand goes to whoever holds your **Inheritance** card, otherwise it's discarded.

The board is posted when the game starts and after every Tribal Council. **`/board`** shows it any time.

### Turns

On your turn, steal a random card from someone (`/steal_random`), optionally play a card, then **`/draw`** to end your turn. The bot keeps track of whose turn it is: only that player can draw. If someone is away, anyone can use **`/skip_turn`**.

`/steal_random` isn't locked to your turn, because Let's Form an Alliance also ends in steals (it's played out at the table, then settled with `/steal_random`, `/give` and `/discard`).

### Reward Challenges

Play a Reward Challenge card with **`/reward_challenge`**. Everyone taking part picks in secret with buttons (your pick is confirmed privately), and the picks are revealed once everyone is in:

- **`/reward_challenge numbers_game`**: everyone still in the game picks a number from 1 to 5. The lowest number that nobody else picked wins, and that player chooses someone to steal 2 random cards from. If every number was picked more than once, nobody wins.
- **`/reward_challenge power_pair player1 player2`**: you and the two players you name pick 1, 2 or 3. If exactly two of you match, you each steal 1 random card from the third; if all three match, you each discard 1 card; if all three are different, you play again.
- **`/reward_challenge do_or_die player`**: Rock Paper Scissors. The winner steals 2 random cards from the loser (that can be you); on a tie, you swap 1 random card.

Anyone who hasn't picked after a minute sits out the Numbers Game, or gets a random pick in Power Pair and Do or Die. Every steal can be blocked with `/sorry_for_you`. Only one challenge runs at a time, and nobody can draw until it's over.

### Tribal Council

Drawing a Tribal Council card starts one, with you as the leader:

1. **Discussion.** Play tribal advantages (`/extra_vote`, `/control_the_vote`, `/goodwill_gamble`, `/im_the_leader`). The leader can press **Start the vote** to end discussion early.
2. **Voting.** Everyone still in the game votes with `/cast_vote`.
3. **Idols.** `/immunity_idol` (you or another player), then `/idol_nullifier` if an idol was played.
4. **The votes are read** and the player with the most votes loses a castaway. A **double** Tribal Council votes out the top two, unless only three players remain.
5. **Ties.** The leader breaks a tie with `/break_tie`. If they don't decide within 5 minutes, it goes to rocks (a random pick).

If the draw pile runs out before the final two, every draw sends the tribe straight to Tribal Council.

### Final Tribal Council

When two players remain, the Final Tribal Council starts on its own. The finalists plead their case, and the jury votes for the winner with the buttons (or `/cast_vote`). The votes are read once every juror has voted, or after 10 minutes. The Final Tribal Council Leader (the last player voted out) breaks a tie, and can use `/reveal_votes` to read the votes early.

### Commands

| Command | What it does |
| --- | --- |
| `/setup`, `/start` | Start a game (lobby, or quick start) |
| `/castaways` | Pick your castaways and photos, or see yours |
| `/board` | Show the tribe board |
| `/hand`, `/card_info`, `/card_count` | Look at your cards, any card, or someone's hand size |
| `/draw`, `/skip_turn` | End your turn, or skip an absent player |
| `/steal_random`, `/give`, `/discard` | Move cards around |
| `/spy_shack`, `/knowledge_is_power`, `/camp_raid`, `/sorry_for_you` | Play action cards |
| `/reward_challenge` | Play a Reward Challenge: It's a Numbers Game, Power Pair or Do or Die |
| `/extra_vote`, `/control_the_vote`, `/goodwill_gamble`, `/im_the_leader` | Tribal advantages |
| `/cast_vote`, `/immunity_idol`, `/idol_nullifier`, `/break_tie` | Tribal Council |
| `/final_tribal_council`, `/reveal_votes` | Final Tribal Council (normally automatic) |
| `/upcoming_tribal_councils` | Draws until the next Tribal Councils |
| `/end_game` | End the game (or cancel a lobby) so a new one can start |

## Configuration

Timings can be changed with environment variables, in seconds:

| Variable | Default |
| --- | --- |
| `DISCUSSION_SECONDS` | 180 (a game's `discussion_minutes` overrides it) |
| `VOTING_SECONDS` | 60 |
| `IDOL_WINDOW_SECONDS` | 60 |
| `NULLIFIER_WINDOW_SECONDS` | 30 |
| `SORRY_FOR_YOU_SECONDS` | 15 |
| `TIE_BREAK_SECONDS` | 300 |
| `FINAL_VOTE_SECONDS` | 600 |
| `VOTE_READ_SECONDS` / `SUSPENSE_SECONDS` | 3 / 5 |
| `LOBBY_SECONDS` | 1800 |
| `MENU_SECONDS` | 60 |
| `REWARD_CHALLENGE_SECONDS` | 60 (time to pick in a Reward Challenge) |

Other settings (player counts, cards per player, share of double Tribal Councils) live in `src/game/config.ts`.

## Development

- `bun run typecheck` type-checks the bot and the tests.
- `bun run test` (or `bun test`) runs the tests. They drive real game flows through a fake Discord client in `test/helpers`.

## TODO:
- [x] Immunity Idols
- [x] FINAL TRIBAL
- [x] Implement double elim tribal council
- [x] Switch to using card enums for error validation rather than string literals
- [x] Refactor centralized config
- [x] Reset game command (`/end_game`)
- [x] FIX PROPORTIONS Tribal council cards (doubles now happen, official deck layout, and the game always reaches the final two)
- [x] Camp raid (steal next draw)
- [x] Force discard after getting sorry-for-you'd
- [x] REWARD CHALLENGE custom command
- [x] Inheritance functionality (automatic when a player is eliminated)
- [x] Pick your own castaways, grayed out as you lose lives
- [ ] Let's Form an Alliance command
- [ ] Keep games going across bot restarts
