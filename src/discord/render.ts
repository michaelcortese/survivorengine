/**
 * GameEvents -> Discord messages. EVERY word a player reads is written here or in `format.ts`.
 *
 * The engine emits data and never prose (see the header of `engine/events.ts`), so this is the
 * single file where copy changes happen and the single file a rule change never touches.
 *
 * THREE HARD RULES, each closing a specific audit finding:
 *
 *  1. ROUTE BY `audience`, ALWAYS. `public` goes to `channel.send`; `players[…]` goes to those
 *     players and nobody else. Audit #119 ("guard replies are non-ephemeral in some commands and
 *     ephemeral in the very next guard of the same function") and #126 ("public-by-rule
 *     information — hand SIZES, turn order, upcoming councils — was sent ephemerally, while
 *     private information leaked publicly") both came from deciding this at the call site.
 *     `renderEvents` additionally re-checks every event against `EVENT_AUDIENCE_POLICY` and
 *     DROPS anything whose envelope disagrees with the policy: fail closed, never leak.
 *  2. NEVER DRIVE A FLOW OFF ONE INTERACTION TOKEN. Everything public is a fresh `channel.send`.
 *     Audit #44: the old Tribal Council burned 10m30s of `setTimeout` sleeps against a token
 *     that expires after 15 minutes, so its later `followUp()` calls threw and the game died
 *     mid-council.
 *  3. STAY UNDER THE LIMITS. Consecutive one-line public events are batched into one message and
 *     split at `discord.maxMessageLength`; embed text is truncated to its own ceiling. Audit
 *     #86: unbounded strings were rejected wholesale with a 400 and the player saw nothing.
 *
 * The dramatic beats — votes read out one at a time, "the tribe has spoken", the torch snuff,
 * the Final Tribal Council's "3… 2… 1…" — are `Beat` sequences with a pause between them. The
 * pause is `sink.pause()`, awaited by the RENDER queue, which the session runs strictly after
 * `dispatch()` has already returned. The engine is never inside that await.
 */

import { EmbedBuilder } from "discord.js";

import type { SurvivorConfig } from "../config.js";
import { CARD_CATALOG, PLAYER_COLORS } from "../engine/cards.js";
import type { CardDefinition } from "../engine/cards.js";
import {
  EVENT_AUDIENCE_POLICY,
  audienceMatchesPolicy,
  isPublic,
  recipientsOf,
  type ChallengeOutcome,
  type GameEvent,
  type HouseRuleId,
} from "../engine/events.js";
import type {
  CardInstance,
  CardUid,
  ChallengeSubmission,
  GameView,
  PendingKind,
  PlayerId,
  PrivateView,
  PublicPlayerView,
} from "../engine/types.js";
import { assertNever } from "../engine/types.js";
import type { Logger } from "../logger.js";
import { castawaysLine } from "./board.js";
import {
  bold,
  cardName,
  castawayList,
  colorEmoji,
  colorHex,
  councilKindLabel,
  deadline,
  humanDuration,
  humanize,
  instanceName,
  italic,
  joinAndSplit,
  mention,
  mentionList,
  ordinal,
  possessive,
  quantity,
  splitByLength,
  tieBreakTierLabel,
  torchCount,
  torches,
  verbToBe,
  truncate,
  verbHas,
} from "./format.js";

// ---------------------------------------------------------------------------
// Palette. Presentation only — not policy, so not config.
// ---------------------------------------------------------------------------

const ACCENT = {
  neutral: 0x2f6f4e,
  council: 0xb8860b,
  elimination: 0x8b1a1a,
  final: 0x4b0082,
  win: 0xd4af37,
  info: 0x3a6ea5,
} as const;

// ---------------------------------------------------------------------------
// What the renderer needs to know
// ---------------------------------------------------------------------------

/**
 * Everything a narration may consult. Deliberately small: a renderer that could reach `state()`
 * could reach the secret ballot, and `GameView` is structurally incapable of carrying one.
 */
export interface RenderContext {
  /** The PUBLIC view, captured after the dispatch that produced these events. */
  readonly view: GameView;
  readonly config: SurvivorConfig;
  /** Resolve a uid against the card registry. Card identities are not secrets; hands are. */
  card(uid: CardUid): CardInstance | null;
}

export interface OutgoingMessage {
  readonly content?: string;
  readonly embeds?: readonly EmbedBuilder[];
}

/**
 * Where rendered messages go. An interface, not a channel, so that `registry.ts` can supply the
 * channel plus an ephemeral-or-DM courier, and a test can supply an array.
 */
export interface RenderSink {
  /** `audience: public`. A fresh `channel.send`, never a followUp on an interaction token. */
  publish(payload: OutgoingMessage): Promise<void>;
  /** `audience: players[…]`. Ephemeral to the acting player, a DM to anyone else. */
  whisper(playerIds: readonly PlayerId[], payload: OutgoingMessage): Promise<void>;
  /** The dramatic pause. Injected so a test never sleeps. */
  pause(ms: number): Promise<void>;
}

/** One paced message in a ceremony. */
export interface Beat {
  readonly content?: string;
  readonly embeds?: readonly EmbedBuilder[];
  /** Pause AFTER this beat. Omitted means the configured vote-reveal interval. */
  readonly pauseAfterMs?: number;
}

/**
 * How one event wants to be shown.
 *
 * `line` is the common case and is BATCHED with its neighbours, so a turn does not produce six
 * separate messages. `message` and `beats` flush the batch first, so ordering is never scrambled.
 */
export type Narration =
  | { readonly kind: "line"; readonly text: string }
  | {
      readonly kind: "message";
      readonly content?: string;
      readonly embeds?: readonly EmbedBuilder[];
    }
  | { readonly kind: "beats"; readonly beats: readonly Beat[] };

const line = (text: string): Narration => ({ kind: "line", text });
const message = (
  content: string | undefined,
  embeds?: readonly EmbedBuilder[],
): Narration => ({ kind: "message", content, embeds });

// ---------------------------------------------------------------------------
// The renderer
// ---------------------------------------------------------------------------

export interface RenderOptions {
  readonly logger: Logger;
}

/**
 * Render a batch of events.
 *
 * Order is preserved exactly. Public one-liners are coalesced; anything with an embed or a
 * ceremony gets its own message. Private events go only to the players named in their envelope.
 */
