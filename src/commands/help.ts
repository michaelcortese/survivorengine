/**
 * `/help` — and the worked example every other command is written from.
 *
 * Read this file before writing a command. It is deliberately the simplest possible command that
 * still uses every part of the contract: a builder, an option with autocomplete, config-driven
 * copy, and exactly one ephemeral response through `ctx.reply`. The full contract, including how
 * to reach a session and dispatch an action, is documented on `Command` in
 * `src/discord/interactions.ts`.
 *
 * Three things this file demonstrates that are NOT optional:
 *
 *  1. `ctx.reply.send(...)` — never `interaction.reply`. One acknowledgement helper, always
 *     (audit #42/#45/#46/#89).
 *  2. Numbers come from `ctx.config`, never from a literal in the prose. Audit #95 was
 *     "the UI text already contradicts the code": the old bot's help said one thing while the
 *     engine enforced another, and both were hardcoded in different files.
 *  3. `autocomplete` answers fast and cannot defer. Discord gives it three seconds and shows
 *     nothing at all if it misses.
 *
 * The content itself is the rulebook in the order a new player meets it. `/help` is the first
 * thing anyone runs and audit #82 — "the error message names a command that does not exist" —
 * is the reason every command named below is checked against the real command surface.
 */

import { EmbedBuilder, SlashCommandBuilder } from "discord.js";

import type { SurvivorConfig } from "../config.js";
import type {
  AutocompleteContext,
  Command,
  CommandContext,
} from "../discord/interactions.js";
import { bold, quantity } from "../discord/format.js";

// ---------------------------------------------------------------------------
// Topics
// ---------------------------------------------------------------------------

const TOPIC_ORDER = [
  "overview",
  "setup",
  "turn",
  "cards",
  "council",
  "final",
  "commands",
] as const;

type Topic = (typeof TOPIC_ORDER)[number];

const TOPIC_LABEL: Readonly<Record<Topic, string>> = {
  overview: "How to play",
  setup: "Setting up a game",
  turn: "Your turn: steal, play, draw",
  cards: "Cards and when you may play them",
  council: "Tribal Council",
  final: "The Final Tribal Council",
  commands: "Every command",
};

/** Extra words that should find a topic in autocomplete but do not belong in its title. */
const TOPIC_KEYWORDS: Readonly<Record<Topic, readonly string[]>> = {
  overview: ["start", "rules", "how", "win", "basics", "new"],
  setup: ["lobby", "join", "begin", "colour", "color", "players", "torches", "resume"],
  turn: ["steal", "play", "draw", "skip", "phase", "order"],
  cards: [
    "hand",
    "timing",
    "idol",
    "advantage",
    "reaction",
    "sorry for you",
    "survival guide",
  ],
  council: [
    "vote",
    "voting",
    "leader",
    "idol",
    "nullifier",
    "tally",
    "tie",
    "eliminate",
  ],
  final: ["jury", "finalists", "winner", "endgame", "sole survivor"],
  commands: ["command", "slash", "list", "reference"],
};

const ACCENT = 0x2f6f4e;

function overview(config: SurvivorConfig): EmbedBuilder {
  const limits = config.engine.limits;
  return new EmbedBuilder()
    .setColor(ACCENT)
    .setTitle("Survivor: The Tribe Has Spoken")
    .setDescription(
      [
        `${quantity(limits.minPlayers, "player")} to ${limits.maxPlayers} play. You each start with ${quantity(limits.characterCardsPerPlayer, "Survivor Character Card")} — your torches — and ${quantity(limits.startingHandSize, "card")} in hand.`,
        "",
        `${bold("The goal.")} Be the last survivor with a torch still lit. Every Tribal Council snuffs at least one, and the last two standing face a jury of everyone who went home.`,
        "",
        `${bold("A turn is three steps.")} Steal a random card from somebody, then optionally play one card, then draw. Drawing a Tribal Council card stops everything and starts a council.`,
        "",
        `${bold("Everything you hold is secret; everything about how much you hold is not.")} Your hand is yours alone — but how many cards you have, how many torches you have left, and when the next council is coming are public to the whole table. \`/status\` shows all of it.`,
      ].join("\n"),
    )
    .setFooter({
      text: "More: /help setup · /help turn · /help council · /help final",
    });
}

