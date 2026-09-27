/**
 * THE acknowledgement discipline, and THE contract every command is written against.
 *
 * Four separate audit findings all reduce to "reply/defer/followUp was decided at 26 different
 * call sites":
 *
 *   #45  a command called `followUp()` first                   -> InteractionNotReplied
 *   #46  a command called `reply()` twice                      -> InteractionAlreadyReplied
 *   #42  a command acknowledged nothing at all                 -> "The application did not respond"
 *   #89  a command deferred and then replied                   -> InteractionAlreadyReplied
 *
 * The fix is structural, not a checklist: a handler never touches `interaction.reply`,
 * `interaction.deferReply`, `interaction.editReply` or `interaction.followUp`. It is handed a
 * `Responder`, which knows which of the three states the interaction is in, serialises every
 * call through one promise chain so two of them cannot race, and picks the right API itself.
 * The state can only be advanced from inside that chain, so "exactly one acknowledgement" is a
 * property of the class rather than a rule people remember.
 *
 * ============================ THE VISIBILITY RULE ============================
 *
 * An interaction response is ALWAYS EPHEMERAL. Anything the table is meant to see goes to
 * `channel.send` — `Responder.announce()` here, or the render pipeline in `registry.ts`.
 *
 * That is not a style preference, it is audit #44 and #126 at once. An interaction token dies
 * after fifteen minutes (`discord.interactionTokenLifetime`), so a public message that a
 * council will still be editing twenty minutes later CANNOT live on one; and a public-by-rule
 * fact posted as an interaction reply is visible only to the person who typed the command,
 * which is precisely how hand sizes and turn order ended up hidden while private information
 * leaked. `send()` whispers, `announce()` speaks, and neither can be mistaken for the other.
 *
 * ============================ WHAT COMMAND AUTHORS USE ============================
 *
 * The `Command` interface below is the module shape every file in `src/commands/**` exports as
 * its default. `CommandContext` is the only thing a command's `execute` is given, and it
 * already carries the session, the actor, the config, a logger and a dispatch path that saves,
 * renders and re-arms the timer. See the long comment on `Command` for a copyable skeleton.
 */

import {
  MessageFlags,
  PermissionFlagsBits,
  type AnySelectMenuInteraction,
  type AttachmentBuilder,
  type AutocompleteInteraction,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type ClientEvents,
  type EmbedBuilder,
  type GuildTextBasedChannel,
  type Interaction,
  type InteractionEditReplyOptions,
  type InteractionReplyOptions,
  type InteractionUpdateOptions,
  type Message,
  type MessageComponentInteraction,
  type MessageEditOptions,
  type ModalBuilder,
  type ModalMessageModalSubmitInteraction,
  type ModalSubmitInteraction,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
  type RepliableInteraction,
} from "discord.js";

import type { DiscordConfig, SurvivorConfig } from "../config.js";
import { CARD_CATALOG } from "../engine/cards.js";
import type {
  Action,
  ActionKind,
  CardKind,
  CardUid,
  CouncilPhase,
  DispatchOutcome,
  FinalCouncilPhase,
  GameError,
  GameErrorCode,
  PendingId,
  PendingKind,
  PlayerColor,
  PlayerId,
  Result,
} from "../engine/types.js";
import {
  ALL_CARD_KINDS,
  ALL_PLAYER_COLORS,
  COUNCIL_PHASE_ORDER,
  FINAL_COUNCIL_PHASE_ORDER,
  asCardUid,
  asPendingId,
  asPlayerId,
  err,
  ok,
} from "../engine/types.js";
import { describeCause, type Logger } from "../logger.js";
import type { SaveStore } from "../persistence/store.js";
import { looksLikePendingId } from "../engine/pending.js";
import type {
  GameSession,
  PrivateCourier,
  SessionRegistry,
  WindowPrompter,
} from "./registry.js";
import type { OutgoingMessage } from "./render.js";
import {
  UI_INTENT,
  disableAll,
  packPlayerArg,
  type ParsedCustomId,
  type Row,
} from "./ui.js";

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

/**
 * What a handler hands to the `Responder`. A superset of `render.ts`'s `OutgoingMessage` — the
 * renderer never attaches components, because a component needs a nonce taken from the state
 * the message is being rendered against. The one exception is a window prompt, which the session
 * builds from the live game at the moment it is sent (`WindowPrompter` in `registry.ts`).
 */
export interface Payload {
  readonly content?: string;
  readonly embeds?: readonly EmbedBuilder[];
  readonly components?: readonly Row[];
  /**
   * Attachments — the tribe board picture. Carried by `announce()` only: a board is public by
   * rule, so it has no business on an ephemeral reply.
   */
  readonly files?: readonly AttachmentBuilder[];
}

/**
 * The component interactions Discord actually delivers.
 *
 * `MessageComponentInteraction` is the abstract base class and is NOT a member of the
 * `Interaction` union, so naming it in a signature quietly makes that signature uncallable with
 * a real interaction. These two aliases are the concrete unions to use instead.
 */
export type ComponentInteraction = ButtonInteraction | AnySelectMenuInteraction;

/** Modals decode through exactly the same custom_id protocol, so they route the same way. */
export type ComponentOrModalInteraction = ComponentInteraction | ModalSubmitInteraction;

/** Acknowledgement state. The only three states Discord recognises. */
export type AckState = "fresh" | "deferred" | "replied";

/**
 * `readonly` arrays are not assignable to discord.js's mutable option arrays, and each of the
 * four APIs takes a slightly different options type. Converting in one place is what keeps the
 * `Responder` methods below readable enough to audit.
 */
function toReplyOptions(payload: Payload, ephemeral: boolean): InteractionReplyOptions {
  const options: InteractionReplyOptions = {
    content: payload.content,
    embeds: payload.embeds ? [...payload.embeds] : undefined,
    components: payload.components ? [...payload.components] : undefined,
  };
  return ephemeral ? { ...options, flags: MessageFlags.Ephemeral } : options;
}

/**
 * Editing clears what it omits: `null`/`[]` rather than `undefined`, so a re-render genuinely
 * removes the components of a closed window instead of leaving them behind (audit #88).
 */
function toEditReplyOptions(payload: Payload): InteractionEditReplyOptions {
  return {
    content: payload.content ?? null,
    embeds: payload.embeds ? [...payload.embeds] : [],
    components: payload.components ? [...payload.components] : [],
  };
}

function toUpdateOptions(payload: Payload): InteractionUpdateOptions {
  return {
    content: payload.content ?? null,
    embeds: payload.embeds ? [...payload.embeds] : [],
    components: payload.components ? [...payload.components] : [],
  };
}

function toMessageEditOptions(payload: Payload): MessageEditOptions {
  return {
    content: payload.content ?? null,
    embeds: payload.embeds ? [...payload.embeds] : [],
    components: payload.components ? [...payload.components] : [],
  };
}

/**
 * An interaction raised from a message this bot may edit: a component on it, or a modal that was
 * opened from one of its components. Both answer `update()` / `deferUpdate()` by editing THAT
 * message, which is what lets a form opened from the lobby card re-render the card itself.
 */
type FromMessage = MessageComponentInteraction | ModalMessageModalSubmitInteraction;

function fromMessage(interaction: RepliableInteraction): FromMessage | null {
  if (interaction.isMessageComponent()) return interaction;
  if (interaction.isModalSubmit() && interaction.isFromMessage()) return interaction;
  return null;
}

// ---------------------------------------------------------------------------
// The Responder
// ---------------------------------------------------------------------------

