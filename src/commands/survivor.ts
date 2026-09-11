/**
 * `/survivor` — the lobby and the lifecycle: `start`, `abandon`, `host`, `resume`.
 *
 * This is the only command that creates or destroys a game, and every defect the old bot had in
 * that area was a lifecycle defect rather than a rules one:
 *
 *   #48  a module-level singleton meant ONE game per process
 *          -> `ctx.registry.create({ channel, hostId })`. Keyed by channel, and a second game in
 *             the same channel comes back as `game_already_started`, never a silent replacement.
 *   #78  a component outlived the game it was minted for
 *          -> every lobby button carries `session.uiContext(...)`, so the router can prove the
 *             press belongs to THIS game and THIS incarnation before anything is applied.
 *   #19/#24  `/abandon` ended a game with no confirmation and no authorization
 *          -> the command posts a confirmation; the Confirm button is routed to `"uy:abandon"`
 *             here, and the presser must be the host or hold Manage Server.
 *   #44  a long flow was driven off one interaction token, which expires after fifteen minutes
 *          -> the lobby card is a real `channel.send` (`ctx.reply.announce`), and every Join /
 *             Leave / colour press re-renders THAT message through `ctx.reply.update()`. There
 *             is no collector and no timer anywhere in this file.
 *   #24  a host who left could not hand the game on, so the lobby dead-ended
 *          -> the ENGINE passes the role to the next seat on `leave_game` / `remove_player`,
 *             `/survivor host` hands it over deliberately, and an emptied lobby is disposed of.
 *   #124 `/resume` read an arbitrary caller-supplied path
 *          -> `registry.restore(channel)` is keyed by channel id inside the configured saves
 *             directory and takes no path at all.
 *
 * THE LIVE LOBBY. `lobbyPayload()` renders the whole card — embed and components — from the
 * session as it is right now. Every handler below ends by calling it again, so the player list,
 * the colour swatches and the Begin button are always the state the buttons were minted against
 * rather than a stale snapshot from whenever the message was first posted.
 */

import { ButtonStyle, SlashCommandBuilder } from "discord.js";

import type { SurvivorConfig } from "../config.js";
import type {
  Command,
  CommandContext,
  ComponentContext,
  Payload,
} from "../discord/interactions.js";
import { ANY_PLAYER } from "../discord/interactions.js";
import type { GameSession } from "../discord/registry.js";
import { lobbyEmbed, statusEmbed } from "../discord/render.js";
import { bold, colorEmoji, colorLabel, mention, quantity } from "../discord/format.js";
import {
  UI_INTENT,
  button,
  buttonRows,
  confirmRow,
  packPlayerArg,
  playerOptions,
  select,
  type Row,
} from "../discord/ui.js";
import type { GameError, PlayerColor, PlayerId } from "../engine/types.js";
import { ALL_PLAYER_COLORS, asPlayerId } from "../engine/types.js";
import { saveExists } from "../persistence/store.js";

// ---------------------------------------------------------------------------
// Little shared helpers
// ---------------------------------------------------------------------------

/**
 * A refusal this LAYER makes, in the shape `ctx.reply.fail` renders from a code.
 *
 * Never used for something the engine already refuses — that comes back as a real `GameError`
 * and is handed straight to `fail` (audit #23/#118: do not invent copy at a call site).
 */
const layerError = (code: GameError["code"], message: string): GameError => ({
  code,
  message,
});

/** `args[0]` of the host picker this command mints. See `ComponentRoutes` for why it exists. */
const HOST_FLOW = "host";

// ---------------------------------------------------------------------------
// The lobby card
// ---------------------------------------------------------------------------

/**
 * The whole lobby message: who is in, what colour they took, and what may be pressed.
 *
 * `ANY_PLAYER` on Join / Leave / the colour swatches, because a lobby button genuinely belongs
 * to everybody — including people who are not in the game yet, whom the protocol could not name.
 * **Begin** names the host, so a non-host press is refused by the router with "That button is
 * not yours to press" before it ever reaches the engine.
 */