function setup(config: SurvivorConfig): EmbedBuilder {
  const limits = config.engine.limits;
  return new EmbedBuilder()
    .setColor(ACCENT)
    .setTitle(TOPIC_LABEL.setup)
    .setDescription(
      [
        `${bold("1. Open a lobby.")} \`/survivor start\` posts a lobby in this channel. One game per channel, always.`,
        `${bold("2. Everyone joins.")} Press **Join** on the lobby message and pick a colour. ${limits.minPlayers}–${limits.maxPlayers} players.`,
        `${bold("3. The host presses Begin.")} Hands are dealt, the deck is built for your player count, and the first player is chosen.`,
        "",
        `${bold("Your torches.")} You hold ${quantity(limits.characterCardsPerPlayer, "Survivor Character Card")}. Losing one at a council flips it face down; losing the last one puts you on the jury, where you still choose the winner.`,
        "",
        `${bold("If the bot restarts")} mid-game, nothing is lost — \`/survivor resume\` brings this channel's game back exactly where it was.`,
        `${bold("If the host has to go,")} the role passes to the next player by itself — or the host hands it over first with \`/survivor host <player>\`.`,
        `${bold("If a game needs to end early,")} the host runs \`/survivor abandon\` and confirms.`,
      ].join("\n"),
    );
}

function turn(): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(ACCENT)
    .setTitle(TOPIC_LABEL.turn)
    .setDescription("A turn is always these three steps, in this order.")
    .addFields(
      {
        name: "1. Steal — `/steal <player>` · required",
        value:
          "Take one card at random from another player's hand. You do not choose which card, and they do not choose which card leaves. You must do this before you may play anything.",
      },
      {
        name: "2. Play — `/play` · optional, one card",
        value:
          "`/play` shows you, privately, exactly the cards you may legally play right now — no more and no less. Pick one and the bot walks you through any targets it needs. Not playing is a real choice: `/skip` says so out loud and moves the turn on.",
      },
      {
        name: "3. Draw — `/draw` · required, ends your turn",
        value:
          "Take the top card of the draw pile. If it is a Tribal Council card, put it down immediately: you are the Tribal Council Leader, and the whole table stops to vote somebody out.",
      },
      {
        name: "Out of turn",
        value:
          "Some cards answer somebody else's play — Sorry For You!, Immunity Idol, Idol Nullifier, Inheritance. You never need a command for those: the bot asks the players who may respond, with buttons, and waits.",
      },
    );
}

function cards(): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(ACCENT)
    .setTitle(TOPIC_LABEL.cards)
    .setDescription(
      [
        "`/hand` shows what you are holding, with the rules text of every card and what you may do with it right now. Only you can see it.",
        "",
        "`/card <name>` looks up any card in the box — the printed rules text, when it may be played, and how many are in the deck. It autocompletes, so start typing.",
        "",
        `${bold("Timing is the thing that catches people out.")} Some cards are played on your turn and use up your one card play. Some are reactions, played out of turn, and cost you nothing. Some — Immunity Idol, Idol Nullifier, the tribal advantages — may only be played at specific moments during a Tribal Council. \`/card\` states which for every card.`,
        "",
        `${bold("Cards are addressed by identity, never by position.")} A card you pick in a menu is the card you get, even if your hand changed while the menu was open.`,
      ].join("\n"),
    );
}

function council(): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0xb8860b)
    .setTitle(TOPIC_LABEL.council)
    .setDescription(
      "Whoever draws the Tribal Council card is the Leader. They run the council with `/council`, one phase at a time — the council never advances on a timer while people are still talking.",
    )
    .addFields(
      {
        name: "Advantages",
        value:
          "Anyone holding Control the Vote, Goodwill Gamble or I'm the Leader Now may play it now, in the open.",
      },
      {
        name: "Discussion",
        value: "Talk. Accuse. Lie. The Leader decides when it is time to vote.",
      },
      {
        name: "Voting — `/vote <player>`",
        value:
          "Every vote card you hold goes in the box, one `/vote` each. Your vote is secret until the box is opened, but the channel shows how many are in, so nobody is left waiting on a person who has already voted.",
      },
      {
        name: "Idols, then Nullifiers",
        value:
          "Anyone may play an Immunity Idol to protect themselves or somebody else — before any vote is read. Then, and only then, an Idol Nullifier may cancel one.",
      },
      {
        name: "Tally",
        value:
          "The votes are read out one at a time. Votes against a protected player do not count. Most votes goes home and turns over a torch.",
      },
      {
        name: "Ties",
        value:
          "A tie is broken by a fixed ladder, and if it comes down to it the Leader decides. The bot says which rung broke the tie and why.",
      },
    );
}