/**
 * One interaction, one acknowledgement.
 *
 * Every method is queued on `#chain`, so a handler that fires `send()` while the auto-defer
 * timer is mid-flight gets the two serialised rather than an `InteractionAlreadyReplied`. Every
 * method also swallows and logs its own transport failures: a dead webhook or an expired token
 * is a delivery problem, and the game state is already committed by the time we are talking.
 * Audit #22/#46 — one bad interaction took down the whole process.
 */
export class Responder {
  readonly #interaction: RepliableInteraction;
  readonly #discord: DiscordConfig;
  readonly #log: Logger;

  #state: AckState = "fresh";
  /** How we acknowledged, which decides what `editReply` would edit. */
  #deferKind: "reply" | "update" | null = null;
  /** Everything that TOUCHES THE INTERACTION. The acknowledgement deadline lives on this one. */
  #chain: Promise<void> = Promise.resolve();
  /**
   * Channel sends, serialised among themselves and NOWHERE NEAR the interaction chain.
   *
   * `announce()` never touches the interaction — it is a `channel.send` — but it used to be
   * queued on `#chain` all the same, so the auto-defer timer at 2s had to wait behind it. A
   * `channel.send` delayed past ~3s by discord.js's per-channel bucket (5 messages / 5s, which
   * is exactly what a busy Tribal Council produces) therefore pushed `deferReply` past Discord's
   * three-second deadline and the player saw "The application did not respond" — audit #16/#42
   * reappearing through the mechanism written to prevent it. Two lanes, and an announce can
   * never delay an acknowledgement again.
   */
  #announceChain: Promise<void> = Promise.resolve();
  #autoDeferTimer: NodeJS.Timeout | null = null;

  constructor(interaction: RepliableInteraction, config: SurvivorConfig, log: Logger) {
    this.#interaction = interaction;
    this.#discord = config.discord;
    this.#log = log;
  }

  get state(): AckState {
    return this.#state;
  }

  get acknowledged(): boolean {
    return this.#state !== "fresh";
  }

  get interaction(): RepliableInteraction {
    return this.#interaction;
  }

  // -------------------------------------------------------------------------
  // Auto-defer
  // -------------------------------------------------------------------------

  /**
   * Start the clock that acknowledges on the handler's behalf.
   *
   * Discord closes an unacknowledged interaction after `initialResponseDeadline` (3s) and shows
   * the player "The application did not respond" — audit #16/#42. The router arms this for
   * EVERY interaction at `discord.autoDeferAfter` (2s), so a slow handler cannot produce that
   * message no matter what it forgets to do. A handler that answers in time disarms it simply
   * by acknowledging.
   *
   * A component defers as an UPDATE, which leaves both `send()` (a fresh ephemeral follow-up)
   * and `update()` (editing the message the button is on) available afterwards. A command
   * defers as an ephemeral REPLY, per the visibility rule.
   */
  armAutoDefer(): void {
    if (this.#autoDeferTimer !== null || this.acknowledged) return;
    const timer = setTimeout(() => {
      this.#autoDeferTimer = null;
      const asUpdate = fromMessage(this.#interaction) !== null;
      void (asUpdate ? this.deferUpdate() : this.defer());
    }, this.#discord.autoDeferAfter);
    // A pending acknowledgement must never be the reason the process is still alive.
    timer.unref();
    this.#autoDeferTimer = timer;
  }

  cancelAutoDefer(): void {
    if (this.#autoDeferTimer !== null) {
      clearTimeout(this.#autoDeferTimer);
      this.#autoDeferTimer = null;
    }
  }

  // -------------------------------------------------------------------------
  // Acknowledging
  // -------------------------------------------------------------------------

  /** Acknowledge with a "thinking…" ephemeral reply. Idempotent. */
  async defer(): Promise<void> {
    await this.#enqueue(async () => {
      if (this.#state !== "fresh") return;
      this.cancelAutoDefer();
      await this.#interaction.deferReply({ flags: MessageFlags.Ephemeral });
      this.#state = "deferred";
      this.#deferKind = "reply";
    }, "defer");
  }

  /**
   * Acknowledge a component press without saying anything, leaving the source message editable.
   * Idempotent, and a no-op on anything that is not a message component.
   */
  async deferUpdate(): Promise<void> {
    await this.#enqueue(async () => {
      if (this.#state !== "fresh") return;
      const source = fromMessage(this.#interaction);
      if (source === null) return;
      this.cancelAutoDefer();
      await source.deferUpdate();
      this.#state = "deferred";
      this.#deferKind = "update";
    }, "deferUpdate");
  }

  /**
   * Answer with a form. Only ever the FIRST answer: Discord refuses a modal on an interaction that
   * has already been acknowledged, and a modal submission cannot open another. Returns false when
   * the modal could not be shown, so the caller can say so instead of leaving the press hanging.
   */
  async showModal(modal: ModalBuilder): Promise<boolean> {
    const shown = await this.#enqueue(async () => {
      if (this.#state !== "fresh") return false;
      const interaction = this.#interaction;
      if (!interaction.isChatInputCommand() && !interaction.isMessageComponent())
        return false;
      this.cancelAutoDefer();
      await interaction.showModal(modal);
      this.#state = "replied";
      return true;
    }, "showModal");
    return shown ?? false;
  }

  // -------------------------------------------------------------------------
  // Talking to one player
  // -------------------------------------------------------------------------

  /**
   * Say something to the person who ran the command. ALWAYS ephemeral — see the visibility rule
   * at the top of this file. Safe to call any number of times; the second call is a follow-up.
   */
  async send(payload: Payload): Promise<void> {
    await this.#enqueue(async () => {
      this.cancelAutoDefer();
      if (this.#state === "fresh") {
        await this.#interaction.reply(toReplyOptions(payload, true));
        this.#state = "replied";
        this.#deferKind = "reply";
        return;
      }
      if (this.#state === "deferred" && this.#deferKind === "reply") {
        // The deferred reply is a real (empty, ephemeral) message: fill it in.
        await this.#interaction.editReply(toEditReplyOptions(payload));
        this.#state = "replied";
        return;
      }
      // Deferred as an update, or already replied: a new ephemeral message.
      await this.#interaction.followUp(toReplyOptions(payload, true));
      this.#state = "replied";
    }, "send");
  }

  /**
   * Refuse an action in the player's own words.
   *
   * Audit #23/#118: every failure in the old bot produced "There was an error while executing
   * this command!", which told a player nothing about a rule they had just broken. Every refusal
   * here names what happened and what to do instead — see `describeGameError`.
   */
  fail(reason: GameError | string): Promise<void> {
    const text = typeof reason === "string" ? reason : describeGameError(reason);
    return this.send({ content: text });
  }

  // -------------------------------------------------------------------------
  // Talking to the table
  // -------------------------------------------------------------------------

