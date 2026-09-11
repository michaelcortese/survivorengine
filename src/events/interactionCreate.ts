/**
 * THE router. Every click, command, keystroke and modal in the bot arrives here.
 *
 * It has exactly two jobs, and the second one is the important one:
 *
 *  1. Find the handler — a command by name, a component by the route key its custom_id decodes
 *     to, an autocomplete by the command that owns the focused option.
 *  2. PROVE the interaction is still valid before anything is applied. A component minted for a
 *     game that has since ended, for a different player, for the previous game in this channel,
 *     or by a build that no longer exists must produce a sentence, never a throw and never a
 *     move in somebody's game.
 *
 * The old bot got this wrong in five separate ways, and each one is closed here by a specific
 * check rather than by a convention:
 *
 *   #30/#47  collectors were channel-wide and filtered only on customId, so two concurrent flows
 *            cross-wired and one of them crashed the process
 *                -> the custom_id names the ONE player entitled to press it, and `parsed.actor`
 *                   is compared with the presser (`isTheirComponent`).
 *   #48/#78  a component outlived the game it belonged to
 *                -> game id AND incarnation (`GameState.createdAtMs`) are both checked, so a
 *                   button from the previous game in this channel is refused rather than applied
 *                   to its replacement.
 *   #88      components stayed enabled after their window closed, so a click produced
 *            "This interaction failed"
 *                -> a refusal disables the message it came from, and a successful action that
 *                   closes a pending window re-renders that prompt dead.
 *   #39/#50  a hand was spliced by an array index captured 60s earlier
 *                -> cards travel as `CardUid`s inside the custom_id and select values; this file
 *                   never looks at a position.
 *   #22/#46  one bad interaction took down the whole process
 *                -> every path is inside a try/catch that logs and answers; nothing rethrows.
 *
 * There is no collector anywhere in the codebase. A collector is a timer with an opinion about
 * which message it belongs to, and the custom_id already carries that opinion in a form that
 * survives a restart.
 */

import {
  Events,
  MessageFlags,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type GuildTextBasedChannel,
  type Interaction,
  type ModalSubmitInteraction,
} from "discord.js";

import type { Action, DispatchOutcome, PlayerId, Result } from "../engine/types.js";
import { err, ok } from "../engine/types.js";
import type {
  AutocompleteContext,
  BotContext,
  Command,
  CommandContext,
  ComponentContext,
  ComponentHandler,
  ComponentInteraction,
  ComponentOrModalInteraction,
  EventModule,
} from "../discord/interactions.js";
import {
  InteractionCourier,
  ROUTER_COPY,
  Responder,
  actionFromComponent,
  displayNameOf,
  hasManageGuild,
  isInert,
  mayPress,
  playerIdOf,
  routeKeysFor,
} from "../discord/interactions.js";
import { looksLikePendingId } from "../engine/pending.js";
import type { GameSession } from "../discord/registry.js";
import { statusEmbed } from "../discord/render.js";
import { UI_INTENT, parseCustomId, type ParsedCustomId } from "../discord/ui.js";
import { describeCause, type Logger } from "../logger.js";

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

/**
 * The channel, if it is a place a game can live.
 *
 * A game is keyed by channel id, and a DM has no tribe in it. Same narrowing the registry uses
 * when it re-fetches a channel at boot, so the two cannot disagree about what counts.
 */
function guildChannelOf(interaction: Interaction): GuildTextBasedChannel | null {
  const channel = interaction.channel;
  if (!channel || channel.isDMBased() || !channel.isTextBased()) return null;
  return channel;
}

/** Select values, or nothing for a plain button. */
function componentValues(interaction: ComponentInteraction): readonly string[] {
  return interaction.isAnySelectMenu() ? interaction.values : [];
}