export async function renderEvents(
  events: readonly GameEvent[],
  ctx: RenderContext,
  sink: RenderSink,
  options: RenderOptions,
): Promise<void> {
  const max = ctx.config.discord.maxMessageLength;
  let batch: string[] = [];

  /**
   * A payload with neither content nor an embed.
   *
   * Discord rejects one with 50006 "Cannot send an empty message", and until that rejection was
   * contained below it aborted the whole batch — the table saw "3… 2… 1…" and then silence
   * while the game carried on without them. Nothing should reach the sink empty in the first
   * place (every narration now has copy for its empty case), so this is the belt to that pair
   * of braces: it logs rather than sends, and the rest of the batch survives either way.
   */
  const isEmpty = (payload: OutgoingMessage): boolean =>
    (payload.content === undefined || payload.content.trim() === "") &&
    (payload.embeds?.length ?? 0) === 0;

  /**
   * ONE delivery. A transport failure costs this message and nothing else.
   *
   * The try/catch above `describeEvent` says "a renderer throw must never cost the table the
   * rest of the batch" — but it only ever wrapped the NARRATION. Every `sink.publish` sat
   * outside it, so a 50006, a 50013 after a permission change, a deleted channel or an
   * unretried 429 propagated out of `renderEvents` into `enqueueRender`'s catch, which logged
   * "rendering failed" and abandoned every remaining event: the tally, the eliminations, the
   * torch snuff and the turn end, on a game whose state had already moved on (audit #66/#43).
   * Note the contrast with the whisper path, which was defensive at every level already.
   */
  const deliver = async (
    what: string,
    event: GameEvent | null,
    send: () => Promise<void>,
  ): Promise<void> => {
    try {
      await send();
    } catch (cause) {
      options.logger.error("could not deliver a rendered message", cause, {
        what,
        type: event?.type,
        seq: event?.seq,
      });
    }
  };

  const publish = async (
    event: GameEvent | null,
    payload: OutgoingMessage,
  ): Promise<void> => {
    if (isEmpty(payload)) {
      options.logger.error("refusing to publish an empty message", undefined, {
        type: event?.type,
        seq: event?.seq,
      });
      return;
    }
    await deliver("publish", event, () => sink.publish(payload));
  };

  const whisper = async (
    event: GameEvent,
    recipients: readonly PlayerId[],
    payload: OutgoingMessage,
  ): Promise<void> => {
    if (isEmpty(payload)) {
      options.logger.error("refusing to whisper an empty message", undefined, {
        type: event.type,
        seq: event.seq,
      });
      return;
    }
    await deliver("whisper", event, () => sink.whisper(recipients, payload));
  };

  /**
   * Send the coalesced one-liners.
   *
   * No event is named: the batch holds lines from SEVERAL events by definition, so attributing
   * a delivery failure to whichever event happened to force the flush would be a lie in the
   * log line an operator actually reads.
   */
  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    const pieces = joinAndSplit(batch, max);
    batch = [];
    for (const content of pieces) await publish(null, { content });
  };

  for (const event of events) {
    // The envelope is a runtime value chosen at ~80 emit sites; the policy table is the
    // decision. When they disagree the event is DROPPED, not guessed at — a leaked hand cannot
    // be un-leaked, and the log line is enough to find the emit site.
    if (!audienceMatchesPolicy(event)) {
      options.logger.error(
        "event audience disagrees with EVENT_AUDIENCE_POLICY; dropped",
        undefined,
        {
          type: event.type,
          seq: event.seq,
          envelope: event.audience.kind,
          policy: EVENT_AUDIENCE_POLICY[event.type],
        },
      );
      continue;
    }

    let narration: Narration | null;
    try {
      narration = describeEvent(event, ctx);
    } catch (cause) {
      // A renderer throw must never cost the table the rest of the batch. The state is already
      // committed; only the words are at risk.
      options.logger.error("could not narrate an event", cause, {
        type: event.type,
        seq: event.seq,
      });
      continue;
    }
    if (!narration) continue;

    // `isPublic`/`recipientsOf` come from `engine/events.ts`, which is where the audience
    // envelope is defined. Audience routing is the first of this file's three hard rules and
    // the one whose failure "cannot be un-leaked" — so having the engine own the predicate
    // while the layer that must not get it wrong re-derived it inline is exactly the
    // configuration that produced audit #119/#126.
    const toEveryone = isPublic(event);
    const recipients = recipientsOf(event);
    if (!toEveryone && recipients.length === 0) continue;

    if (narration.kind === "line") {
      if (toEveryone) {
        batch.push(narration.text);
      } else {
        await flush();
        for (const content of splitByLength(narration.text, max)) {
          await whisper(event, recipients, { content });
        }
      }
      continue;
    }

    await flush();

    // `message` and `beat` bodies go through the same splitter the `line` path uses. They did
    // not, and the file header's "STAY UNDER THE LIMITS" claim therefore held for one of the
    // three narration kinds: `take_resolved` after an Inheritance claim, `spy_shack_peeked` and
    // `finalist_hand_revealed` all enumerate a whole unbounded hand, and stayed under 2000
    // characters only because the physical box holds 68 cards. That is arithmetic, not a guard.
    if (narration.kind === "message") {
      const pieces = splitContent(narration.content, max);
      for (const [index, content] of pieces.entries()) {
        const payload: OutgoingMessage = {
          content,
          // The embeds ride with the LAST piece, so they still sit under their own text.
          embeds: index === pieces.length - 1 ? narration.embeds : undefined,
        };
        if (toEveryone) await publish(event, payload);
        else await whisper(event, recipients, payload);
      }
      continue;
    }

    for (const [index, beat] of narration.beats.entries()) {
      const pieces = splitContent(beat.content, max);
      for (const [piece, content] of pieces.entries()) {
        const payload: OutgoingMessage = {
          content,
          embeds: piece === pieces.length - 1 ? beat.embeds : undefined,
        };
        if (toEveryone) await publish(event, payload);
        else await whisper(event, recipients, payload);
      }
      if (index < narration.beats.length - 1) {
        await deliver("pause", event, () =>
          sink.pause(beat.pauseAfterMs ?? ctx.config.engine.timings.voteRevealInterval),
        );
      }
    }
  }

  await flush();
}

/**
 * One narration body as the pieces it will be sent in. A body with no text is still one
 * (empty) piece, because the embeds that ride with it still have to go out.
 */
function splitContent(
  content: string | undefined,
  max: number,
): readonly (string | undefined)[] {
  if (content === undefined || content === "") return [content];
  const pieces = splitByLength(content, max);
  return pieces.length === 0 ? [content] : pieces;
}

// ---------------------------------------------------------------------------
// Naming helpers
// ---------------------------------------------------------------------------

const playerOf = (ctx: RenderContext, id: PlayerId): PublicPlayerView | null =>
  ctx.view.players.find((p) => p.id === id) ?? null;

/** Display name, for embed titles and field names where a mention would not render. */
const nameOf = (ctx: RenderContext, id: PlayerId): string =>
  playerOf(ctx, id)?.displayName ?? "a player";

/** The colour dot that identifies a player at a glance, matching their physical colour. */
const dotOf = (ctx: RenderContext, id: PlayerId): string => {
  const player = playerOf(ctx, id);
  return player ? colorEmoji(player.color) : "•";
};

const submissionText = (submission: ChallengeSubmission): string =>
  submission.kind === "rps"
    ? { rock: "🪨 Rock", paper: "📄 Paper", scissors: "✂️ Scissors" }[submission.throw]
    : `${"☝️✌️🤟🖖🖐️"[submission.count - 1] ?? ""} ${submission.count}`;

const challengeName = (
  kind: "do_or_die" | "power_pair" | "its_a_numbers_game",
): string => cardName(kind);

// ---------------------------------------------------------------------------
// House rules, in players' words
// ---------------------------------------------------------------------------

/**
 * docs/RULES.md: "Any implementation is inventing a rule here, and should say so in-app." This
 * is how it says so. `Record<HouseRuleId, …>` so a new house rule cannot ship silently.
 */
const HOUSE_RULE_BLURB: Readonly<Record<HouseRuleId, string>> = {
  sorryForYouBlocksKnowledgeIsPower:
    "whether Sorry For You can block Knowledge is Power (the card says *give*, not *take*)",
  sorryForYouBlocksSpyShack: "whether Sorry For You can block The Spy Shack",
  spyShackLookHappensBeforeBlock:
    "whether a blocked Spy Shack still got to look at the hand first",
  sorryForYouBlocksCampRaid:
    "whether Sorry For You can block a Camp Raid as it resolves",
  sorryForYouBlocksControlTheVote:
    "whether Sorry For You can block Control the Vote taking a Vote Card",
  campRaidTakesTribalCouncilCard:
    'whether a Camp Raid takes a drawn Tribal Council card ("no matter what it is")',
  allowSelfVote: "whether you may vote for yourself",
  allowVotingForEliminatedPlayer:
    "whether you may vote for an already-eliminated player",
  allowMultipleIdolsPerPlayerPerCouncil:
    "whether one player may play more than one Immunity Idol at a council",
  allianceStealIsRandom:
    "whether the Let's Form an Alliance steal is random (the card omits the word)",
  nullifierCancelsAllIdols:
    "whether an Idol Nullifier cancels every idol or just the one named",
  allowStealFromEmptyHand:
    "whether the mandatory steal may be declared against an empty hand",
  voteCardIsStealable: "whether your Vote Card can be taken by an ordinary steal",
  tieBreakIdolTierIncludesProtected:
    "whether the tie-break's idol rung includes players *protected* by an idol as well as those who *played* one",
  drawPileExhaustionPolicy: "what happens when the draw pile runs out",
  idol_nullifier_included:
    "whether the hidden 68th card, the Idol Nullifier, is shuffled into the deck",
};

// ---------------------------------------------------------------------------
// describeEvent: the one switch
// ---------------------------------------------------------------------------

/**
 * One event -> one narration, or null for events that carry no news worth a message.
 *
 * The `switch` is exhaustive over all 83 members, enforced by
 * `@typescript-eslint/switch-exhaustiveness-check` plus the `assertNever` default. An 84th event
 * is a build failure here, which is the whole reason the union is closed — audit #74: thirteen
 * of forty-seven cards had no implementation at all and nothing noticed.
 */