  /**
   * Post to the channel. The ONLY way a handler makes something public.
   *
   * A fresh `channel.send` rather than a public interaction reply, so the message outlives the
   * fifteen-minute interaction token and can still be edited during a council (audit #44).
   * Returns the `Message` so a caller that must edit it later (the lobby card) can keep its id.
   */
  announce(payload: Payload): Promise<Message | null> {
    return this.#queue(
      "channel",
      async () => {
        const channel = this.#interaction.channel;
        if (!channel?.isSendable()) {
          this.#log.warn("cannot announce: channel is not sendable", {
            channel: channel?.id,
          });
          return null;
        }
        return await channel.send({
          content: payload.content,
          embeds: payload.embeds ? [...payload.embeds] : undefined,
          components: payload.components ? [...payload.components] : undefined,
          files: payload.files ? [...payload.files] : undefined,
        });
      },
      "announce",
    );
  }

  // -------------------------------------------------------------------------
  // The message a component lives on
  // -------------------------------------------------------------------------

  /**
   * Re-render the message this component is attached to — or, for a modal opened from a
   * component, the message that component was on. No-op off a message.
   */
  async update(payload: Payload): Promise<void> {
    await this.#enqueue(async () => {
      const interaction = fromMessage(this.#interaction);
      if (interaction === null) return;
      this.cancelAutoDefer();

      if (this.#state === "fresh") {
        await interaction.update(toUpdateOptions(payload));
        this.#state = "replied";
        this.#deferKind = "update";
        return;
      }
      if (this.#state === "deferred" && this.#deferKind === "update") {
        await interaction.editReply(toEditReplyOptions(payload));
        this.#state = "replied";
        return;
      }
      // We acknowledged as a reply, so `editReply` would edit the wrong message. Edit the
      // source message through the INTERACTION'S WEBHOOK rather than through the channel:
      // `Message#edit` routes to `PATCH /channels/{id}/messages/{id}`, which does not exist for
      // an ephemeral message (404 Unknown Message, swallowed as a warn), and every ephemeral
      // surface in this bot carries components. `webhook.editMessage` is valid for both kinds
      // for the lifetime of the token.
      await this.#editSourceMessage(toMessageEditOptions(payload));
    }, "update");
  }

  /**
   * Kill every component on the source message.
   *
   * Audit #88: a component whose window has closed stayed enabled, so the next click produced
   * "This interaction failed" instead of an explanation. A window that closes re-renders dead.
   */
  async disableSource(): Promise<void> {
    await this.#enqueue(async () => {
      const interaction = this.#interaction;
      if (!interaction.isMessageComponent()) return;
      const components = disableAll(interaction.message.components);
      if (this.#state === "fresh") {
        await interaction.update({ components });
        this.#state = "replied";
        this.#deferKind = "update";
        return;
      }
      await this.#editSourceMessage({ components });
    }, "disableSource");
  }

  // -------------------------------------------------------------------------
  // Private delivery, for the courier
  // -------------------------------------------------------------------------

  /**
   * Deliver a rendered private message on this interaction. Reports whether it landed, so the
   * session can fall back to a DM rather than dropping a player's private information.
   */
  deliver(payload: OutgoingMessage): Promise<boolean> {
    return this.#enqueue(async () => {
      this.cancelAutoDefer();
      const options = toReplyOptions(
        { content: payload.content, embeds: payload.embeds },
        true,
      );
      if (this.#state === "fresh") {
        await this.#interaction.reply(options);
        this.#state = "replied";
        this.#deferKind = "reply";
        return true;
      }
      if (this.#state === "deferred" && this.#deferKind === "reply") {
        await this.#interaction.editReply(
          toEditReplyOptions({ content: payload.content, embeds: payload.embeds }),
        );
        this.#state = "replied";
        return true;
      }
      await this.#interaction.followUp(options);
      this.#state = "replied";
      return true;
    }, "deliver").then(
      (delivered) => delivered ?? false,
      () => false,
    );
  }

  // -------------------------------------------------------------------------
  // The queue
  // -------------------------------------------------------------------------

  /**
   * Edit the message a component is attached to, ephemeral or not.
   *
   * `interaction.webhook.editMessage(id, …)` is `PATCH /webhooks/{app}/{token}/messages/{id}`,
   * which is the only route that reaches an ephemeral message. The channel route is kept as a
   * fallback for the case where the token has already expired but the message is a real one.
   */
  async #editSourceMessage(options: MessageEditOptions): Promise<void> {
    const interaction = fromMessage(this.#interaction);
    if (interaction === null) return;
    try {
      await interaction.webhook.editMessage(interaction.message.id, {
        content: options.content ?? null,
        embeds: options.embeds ? [...options.embeds] : [],
        components: options.components ? [...options.components] : [],
      });
    } catch (cause) {
      if (interaction.message.flags.has(MessageFlags.Ephemeral)) throw cause;
      await interaction.message.edit(options);
    }
  }

  /**
   * Serialise, then swallow. Nothing here may throw into a handler: by the time we are talking
   * the dispatch has already been committed and saved, and only the words are at risk.
   */
  #enqueue<T>(work: () => Promise<T>, what: string): Promise<T | null> {
    return this.#queue("interaction", work, what);
  }

  /**
   * The two lanes. `interaction` carries everything that acknowledges or edits the interaction
   * and must stay clear for the auto-defer; `channel` carries `announce`, which is ordinary
   * network work with no deadline attached to it.
   */
  #queue<T>(
    lane: "interaction" | "channel",
    work: () => Promise<T>,
    what: string,
  ): Promise<T | null> {
    const head = lane === "interaction" ? this.#chain : this.#announceChain;
    const result = head.then(async () => {
      try {
        return await work();
      } catch (cause) {
        this.#log.warn("could not answer an interaction", {
          what,
          lane,
          state: this.#state,
          cause: describeCause(cause),
        });
        return null;
      }
    });
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    if (lane === "interaction") this.#chain = tail;
    else this.#announceChain = tail;
    return result;
  }
}

// ---------------------------------------------------------------------------
// The ephemeral-first courier
// ---------------------------------------------------------------------------

/**
 * The courier `registry.ts` asks for: private events addressed at the player who just clicked
 * are answered on their own interaction, and everything else falls through to a DM.
 *
 * Returns false for any recipient set that is not exactly this viewer, which is what makes the
 * session try the DM courier instead — an ephemeral reply can only reach one person, and the
 * other recipients would silently lose their message.
 */
export class InteractionCourier implements PrivateCourier {
  readonly #responder: Responder;
  readonly #viewer: PlayerId;

  constructor(responder: Responder, viewer: PlayerId) {
    this.#responder = responder;
    this.#viewer = viewer;
  }