/**
 * Modal field values in field order.
 *
 * Read through `unknown` rather than through the `ModalData` union: a modal's payload comes off
 * the wire, this file is the boundary, and a shape we did not expect must degrade to "no value"
 * instead of to a `TypeError` inside the router.
 */
function modalValues(interaction: ModalSubmitInteraction): readonly string[] {
  const out: string[] = [];
  for (const field of interaction.fields.fields.values()) {
    const single: unknown = (field as { value?: unknown }).value;
    if (typeof single === "string") {
      out.push(single);
      continue;
    }
    const many: unknown = (field as { values?: unknown }).values;
    if (Array.isArray(many)) {
      for (const value of many as readonly unknown[]) {
        if (typeof value === "string") out.push(value);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Chat input commands
// ---------------------------------------------------------------------------

async function handleCommand(
  bot: BotContext,
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const command: Command | undefined = bot.commands.get(interaction.commandName);
  const log = bot.log.child({
    command: interaction.commandName,
    channel: interaction.channelId,
    actor: interaction.user.id,
  });

  const responder = new Responder(interaction, bot.config, log);
  // Armed before anything else runs: whatever the handler does or forgets to do, Discord gets
  // an acknowledgement inside its three-second deadline (audit #16/#42).
  responder.armAutoDefer();

  if (!command) {
    // Audit #57/#61/#103: the compiled build loaded zero commands and every command in the
    // server was a dead entry. Saying so is how that gets noticed in minutes, not weeks.
    log.error("no handler for a registered command", undefined, {
      known: bot.commands.size,
    });
    await responder.send({
      content:
        "That command is registered with Discord but this build has no handler for it. Try again in a minute; if it keeps happening, the bot needs redeploying.",
    });
    return;
  }

  const nowMs = Date.now();
  const actor = playerIdOf(interaction.user.id);
  const channel = guildChannelOf(interaction);
  const courier = new InteractionCourier(responder, actor);

  const session = (): GameSession | null =>
    channel ? bot.registry.get(channel.id) : null;

  const ctx: CommandContext = {
    interaction,
    reply: responder,
    actor,
    channel,
    registry: bot.registry,
    config: bot.config,
    client: bot.client,
    store: bot.store,
    log,
    nowMs,
    courier,
    session,
    requireSession: (): Result<GameSession> => {
      if (!channel) return err("game_not_found", ROUTER_COPY.notInGuild);
      return bot.registry.require(channel.id);
    },
    requireChannel: (): Result<GuildTextBasedChannel> =>
      channel ? ok(channel) : err("game_not_found", ROUTER_COPY.notInGuild),
    dispatch: (target, action) => target.apply(action, { courier, nowMs }),
    hasManageGuild: () => hasManageGuild(interaction),
    displayName: () => displayNameOf(interaction),
  };

  try {
    await command.execute(ctx);
  } catch (cause) {
    // A handler throw is a bug in that command, not a reason to lose the game or the process.
    log.error("command handler threw", cause);
    await responder.fail(
      "Something went wrong running that command. The game itself is untouched — try again, and `/status` will show you where things stand.",
    );
    return;
  } finally {
    responder.cancelAutoDefer();
  }

  // A command that answered nothing would leave the player looking at "thinking…" forever.
  if (!responder.acknowledged) {
    log.debug("command produced no response; acknowledging for it");
    await responder.send({ content: "Done." });
  }
}

// ---------------------------------------------------------------------------
// Autocomplete
// ---------------------------------------------------------------------------

/**
 * Autocomplete cannot be deferred: Discord wants the choices inside three seconds or it shows
 * nothing at all. So there is no `Responder` here — one response, or an empty list.
 */
async function handleAutocomplete(
  bot: BotContext,
  interaction: AutocompleteInteraction,
): Promise<void> {
  const command = bot.commands.get(interaction.commandName);
  const log = bot.log.child({
    command: interaction.commandName,
    autocomplete: true,
    actor: interaction.user.id,
  });

  let answered = false;
  const respond = async (
    choices: readonly { readonly name: string; readonly value: string }[],
  ): Promise<void> => {
    if (answered) return;
    answered = true;
    try {
      // Discord caps an autocomplete response at 25, the same ceiling as a select menu.
      await interaction.respond(
        choices.slice(0, bot.config.discord.maxSelectMenuOptions).map((choice) => ({
          name: choice.name,
          value: choice.value,
        })),
      );
    } catch (cause) {
      log.debug("could not answer an autocomplete", { cause: describeCause(cause) });
    }
  };

  if (!command?.autocomplete) {
    await respond([]);
    return;
  }

  const focused = interaction.options.getFocused(true);
  const ctx: AutocompleteContext = {
    interaction,
    focused: { name: focused.name, value: focused.value },
    registry: bot.registry,
    config: bot.config,
    log,
    actor: playerIdOf(interaction.user.id),
    respond,
  };

  try {
    await command.autocomplete(ctx);
  } catch (cause) {
    log.error("autocomplete handler threw", cause);
  }
  await respond([]);
}

// ---------------------------------------------------------------------------
// Components and modals
// ---------------------------------------------------------------------------

/**
 * Everything that has to be true before a component press may touch a game.
 *
 * Each `return` here is one of the audit findings in the file header, and the order matters:
 * cheap structural checks first, so a hand-crafted custom_id from a curious player never gets
 * as far as a session lookup.
 */
type Validation =
  | {
      readonly ok: true;
      readonly session: GameSession;
      readonly parsed: ParsedCustomId;
    }
  | { readonly ok: false; readonly message: string; readonly killComponents: boolean };

function validateComponent(
  bot: BotContext,
  interaction: ComponentOrModalInteraction,
  presser: PlayerId,
  log: Logger,
): Validation | null {
  const parsed = parseCustomId(interaction.customId, bot.config.discord);
  if (!parsed.ok) {
    // Another application's component, an id from a previous protocol, or a fabricated one.
    log.debug("undecodable custom_id", { code: parsed.error.code });
    return { ok: false, message: ROUTER_COPY.staleComponent, killComponents: true };
  }
  // A placeholder `ui.ts` mints when an id could not be minted. Acknowledge and say nothing.
  if (isInert(parsed.value)) return null;

  // `ANY_PLAYER` is the lobby's escape hatch: a Join button belongs to everybody, including
  // people who are not in the game yet. Everything else names exactly one presser (audit #30/#47).
  if (!mayPress(parsed.value, presser)) {
    return {
      ok: false,
      message: ROUTER_COPY.otherPlayersComponent,
      killComponents: false,
    };
  }

  const channel = guildChannelOf(interaction);
  if (!channel) {
    return { ok: false, message: ROUTER_COPY.notInGuild, killComponents: false };
  }

  const session = bot.registry.get(channel.id);
  if (!session || session.retired) {
    return {
      ok: false,
      message: "That game is over. `/survivor start` deals a new one.",
      killComponents: true,
    };
  }
  // Both halves matter: the game id says which channel, the incarnation says WHICH GAME in that
  // channel. Without the second, a button from a finished game applies to its replacement (#78).
  if (
    session.gameId !== parsed.value.gameId ||
    session.incarnation !== parsed.value.incarnation
  ) {
    return { ok: false, message: ROUTER_COPY.wrongGame, killComponents: true };
  }

  return { ok: true, session, parsed: parsed.value };
}

async function handleComponent(
  bot: BotContext,
  interaction: ComponentOrModalInteraction,
  values: readonly string[],
): Promise<void> {
  const log = bot.log.child({
    component: interaction.customId,
    channel: interaction.channelId,
    actor: interaction.user.id,
  });
  const responder = new Responder(interaction, bot.config, log);
  responder.armAutoDefer();

  const presser = playerIdOf(interaction.user.id);
  const validation = validateComponent(bot, interaction, presser, log);

  if (validation === null) {
    await responder.deferUpdate();
    return;
  }
  if (!validation.ok) {
    // KILL FIRST, THEN EXPLAIN. A refused component must not stay pressable, or the next click
    // produces "This interaction failed" and the player learns nothing (audit #88) — and while
    // the responder is still `fresh` the kill goes out as `interaction.update()`, which is the
    // only edit route that works on an ephemeral message. Explaining first would acknowledge as
    // a reply and leave the edit to a channel-route PATCH that 404s on every ephemeral surface
    // in the bot (`/hand` pages, the `/council` panel, the `/vote` ballot, the `/play` menus).
    if (validation.killComponents) await responder.disableSource();
    await responder.send({ content: validation.message });
    return;
  }

  const { session, parsed } = validation;
  const nowMs = Date.now();
  // Expire anything whose deadline has passed BEFORE reading legality, so a press that lands a
  // moment after a window closed is judged against the board as it actually is.
  if (!session.retired) session.tick(nowMs);

  const courier = new InteractionCourier(responder, presser);
  const ctx: ComponentContext = {
    interaction,
    reply: responder,
    parsed,
    values,
    session,
    actor: presser,
    registry: bot.registry,
    config: bot.config,
    client: bot.client,
    log,
    nowMs,
    courier,
    hasManageGuild: () => hasManageGuild(interaction),
    displayName: () => displayNameOf(interaction),
    dispatch: (action: Action): Result<DispatchOutcome> =>
      session.apply(action, { courier, nowMs }),
  };

  try {
    const handler = findHandler(bot, parsed);
    if (handler) await handler(ctx);
    else if (parsed.intent.kind === "action") await applyGenericAction(ctx);
    else await handleUiIntent(ctx);
  } catch (cause) {
    log.error("component handler threw", cause);
    await responder.fail(
      "Something went wrong handling that. The game itself is untouched — `/status` will show you where things stand.",
    );
  } finally {
    responder.cancelAutoDefer();
  }

  // Silence is a legitimate outcome for a button: acknowledging as an update means the player
  // sees the press land without an ephemeral message they did not ask for.
  //
  // `deferUpdate()` is a no-op off a message component, and `cancelAutoDefer()` has already run
  // in the `finally` above — so a modal handler that returned quickly without replying would
  // leave the interaction unacknowledged and the player looking at "This interaction failed".
  // A modal gets the same treatment `handleCommand` gives a silent command.
  if (!responder.acknowledged) {
    if (interaction.isMessageComponent()) await responder.deferUpdate();
    else await responder.send({ content: "Done." });
  }
}

function findHandler(bot: BotContext, parsed: ParsedCustomId): ComponentHandler | null {
  for (const key of routeKeysFor(parsed)) {
    const handler = bot.components.get(key);
    if (handler) return handler;
  }
  return null;
}

/**
 * A component nobody claimed, carrying an engine action: rebuild it and dispatch it.
 *
 * This is what makes the buttons `ui.componentsForLegalActions()` mints work without a handler
 * per card — the encoder and the decoder are one pair, and a command only writes code for the
 * flows the custom_id genuinely cannot express (see `actionFromComponent`).
 */
async function applyGenericAction(ctx: ComponentContext): Promise<void> {
  const built = actionFromComponent(ctx.parsed, ctx.values, ctx.session, {
    actor: ctx.actor,
    displayName: ctx.displayName(),
  });
  if (!built.ok) {
    // Not a player error: a component was minted for a flow with no way to decode it.
    ctx.log.error("could not rebuild an action from a component", undefined, {
      code: built.error.code,
      detail: built.error.message,
    });
    await ctx.reply.send({ content: ROUTER_COPY.unhandled });
    return;
  }

  // `looksLikePendingId` rather than a fourth hand-rolled `startsWith("pnd-")`: the engine mints
  // the format and the engine answers the question.
  const pendingBefore = ctx.parsed.args.find((arg) => looksLikePendingId(arg)) ?? null;
  const outcome = ctx.dispatch(built.value);
  if (!outcome.ok) {
    // The engine refused, and changed nothing (audit #49). Say which rule, in the player's words.
    ctx.log.debug("component action refused", {
      action: built.value.type,
      code: outcome.error.code,
    });
    await ctx.reply.fail(outcome.error);
    return;
  }

  // The window this prompt was about is closed: re-render the prompt dead so nobody presses it
  // again and gets "This interaction failed" (audit #88).
  const stillOpen =
    pendingBefore !== null &&
    ctx.session.view().openPending.some((pending) => pending.id === pendingBefore);
  if (pendingBefore !== null && !stillOpen) await ctx.reply.disableSource();
}

/**
 * The UI steps that have a sensible meaning without a command claiming them.
 *
 * Everything else — opening a play menu, picking a target, confirming an abandon — belongs to
 * the command that renders it, because only that command knows what the flow is building. An
 * unclaimed one is a wiring bug and is logged as one.
 */
async function handleUiIntent(ctx: ComponentContext): Promise<void> {
  if (ctx.parsed.intent.kind !== "ui") return;

  switch (ctx.parsed.intent.ui) {
    case UI_INTENT.Cancel:
      await ctx.reply.disableSource();
      await ctx.reply.send({ content: "Cancelled. Nothing has changed." });
      return;

    case UI_INTENT.Refresh: {
      // Never mutates: `tick` has already run, and this only re-reads the public board.
      await ctx.reply.send({
        embeds: [statusEmbed(ctx.session.view(), ctx.config)],
      });
      return;
    }

    case UI_INTENT.Inert:
      await ctx.reply.deferUpdate();
      return;

    case UI_INTENT.OpenPlayMenu:
    case UI_INTENT.PickTarget:
    case UI_INTENT.PickColor:
    case UI_INTENT.PickSecondTarget:
    case UI_INTENT.Confirm:
      ctx.log.error("no handler is registered for a UI step", undefined, {
        ui: ctx.parsed.intent.ui,
        keys: routeKeysFor(ctx.parsed).join(","),
      });
      await ctx.reply.send({ content: ROUTER_COPY.unhandled });
      return;

    default:
      ctx.log.error("unknown UI step", undefined, { ui: String(ctx.parsed.intent.ui) });
      await ctx.reply.send({ content: ROUTER_COPY.unhandled });
      return;
  }
}

// ---------------------------------------------------------------------------
// The event
// ---------------------------------------------------------------------------

const interactionCreate: EventModule<Events.InteractionCreate> = {
  name: Events.InteractionCreate,

  async execute(bot: BotContext, interaction: Interaction): Promise<void> {
    try {
      if (interaction.isChatInputCommand()) {
        await handleCommand(bot, interaction);
      } else if (interaction.isAutocomplete()) {
        await handleAutocomplete(bot, interaction);
      } else if (interaction.isMessageComponent()) {
        await handleComponent(bot, interaction, componentValues(interaction));
      } else if (interaction.isModalSubmit()) {
        await handleComponent(bot, interaction, modalValues(interaction));
      }
      // Context menus and anything Discord adds later are ignored on purpose: we register none.
    } catch (cause) {
      // The backstop. Every path above already catches its own failures; this exists so that a
      // failure in the catching itself still cannot reach `unhandledRejection` (audit #22/#46).
      bot.log.error("interaction routing failed", cause, {
        type: String(interaction.type),
        channel: interaction.channelId,
      });
      if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
        try {
          await interaction.reply({
            content:
              "Something went wrong handling that. Nothing in the game has changed — please try again.",
            flags: MessageFlags.Ephemeral,
          });
        } catch {
          // The token is gone. There is nothing left to say and nothing left to do.
        }
      }
    }
  },
};

export default interactionCreate;