function lobbyPayload(
  session: GameSession,
  config: SurvivorConfig,
  nowMs: number,
): Payload {
  const view = session.view();
  const discord = config.discord;
  const limits = config.engine.limits;
  const shared = session.uiContext(ANY_PLAYER);

  // Enablement comes from the ENGINE, never from an opinion here (audit #88). `start_game`
  // appears in the host's legal actions only once the lobby is big enough and the host is in it.
  const mayBegin = session
    .legalActions(view.hostId, nowMs)
    .some((action) => action.kind === "start_game");

  const controls = buttonRows(
    [
      button(
        {
          parts: { ...shared, intent: "join_game" },
          label: "Join",
          style: ButtonStyle.Success,
          emoji: "🔥",
          disabled: view.players.length >= limits.maxPlayers,
        },
        discord,
      ),
      button(
        {
          parts: { ...shared, intent: "leave_game" },
          label: "Leave",
          style: ButtonStyle.Secondary,
          disabled: view.players.length === 0,
        },
        discord,
      ),
      button(
        {
          parts: { ...shared, actor: view.hostId, intent: "start_game" },
          label: "Begin",
          style: ButtonStyle.Primary,
          disabled: !mayBegin,
        },
        discord,
      ),
    ],
    discord,
  );

  const takenBy = new Map<PlayerColor, PlayerId>(
    view.players.map((player) => [player.color, player.id]),
  );
  const swatches = ALL_PLAYER_COLORS.map((color) =>
    button(
      {
        parts: { ...shared, intent: "choose_color", args: [color] },
        label: colorLabel(color),
        emoji: colorEmoji(color),
        style: ButtonStyle.Secondary,
        // A colour somebody already holds is rendered visible-but-DEAD rather than removed: an
        // absent affordance is indistinguishable from a rule the player has not understood.
        disabled: takenBy.has(color),
      },
      discord,
    ),
  );
  // Two rows of three read as a palette; `buttonRows` alone would give five and one.
  const half = Math.ceil(swatches.length / 2);
  const colors: Row[] = [
    ...buttonRows(swatches.slice(0, half), discord),
    ...buttonRows(swatches.slice(half), discord),
  ];

  // No "the host has left" banner any more, because that state no longer exists: the engine
  // passes the role to the next seat the moment a host leaves or is removed (`host_changed`,
  // narrated publicly), and a lobby the last player walks out of is disposed of rather than
  // left un-beginnable. Every press re-renders this card, so **Begin** is always minted for
  // whoever the host is NOW, and 🏕️ in the embed moves with them.
  return {
    embeds: [lobbyEmbed(view, config)],
    components: [...controls, ...colors],
  };
}

// ---------------------------------------------------------------------------
// /survivor start
// ---------------------------------------------------------------------------

async function start(ctx: CommandContext): Promise<void> {
  const channel = ctx.requireChannel();
  if (!channel.ok) return ctx.reply.fail(channel.error);

  // A save with no live session means the bot restarted and could not reach this channel at
  // boot. Creating a new game here would overwrite that file on its very first autosave, so the
  // lobby is refused and the player is pointed at the command that actually recovers it.
  if (
    ctx.registry.get(channel.value.id) === null &&
    ctx.config.autosave.enabled &&
    saveExists(ctx.config.autosave.directory, channel.value.id)
  ) {
    return ctx.reply.fail(
      "This channel has an interrupted game saved. Bring it back with `/survivor resume`, or end it with `/survivor abandon` once it is back.",
    );
  }

  const created = ctx.registry.create({
    channel: channel.value,
    hostId: ctx.actor,
    nowMs: ctx.nowMs,
  });
  if (!created.ok) return ctx.reply.fail(created.error);
  const session = created.value;

  // The host is at the fire by definition — they just lit it. A refusal here is impossible in a
  // brand-new lobby, but it is a `Result` and dropping it silently is how audit #49 reads.
  const joined = ctx.dispatch(session, {
    type: "join_game",
    actor: ctx.actor,
    displayName: ctx.displayName(),
  });
  if (!joined.ok) {
    ctx.log.warn("host could not join their own new lobby", {
      code: joined.error.code,
    });
  }

  const posted = await ctx.reply.announce(lobbyPayload(session, ctx.config, ctx.nowMs));
  if (posted === null) {
    // No lobby card means no way to join, so the game that was just created is unreachable.
    // Ending it is the only outcome that leaves the channel in a state anyone can act on.
    ctx.dispatch(session, { type: "abandon_game", actor: ctx.actor });
    return ctx.reply.fail(
      "I could not post the lobby in this channel, so there is nothing to join. Check that I have permission to send messages and embeds here, then try again.",
    );
  }

  await ctx.reply.send({
    content: `Lobby is open. Everyone presses ${bold("Join")} on the message above, and you press ${bold("Begin")} once ${quantity(ctx.config.engine.limits.minPlayers, "player")} are in.`,
  });
}