export function describeEvent(event: GameEvent, ctx: RenderContext): Narration | null {
  const limits = ctx.config.engine.limits;

  switch (event.type) {
    // ---------------------------------------------------------------- lifecycle
    case "game_created":
      return null; // the lobby message itself is the announcement

    case "player_joined":
      return line(
        `${dotOf(ctx, event.playerId)} ${mention(event.playerId)} joined as ${bold(humanize(event.color))} — ${quantity(event.playerCount, "player")} at the fire.`,
      );

    case "player_left":
      return line(
        event.wasInProgress
          ? `${mention(event.playerId)} walked away from the table. They keep their seat, they are not on the Jury, and turn order skips them.`
          : `${mention(event.playerId)} left the lobby — ${quantity(event.playerCount, "player")} remaining.`,
      );

    case "player_removed":
      return line(
        `${mention(event.playerId)} was removed from the game by ${mention(event.removedById)}.`,
      );

    // Who is running the game is table information, and the two ways it changes hands read very
    // differently: one is a decision, the other is the game refusing to dead-end because
    // somebody walked out. Saying which is which is the difference between "fine" and "wait,
    // why is it theirs now?".
    case "host_changed":
      return line(
        event.reason === "transferred"
          ? `🏕️ ${mention(event.previousHostId)} hands the camp over: ${mention(event.newHostId)} is now the host.`
          : `🏕️ ${mention(event.previousHostId)} was the host and is no longer at the table, so the camp passes to ${mention(event.newHostId)}.`,
      );

    case "color_chosen":
      return line(
        `${colorEmoji(event.color)} ${mention(event.playerId)} is now ${bold(humanize(event.color))}.`,
      );

    // Who is on each Survivor Character Card. One line per player, so the deal at the start
    // reads as the tribe's roll call — and it is the whole of it wherever the board image cannot
    // be drawn.
    case "castaways_named":
      return line(
        event.reason === "renamed"
          ? `🔥 ${mention(event.playerId)} renamed their castaways: ${castawayList(event.castaways)}.`
          : `🔥 ${possessive(mention(event.playerId))} castaways: ${castawayList(event.castaways)}.`,
      );

    case "player_connection_changed":
      return event.connected
        ? null
        : line(
            `${italic(`${nameOf(ctx, event.playerId)} has gone quiet. Their cards and votes are untouched.`)}`,
          );

    case "game_started": {
      const embed = new EmbedBuilder()
        .setColor(ACCENT.neutral)
        .setTitle("The tribe has gathered")
        .setDescription(
          [
            `${quantity(event.playerCount, "player")}. Play passes to the ${bold("left")}.`,
            "",
            bold("Turn order"),
            ...event.seatOrder.map(
              (id, index) => `${ordinal(index + 1)}. ${dotOf(ctx, id)} ${mention(id)}`,
            ),
            "",
            `Every turn is ${bold("Steal → Play (or don't) → Draw")}. All three, in that order.`,
            `First up: ${mention(event.firstPlayerId)}.`,
          ].join("\n"),
        )
        .setFooter({ text: `shuffle seed ${event.seed}` });
      return message(undefined, [embed]);
    }

    case "deck_built": {
      const councils = event.singleCouncilCards + event.doubleCouncilCards;
      return line(
        [
          `🂠 ${quantity(event.drawPileSize, "card")} in the draw pile, with ${quantity(councils, "Tribal Council card")} spaced through it`,
          `(${event.singleCouncilCards} single, ${event.doubleCouncilCards} double).`,
          "Tribal Council cards are oversized, so you always know when the next one is coming —",
          `use ${bold("/status")} to see how far away they are.`,
          event.idolNullifierIncluded
            ? `\n${italic("The hidden 68th card, the Idol Nullifier, is in this deck.")}`
            : "",
        ]
          .filter((part) => part !== "")
          .join(" "),
      );
    }

    case "vote_cards_dealt":
      return line(
        `🗳️ ${quantity(event.perPlayer, "Vote Card")} to each player. ${quantity(event.removedCount, "spare")} put away.`,
      );

    case "hands_dealt":
      return line(
        `🃏 ${quantity(event.handSize, "card")} dealt to each player. Check yours with ${bold("/hand")}.`,
      );

    case "game_abandoned":
      // An emptied lobby is not somebody ending the game, and narrating it as one would name
      // the last player out as the person who killed it.
      return message(
        event.emptyLobby === true
          ? `🪹 The last player left, so this lobby has been closed. ${bold("/survivor start")} opens a new one.`
          : `🛑 ${mention(event.byId)} ended this game${
              event.viaModerator === true ? " as a server moderator" : ""
            }. The save has been cleared — ${bold("/survivor start")} begins a fresh one.`,
      );

    case "game_finished":
      return event.winnerId === null
        ? message("The game is over with no winner.")
        : null; // `winner_declared` already carried the ceremony

    case "snapshot_restored":
      return line(
        [
          // `savedAtMs` is a deterministic stamp, not a clock reading: showing it as a time put
          // "saved 3 hours ago" on a game played a minute before the restart.
          `💾 Game restored from the autosave — last played <t:${Math.floor(event.lastPlayedAtMs / 1000)}:R>. Nothing was lost.`,
          // The table needs to know what the restart did to their clock. Without this the only
          // visible sign would be windows whose countdowns jumped, or — before deadlines were
          // rebased at all — a council that resolved itself in three seconds.
          event.rebasedByMs > 0
            ? italic(
                ` Every open window was given back the time it had left (the bot was away for ${humanDuration(event.rebasedByMs)}).`,
              )
            : "",
        ].join(""),
      );

    // --------------------------------------------------------------------- turn
    case "turn_started":
      return line(
        `\n${dotOf(ctx, event.playerId)} ${bold(`Turn ${event.turnNumber}`)} — ${mention(event.playerId)}. Step 1: ${bold("/steal")} from another player. ${event.deadlineMs === null ? "" : `(auto-advances ${deadline(event.deadlineMs)})`}`,
      );

    case "turn_phase_changed":
      switch (event.to) {
        case "play":
          return line(
            `Step 2: ${mention(event.playerId)} may ${bold("/play")} one card, or ${bold("/skip")}.`,
          );
        case "draw":
          return line(
            `Step 3: ${mention(event.playerId)} must ${bold("/draw")} to end the turn.`,
          );
        case "steal":
        case "ended":
          return null;
        default:
          return assertNever(event, "turn_phase_changed");
      }

    case "play_step_skipped":
      return line(`${mention(event.playerId)} plays nothing this turn.`);

    case "card_played":
      return line(
        `${dotOf(ctx, event.playerId)} ${mention(event.playerId)} plays ${bold(cardName(event.kind))}.`,
      );

    case "card_drawn":
      return message(
        `You drew ${bold(cardName(event.kind))}.`,
        ctx.config.discord.renderCardArt
          ? [cardEmbed(event.kind, ctx.config)]
          : undefined,
      );

    case "turn_ended":
      return line(
        event.nextPlayerId === null
          ? `Turn over. ${quantity(event.drawPileRemaining, "card")} left in the draw pile.`
          : `Turn over — ${quantity(event.drawPileRemaining, "card")} left in the draw pile.`,
      );

    case "draw_pile_exhausted":
      return message(
        [
          "🂠 " + bold("The draw pile is empty."),
          "The rulebook does not cover this, so the bot is applying its configured answer:",
          event.policy === "final_council"
            ? `every player but the two holding the most Survivor Character Cards is eliminated, and the Final Tribal Council begins now. ${quantity(event.playersRemaining, "player")} were still in.`
            : `the game ends here with no winner. ${quantity(event.playersRemaining, "player")} were still in.`,
        ].join(" "),
      );

    // -------------------------------------------------------------------- takes
    case "take_declared": {
      const takers = mentionList(event.takerIds);
      const what =
        event.selection === "random"
          ? `${quantity(event.count, "card")} at random`
          : event.selection === "chosen"
            ? `${quantity(event.count, "card")} of their choosing`
            : `${quantity(event.count, "specific card")}`;
      return line(
        `🫳 ${takers} ${event.takerIds.length === 1 ? "is taking" : "are taking"} ${what} from ${mention(event.victimId)}. ${bold("Sorry For You")} may be played until ${deadline(event.deadlineMs)}.`,
      );
    }

    case "take_resolved":
      return message(
        event.cardUids.length === 0
          ? `Nothing moved between ${mention(event.takerId)} and ${mention(event.victimId)}.`
          : `${mention(event.takerId)} took ${bold(event.kinds.map(cardName).join(", "))} from ${mention(event.victimId)}.`,
      );

    case "cards_transferred":
      return line(
        `${quantity(event.count, "card")} moved from ${mention(event.fromId)} (${event.fromHandSize} in hand) to ${mention(event.toId)} (${event.toHandSize} in hand).`,
      );

    case "take_blocked":
      return message(
        `🚫 ${bold("Sorry For You!")} ${mention(event.victimId)} blocks ${mentionList(event.blockedTakerIds)}. ${event.blockedTakerIds.length > 1 ? "They each get nothing, and must EACH discard a card." : "They get nothing, and must discard a card instead."}`,
      );

    case "take_found_nothing":
      return line(
        `${mention(event.takerId)} reached into ${possessive(nameOf(ctx, event.victimId))} empty hand and came away with nothing.`,
      );

    case "sorry_for_you_played":
      return null; // `take_blocked` is the moment; this would just double it

    case "forced_discard_opened":
      return line(
        `${mention(event.playerId)} must discard ${quantity(event.count, "card")}${event.reason === "sorry_for_you_penalty" ? " for the blocked steal" : ""} — ${deadline(event.deadlineMs)}.`,
      );

    case "card_discarded":
      return line(
        `🗑️ ${mention(event.playerId)} discards ${bold(cardName(event.kind))}${event.autoSelected ? italic(" (chosen for them when the window closed)") : ""}.`,
      );

    // ------------------------------------------------------------- card effects
    case "camp_raid_placed":
      return line(
        `⛺ ${mention(event.raiderId)} sets a ${bold("Camp Raid")} in front of ${mention(event.victimId)}. It takes the card they draw at the end of their next turn.`,
      );

    case "camp_raid_resolved":
      return message(
        `⛺ The Camp Raid takes ${bold(cardName(event.takenCardKind))} from ${mention(event.victimId)}.${event.wasTribalCouncilCard ? `\n${mention(event.raiderId)} took a ${bold("Tribal Council")} card — they are the Leader.` : ""}`,
      );

    case "knowledge_is_power_asked":
      return line(
        `❓ ${mention(event.askerId)} asks ${mention(event.targetId)}: *"Do you have a ${bold(cardName(event.named))}?"*`,
      );

    case "knowledge_is_power_answered":
      return line(
        event.hit
          ? `…they do. ${mention(event.targetId)} hands it over.`
          : `…they don't. The whole tribe now knows ${mention(event.targetId)} has no ${bold(cardName(event.named))}.`,
      );

    case "spy_shack_peeked":
      return message(
        [
          `🔦 ${possessive(nameOf(ctx, event.targetId))} hand:`,
          ...event.cards.map((card) => `• ${instanceName(card)}`),
          "",
          italic("Only you saw this. Now pick the one you are taking."),
        ].join("\n"),
      );

    case "alliance_formed":
      return line(
        `🤝 ${mention(event.initiatorId)} forms an alliance with ${mention(event.partnerId)}. ${mention(event.initiatorId)} steals from ${mention(event.initiatorVictimId)}; ${mention(event.partnerId)} picks their own mark.`,
      );

    case "alliance_target_chosen":
      return line(
        `🤝 ${mention(event.partnerId)} steals from ${mention(event.victimId)}.`,
      );

    // --------------------------------------------------------------- challenges
    case "challenge_started":
      return message(
        [
          `🏆 ${bold(challengeName(event.challenge))}${event.round > 1 ? ` — round ${event.round}` : ""}`,
          `${mentionList(event.participantIds)}: choose in secret. Everything reveals at once.`,
          `Submissions close ${deadline(event.deadlineMs)}.`,
        ].join("\n"),
      );

    case "challenge_submission_received":
      return line(
        `${dotOf(ctx, event.playerId)} ${nameOf(ctx, event.playerId)} has chosen. (${event.submittedCount}/${event.participantCount})`,
      );

    case "challenge_revealed": {
      // A window that closes with nobody having submitted emits `reveals: []` — `resolveChallenge`
      // collects only the slots that actually answered. The fourth beat used to `join("\n")`
      // that into the empty string and hand `sink.publish` a message with no content at all,
      // which Discord rejects with 50006 and which took the whole rest of the batch with it:
      // the table heard "3… 2… 1…" and then nothing, no outcome, no cards, no turn end.
      const beats: Beat[] = [
        { content: bold("3…") },
        { content: bold("2…") },
        { content: bold("1…") },
        {
          content:
            event.reveals.length === 0
              ? italic("Nobody submitted in time. Everyone forfeits the round.")
              : event.reveals
                  .map(
                    (reveal) =>
                      `${dotOf(ctx, reveal.playerId)} ${mention(reveal.playerId)} — ${bold(submissionText(reveal.submission))}`,
                  )
                  .join("\n"),
        },
      ];
      return { kind: "beats", beats };
    }

    case "challenge_replayed":
      return line(
        event.reason === "all_different"
          ? `Everyone showed something different. ${bold("Play again")} — round ${event.nextRound}.`
          : `No single lowest number. ${bold("Play again")} — round ${event.nextRound}.`,
      );

    case "challenge_resolved":
      return line(challengeOutcomeText(event.outcome, ctx));

    case "challenge_swap_completed":
      return message(
        `You swapped ${bold(cardName(event.aGaveCardKind))} for ${bold(cardName(event.bGaveCardKind))}.`,
      );

    // ------------------------------------------------------------------ council
    case "council_started": {
      const embed = new EmbedBuilder()
        .setColor(ACCENT.council)
        .setTitle(`🔥 Tribal Council #${event.councilNumber}`)
        .setDescription(
          [
            `${bold(councilKindLabel(event.kind))} — ${event.kind === "double" ? "two DIFFERENT players go home" : "one player goes home"}.`,
            "",
            `${mention(event.drawerId)} drew the card, so ${mention(event.leaderId)} is the ${bold("Tribal Council Leader")}.`,
            "The Leader runs the council with **/council** and is responsible for breaking ties.",
            "",
            `${quantity(event.councilsRemainingInDeck, "Tribal Council card")} still in the deck.`,
          ].join("\n"),
        );
      return message(undefined, [embed]);
    }

    case "council_phase_changed": {
      const headline: Readonly<Record<typeof event.to, string | null>> = {
        advantages:
          "**Tribal Advantages.** Control the Vote, Goodwill Gamble and I'm the Leader Now may be played now or any time before the vote — from **/council**.",
        discussion: "**Discussion.** Talk it out. Advantages are still playable.",
        voting:
          "**Voting is open.** Everyone with a Vote Card must vote — use **/vote**. Nobody sees a ballot until the box is opened.",
        idols:
          "**Immunity Idols.** Every vote is in. Idols may be played now, before the box opens — from **/council**.",
        nullifiers:
          "**Idol Nullifiers.** An idol has been played. It can still be cancelled — from **/council**.",
        tally: "**The votes will now be read.**",
        tie_break: "**It is not clear who is voted out.** The Leader must decide.",
        cleanup: null,
      };
      const text = headline[event.to];
      return text === null
        ? null
        : line(
            `${text}${event.deadlineMs === null ? "" : ` (${deadline(event.deadlineMs)})`}`,
          );
    }

    case "council_leader_changed":
      return line(
        `👑 ${bold("I'm the Leader Now.")} ${mention(event.toId)} takes the Leader role from ${mention(event.fromId)}${event.grantsNextTurn ? " — and takes the next turn when this council ends" : ""}.`,
      );

    case "advantage_played":
      return line(
        `${mention(event.playedById)} plays ${bold(cardName(event.kind))}${event.targetId === null ? "" : ` on ${mention(event.targetId)}`}.`,
      );

    case "vote_card_taken":
      return line(
        `🗳️ ${mention(event.takerId)} takes ${possessive(nameOf(ctx, event.victimId))} Vote Card${event.mustBeUsedThisCouncil ? " — and MUST cast it at this council, on top of their own" : ""}.`,
      );

    case "goodwill_gamble_given":
      return line(
        `🎁 ${mention(event.giverId)} gives their vote to ${mention(event.recipientId)}, who MUST cast it at this council.`,
      );

    case "voting_opened":
      return message(
        [
          `🗳️ ${bold("Everyone must vote.")} ${mentionList(event.requiredVoterIds)} — use ${bold("/vote")}.`,
          event.requiredCasts.length > event.requiredVoterIds.length
            ? italic(
                "Some players owe more than one cast tonight. Voting cannot close until every obligated card is in the box.",
              )
            : "",
          italic(
            "Tap the table in rhythm. Nobody should be able to hear how many votes are going in.",
          ),
        ]
          .filter((part) => part !== "")
          .join("\n"),
      );

    case "vote_cast":
      return message(
        `Your vote for ${bold(nameOf(ctx, event.targetId))} is in the box. Nobody else can see it.`,
      );

    case "voter_finished":
      return line(
        event.remainingVoterIds.length === 0
          ? `${mention(event.voterId)} is finished. Every vote is in.`
          : `${mention(event.voterId)} is finished. Still waiting on ${mentionList(event.remainingVoterIds)}.`,
      );

    case "votes_forfeited": {
      // Said out loud and named, because a forfeited vote changes who goes home. The rulebook's
      // "Everyone must vote" assumes a table where the box is physically handed to the next
      // seat; a port has to decide what happens when somebody walks away, and the table is
      // entitled to know that it happened rather than to wonder why the count is short.
      const gambles = event.casts.filter(
        (cast) => cast.source === "goodwill_gamble",
      ).length;
      return line(
        [
          `⌛ Time is up on the vote. ${mentionList(event.playerIds)} did not cast, so ${quantity(event.casts.length, "vote")} ${verbToBe(event.casts.length)} forfeited.`,
          gambles > 0
            ? ` ${quantity(gambles, "Goodwill Gamble")} ${verbToBe(gambles)} discarded unused.`
            : "",
          " The box closes with the votes that are in it.",
        ].join(""),
      );
    }

    case "voting_closed":
      return line("🗳️ The Voting Box is closed.");

    case "idol_window_opened":
      return line(
        `🗿 ${bold("Immunity Idols")} may be played until ${deadline(event.deadlineMs)} — on yourself or on anyone else. Holding one? ${bold("/council")} has the button.`,
      );

    case "idol_played":
      return line(
        `🗿 ${mention(event.playedById)} plays an ${bold("Immunity Idol")}${event.protectsId === event.playedById ? " on themselves" : ` on ${mention(event.protectsId)}`}.`,
      );

    case "nullifier_window_opened":
      return line(
        `🕳️ ${quantity(event.idolCardUids.length, "idol")} on the table. An ${bold("Idol Nullifier")} may cancel one until ${deadline(event.deadlineMs)} — from ${bold("/council")}.`,
      );

    case "idol_nullified":
      return line(
        `🕳️ ${mention(event.playedById)} plays an ${bold("Idol Nullifier")}. The idol protecting ${mention(event.idolProtectedId)} is cancelled — those votes count after all.`,
      );

    case "votes_revealed": {
      const beats: Beat[] = [
        { content: `🔥 ${bold("Once the votes are read, the decision is final.")}` },
      ];
      for (const [index, vote] of event.revealOrder.entries()) {
        beats.push({
          content: `${italic(`${ordinal(index + 1)} vote…`)}\n${dotOf(ctx, vote.targetId)} ${bold(nameOf(ctx, vote.targetId))}`,
        });
      }
      beats.push({ content: `That's ${quantity(event.totalVotes, "vote")}.` });
      return { kind: "beats", beats };
    }

    case "tally_computed": {
      const rows = [...event.rows]
        .sort((a, b) => b.countedVotes - a.countedVotes || a.rawVotes - b.rawVotes)
        .filter((row) => row.rawVotes > 0 || row.immune)
        .map((row) => {
          const base = `${dotOf(ctx, row.playerId)} ${bold(nameOf(ctx, row.playerId))} — ${quantity(row.countedVotes, "vote")}`;
          return row.immune
            ? `${base} ${italic(`(${quantity(row.rawVotes, "vote")} cast, but an Immunity Idol wiped them out)`)}`
            : base;
        });
      const embed = new EmbedBuilder()
        .setColor(ACCENT.council)
        .setTitle("The votes")
        .setDescription(
          truncate(
            rows.length > 0
              ? rows.join("\n")
              : "Every vote was cancelled by an Immunity Idol.",
            ctx.config.discord.maxEmbedDescriptionLength,
          ),
        );
      return message(undefined, [embed]);
    }

    case "tie_break_required":
      return message(
        [
          `⚖️ ${bold("It is not clear who is voted out.")}`,
          reasonText(event.reason),
          `${mention(event.leaderId)}, as Tribal Council Leader you must choose ${quantity(event.choose, "player")} from ${tieBreakTierLabel(event.tier)}:`,
          event.candidates.map((id) => `• ${dotOf(ctx, id)} ${mention(id)}`).join("\n"),
          italic(`Decide by ${deadline(event.deadlineMs)} or the bot decides for you.`),
        ].join("\n"),
      );

    case "tie_break_tier_descended":
      return line(
        `⚖️ ${italic(`No ${tieBreakTierLabel(event.from)} to choose from — the rule moves down to ${tieBreakTierLabel(event.to)}.`)}`,
      );

    case "leader_chose_eliminations":
      return line(
        `⚖️ ${mention(event.leaderId)} chooses ${mentionList(event.targetIds)}.`,
      );

    case "character_card_flipped": {
      const remaining = event.charactersRemaining;
      // Older events (and a castaway-less test fixture) carry no name; the sentence still reads.
      const who = event.castaway ? `${bold(event.castaway)} is voted out. ` : "";
      return {
        kind: "beats",
        beats: [
          {
            content: `🔥 ${mention(event.playerId)}, ${bold("the tribe has spoken.")}`,
          },
          {
            content:
              remaining > 0
                ? `${italic("A torch is snuffed.")} ${who}${torches(remaining, limits.characterCardsPerPlayer)} — ${mention(event.playerId)} ${verbHas(remaining)} ${torchCount(remaining)} left and is still in this game.`
                : `${italic("The last torch is snuffed.")} ${who}${torches(0, limits.characterCardsPerPlayer)}`,
          },
        ],
      };
    }

    case "player_eliminated":
      return message(
        [
          `🕯️ ${mention(event.playerId)} is the ${bold(`${ordinal(event.eliminationOrder)} person voted out`)} of Survivor.`,
          `They join the ${bold("Jury")}. ${quantity(event.playersRemaining, "player")} left in the game.`,
        ].join("\n"),
      );

    case "inheritance_window_opened":
      return line(
        `📜 ${possessive(nameOf(ctx, event.eliminatedPlayerId))} ${quantity(event.handSize, "card")} ${verbToBeWord(event.handSize)} on the table. Whoever holds the ${bold(`${humanize(event.color)} Inheritance`)} card may claim ${event.handSize === 1 ? "it" : "them all"} — ${deadline(event.deadlineMs)}.`,
      );

    case "inheritance_claimed":
      return line(
        `📜 ${mention(event.claimantId)} plays ${bold("Inheritance")} and takes all ${quantity(event.cardCount, "card")} from ${mention(event.eliminatedPlayerId)}.`,
      );

    case "hand_discarded_on_elimination": {
      const parts = [
        event.cards.length === 0
          ? `${mention(event.playerId)} went out empty-handed.`
          : `${possessive(nameOf(ctx, event.playerId))} hand goes face up on the Discard Pile: ${event.cards.map((card) => bold(instanceName(card))).join(", ")}.`,
      ];
      if (event.voteCardsReturned > 0) {
        parts.push(
          `${quantity(event.voteCardsReturned, "Vote Card")} back to the bank.`,
        );
      }
      if (event.grantedVotesDiscarded > 0) {
        parts.push(
          `${quantity(event.grantedVotesDiscarded, "granted vote")} discarded.`,
        );
      }
      return line(parts.join(" "));
    }

    case "vote_cards_returned":
      return line(
        `🗳️ A Vote Card returns to ${mentionList(event.playerIds)}.${event.surplusDiscarded > 0 ? ` ${quantity(event.surplusDiscarded, "spare")} discarded.` : ""}`,
      );

    case "council_ended":
      return line(
        [
          "🔥 Tribal Council is over.",
          event.eliminatedIds.length > 0
            ? `${mentionList(event.eliminatedIds)} ${event.eliminatedIds.length === 1 ? "is" : "are"} out.`
            : event.flippedIds.length > 0
              ? `${mentionList(event.flippedIds)} lost a torch but ${event.flippedIds.length === 1 ? "is" : "are"} still in.`
              : "",
          event.nextPlayerId === null
            ? ""
            : `${mention(event.nextPlayerId)} is up${event.nextTurnFromOverride ? " — I'm the Leader Now rewrote the order" : ""}.`,
        ]
          .filter((part) => part !== "")
          .join(" "),
      );

    // ------------------------------------------------------------ final council
    case "final_council_started": {
      const embed = new EmbedBuilder()
        .setColor(ACCENT.final)
        .setTitle("🔥 The Final Tribal Council")
        .setDescription(
          [
            `Two players remain: ${mention(event.finalists[0])} and ${mention(event.finalists[1])}.`,
            "",
            `${mention(event.leaderId)} was the last player voted out, so they are on the Jury ${bold("and")} the Final Tribal Council Leader.`,
            `The Jury: ${mentionList(event.juryIds)}.`,
            "",
            "The Leader asks the three questions. The finalists make their cases — they may reveal their hands, but they may play no cards. Then the Jury votes for a ",
            bold("winner"),
            ", not for someone to go home.",
          ].join(""),
        )
        .setFooter({ text: triggerFooter(event.trigger) });
      return message(undefined, [embed]);
    }

    case "final_council_phase_changed": {
      const headline: Readonly<Record<typeof event.to, string | null>> = {
        opening:
          '**Leader, ask the three questions:** *"What did you do to get here?"*, *"What was your biggest move?"*, *"Why do you deserve to win?"*',
        statements:
          "**The finalists make their cases.** You may reveal your hand as evidence. You may not play a card.",
        jury_questions: "**The Jury may ask questions or make their own case.**",
        jury_vote:
          "**The Jury votes for a winner.** Every vote is secret until the last one is in, then they all reveal at once.",
        tie_break:
          "**The Jury is split.** The Leader decides — and need not stick with their own vote.",
        complete: null,
      };
      const text = headline[event.to];
      return text === null
        ? null
        : line(
            `${text}${event.deadlineMs === null ? "" : ` (${deadline(event.deadlineMs)})`}`,
          );
    }

    case "finalist_hand_revealed":
      return message(
        `${mention(event.playerId)} reveals their hand: ${event.cards.length === 0 ? italic("nothing at all") : event.cards.map((card) => bold(instanceName(card))).join(", ")}.`,
      );

    case "juror_ready":
      return line(
        `${mention(event.jurorId)} is ready to vote. (${event.readyCount}/${event.juryCount})`,
      );

    case "jury_vote_cast":
      return message(
        `Your vote for ${bold(nameOf(ctx, event.finalistId))} is locked in.`,
      );

    case "jury_vote_registered":
      return line(
        `${mention(event.jurorId)} has voted. (${event.castCount}/${event.juryCount})`,
      );

    case "jury_votes_revealed": {
      const beats: Beat[] = [
        { content: `🔥 ${bold("The winner of Survivor is…")}` },
        { content: bold("3…") },
        { content: bold("2…") },
        { content: bold("1…") },
      ];
      for (const vote of event.votes) {
        beats.push({
          content: `${dotOf(ctx, vote.finalistId)} ${mention(vote.jurorId)} votes for ${bold(nameOf(ctx, vote.finalistId))}`,
        });
      }
      beats.push({
        content: event.tallies
          .map(
            (tally) =>
              `${bold(nameOf(ctx, tally.finalistId))}: ${quantity(tally.votes, "vote")}`,
          )
          .join(" · "),
      });
      return { kind: "beats", beats };
    }

    case "final_tie_break_required":
      return message(
        `⚖️ The Jury is split down the middle. ${mention(event.leaderId)}, you decide between ${mention(event.finalists[0])} and ${mention(event.finalists[1])} — and you do ${bold("not")} have to pick the one you voted for. ${deadline(event.deadlineMs)}.`,
      );

    case "winner_declared": {
      const votes = event.votes ?? 0;
      // Older events carry no `votesAgainst`; for them the difference is the best available.
      const against = event.votesAgainst ?? Math.max(0, (event.juryCount ?? 0) - votes);
      const abstained = Math.max(0, (event.juryCount ?? 0) - votes - against);
      const method =
        event.method === "jury_majority"
          ? `by a Jury vote of ${votes}–${against}${abstained > 0 ? ` (${quantity(abstained, "juror")} did not vote)` : ""}`
          : event.method === "leader_tie_break"
            ? "on the Final Tribal Council Leader's casting decision"
            : "as the last player standing";
      const embed = new EmbedBuilder()
        .setColor(ACCENT.win)
        .setTitle("🏆 Sole Survivor")
        .setDescription(
          `${dotOf(ctx, event.winnerId)} ${mention(event.winnerId)} wins ${method}.\n\n${italic("The tribe has spoken.")}`,
        );
      return message(undefined, [embed]);
    }

    // -------------------------------------------------- pending windows / policy
    case "pending_opened":
      switch (event.pendingKind) {
        case "card_choice":
          return line(
            `🔦 ${mentionList(event.waitingOnIds)} is picking a card — ${deadline(event.deadlineMs)}.`,
          );
        case "alliance_target":
          return line(
            `🤝 ${mentionList(event.waitingOnIds)} must name their own mark — ${deadline(event.deadlineMs)}.`,
          );
        case "steal_victim":
          return line(
            `🎯 ${mentionList(event.waitingOnIds)} is choosing who to steal from — ${deadline(event.deadlineMs)}.`,
          );
        // These all have a richer dedicated event; narrating both would double every window.
        case "take":
        case "discard":
        case "challenge":
        case "leader_decision":
        case "inheritance":
          return null;
        default:
          return assertNever(event.pendingKind, "pending_opened");
      }

    case "pending_expired":
      return line(`⏳ ${italic(expiryText(event.defaultApplied))}`);

    case "pending_cancelled":
      return event.reason === "declined" || event.reason === "blocked"
        ? null // the decline and the block each have their own, better, event
        : line(`⏳ ${italic(`That window closed: ${humanize(event.reason)}.`)}`);

    case "house_rule_applied":
      return line(
        `📖 ${italic(`House rule: ${HOUSE_RULE_BLURB[event.rule]} — this game says ${bold(String(event.setting))}.`)}${event.affectedPlayerIds.length > 0 ? ` (${mentionList(event.affectedPlayerIds)})` : ""}`,
      );

    default:
      return assertNever(event, "describeEvent");
  }
}

