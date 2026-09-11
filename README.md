# Survivor Engine

A Discord bot that runs the card game **[Survivor: The Tribe Has Spoken][game]** (Exploding
Kittens, 2024) so you can play it with friends over a voice call.

The bot is the table: it deals, shuffles, tracks every hand, runs Tribal Council, keeps the
votes secret until the box opens, and enforces the rules — including the ones people argue
about. You bring the arguing.

[game]: https://explodingkittens.com/products/survivor-the-tribe-has-spoken

---

## Quick start

```bash
git clone <this repo> && cd survivorengine
npm install
cp .env.example .env      # fill in TOKEN, CLIENT_ID, GUILD_ID
npm run deploy            # register slash commands
npm start
```

You need a Discord application with a bot user. `TOKEN` and `CLIENT_ID` come from the
[Developer Portal][portal]; `GUILD_ID` is your server's ID (right-click the server →
Copy Server ID, with Developer Mode on). Setting `GUILD_ID` registers commands to that one
server and they appear instantly — leave it blank to register globally, which takes up to an
hour to propagate.

`DISCORD_TOKEN`, `DISCORD_CLIENT_ID` and `DISCORD_GUILD_ID` are accepted as well and take
precedence; starting without a token or a client id prints both spellings of whichever is
missing and exits non-zero rather than half-starting.

The bot needs the `applications.commands` scope, and the **Send Messages**, **Embed Links**
and **Use Application Commands** permissions in the channel you play in.

[portal]: https://discord.com/developers/applications

---

## How to play

Each game lives in one **channel**. Several channels — and several servers — can run their
own games at the same time.

```
/survivor start     →  lobby appears, everyone hits Join and picks a colour
                    →  host hits Begin (3–6 players)
```

### Your turn is three steps, in order

| Step | Command            |                                                        |
| ---- | ------------------ | ------------------------------------------------------ |
| 1    | `/steal @player`   | **Mandatory.** Take one random card from their hand.   |
| 2    | `/play` or `/skip` | **Optional.** Play at most one card.                   |
| 3    | `/draw`            | **Mandatory.** Draw the top card. This ends your turn. |

`/play` shows you only the cards you can legally play _right now_ and walks you through
whatever the card needs — a target, a card to take, a challenge to throw. You never have to
remember a card's name or spell it correctly.

If someone tries to take cards from you and you're holding **Sorry for You**, the bot quietly
offers you the block. They get nothing and discard a card instead.

### Tribal Council

Drawing a Tribal Council card starts one immediately, and whoever drew it leads. The bot walks
the table through the leader's script:

**Advantages** → **Discussion** → **Vote** → **Immunity Idol** → **Idol Nullifier** → **Tally**

`/council` is the leader's panel: it shows where the council is and carries the button that
opens the next phase. The leader advances when the table is ready — the physical game has no
timers and neither does this one, beyond generous backstops that exist so one player who closed
Discord cannot freeze a council forever. If the voting backstop runs out with a vote still
uncast, the bot forfeits that vote **out loud, by name**, and the box closes with what is in it.

Votes go in with `/vote @player` and stay secret until the box is opened; the channel only shows
how many are in. Nothing the bot ever publishes says who voted for whom.

Then the votes are read one at a time, the way they should be.

### The rule everyone gets wrong

When it's unclear who goes home, the leader chooses — but **only from the tier the rules allow**,
descending only when a tier is empty:

1. Non-immune players who **received votes**
2. Non-immune players who received **no votes**
3. Players who **played Immunity Idols**

So an Immunity Idol is _not_ absolute protection. If everyone else is exhausted, an idol holder
still goes home. The bot offers the leader only the legal candidates and says which tier is in
force and why.

### The endgame

The moment two players remain, the **Final Tribal Council** begins — however many torches they
have left. Everyone voted out forms the jury, and the most recently eliminated player both votes
_and_ leads. The finalists can't play a card; they can only make their case and show their hands.
Then the jury votes **for** a winner, all at once. On a tie, the leader decides.

### Everything else

| Command                  |                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------- |
| `/status`                | The board: turn, phase, everyone's hand size and torches, cards left                  |
| `/hand`                  | Your cards, privately, with the rules text for each                                   |
| `/council`               | The Tribal Council panel — where the council is, and the leader's next step           |
| `/card <name>`           | The Survival Guide — any card's official text, with autocomplete                      |
| `/help`                  | How to play                                                                           |
| `/survivor host @player` | Hand the host role to somebody else                                                   |
| `/survivor abandon`      | End the game in this channel (host or a Manage Server moderator, with a confirmation) |
| `/survivor resume`       | Restore the game after a restart                                                      |

That is the whole surface: eleven slash commands (`/card`, `/council`, `/draw`, `/hand`,
`/help`, `/play`, `/skip`, `/status`, `/steal`, `/survivor`, `/vote`), with `/survivor`
carrying `start`, `host`, `abandon` and `resume`.

---

## Development

```bash
npm run dev         # watch mode
npm test            # 675 tests
npm run check       # typecheck + lint + engine purity + test — what CI runs
```

### How it's built

The rules live in a **pure engine** under `src/engine/` that has never heard of Discord. It
imports no `discord.js`, touches no filesystem, holds no timers, and never reads the clock. You
give it an action and a timestamp; it gives you back a new state and a list of events. That is
why the rules are testable at all, and why 675 tests can drive thousands of complete games in
under thirty seconds. `npm run engine:purity` fails the build if anything under `src/engine/`
ever acquires a `discord.js` import, a node builtin, a clock reading or a `Math.random()`.

Everything Discord-shaped lives in `src/discord/` and `src/commands/`, and talks to the engine
through one small facade. The engine emits _data_; the Discord layer decides what that looks
like and — critically — who is allowed to see it. Every event carries an audience, so a secret
cannot be rendered into a public channel by accident.

```
src/
  config.ts        every tunable in one place
  engine/          the rules. pure, deterministic, seeded, fully tested
  discord/         registry, renderer, components, formatting
  persistence/     atomic saves, one file per channel
  commands/        thin adapters — they dispatch and render, they never judge
  events/          interaction routing
tests/             15 suites, 675 tests
docs/
  RULES.md         the official rulebook + Survival Guide, transcribed
  ARCHITECTURE.md  the design, and what each decision prevents
  AUDIT.md         129 defects found in the previous implementation
```

Games are keyed per channel, saved atomically after every action, and restored on restart.
A restore rebases every open window by however long the bot was away, so a redeploy does not
forfeit a 20-second Sorry For You before anyone can press it. Shuffles are seeded, so a game can
be replayed exactly — set `SURVIVOR_RNG_SEED` to pin one.

### House rules

The physical rulebook leaves a few situations genuinely open, and `src/config.ts` has a toggle
for each rather than quietly picking one. When a house rule decides something, the bot says so
in the channel instead of silently applying it. See `docs/RULES.md` for the list of gaps.

---

## Credits

_Survivor: The Tribe Has Spoken_ is designed by Ian Clayman, Elan Lee and Jeff Probst, published
by Exploding Kittens. This is an unofficial fan project for playing a game you own with friends
who aren't in the room. It ships no card art of its own and is not affiliated with Exploding
Kittens or Survivor Productions.