// ---------------------------------------------------------------------------
// /survivor abandon
// ---------------------------------------------------------------------------

async function abandon(ctx: CommandContext): Promise<void> {
  const found = ctx.requireSession();
  if (!found.ok) return ctx.reply.fail(found.error);
  const session = found.value;
  const view = session.view();

  const isHost = ctx.actor === view.hostId;
  if (!isHost && !ctx.hasManageGuild()) {
    return ctx.reply.fail(
      layerError("not_host", "only the host or a server moderator may end a game"),
    );
  }

  // Never a bare button (audit #19/#24). The Confirm carries the flow tag `abandon`, which is
  // what routes it to the `"uy:abandon"` handler below rather than to some other flow's Confirm.
  await ctx.reply.send({
    content: [
      `${bold("End this game?")} Every hand, every torch and every vote goes with it, and the autosave is deleted.`,
      view.status === "lobby"
        ? "This lobby has not started yet."
        : `${quantity(view.players.filter((player) => !player.departed).length, "player")} are still in it.`,
    ].join("\n"),
    components: [
      confirmRow(
        { ...session.uiContext(ctx.actor), args: ["abandon"] },
        { confirm: "End this game", cancel: "Never mind" },
        ctx.config.discord,
      ),
    ],
  });
}

/**
 * The Confirm on `/survivor abandon`.
 *
 * The authorization is checked AGAIN here rather than trusted from the command that minted the
 * button: the router proves the presser is `parsed.actor`, but a player's permissions can change
 * between the prompt and the press, and "who may end the game" is exactly the question audit #24
 * was about.
 */
async function confirmAbandon(ctx: ComponentContext): Promise<void> {
  const view = ctx.session.view();
  const isHost = ctx.actor === view.hostId;
  const isModerator = ctx.hasManageGuild();
  if (!isHost && !isModerator) {
    await ctx.reply.disableSource();
    await ctx.reply.fail(
      layerError("not_host", "only the host or a server moderator may end a game"),
    );
    return;
  }

  // ARCHITECTURE.md §1: "The Discord layer may additionally admit a guild moderator, and when it
  // does it passes the moderator's id as the actor and records it — the engine's check is on the
  // id it is given." `viaModerator` is this layer asserting it just checked Manage Server, five
  // lines up. The actor stays the MODERATOR's own id, so `stage.abandonedById` and the public
  // `game_abandoned` narration both name whoever actually ended it, rather than attributing it
  // to a host who was not there.
  const outcome = ctx.dispatch({
    type: "abandon_game",
    actor: ctx.actor,
    viaModerator: !isHost && isModerator,
  });
  if (!outcome.ok) {
    await ctx.reply.fail(outcome.error);
    return;
  }
  if (!isHost) {
    ctx.log.warn("game ended by a server moderator", {
      moderator: ctx.actor,
      host: view.hostId,
    });
  }
  await ctx.reply.update({ content: "This game has been ended.", components: [] });
}

// ---------------------------------------------------------------------------
// /survivor host
// ---------------------------------------------------------------------------

/**
 * Hand the host role to somebody else, on purpose.
 *
 * The engine moves the role by itself when a host leaves, which is what keeps a lobby from
 * dead-ending; this is the case that has nothing to do with leaving — the host is about to go
 * quiet, or simply wants somebody else running the table. Nothing is re-checked here: who may
 * do this, and who may receive it, are the engine's answers (`transfer_host`), and the table
 * hears about it from the public `host_changed` event rather than from this reply.
 */