// ---------------------------------------------------------------------------
// Small narration helpers
// ---------------------------------------------------------------------------

const verbToBeWord = (count: number): string => (count === 1 ? "is" : "are");

function reasonText(reason: string): string {
  switch (reason) {
    case "tie_for_most":
      return "Two or more players are tied for the most votes.";
    case "double_tie_for_most":
      return "Three or more players are tied for the most votes, and two must go.";
    case "double_tie_for_second":
      return "One player is clear, and the second place is tied.";
    case "unclear_cascade":
      return "There were not enough eligible players at the usual rung, so the rule has moved down.";
    case "three_player_double_override":
      return "Only three players are left and a Double Elimination would leave one. The rulebook says eliminate ONE, then go straight to the Final Tribal Council.";
    default:
      return "";
  }
}

function expiryText(applied: string): string {
  switch (applied) {
    case "take_resolved":
      return "Nobody played Sorry For You. The cards moved.";
    case "discard_auto_selected":
      return "The discard window closed, so a card was picked at random.";
    case "challenge_forfeited":
      return "Someone never submitted. They forfeit the round.";
    case "card_choice_auto_selected":
      return "No card was picked, so the bot picked one.";
    case "alliance_target_forfeited":
      return "No mark was named, so the alliance partner steals from nobody.";
    case "steal_victim_forfeited":
      return "No victim was named, so the steal is forfeited.";
    case "leader_choice_auto_selected":
      return "The Leader ran out of time, so the bot chose from the eligible players.";
    case "inheritance_forfeited":
      return "Nobody claimed the hand. It goes face up on the Discard Pile.";
    default:
      return "That window closed.";
  }
}