function final(): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0x4b0082)
    .setTitle(TOPIC_LABEL.final)
    .setDescription(
      [
        "When two survivors are left, the game stops being about cards and starts being about the people you sent home.",
        "",
        `${bold("The jury")} is everyone who has been voted out. The most recently eliminated player runs the council.`,
        `${bold("The finalists")} make their case, and may reveal their hands. They play no cards.`,
        `${bold("The jury asks questions,")} and then every juror votes for the finalist they want to win.`,
        `${bold("The votes are revealed together.")} An even jury can split evenly — then the Leader chooses, and they are not bound by their own vote.`,
        "",
        "The finalist with the most jury votes is the Sole Survivor.",
      ].join("\n"),
    );
}

function commands(): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(ACCENT)
    .setTitle(TOPIC_LABEL.commands)
    .addFields(
      {
        name: "Getting a game going",
        value: [
          "`/survivor start` — open a lobby in this channel",
          "`/survivor resume` — bring back this channel's game after a restart",
          "`/survivor host <player>` — hand the host role to somebody else (host only)",
          "`/survivor abandon` — end this channel's game (host or a server moderator, with a confirmation)",
        ].join("\n"),
      },
      {
        name: "Your turn",
        value: [
          "`/steal <player>` — step 1, take a random card",
          "`/play` — step 2, play a card (optional)",
          "`/skip` — step 2, decline",
          "`/draw` — step 3, draw and end your turn",
        ].join("\n"),
      },
      {
        name: "Knowing what is going on",
        value: [
          "`/hand` — your cards, privately",
          "`/status` — the public board: turn, torches, hand sizes, councils to come",
          "`/card <name>` — look up any card's rules",
          "`/help [topic]` — this",
        ].join("\n"),
      },
      {
        name: "Tribal Council",
        value: [
          "`/vote <player>` — cast one vote",
          "`/council` — the Leader's controls",
        ].join("\n"),
      },
      {
        name: "Buttons, not commands",
        value:
          "Reactions and windows — blocking with Sorry For You!, playing an idol, claiming an Inheritance, answering a challenge, discarding — are all buttons the bot posts when they become possible. A button belongs to one player and one moment; if it stops being valid, the bot says so instead of failing.",
      },
    );
}

function embedFor(topic: Topic, config: SurvivorConfig): EmbedBuilder {
  switch (topic) {
    case "overview":
      return overview(config);
    case "setup":
      return setup(config);
    case "turn":
      return turn();
    case "cards":
      return cards();
    case "council":
      return council();
    case "final":
      return final();
    case "commands":
      return commands();
    default:
      // Values from a Discord option are strings from the network, not members of a union.
      return overview(config);
  }
}

const isTopic = (raw: string): raw is Topic =>
  (TOPIC_ORDER as readonly string[]).includes(raw);

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

const help: Command = {
  data: new SlashCommandBuilder()
    .setName("help")
    .setDescription(
      "How to play Survivor: setup, turns, Tribal Council and the endgame.",
    )
    .addStringOption((option) =>
      option
        .setName("topic")
        .setDescription("Jump straight to one part of the rules")
        .setRequired(false)
        .setAutocomplete(true),
    ),

  async execute(ctx: CommandContext): Promise<void> {
    const requested = ctx.interaction.options.getString("topic") ?? "overview";
    const topic: Topic = isTopic(requested)
      ? requested
      : (resolveTopic(requested) ?? "overview");

    // Ephemeral, like every interaction response: help is reference material for one person,
    // not something the table needs pasted into the middle of a council.
    await ctx.reply.send({ embeds: [embedFor(topic, ctx.config)] });
  },

  async autocomplete(ctx: AutocompleteContext): Promise<void> {
    const query = ctx.focused.value.trim().toLowerCase();
    const matches = TOPIC_ORDER.filter(
      (topic) => query === "" || matchesTopic(topic, query),
    );
    await ctx.respond(
      matches.map((topic) => ({ name: TOPIC_LABEL[topic], value: topic })),
    );
  },
};

function matchesTopic(topic: Topic, query: string): boolean {
  if (topic.includes(query)) return true;
  if (TOPIC_LABEL[topic].toLowerCase().includes(query)) return true;
  return TOPIC_KEYWORDS[topic].some((keyword) => keyword.includes(query));
}

/** Somebody typed instead of picking. Fall back to the same matching autocomplete uses. */
function resolveTopic(raw: string): Topic | null {
  const query = raw.trim().toLowerCase();
  if (query === "") return null;
  return TOPIC_ORDER.find((topic) => matchesTopic(topic, query)) ?? null;
}

export default help;