  async deliver(
    playerIds: readonly PlayerId[],
    payload: OutgoingMessage,
  ): Promise<boolean> {
    if (playerIds.length !== 1 || playerIds[0] !== this.#viewer) return false;
    return await this.#responder.deliver(payload);
  }
}

// ---------------------------------------------------------------------------
// GameError -> a sentence a player can act on
// ---------------------------------------------------------------------------

/**
 * Every refusal the engine can produce, in players' words.
 *
 * `Record<GameErrorCode, string>` on purpose: a new error code is a COMPILE ERROR here, so it
 * can never reach a player as "There was an error while executing this command!" (audit
 * #23/#118, and #82: "the message names a command that does not exist"). Each line says what
 * happened AND what to do next, because a refusal a player cannot act on is a bug report.
 *
 * These render from `code`, never from `GameError.message` — that field is developer-facing and
 * goes to the log.
 */
const ERROR_COPY: Readonly<Record<GameErrorCode, string>> = {
  // lobby / lifecycle
  game_not_found:
    "There is no game in this channel. Start one with `/survivor start`, or bring back an interrupted one with `/survivor resume`.",
  game_already_started:
    "A game is already running in this channel. Play it out, or end it with `/survivor abandon`.",
  game_not_started:
    "The game has not begun yet. The host presses **Begin** on the lobby message once at least three players have joined.",
  game_finished: "That game is over. `/survivor start` deals a new one.",
  game_abandoned: "That game was abandoned. `/survivor start` deals a new one.",
  not_enough_players: "Not enough players yet — Survivor needs at least three.",
  too_many_players: "The tribe is full. Six players is the maximum.",
  already_joined: "You are already in this game.",
  color_taken: "Someone already took that colour. Pick another from the lobby message.",
  no_colors_available: "Every colour is taken.",
  castaway_name_invalid:
    "That castaway name will not fit on the board. Use letters, numbers, spaces and simple punctuation, up to 40 characters — and once the game is under way, every castaway needs a name.",
  castaway_name_taken:
    "Somebody at this table already has that castaway, and there is only one of each. Pick someone else — `/castaways` suggests legends as you type.",
  castaway_voted_out:
    "That castaway has already been voted out, and their card stays turned over. You can still rename the ones in the game.",
  not_in_game:
    "You are not in this game. Join from the lobby message before it begins.",
  player_eliminated:
    "Your torch has been snuffed, so you are out of the game — but you are on the jury, and you will vote for the winner at the Final Tribal Council.",
  player_left_game: "That player has left the table.",
  not_authorized: "You are not allowed to do that.",
  not_host: "Only the host can do that.",

  // turn structure
  not_your_turn: "It is not your turn. `/status` shows whose it is.",
  wrong_turn_phase:
    "Not at this point in the turn. A turn goes **steal → play (optional) → draw**.",
  steal_step_not_done:
    "Steal first. `/steal` takes a random card from another player, and only then may you play one.",
  card_already_played_this_turn:
    "You have already played a card this turn — you get one. `/draw` to finish your turn.",

  // cards and targets
  card_not_in_hand:
    "That card is not in your hand any more. `/hand` shows what you are holding.",
  unknown_card_kind: "I do not know that card. `/card` looks up any card in the box.",
  wrong_card_kind: "That card cannot do this.",
  card_not_playable_now:
    "That card cannot be played right now. `/card` shows exactly when each one may be played.",
  target_required: "That needs a target — say who it is aimed at.",
  invalid_target: "That is not a legal target for this.",
  target_not_in_game: "That player is not in this game.",
  self_target_not_allowed: "You cannot aim that at yourself.",
  duplicate_target: "You have to name two different players.",
  camp_raid_already_present: "That player is already camp-raided.",
  empty_hand: "That player has no cards to take.",

  // pending windows
  pending_not_found: "That prompt has expired or has already been answered.",
  pending_already_resolved: "That prompt has already been answered.",
  not_a_participant: "That prompt is not for you.",
  already_submitted: "You have already answered that one.",
  wrong_pending_kind: "That answer does not fit the prompt you were asked.",

  // tribal council
  not_council_leader:
    "Only the Tribal Council Leader can do that — the player who drew the Tribal Council card.",
  wrong_council_phase:
    "Not in this phase of the council. The Leader moves it along with `/council`.",
  stale_phase:
    "The council has already moved on — that button belonged to the previous phase. `/council` shows where things stand.",
  no_council_in_progress: "There is no Tribal Council happening right now.",
  no_vote_card: "You have no vote card to cast.",
  vote_already_cast_with_card: "You have already voted with that card.",
  voting_not_open: "Voting is not open yet. The Leader opens it with `/council`.",
  must_cast_mandatory_vote:
    "You still have a vote you are required to cast — every vote card in front of you has to go in the box.",
  no_idol_to_nullify: "There is no Immunity Idol in play to nullify.",
  idol_already_nullified: "That Immunity Idol has already been nullified.",
  wrong_number_of_choices:
    "Wrong number of names — pick exactly as many as you were asked for.",
  candidate_not_eligible: "That player is not one of the candidates.",

  // final council
  not_a_juror: "Only jurors vote at the Final Tribal Council.",
  not_a_finalist: "That player is not one of the two finalists.",
  jury_vote_already_cast: "You have already cast your jury vote.",
  no_tie_to_break: "There is no tie to break.",

  // snapshots
  snapshot_version_unsupported:
    "That saved game was written by a different version of the bot and cannot be restored.",
  snapshot_malformed: "That saved game could not be read.",
  snapshot_card_census_mismatch:
    "That saved game does not add up — the cards in it do not account for the whole deck — so it will not be restored.",

  // protocol and filesystem. Distinct from the three above so that one grep for a corrupt save
  // does not also return every stale button pressed since the last deploy.
  component_malformed:
    "That button is no longer valid — it was posted by an older version of the bot. Check the latest message in this channel.",
  invalid_game_id:
    "That channel cannot hold a saved game — its id is not one this bot will write to disk.",
  save_write_failed:
    "The game could not be saved to disk. The move itself went through, but it may not survive a restart — please tell whoever runs this bot.",

  // policy
  feature_disabled: "That is switched off in this server's configuration.",
  internal_invariant_violated:
    "Something went wrong inside the game engine. Nothing was changed — please report this.",
};

/** The player-facing sentence for a refusal. */
export function describeGameError(error: GameError): string {
  return ERROR_COPY[error.code];
}

/** Copy for the two refusals the ROUTER makes, which never reach the engine. */
export const ROUTER_COPY = {
  staleComponent:
    "That button is no longer valid — the game has moved on since it was posted. Check the latest message in this channel.",
  otherPlayersComponent: "That button is not yours to press.",
  wrongGame: "That button belongs to an earlier game in this channel.",
  notInGuild: "Survivor is played in a server channel, not in a direct message.",
  unhandled:
    "I could not work out what that button was meant to do. Nothing has changed — please report this.",
} as const;

// ---------------------------------------------------------------------------
// The Command module shape
// ---------------------------------------------------------------------------

/**
 * Anything a `SlashCommandBuilder` (or any of its `Omit`-ed variants) satisfies.
 *
 * Structural on purpose: `new SlashCommandBuilder().addStringOption(...)` returns
 * `SlashCommandOptionsOnlyBuilder`, `.addSubcommand(...)` returns
 * `SlashCommandSubcommandsOnlyBuilder`, and naming one of those in the interface means half the
 * commands fail to typecheck for a reason that has nothing to do with them.
 */
export interface CommandData {
  readonly name: string;
  toJSON(): RESTPostAPIChatInputApplicationCommandsJSONBody;
}

/**
 * Everything a command's `execute` is given. There is no other input: a command never reaches
 * for a module-level anything, because there is no module-level anything to reach for (#48).
 */
export interface CommandContext {
  readonly interaction: ChatInputCommandInteraction;
  /** The one way to say anything. Never touch `interaction.reply` directly. */
  readonly reply: Responder;
  /** Who typed the command, as the engine's branded id. */
  readonly actor: PlayerId;
  /** The channel, when this is a guild text channel. Null in a DM. */
  readonly channel: GuildTextBasedChannel | null;
  readonly registry: SessionRegistry;
  readonly config: SurvivorConfig;
  readonly client: Client;
  readonly store: SaveStore;
  /** Already bound to this command, this channel and this actor. */
  readonly log: Logger;
  /** One clock reading for the whole handler, so two calls cannot disagree. */
  readonly nowMs: number;
  /** Answers private events on this interaction; hand it to `session.apply`. */
  readonly courier: PrivateCourier;