function triggerFooter(trigger: string): string {
  switch (trigger) {
    case "three_player_override":
      return "Three players, a Double Elimination: the rulebook eliminates one and comes straight here.";
    case "draw_pile_empty":
      return "The draw pile ran out — see the house rule above.";
    case "player_left_game":
      return "A player left the table, which took the game to two.";
    default:
      return "Two players left. Regardless of how many Survivor Character Cards they hold.";
  }
}

function challengeOutcomeText(outcome: ChallengeOutcome, ctx: RenderContext): string {
  switch (outcome.kind) {
    case "rps_decisive":
      return `🏆 ${mention(outcome.winnerId)} wins, and steals 2 random cards from ${mention(outcome.loserId)}.`;
    case "rps_tie":
      return `🤝 A tie. ${mentionList([...outcome.playerIds])} each swap 1 card of their own choosing.`;
    case "power_pair_matched":
      return `🏆 ${mentionList([...outcome.matchedIds])} matched. They each steal 1 random card from ${mention(outcome.oddOneOutId)}.`;
    case "power_pair_all_same":
      return `😬 All three matched. ${mentionList([...outcome.playerIds])} each discard 1 card and nobody steals a thing.`;
    case "numbers_game_winner":
      return `🏆 ${mention(outcome.winnerId)} showed ${bold(String(outcome.number))} — the lowest unique number. ${nameOf(ctx, outcome.winnerId)} steals 2 random cards from a player of their choice.`;
    default:
      return assertNever(outcome, "challengeOutcomeText");
  }
}