async function host(ctx: CommandContext): Promise<void> {
  const found = ctx.requireSession();
  if (!found.ok) return ctx.reply.fail(found.error);
  const session = found.value;
  const target = asPlayerId(ctx.interaction.options.getUser("player", true).id);

  const outcome = ctx.dispatch(session, {
    type: "transfer_host",
    actor: ctx.actor,
    target,
  });
  if (!outcome.ok) return ctx.reply.fail(outcome.error);

  await ctx.reply.send({
    content: `${mention(target)} is the host now. They can press ${bold("Begin")}, remove a player and end the game; you cannot.`,
  });

  // The lobby card that is already in the channel was minted with **Begin** naming the OLD
  // host, and a component is bound to the player it names. Posting a fresh card is the whole
  // fix — the new one is minted against the state as it is now (audit #78).
  if (session.view().status === "lobby") {
    await ctx.reply.announce(lobbyPayload(session, ctx.config, ctx.nowMs));
  }
}

// ---------------------------------------------------------------------------
// /survivor resume
// ---------------------------------------------------------------------------

async function resume(ctx: CommandContext): Promise<void> {
  const channel = ctx.requireChannel();
  if (!channel.ok) return ctx.reply.fail(channel.error);

  if (ctx.registry.get(channel.value.id) !== null) {
    return ctx.reply.fail(
      "This channel's game is already running — nothing to bring back. `/status` shows where it stands.",
    );
  }

  // Keyed by channel id inside the configured directory and nothing else (audit #124).
  const restored = await ctx.registry.restore(channel.value);
  if (!restored.ok) {
    if (restored.error.code === "game_not_found") {
      return ctx.reply.fail(
        "There is no saved game in this channel to bring back. `/survivor start` opens a new lobby.",
      );
    }
    ctx.log.warn("resume failed", { code: restored.error.code });
    return ctx.reply.fail(restored.error);
  }

  const session = restored.value;
  const view = session.view();

  // Public by rule, so it goes to the CHANNEL, not to the person who typed the command
  // (audit #119/#126). A lobby comes back as a live lobby card with working buttons; anything
  // further on comes back as the board.
  if (view.status === "lobby") {
    await ctx.reply.announce({
      content: `${bold("The lobby is back.")} Nothing was lost.`,
    });
    await ctx.reply.announce(lobbyPayload(session, ctx.config, ctx.nowMs));
  } else {
    await ctx.reply.announce({
      content: `${bold("The game is back exactly where it was.")} ${whereWeStand(session)}`,
      embeds: [statusEmbed(view, ctx.config)],
    });
  }

  await ctx.reply.send({ content: "Restored." });
}

/** One sentence saying whose move it is, for the line above the restored board. */
function whereWeStand(session: GameSession): string {
  const view = session.view();
  if (view.finalCouncil !== null) {
    return `Final Tribal Council — ${bold(view.finalCouncil.phase.replace(/_/g, " "))}, run by ${mention(view.finalCouncil.leaderId)}.`;
  }
  if (view.council !== null) {
    return `Tribal Council — ${bold(view.council.phase.replace(/_/g, " "))}, led by ${mention(view.council.leaderId)}.`;
  }
  if (view.turn !== null) {
    return `It is ${mention(view.turn.playerId)}'s turn, at the ${bold(view.turn.phase)} step.`;
  }
  return "`/status` shows the board.";
}

// ---------------------------------------------------------------------------
// Lobby button handlers
// ---------------------------------------------------------------------------

/**
 * Dispatch, then re-render the lobby message the button is sitting on.
 *
 * Re-rendering after a REFUSAL too is deliberate: "that colour is taken" is almost always a
 * message that arrived a second after somebody else's press, and the player needs to see the
 * card as it is now rather than the card they clicked.
 */
async function afterLobbyPress(
  ctx: ComponentContext,
  failed: GameError | null,
): Promise<void> {
  if (failed !== null) await ctx.reply.fail(failed);
  await ctx.reply.update(lobbyPayload(ctx.session, ctx.config, ctx.nowMs));
}