  /** This channel's game, or null. */
  session(): GameSession | null;
  /** This channel's game, or the `err` to hand straight to `reply.fail`. */
  requireSession(): Result<GameSession>;
  /** This channel, as a guild text channel, or the `err` to hand to `reply.fail`. */
  requireChannel(): Result<GuildTextBasedChannel>;
  /**
   * THE mutation path: dispatch, autosave, re-arm the tick timer, and render the events to the
   * right audiences. Never call `session.game.dispatch` yourself — it does none of those.
   */
  dispatch(session: GameSession, action: Action): Result<DispatchOutcome>;
  /** Does the caller hold Manage Server here? The moderator escape hatch of audit #24. */
  hasManageGuild(): boolean;
  /** The caller's server nickname, for an action that records a name (`join_game`). */
  displayName(): string;
}

/** What an `autocomplete` implementation is given. Autocomplete cannot defer: answer fast. */
export interface AutocompleteContext {
  readonly interaction: AutocompleteInteraction;
  readonly focused: { readonly name: string; readonly value: string };
  readonly registry: SessionRegistry;
  readonly config: SurvivorConfig;
  readonly log: Logger;
  readonly actor: PlayerId;
  /** Answer with up to 25 choices. Safe to call once; later calls are ignored. */
  respond(
    choices: readonly { readonly name: string; readonly value: string }[],
  ): Promise<void>;
}

/**
 * What a component handler is given. The session, the actor and the game identity have ALREADY
 * been validated by the router: `session` is live, it is the game the component was minted for
 * (game id AND incarnation), and `actor` is both the presser and the player the component names.
 */
export interface ComponentContext {
  readonly interaction: ComponentOrModalInteraction;
  readonly reply: Responder;
  readonly parsed: ParsedCustomId;
  /** Select values, or modal field values in field order. Empty for a plain button. */
  readonly values: readonly string[];
  readonly session: GameSession;
  readonly actor: PlayerId;
  readonly registry: SessionRegistry;
  readonly config: SurvivorConfig;
  readonly client: Client;
  readonly log: Logger;
  readonly nowMs: number;
  readonly courier: PrivateCourier;

  /**
   * Does the presser hold Manage Server here? The SAME implementation `CommandContext` uses.
   *
   * It is on this contract because the one authorization decision that runs from a button —
   * the `/survivor abandon` confirmation, which deletes everyone's game — had nowhere to get
   * it and reimplemented it at the call site. `parsed.seq` is deliberately NOT surfaced here:
   * the nonce is carried for diagnostics and for the incarnation half of audit #78, and nothing
   * consulted the seq half, so advertising a staleness guarantee no code provided was worse
   * than not advertising one. Every action is re-validated by the engine against the CURRENT
   * state, which is what actually makes a stale press safe.
   */
  hasManageGuild(): boolean;
  /** The presser's server nickname, for an action that records a name (`join_game`). */
  displayName(): string;