// ---------------------------------------------------------------------------
// Reusable embeds. Commands build on these so every surface looks the same.
// ---------------------------------------------------------------------------

/**
 * The Survival Guide entry for one card: verbatim printed rules text, the clarifications tagged
 * with which document they came from, timing, quantity, and the art.
 *
 * Audit #90: card art was pasted as a bare URL — which silently vanishes without Embed Links —
 * and audit #92: rules text was paraphrased from memory in three different places. The catalog
 * is the source, and this is the only renderer of it.
 */
export function cardEmbed(
  kind: Parameters<typeof cardName>[0],
  config: SurvivorConfig,
  options: { readonly compact?: boolean } = {},
): EmbedBuilder {
  const definition: CardDefinition = CARD_CATALOG[kind];
  const embed = new EmbedBuilder()
    .setColor(ACCENT.info)
    .setTitle(definition.name)
    .setDescription(
      truncate(
        options.compact === true ? definition.compactText : definition.rulesText,
        config.discord.maxEmbedDescriptionLength,
      ),
    );

  if (options.compact !== true) {
    embed.addFields(
      {
        name: "When you can play it",
        value: timingText(definition.timing),
        inline: true,
      },
      {
        name: "In the box",
        value: quantity(definition.quantityInBox, "copy", "copies"),
        inline: true,
      },
    );
    const clarifications = definition.clarifications
      .filter((entry) => entry.source !== "unofficial")
      .map((entry) => `• ${entry.text}`)
      .join("\n");
    if (clarifications !== "") {
      embed.addFields({
        name: "From the rulebook",
        value: truncate(clarifications, config.discord.maxEmbedFieldValueLength),
      });
    }
    const notes = definition.clarifications
      .filter((entry) => entry.source === "unofficial")
      .map((entry) => `• ${entry.text}`)
      .join("\n");
    if (notes !== "") {
      embed.addFields({
        name: "Not printed anywhere — this bot's reading",
        value: truncate(notes, config.discord.maxEmbedFieldValueLength),
      });
    }
  }

  if (config.discord.renderCardArt && definition.imageUrl !== null) {
    if (options.compact === true) embed.setThumbnail(definition.imageUrl);
    else embed.setImage(definition.imageUrl);
  }
  return embed;
}