async function pressJoin(ctx: ComponentContext): Promise<void> {
  const outcome = ctx.dispatch({
    type: "join_game",
    actor: ctx.actor,
    displayName: ctx.displayName(),
  });
  await afterLobbyPress(ctx, outcome.ok ? null : outcome.error);
}

/**
 * **Leave**.
 *
 * The host leaving is no longer a dead end — the engine hands the role to the next seat and the
 * re-render below mints **Begin** for them. The LAST player leaving closes the lobby outright,
 * and a closed lobby must not be re-rendered with live Join buttons on it (audit #88): the card
 * goes dead, exactly as it does when the game begins.
 */
async function pressLeave(ctx: ComponentContext): Promise<void> {
  const outcome = ctx.dispatch({ type: "leave_game", actor: ctx.actor });
  if (outcome.ok && ctx.session.view().status !== "lobby") {
    await ctx.reply.update({
      content: `${bold("The lobby is closed.")} Everyone left. \`/survivor start\` opens a new one.`,
      components: [],
    });
    return;
  }
  await afterLobbyPress(ctx, outcome.ok ? null : outcome.error);
}

/**
 * A colour swatch.
 *
 * Pressing one while you are not yet at the fire JOINS you in that colour, because that is what
 * the press obviously means and making somebody press Join and then a swatch is two clicks for
 * one decision. The colour travels in `args[0]` and is validated by the engine either way.
 */
async function pressColor(ctx: ComponentContext): Promise<void> {
  const raw = ctx.parsed.args[0] ?? "";
  const color = ALL_PLAYER_COLORS.find((candidate) => candidate === raw);
  if (color === undefined) {
    await ctx.reply.fail(
      layerError("invalid_target", "that button did not name a Survivor colour"),
    );
    await ctx.reply.update(lobbyPayload(ctx.session, ctx.config, ctx.nowMs));
    return;
  }

  const outcome = ctx.session.hasPlayer(ctx.actor)
    ? ctx.dispatch({ type: "choose_color", actor: ctx.actor, color })
    : ctx.dispatch({
        type: "join_game",
        actor: ctx.actor,
        displayName: ctx.displayName(),
        color,
      });
  await afterLobbyPress(ctx, outcome.ok ? null : outcome.error);
}

/**
 * **Begin**. The router has already proved the presser is the host — the button names them — and
 * the engine enforces the 3-6 range, so this only has to say what happened to the lobby card.
 */
async function pressBegin(ctx: ComponentContext): Promise<void> {
  const outcome = ctx.dispatch({ type: "start_game", actor: ctx.actor });
  if (!outcome.ok) {
    await afterLobbyPress(ctx, outcome.error);
    return;
  }
  // The lobby is over: the card is re-rendered DEAD so nobody presses Join into a running game
  // and gets "This interaction failed" (audit #88). The tribe's own announcement — turn order,
  // the deck, the first player — is already on its way from the render pipeline.
  await ctx.reply.update({
    content: `${bold("The lobby is closed.")} The tribe has gathered.`,
    components: [],
  });
}

/**
 * **Abandon this game**, pressed as a button rather than typed.
 *
 * It opens the SAME confirmation `/survivor abandon` opens. A bare button that ends a game is
 * exactly what audit #19/#24 was about, so this handler never dispatches anything itself.
 */
async function pressAbandon(ctx: ComponentContext): Promise<void> {
  const view = ctx.session.view();
  if (ctx.actor !== view.hostId && !ctx.hasManageGuild()) {
    await ctx.reply.fail(
      layerError("not_host", "only the host or a server moderator may end a game"),
    );
    return;
  }
  await ctx.reply.send({
    content: `${bold("End this game?")} Every hand, every torch and every vote goes with it, and the autosave is deleted.`,
    components: [
      confirmRow(
        { ...ctx.session.uiContext(ctx.actor), args: ["abandon"] },
        { confirm: "End this game", cancel: "Never mind" },
        ctx.config.discord,
      ),
    ],
  });
}