  dispatch(action: Action): Result<DispatchOutcome>;
}

export type ComponentHandler = (ctx: ComponentContext) => Promise<void>;

/**
 * Component intents a command claims.
 *
 * KEYS. For an engine action the key is the `ActionKind` itself (`"cast_vote"`). For a UI step
 * it is the `UiIntent` code from `ui.ts` (`"ut"` for PickTarget), optionally suffixed with a
 * FLOW TAG: `"uy:abandon"` matches a Confirm button whose `args[0]` is `"abandon"`.
 *
 * The flow tag exists because the generic UI intents — Confirm, Cancel, PickTarget — are used
 * by several unrelated flows, and two commands claiming the bare key would silently route one
 * flow's button into the other's handler. `src/index.ts` refuses to boot on a duplicate key, so
 * the collision is a startup failure rather than audit #37 wearing a new hat. Lookup tries
 * `"<intent>:<args[0]>"` first and the bare `"<intent>"` second.
 *
 * You do NOT need an entry for a button minted by `componentsForLegalActions()`: the router
 * rebuilds most engine actions from the custom_id on its own (see `actionFromComponent`).
 * Register a handler when the action needs information the custom_id cannot carry, or when the
 * press should open a picker rather than act.
 */
export type ComponentRoutes = Readonly<Record<string, ComponentHandler>>;

/**
 * Minting the components a handler will later receive.
 *
 * ```ts
 * import { ButtonStyle } from "discord.js";
 * import { UI_INTENT, button, buttonRows, componentsForLegalActions, select } from "../discord/ui.js";
 *
 * // (a) Straight from the engine. Enablement comes from `legalActions()`, never from an
 * //     opinion in the renderer, which is what makes audit #88 impossible.
 * const rows = componentsForLegalActions(
 *   session.legalActions(ctx.actor, ctx.nowMs),
 *   { ...session.uiContext(ctx.actor), only: ["steal_random", "skip_play_step", "draw_card"] },
 *   ctx.config.discord,
 * );
 *
 * // (b) A step of your own flow. `args[0]` is the flow tag your handler registers against.
 * const confirm = button(
 *   {
 *     parts: { ...session.uiContext(ctx.actor), intent: UI_INTENT.Confirm, args: ["abandon"] },
 *     label: "End this game",
 *     style: ButtonStyle.Danger,
 *   },
 *   ctx.config.discord,
 * );
 *
 * // and in the same module:
 * //   components: { "uy:abandon": async (ctx) => { ... } }
 * ```
 *
 * `session.uiContext(actor)` supplies the game id, the actor, the incarnation and the seq — the
 * four fields that let the router prove a press is still valid. Pass `ANY_PLAYER` as the actor
 * ONLY for a lobby component the whole table may press.
 */

/**
 * THE module shape. Every file in `src/commands/**` default-exports one of these.
 *
 * ```ts
 * // src/commands/steal.ts
 * import { SlashCommandBuilder } from "discord.js";
 * import type { Command } from "../discord/interactions.js";
 * import { asPlayerId } from "../engine/types.js";
 *
 * const command: Command = {
 *   data: new SlashCommandBuilder()
 *     .setName("steal")
 *     .setDescription("Step 1 of your turn: take a random card from another player.")
 *     .addUserOption((option) =>
 *       option.setName("player").setDescription("Who you are stealing from").setRequired(true),
 *     ),
 *
 *   async execute(ctx) {
 *     const found = ctx.requireSession();
 *     if (!found.ok) return ctx.reply.fail(found.error);
 *
 *     const target = asPlayerId(ctx.interaction.options.getUser("player", true).id);
 *     const outcome = ctx.dispatch(found.value, {
 *       type: "steal_random",
 *       actor: ctx.actor,
 *       target,
 *     });
 *     if (!outcome.ok) return ctx.reply.fail(outcome.error);
 *
 *     // The table already heard about it: `ctx.dispatch` rendered the events publicly.
 *     await ctx.reply.send({ content: "Stolen." });
 *   },
 * };
 *
 * export default command;
 * ```
 *
 * The five rules that skeleton encodes:
 *
 *  1. `ctx.reply` is the ONLY way to answer. Never `interaction.reply` / `deferReply` /
 *     `followUp` / `editReply` (audit #42/#45/#46/#89).
 *  2. `ctx.reply.send` is ephemeral; `ctx.reply.announce` posts to the channel. Public-by-rule
 *     information goes through `announce` or through the renderer, never through `send`
 *     (audit #119/#126).
 *  3. `ctx.dispatch` — never `session.game.dispatch`. It saves, re-arms the tick timer,
 *     renders every event to the audience the ENGINE chose (audit #60), and posts the prompt
 *     for every window the dispatch opened (`Command.prompts`).
 *  4. A refusal is `ctx.reply.fail(error)`, which renders the code into a sentence. Never
 *     invent copy for a `GameError` at a call site (audit #23/#118).
 *  5. Address cards by `CardUid` and players by `PlayerId`, taken from `legalActions()` or from
 *     a select value. NEVER by a position in a hand (audit #39/#50).
 */
export interface Command {
  readonly data: CommandData;
  execute(ctx: CommandContext): Promise<void>;
  /** Only for options declared with `.setAutocomplete(true)`. */
  autocomplete?(ctx: AutocompleteContext): Promise<void>;
  /** Component intents this command owns. See `ComponentRoutes`. */
  readonly components?: ComponentRoutes;
  /**
   * The public prompts for the windows this command's flows answer, by pending kind.
   *
   * The SESSION posts them — one for every window a dispatch or a tick opens, straight after
   * the narration — so a handler never prompts a window itself. Exactly one command owns each
   * kind: see `collectWindowPrompts`.
   */
  readonly prompts?: WindowPrompts;
}

/** A command's window prompts. See `Command.prompts`. */
export type WindowPrompts = Partial<Readonly<Record<PendingKind, WindowPrompter>>>;

export interface CollectedPrompts {
  /** Dispatches each window to the prompt of the command that owns its kind. */
  readonly prompter: WindowPrompter;
  /** Anything that stops every window having exactly one prompt. Non-empty means do not start. */
  readonly problems: readonly string[];
}

/**
 * Merge every command's `prompts` into the one `WindowPrompter` the registry hands its sessions.
 *
 * A kind with no owner is a PROBLEM, because it is a window that opens with no way to answer it
 * (audit #88). A kind with two owners is one too: two live sets of buttons on one window, and one
 * of them silently winning, is audit #37 again. `index.ts` refuses to boot on either.
 */
export function collectWindowPrompts(
  commands: Iterable<Command>,
  kinds: readonly PendingKind[],
): CollectedPrompts {
  const owners = new Map<
    PendingKind,
    { readonly command: string; readonly build: WindowPrompter }
  >();
  const problems: string[] = [];
  const known: ReadonlySet<string> = new Set(kinds);

  for (const command of commands) {
    const name = command.data.name;
    const prompts = command.prompts ?? {};
    for (const key of Object.keys(prompts)) {
      if (!known.has(key)) {
        problems.push(
          `/${name} prompts a "${key}" window, which the engine never opens`,
        );
      }
    }
    for (const kind of kinds) {
      const build = prompts[kind];
      if (build === undefined) continue;
      const owner = owners.get(kind);
      if (owner !== undefined) {
        problems.push(
          `the ${kind} window is prompted by both /${owner.command} and /${name}; exactly one command may own it`,
        );
        continue;
      }
      owners.set(kind, { command: name, build });
    }
  }

  for (const kind of kinds) {
    if (!owners.has(kind)) {
      problems.push(
        `no command prompts the ${kind} window, so it would open with no buttons to answer it`,
      );
    }
  }

  const prompter: WindowPrompter = (session, pending, config) =>
    owners.get(pending.kind)?.build(session, pending, config) ?? null;
  return { prompter, problems };
}

// ---------------------------------------------------------------------------
// The event module shape
// ---------------------------------------------------------------------------

/** Everything the process owns, handed to every event handler. There are no globals. */
export interface BotContext {
  readonly client: Client;
  readonly config: SurvivorConfig;
  readonly registry: SessionRegistry;
  readonly store: SaveStore;
  readonly log: Logger;
  /** Keyed by `data.name`. */
  readonly commands: ReadonlyMap<string, Command>;
  /** Keyed as described on `ComponentRoutes`. */
  readonly components: ReadonlyMap<string, ComponentHandler>;
}

export interface EventModule<K extends keyof ClientEvents = keyof ClientEvents> {
  readonly name: K;
  readonly once?: boolean;
  execute(bot: BotContext, ...args: ClientEvents[K]): Promise<void>;
}

// ---------------------------------------------------------------------------
// custom_id -> Action
// ---------------------------------------------------------------------------

/** `c003:sorry_for_you` — the shape `engine/card.ts` mints. */
const CARD_UID_PATTERN = /^c\d+:/;

const isCardUid = (raw: string): boolean => CARD_UID_PATTERN.test(raw);
/**
 * The engine's own predicate, not a local `/^pnd-/`.
 *
 * The pending id format was re-encoded in three places outside the engine and owned by none, so
 * changing `newPendingId` would have left this file — and the router — hunting for the old
 * shape while every Sorry-For-You press decoded as `target_required`.
 */
const isPendingId = (raw: string): boolean => looksLikePendingId(raw);

const CARD_KINDS: ReadonlySet<string> = new Set<string>(ALL_CARD_KINDS);
const COLORS: ReadonlySet<string> = new Set<string>(ALL_PLAYER_COLORS);
const COUNCIL_PHASES: ReadonlySet<string> = new Set<string>(COUNCIL_PHASE_ORDER);
const FINAL_PHASES: ReadonlySet<string> = new Set<string>(FINAL_COUNCIL_PHASE_ORDER);

/**
 * The raw fields of a component press, sorted by what they are rather than by where they sat.
 *
 * `ui.ts` packs a component's `args` positionally and a select adds its `values` on top, so the
 * same action can arrive as `args=[pendingId, cardUid]` from a one-card button and as
 * `args=[pendingId], values=[cardUid]` from a select over three cards. Every id in the protocol
 * is self-describing — a card uid starts `c<digits>:`, a pending id starts `pnd-`, a player is a
 * base36 snowflake that resolves against the table — so sorting by shape is total, and it is why
 * a handler never has to know which of the two shapes it was handed.
 */
interface ComponentFields {
  readonly cardUids: readonly CardUid[];
  readonly playerIds: readonly PlayerId[];
  readonly pendingId: PendingId | null;
  readonly cardKind: CardKind | null;
  readonly councilPhase: CouncilPhase | null;
  readonly finalPhase: FinalCouncilPhase | null;
  readonly color: PlayerColor | null;
  /** Anything that matched no shape, in order. Challenge throws and finger counts land here. */
  readonly plain: readonly string[];
}

/**
 * Resolve a packed or plain player id against the table.
 *
 * Comparing against `packPlayerArg(player.id)` rather than un-packing means the base36 codec
 * stays private to `ui.ts` AND the value is validated as a seat at this table in the same step:
 * an id for someone who is not playing simply does not resolve.
 */
function resolvePlayer(session: GameSession, raw: string): PlayerId | null {
  for (const player of session.view().players) {
    if (raw === player.id || raw === packPlayerArg(player.id)) return player.id;
  }
  return null;
}

function collectFields(
  parsed: ParsedCustomId,
  values: readonly string[],
  session: GameSession,
): ComponentFields {
  const cardUids: CardUid[] = [];
  const playerIds: PlayerId[] = [];
  const plain: string[] = [];
  let pendingId: PendingId | null = null;
  let cardKind: CardKind | null = null;
  let councilPhase: CouncilPhase | null = null;
  let finalPhase: FinalCouncilPhase | null = null;
  let color: PlayerColor | null = null;

  // args before values: `componentsForLegalActions` puts the engine's own suggestion in args,
  // and a select's values are the player's refinement of it.
  for (const raw of [...parsed.args, ...values]) {
    if (raw === "") continue;
    if (isCardUid(raw)) {
      cardUids.push(asCardUid(raw));
      continue;
    }
    if (isPendingId(raw)) {
      pendingId ??= asPendingId(raw);
      continue;
    }
    if (CARD_KINDS.has(raw)) {
      cardKind ??= raw as CardKind;
      continue;
    }
    if (COLORS.has(raw)) {
      color ??= raw as PlayerColor;
      continue;
    }
    // A council phase and a final-council phase share the name `tie_break`; recording both and
    // letting the action decide which it wanted is the only way that stays unambiguous.
    if (COUNCIL_PHASES.has(raw)) councilPhase ??= raw as CouncilPhase;
    if (FINAL_PHASES.has(raw)) finalPhase ??= raw as FinalCouncilPhase;
    if (COUNCIL_PHASES.has(raw) || FINAL_PHASES.has(raw)) continue;

    const player = resolvePlayer(session, raw);
    if (player !== null) {
      playerIds.push(player);
      continue;
    }
    plain.push(raw);
  }

  return {
    cardUids,
    playerIds,
    pendingId,
    cardKind,
    councilPhase,
    finalPhase,
    color,
    plain,
  };
}

const missing = (what: string): Result<Action> =>
  err("target_required", `this component did not carry ${what}`);

/**
 * Actions that cannot be rebuilt from a custom_id and MUST have a registered handler.
 * Named rather than silently mis-built: an ambiguous rebuild is a wrong move in someone's game.
 */
const NEEDS_HANDLER = (kind: ActionKind, why: string): Result<Action> =>
  err(
    "internal_invariant_violated",
    `${kind} needs a dedicated component handler: ${why}`,
    { kind },
  );

type Builder = (fields: ComponentFields, ctx: BuildContext) => Result<Action>;

interface BuildContext {
  readonly actor: PlayerId;
  readonly displayName: string;
}

/**
 * One builder per action. `Record<ActionKind, Builder>` so a 41st action cannot be added without
 * deciding how its component decodes — the same compile-time guarantee `ACTION_CODE` gives.
 */
const BUILDERS: Readonly<Record<ActionKind, Builder>> = {
  join_game: (f, c) =>
    ok(
      f.color === null
        ? { type: "join_game", actor: c.actor, displayName: c.displayName }
        : {
            type: "join_game",
            actor: c.actor,
            displayName: c.displayName,
            color: f.color,
          },
    ),
  leave_game: (_f, c) => ok({ type: "leave_game", actor: c.actor }),
  choose_color: (f, c) =>
    f.color === null
      ? missing("a colour")
      : ok({ type: "choose_color", actor: c.actor, color: f.color }),
  name_castaways: () =>
    NEEDS_HANDLER(
      "name_castaways",
      "castaway names are typed, so they arrive through a modal or `/castaways`",
    ),
  start_game: (f, c) =>
    ok(
      f.playerIds[0] === undefined
        ? { type: "start_game", actor: c.actor }
        : { type: "start_game", actor: c.actor, firstPlayer: f.playerIds[0] },
    ),
  abandon_game: () =>
    NEEDS_HANDLER(
      "abandon_game",
      "ending a game must go through a confirmation, never a bare button (audit #19/#24)",
    ),
  remove_player: (f, c) =>
    f.playerIds[0] === undefined
      ? missing("a player to remove")
      : ok({ type: "remove_player", actor: c.actor, target: f.playerIds[0] }),
  transfer_host: (f, c) =>
    f.playerIds[0] === undefined
      ? missing("a player to hand the host role to")
      : ok({ type: "transfer_host", actor: c.actor, target: f.playerIds[0] }),

  steal_random: (f, c) =>
    f.playerIds[0] === undefined
      ? missing("a victim")
      : ok({ type: "steal_random", actor: c.actor, target: f.playerIds[0] }),

  play_camp_raid: (f, c) =>
    f.cardUids[0] === undefined || f.playerIds[0] === undefined
      ? missing("a card and a target")
      : ok({
          type: "play_camp_raid",
          actor: c.actor,
          cardUid: f.cardUids[0],
          target: f.playerIds[0],
        }),
  play_knowledge_is_power: (f, c) =>
    f.cardUids[0] === undefined || f.playerIds[0] === undefined || f.cardKind === null
      ? missing("a card, a target and the card you are naming")
      : ok({
          type: "play_knowledge_is_power",
          actor: c.actor,
          cardUid: f.cardUids[0],
          target: f.playerIds[0],
          named: f.cardKind,
        }),
  play_spy_shack: (f, c) =>
    f.cardUids[0] === undefined || f.playerIds[0] === undefined
      ? missing("a card and a target")
      : ok({
          type: "play_spy_shack",
          actor: c.actor,
          cardUid: f.cardUids[0],
          target: f.playerIds[0],
        }),
  play_lets_form_an_alliance: () =>
    NEEDS_HANDLER(
      "play_lets_form_an_alliance",
      "a partner and a victim are both players and the custom_id cannot say which is which",
    ),
  play_do_or_die: (f, c) =>
    f.cardUids[0] === undefined || f.playerIds[0] === undefined
      ? missing("a card and an opponent")
      : ok({
          type: "play_do_or_die",
          actor: c.actor,
          cardUid: f.cardUids[0],
          opponent: f.playerIds[0],
        }),
  play_power_pair: (f, c) =>
    f.cardUids[0] === undefined ||
    f.playerIds[0] === undefined ||
    f.playerIds[1] === undefined
      ? missing("a card and two opponents")
      : ok({
          type: "play_power_pair",
          actor: c.actor,
          cardUid: f.cardUids[0],
          first: f.playerIds[0],
          second: f.playerIds[1],
        }),
  play_its_a_numbers_game: (f, c) =>
    f.cardUids[0] === undefined
      ? missing("a card")
      : ok({ type: "play_its_a_numbers_game", actor: c.actor, cardUid: f.cardUids[0] }),
  skip_play_step: (_f, c) => ok({ type: "skip_play_step", actor: c.actor }),
  draw_card: (_f, c) => ok({ type: "draw_card", actor: c.actor }),

  play_sorry_for_you: (f, c) =>
    f.cardUids[0] === undefined || f.pendingId === null
      ? missing("a card and the window it answers")
      : ok({
          type: "play_sorry_for_you",
          actor: c.actor,
          cardUid: f.cardUids[0],
          pendingId: f.pendingId,
        }),
  play_inheritance: (f, c) =>
    f.cardUids[0] === undefined || f.pendingId === null
      ? missing("a card and the window it answers")
      : ok({
          type: "play_inheritance",
          actor: c.actor,
          cardUid: f.cardUids[0],
          pendingId: f.pendingId,
        }),
  decline_reaction: (f, c) =>
    f.pendingId === null
      ? missing("the window it answers")
      : ok({ type: "decline_reaction", actor: c.actor, pendingId: f.pendingId }),

  submit_challenge_choice: (f, c) => {
    if (f.pendingId === null) return missing("the challenge it answers");
    const raw = f.plain[0];
    if (raw === undefined) return missing("a choice");
    if (raw === "rock" || raw === "paper" || raw === "scissors") {
      return ok({
        type: "submit_challenge_choice",
        actor: c.actor,
        pendingId: f.pendingId,
        submission: { kind: "rps", throw: raw },
      });
    }
    const count = Number.parseInt(raw, 10);
    if (count >= 1 && count <= 5) {
      return ok({
        type: "submit_challenge_choice",
        actor: c.actor,
        pendingId: f.pendingId,
        submission: { kind: "fingers", count: count as 1 | 2 | 3 | 4 | 5 },
      });
    }
    return missing("a recognisable choice");
  },
  choose_alliance_target: (f, c) =>
    f.pendingId === null || f.playerIds[0] === undefined
      ? missing("a window and a target")
      : ok({
          type: "choose_alliance_target",
          actor: c.actor,
          pendingId: f.pendingId,
          target: f.playerIds[0],
        }),
  choose_card: (f, c) =>
    f.pendingId === null || f.cardUids[0] === undefined
      ? missing("a window and a card")
      : ok({
          type: "choose_card",
          actor: c.actor,
          pendingId: f.pendingId,
          cardUid: f.cardUids[0],
        }),
  choose_steal_victim: (f, c) =>
    f.pendingId === null || f.playerIds[0] === undefined
      ? missing("a window and a victim")
      : ok({
          type: "choose_steal_victim",
          actor: c.actor,
          pendingId: f.pendingId,
          target: f.playerIds[0],
        }),
  discard_card: (f, c) =>
    f.pendingId === null || f.cardUids[0] === undefined
      ? missing("a window and a card")
      : ok({
          type: "discard_card",
          actor: c.actor,
          pendingId: f.pendingId,
          cardUid: f.cardUids[0],
        }),

  advance_council: (f, c) =>
    f.councilPhase === null
      ? missing("the phase it is advancing from")
      : ok({ type: "advance_council", actor: c.actor, from: f.councilPhase }),
  play_control_the_vote: (f, c) =>
    f.cardUids[0] === undefined || f.playerIds[0] === undefined
      ? missing("a card and a target")
      : ok({
          type: "play_control_the_vote",
          actor: c.actor,
          cardUid: f.cardUids[0],
          target: f.playerIds[0],
        }),
  play_goodwill_gamble: (f, c) =>
    f.cardUids[0] === undefined || f.playerIds[0] === undefined
      ? missing("a card and a recipient")
      : ok({
          type: "play_goodwill_gamble",
          actor: c.actor,
          cardUid: f.cardUids[0],
          recipient: f.playerIds[0],
        }),
  play_im_the_leader_now: (f, c) =>
    f.cardUids[0] === undefined
      ? missing("a card")
      : ok({ type: "play_im_the_leader_now", actor: c.actor, cardUid: f.cardUids[0] }),
  cast_vote: (f, c) =>
    f.cardUids[0] === undefined || f.playerIds[0] === undefined
      ? missing("a vote card and someone to vote for")
      : ok({
          type: "cast_vote",
          actor: c.actor,
          cardUid: f.cardUids[0],
          target: f.playerIds[0],
        }),
  finish_voting: (_f, c) => ok({ type: "finish_voting", actor: c.actor }),
  play_immunity_idol: (f, c) =>
    f.cardUids[0] === undefined || f.playerIds[0] === undefined
      ? missing("an idol and who it protects")
      : ok({
          type: "play_immunity_idol",
          actor: c.actor,
          cardUid: f.cardUids[0],
          protects: f.playerIds[0],
        }),
  play_idol_nullifier: (f, c) =>
    // Two card uids: the nullifier from the player's own hand first (it comes out of
    // `legalActions().playableCardUids`, so `ui.ts` puts it in `args`), then the idol it cancels.
    f.cardUids[0] === undefined || f.cardUids[1] === undefined
      ? missing("a nullifier and the idol it cancels")
      : ok({
          type: "play_idol_nullifier",
          actor: c.actor,
          cardUid: f.cardUids[0],
          targetIdolUid: f.cardUids[1],
        }),
  leader_choose_eliminations: (f, c) =>
    f.pendingId === null || f.playerIds.length === 0
      ? missing("a window and at least one name")
      : ok({
          type: "leader_choose_eliminations",
          actor: c.actor,
          pendingId: f.pendingId,
          targets: f.playerIds,
        }),

  advance_final_council: (f, c) =>
    f.finalPhase === null
      ? missing("the phase it is advancing from")
      : ok({ type: "advance_final_council", actor: c.actor, from: f.finalPhase }),
  reveal_hand: (_f, c) => ok({ type: "reveal_hand", actor: c.actor }),
  juror_ready: (_f, c) => ok({ type: "juror_ready", actor: c.actor }),
  cast_jury_vote: (f, c) =>
    f.playerIds[0] === undefined
      ? missing("a finalist")
      : ok({ type: "cast_jury_vote", actor: c.actor, finalist: f.playerIds[0] }),
  final_leader_break_tie: (f, c) =>
    f.playerIds[0] === undefined
      ? missing("a winner")
      : ok({ type: "final_leader_break_tie", actor: c.actor, winner: f.playerIds[0] }),
};

/**
 * Rebuild the engine action a component press means.
 *
 * This is the inverse of `ui.componentsForLegalActions`, and it lives here rather than in
 * twenty-six command files because `ui.ts` is what mints those buttons: one encoder, one
 * decoder. A command only writes a handler when the action needs something a custom_id cannot
 * carry (see `NEEDS_HANDLER` above) or when a press should open a picker instead of acting.
 */
export function actionFromComponent(
  parsed: ParsedCustomId,
  values: readonly string[],
  session: GameSession,
  build: BuildContext,
): Result<Action> {
  if (parsed.intent.kind !== "action") {
    return err(
      "internal_invariant_violated",
      "that component is a UI step, not an action",
    );
  }
  const fields = collectFields(parsed, values, session);
  return BUILDERS[parsed.intent.action](fields, build);
}

/** The route key a parsed component looks up, most specific first. See `ComponentRoutes`. */
export function routeKeysFor(parsed: ParsedCustomId): readonly string[] {
  const intent =
    parsed.intent.kind === "action"
      ? parsed.intent.action
      : (parsed.intent.ui as string);
  const flow = parsed.args[0];
  return flow === undefined || flow === "" ? [intent] : [`${intent}:${flow}`, intent];
}

/** True for the deliberately inert placeholders `ui.ts` mints when an id cannot be minted. */
export const isInert = (parsed: ParsedCustomId): boolean =>
  parsed.intent.kind === "ui" && parsed.intent.ui === UI_INTENT.Inert;

/** Card names for `/card`'s autocomplete, and for anything else that has to match a name. */
export const CARD_NAME_INDEX: readonly {
  readonly kind: CardKind;
  readonly name: string;
  readonly search: string;
}[] = Object.values(CARD_CATALOG)
  .slice()
  .sort((a, b) => a.sortOrder - b.sortOrder)
  .map((definition) => ({
    kind: definition.kind,
    name: definition.name,
    search: [definition.name, definition.kind, ...definition.aliases]
      .join(" ")
      .toLowerCase(),
  }));

/** A Discord user id, as the engine's branded player id. The one place that conversion lives. */
export const playerIdOf = (userId: string): PlayerId => asPlayerId(userId);

/**
 * Manage Server — the moderator escape hatch of audit #24, answered in ONE place.
 *
 * It lives here rather than in the router because both contracts above expose it
 * (`CommandContext.hasManageGuild`, `ComponentContext.hasManageGuild`) and because it was
 * previously implemented twice: once in `events/interactionCreate.ts` under a comment claiming
 * it was "checked in one place", and once again in `commands/survivor.ts`, which is the copy
 * that gated the Confirm button that actually ends everyone's game. A future change to how
 * moderator permission is decided must not be able to reach one of those and miss the other.
 */
export const hasManageGuild = (interaction: Interaction): boolean =>
  interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false;

/**
 * The name to record for a player who joins. Server nickname wins, because the whole table
 * already calls them that out loud on the voice call. Also single-sourced: `survivor.ts` held a
 * byte-for-byte duplicate of this.
 */
export function displayNameOf(interaction: Interaction): string {
  const member = interaction.member;
  if (
    member !== null &&
    "displayName" in member &&
    typeof member.displayName === "string"
  ) {
    return member.displayName;
  }
  return interaction.user.displayName;
}

/**
 * The `actor` to mint a component with when ANY player may press it.
 *
 * The protocol names one entitled player per component, which is what killed the cross-wired
 * collectors of audit #30/#47 — but a lobby's **Join** button genuinely belongs to everybody,
 * including people who are not in the game yet. `"0"` is not a legal Discord snowflake, so it
 * can never collide with a real user, and the router treats it as "no owner" rather than as an
 * owner nobody matches. Use it for lobby buttons and for nothing else: any component that acts
 * on the game state must name the player it acts for, so the engine can refuse the rest.
 */
export const ANY_PLAYER: PlayerId = asPlayerId("0");

/** Is this component pressable by this player? The one place that question is answered. */
export const mayPress = (parsed: ParsedCustomId, presser: PlayerId): boolean =>
  parsed.actor === ANY_PLAYER || parsed.actor === presser;