/**
 * When a card may be played, in players' words.
 *
 * EXPORTED because `/hand` prints the same sentence next to every card you hold, and while this
 * was module-private that command carried its own `Readonly<Record<CardTiming, string>>` — eight
 * lines of copy that could drift from the Survival Guide entry for the same card without
 * anything noticing. One card, one answer, wherever it is asked.
 */
export function timingText(timing: CardDefinition["timing"]): string {
  switch (timing) {
    case "never":
      return "Never played from your hand";
    case "turn_play_step":
      return "Step 2 of your own turn (uses your one play)";
    case "council_before_voting":
      return "At a Tribal Council, before voting opens";
    case "council_voting":
      return "During the voting phase";
    case "council_idol_window":
      return "After every vote is in, before the box opens";
    case "council_nullifier_window":
      return "After an Immunity Idol is played";
    case "reaction_to_take":
      return "Any time someone takes cards from you (not your turn play)";
    case "reaction_to_elimination":
      return "The instant a player's second character card is turned over";
    default:
      return assertNever(timing, "timingText");
  }
}

/**
 * The public board.
 *
 * EVERYTHING here is public by rule: hand SIZES ("You CAN'T hide how many cards you have"),
 * torches (character cards stay face up), turn order, and how far the next Tribal Council is
 * (the cards are oversized precisely so everyone can see it coming). Audit #126 sent exactly
 * this information ephemerally.
 */
export function statusEmbed(view: GameView, config: SurvivorConfig): EmbedBuilder {
  const perPlayer = config.engine.limits.characterCardsPerPlayer;
  const embed = new EmbedBuilder().setColor(ACCENT.neutral).setTitle("The tribe");

  const rows = [...view.players]
    .sort((a, b) => a.seat - b.seat)
    .map((player) => {
      const marks = [
        player.isCurrentPlayer ? "▶️" : "",
        player.isCouncilLeader ? "👑" : "",
        player.isHost ? "🏕️" : "",
        player.campRaidBy !== null ? "⛺" : "",
        player.connected ? "" : "💤",
      ]
        .filter((mark) => mark !== "")
        .join("");
      const state = player.departed
        ? "*left the table*"
        : player.eliminated
          ? "*on the Jury*"
          : `${torches(player.charactersRemaining, perPlayer)} · ${quantity(player.handSize, "card")}${player.voteCardCount !== 1 ? ` · ${quantity(player.voteCardCount, "vote card")}` : ""}${player.grantedVoteCount > 0 ? ` · +${player.grantedVoteCount} granted` : ""}`;
      // Who they are playing as: the castaways, struck through as they are voted out.
      const castaways =
        player.castaways.length > 0 ? `\n\u2003${castawaysLine(player)}` : "";
      return `${colorEmoji(player.color)} ${bold(player.displayName)} ${marks}\n\u2003${state}${castaways}`;
    });

  // discord.js REJECTS an empty description outright ("Received one or more errors"), and
  // `rows` is empty for a game with nobody in it — a lobby before the first Join. `/status`
  // routes those to `lobbyEmbed`, but the router's generic Refresh button calls this
  // unconditionally, so an empty board used to throw into the handler's catch and reach the
  // player as "Something went wrong". A board with no tribe on it is a sentence, not an error.
  embed.setDescription(
    rows.length === 0
      ? "Nobody has joined yet."
      : truncate(rows.join("\n"), config.discord.maxEmbedDescriptionLength),
  );

  const nextCouncil = view.drawsUntilCouncils[0];
  embed.addFields(
    {
      name: "Draw pile",
      value: `${quantity(view.drawPileSize, "card")}\n${
        nextCouncil === undefined
          ? "No Tribal Council cards left"
          : `Next Tribal Council in ${quantity(nextCouncil, "draw")}`
      }`,
      inline: true,
    },
    {
      name: "Councils remaining",
      value: String(view.drawsUntilCouncils.length),
      inline: true,
    },
  );

  if (view.turn) {
    embed.addFields({
      name: "Turn",
      value: `${mention(view.turn.playerId)} — step ${turnStepNumber(view.turn.phase)} of 3 (${humanize(view.turn.phase)})`,
    });
  }
  if (view.council) {
    embed.addFields({
      name: `Tribal Council (${councilKindLabel(view.council.kind)})`,
      value: [
        `Phase: ${bold(humanize(view.council.phase))}`,
        `Leader: ${mention(view.council.leaderId)}`,
        `${quantity(view.council.voteCount, "card")} in the box`,
        view.council.remainingVoterIds.length > 0
          ? `Waiting on ${mentionList(view.council.remainingVoterIds)}`
          : "",
      ]
        .filter((part) => part !== "")
        .join("\n"),
    });
  }
  if (view.finalCouncil) {
    embed.addFields({
      name: "Final Tribal Council",
      value: [
        `Phase: ${bold(humanize(view.finalCouncil.phase))}`,
        `Finalists: ${mentionList([...view.finalCouncil.finalists])}`,
        `Jury: ${mentionList(view.finalCouncil.jury)} (${view.finalCouncil.castCount}/${view.finalCouncil.jury.length} voted)`,
      ].join("\n"),
    });
  }
  if (view.openPending.length > 0) {
    embed.addFields({ name: "Waiting on", value: waitingOnField(view, config) });
  }
  return embed;
}

/**
 * What each open window is waiting for, in players' words.
 *
 * `Record<PendingKind, string>` so a ninth window cannot be added without deciding what the
 * table is told it is waiting on. Every one of these is public: WHO is being waited on and
 * until WHEN are table facts. What they were ASKED, and what they answer, stay in their own
 * private view.
 */
const PENDING_LABEL: Readonly<Record<PendingKind, string>> = {
  take: "Cards are being taken — the Sorry For You! window is open",
  discard: "Choosing which cards to discard",
  challenge: "A Reward Challenge — every answer stays secret until all of them are in",
  card_choice: "Choosing a card",
  alliance_target: "Choosing who the alliance steals from",
  steal_victim: "Choosing who to steal from",
  leader_decision: "The Tribal Council Leader is deciding",
  inheritance: "The Inheritance is up for claim",
};