/** **Pass the host role on**: the button opens the picker the action needs. */
async function pressTransferHost(ctx: ComponentContext): Promise<void> {
  const legal = ctx.session
    .legalActions(ctx.actor, ctx.nowMs)
    .find((action) => action.kind === "transfer_host");
  const targets = legal?.legalTargets ?? [];
  if (targets.length === 0) {
    await ctx.reply.fail(
      layerError("invalid_target", "there is nobody to hand the host role to"),
    );
    return;
  }
  await ctx.reply.send({
    content: "Who takes over as host?",
    components: [
      select(
        {
          parts: {
            ...ctx.session.uiContext(ctx.actor),
            intent: UI_INTENT.PickTarget,
            args: [HOST_FLOW],
          },
          placeholder: "Pass the host role to…",
          options: playerOptions(
            ctx.session.view().players,
            targets,
            ctx.config.engine.limits.characterCardsPerPlayer,
          ),
        },
        ctx.config.discord,
      ),
    ],
  });
}

async function pickNewHost(ctx: ComponentContext): Promise<void> {
  const raw = ctx.values[0];
  const target =
    raw === undefined
      ? null
      : (ctx.session
          .view()
          .players.find(
            (player) => raw === player.id || raw === packPlayerArg(player.id),
          )?.id ?? null);
  if (target === null) {
    await ctx.reply.fail(
      layerError("target_not_in_game", "the picked player is not at this table"),
    );
    return;
  }
  const outcome = ctx.dispatch({ type: "transfer_host", actor: ctx.actor, target });
  if (!outcome.ok) {
    await ctx.reply.fail(outcome.error);
    return;
  }
  await ctx.reply.send({
    content: `${mention(target)} is the host now. They can press ${bold("Begin")}, remove a player and end the game; you cannot.`,
  });
  if (ctx.session.view().status === "lobby") {
    await ctx.reply.announce(lobbyPayload(ctx.session, ctx.config, ctx.nowMs));
  }
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

const survivor: Command = {
  data: new SlashCommandBuilder()
    .setName("survivor")
    .setDescription("Open, end or bring back this channel's game.")
    .addSubcommand((sub) =>
      sub
        .setName("start")
        .setDescription("Open a lobby in this channel and invite the table to join."),
    )
    .addSubcommand((sub) =>
      sub
        .setName("abandon")
        .setDescription(
          "End this channel's game. Host or Manage Server, with a confirmation.",
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("host")
        .setDescription("Hand the host role to another player at this table.")
        .addUserOption((option) =>
          option
            .setName("player")
            .setDescription("Who takes over as host")
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("resume")
        .setDescription("Bring back this channel's game after the bot restarted."),
    ),

  async execute(ctx: CommandContext): Promise<void> {
    switch (ctx.interaction.options.getSubcommand()) {
      case "start":
        await start(ctx);
        return;
      case "abandon":
        await abandon(ctx);
        return;
      case "host":
        await host(ctx);
        return;
      case "resume":
        await resume(ctx);
        return;
      default:
        // Discord sends a string off the wire, not a member of a union.
        await ctx.reply.fail(
          "I do not know that `/survivor` subcommand. Try `start`, `abandon`, `host` or `resume`.",
        );
        return;
    }
  },

  components: {
    join_game: pressJoin,
    leave_game: pressLeave,
    choose_color: pressColor,
    start_game: pressBegin,
    "uy:abandon": confirmAbandon,
    // The two host actions a BUTTON cannot carry. `componentsForLegalActions()` mints one for
    // every legal action, and neither of these can be rebuilt from a custom_id: `abandon_game`
    // must go through a confirmation (audit #19/#24) and `transfer_host` needs a player the
    // button has no room to name. Without these routes both were minted ENABLED and the press
    // reached the host as "I could not work out what that button was meant to do" — audit #88
    // on the two most consequential controls in the game. `steal.ts` is the same pattern.
    abandon_game: pressAbandon,
    transfer_host: pressTransferHost,
    [`${UI_INTENT.PickTarget}:${HOST_FLOW}`]: pickNewHost,
  },
};

export default survivor;