/**
 * Who the game is waiting on, and until when.
 *
 * Rendered as a Discord relative timestamp rather than a duration baked into the text, so the
 * copy cannot disagree with the deadline it came from (audit #64: the old council announced
 * "8 minutes (30 seconds for testing)" while blocking for eight).
 *
 * This lives on the board rather than in `/status` alone because every surface that shows the
 * board — the command, the render pipeline, the router's Refresh button — has to answer "what
 * is everyone waiting for?", and a board that answers it in only one of those places is how a
 * table ends up staring at a game they think has hung.
 */
function waitingOnField(view: GameView, config: SurvivorConfig): string {
  return truncate(
    view.openPending
      .map(
        (pending) =>
          // \u2003 is an EM SPACE: Discord collapses ordinary leading whitespace.
          `• ${PENDING_LABEL[pending.kind]}\n\u2003${mentionList(pending.waitingOnIds)} — closes ${deadline(pending.deadlineMs)}`,
      )
      .join("\n"),
    config.discord.maxEmbedFieldValueLength,
  );
}

const turnStepNumber = (phase: string): number =>
  phase === "steal" ? 1 : phase === "play" ? 2 : 3;

/**
 * A player's own hand. EPHEMERAL, always — this is the one thing in the game that is never
 * public. Extra Votes appear here as ordinary hand cards because that is exactly what they are.
 */
export function handEmbeds(
  privateView: PrivateView,
  view: GameView,
  config: SurvivorConfig,
): readonly EmbedBuilder[] {
  const me = view.players.find((player) => player.id === privateView.viewer);
  const header = new EmbedBuilder()
    .setColor(me ? colorHex(me.color) : ACCENT.neutral)
    .setTitle(`Your hand — ${quantity(privateView.hand.length, "card")}`)
    .setDescription(
      privateView.hand.length === 0
        ? italic("Empty. Nothing to play and nothing to steal.")
        : handListText(privateView.hand, config.discord.maxEmbedDescriptionLength),
    );

  const extras: string[] = [];
  if (me) {
    extras.push(
      `${torches(me.charactersRemaining, config.engine.limits.characterCardsPerPlayer)} ${torchCount(me.charactersRemaining)}`,
    );
  }
  extras.push(
    privateView.voteCards.length === 0
      ? "No Vote Card"
      : `${quantity(privateView.voteCards.length, "Vote Card")}`,
  );
  if (privateView.grantedVotes.length > 0) {
    extras.push(
      `${quantity(privateView.grantedVotes.length, "granted vote")} — you MUST cast ${privateView.grantedVotes.length === 1 ? "it" : "them"} at this council`,
    );
  }
  header.addFields({ name: "Also yours", value: extras.join("\n") });

  if (privateView.myVotes.length > 0) {
    header.addFields({
      name: "Votes you have cast",
      value: privateView.myVotes
        .map(
          (vote) =>
            `• ${bold(view.players.find((p) => p.id === vote.targetId)?.displayName ?? "?")}`,
        )
        .join("\n"),
    });
  }

  const embeds = [header];
  // How much memory of other people's hands `/hand` keeps in front of a player is a display
  // POLICY, so it is named in config rather than left as a bare `.slice(-2)` here, where
  // nothing recorded that 2 was a decision and not an accident.
  let budget = config.discord.maxEmbedTotalLength - embedTextLength(header);
  for (const reveal of privateView.revealedToMe.slice(
    -Math.max(0, config.discord.handRevealHistoryShown),
  )) {
    const title = `You have seen ${possessive(view.players.find((p) => p.id === reveal.ownerId)?.displayName ?? "a player")} hand`;
    const room = Math.min(
      config.discord.maxEmbedDescriptionLength,
      budget - title.length,
    );
    if (room <= 0) break;
    embeds.push(
      new EmbedBuilder()
        .setColor(ACCENT.info)
        .setTitle(title)
        .setDescription(
          truncate(
            reveal.cards.map((card) => `• ${instanceName(card)}`).join("\n") ||
              italic("It was empty."),
            room,
          ),
        ),
    );
    budget -= embedTextLength(embeds[embeds.length - 1] as EmbedBuilder);
  }
  return embeds.slice(0, config.discord.maxEmbedsPerMessage);
}

/** Everything Discord counts towards a message's embed budget, for one embed. */
function embedTextLength(embed: EmbedBuilder): number {
  const data = embed.data;
  let total = (data.title?.length ?? 0) + (data.description?.length ?? 0);
  total += data.footer?.text.length ?? 0;
  total += data.author?.name.length ?? 0;
  for (const field of data.fields ?? [])
    total += field.name.length + field.value.length;
  return total;
}

/**
 * The hand summary, BOUNDED.
 *
 * Every other description in this file goes through `truncate(…, maxEmbedDescriptionLength)`;
 * this one did not. Each entry is 74-126 characters, `limits.maxHandSize` is `null` so nothing
 * in the engine bounds a hand, and at 44 cards the description crossed Discord's 4096 and threw
 * out of `setDescription` — so `/hand` answered "Something went wrong" and the player could not
 * see a single one of their cards. That is audit #86 exactly: an unbounded string rejected
 * wholesale, and the player sees nothing.
 *
 * What does not fit is COUNTED rather than silently dropped, and every card kind's full printed
 * rules text is still on the `/hand` detail pages below this embed.
 */
function handListText(hand: readonly CardInstance[], max: number): string {
  const entries = hand.map((card) => {
    const definition = CARD_CATALOG[card.kind];
    return `${bold(instanceName(card))}\n\u2003${definition.compactText}`;
  });
  const whole = entries.join("\n");
  if (whole.length <= max) return whole;

  const tailFor = (remaining: number): string =>
    italic(
      `…and ${quantity(remaining, "more card")} — every card you hold has its full rules text on the pages below.`,
    );
  // Reserved against the LONGEST possible tail, so the real one always fits.
  const reserve = tailFor(entries.length).length + 1;

  const kept: string[] = [];
  let used = 0;
  for (const entry of entries) {
    const cost = kept.length === 0 ? entry.length : entry.length + 1;
    if (used + cost + reserve > max) break;
    kept.push(entry);
    used += cost;
  }
  const remaining = entries.length - kept.length;
  if (remaining === 0) return truncate(kept.join("\n"), max);
  const joined = kept.length === 0 ? "" : `${kept.join("\n")}\n`;
  return truncate(`${joined}${tailFor(remaining)}`, max);
}

/** A lobby player's picks, a blank shown as the random legend it will become. */
const lobbyCastaways = (player: PublicPlayerView): string =>
  player.castaways
    .map((castaway) =>
      castaway.name === null
        ? `🎲 ${italic("random legend")}`
        : `🔥 ${bold(castaway.name)}`,
    )
    .join(" · ");

/** The lobby card: who is in, what colour they took, and who may press Begin. */
export function lobbyEmbed(view: GameView, config: SurvivorConfig): EmbedBuilder {
  const limits = config.engine.limits;
  const taken = new Set(view.players.map((player) => player.color));
  // `PLAYER_COLORS` is the catalog's authoritative six-entry table and `validateCatalog`
  // asserts it holds exactly six. This used to be a literal array of the six colour NAMES
  // laundered through a cast — which silenced the type system on the one array it could have
  // checked for free, and had already drifted: `humanize("red")` printed "Red" while the
  // catalog's own player-facing label for that colour is "Dark Red", so the lobby and every
  // other surface in the bot called the same colour two different things.
  const free = PLAYER_COLORS.filter((color) => !taken.has(color.color));

  return new EmbedBuilder()
    .setColor(ACCENT.neutral)
    .setTitle("Survivor: The Tribe Has Spoken")
    .setDescription(
      [
        view.players.length === 0
          ? italic("Nobody has joined yet.")
          : view.players
              .map(
                (player) =>
                  `${colorEmoji(player.color)} ${mention(player.id)}${player.isHost ? " 🏕️" : ""}\n\u2003${lobbyCastaways(player)}`,
              )
              .join("\n"),
        "",
        view.players.length < limits.minPlayers
          ? `Needs at least ${quantity(limits.minPlayers, "player")} — ${quantity(limits.minPlayers - view.players.length, "more")} to go.`
          : `Ready when the host is. Up to ${limits.maxPlayers} can play.`,
        `Your two ${bold("castaways")} are your lives — the first is voted out first. Press ${bold("Castaways")} to pick yours, or leave them to chance and be dealt legends.`,
        free.length > 0
          ? italic(
              `Free colours: ${free.map((color) => `${color.emoji} ${color.label}`).join(", ")}`,
            )
          : "",
      ]
        .filter((part) => part !== "")
        .join("\n"),
    )
    .setFooter({ text: "New to this? /help walks through the whole game." });
}
