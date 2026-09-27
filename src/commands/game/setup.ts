import {
  ButtonInteraction,
  ChatInputCommandInteraction,
  ComponentType,
  MessageFlags,
  SlashCommandBuilder,
} from "discord.js";
import { Game } from "../../game/game";
import Player from "../../game/player";
import { Lobby, LobbyEntry } from "../../game/lobby";
import { GameConfig } from "../../game/config";
import { sanitizeCastawayName } from "../../game/castaways";
import { buildBoardMessage } from "../../game/board";
import { replyEphemeral, sendableChannel, userInfo } from "../../util/discord";

const MODAL_TIMEOUT_MS = 5 * 60_000;

function toPlayer(entry: LobbyEntry): Player {
  const player = new Player(
    entry.userId,
    entry.displayName,
    entry.picks.map((pick) => pick?.name),
  );
  player.avatarUrl = entry.avatarUrl;
  entry.picks.forEach((pick, i) => {
    if (pick?.image) player.castaways[i].image = pick.image;
  });
  return player;
}

async function handlePick(lobby: Lobby, click: ButtonInteraction) {
  let entry = lobby.find(click.user.id);
  const newlyJoined = !entry;
  if (!entry) {
    const joined = lobby.join(userInfo(click.user));
    if ("error" in joined) {
      await replyEphemeral(click, joined.error);
      return;
    }
    entry = joined.entry;
  }

  await click.showModal(lobby.buildCastawayModal(entry));
  if (newlyJoined) {
    // Picking castaways also joins the game; show that straight away.
    await lobby.message?.edit(lobby.render()).catch(() => undefined);
  }
  const submit = await click
    .awaitModalSubmit({
      time: MODAL_TIMEOUT_MS,
      filter: (modal) => modal.customId === lobby.modalId(click.user.id),
    })
    .catch(() => null);
  if (!submit) return;

  const current = lobby.find(click.user.id);
  if (lobby.closed || !current) {
    await replyEphemeral(submit, "This game setup has closed.");
    return;
  }
  ["first", "second"].forEach((field, i) => {
    const name = sanitizeCastawayName(submit.fields.getTextInputValue(field));
    const previous = current.picks[i];
    // Keep an uploaded photo only while the castaway keeps the same name.
    current.picks[i] = name
      ? { name, image: previous?.name === name ? previous.image : undefined }
      : undefined;
  });

  if (submit.isFromMessage()) {
    await submit.update(lobby.render());
  } else {
    await replyEphemeral(submit, "Your castaways are saved!");
    await lobby.message?.edit(lobby.render()).catch(() => undefined);
  }
}

export default {
  data: new SlashCommandBuilder()
    .setName("setup")
    .setDescription("Set up a game: players join and pick the two Survivor castaways that are their lives")
    .addNumberOption((option) =>
      option
        .setName("discussion_minutes")
        .setDescription("Tribal Council discussion time in minutes (default 3)")
        .setMinValue(0.5)
        .setMaxValue(15),
    ),
  async execute(interaction: ChatInputCommandInteraction) {
    if (Game.active) {
      return replyEphemeral(
        interaction,
        "A game is already in progress! Use /end_game to end it first.",
      );
    }
    if (Game.lobby && !Game.lobby.closed) {
      return replyEphemeral(
        interaction,
        "A game is already being set up. Look for the lobby message, or cancel it with /end_game.",
      );
    }

    const minutes = interaction.options.getNumber("discussion_minutes");
    const lobby = new Lobby(
      interaction.user.id,
      minutes ? minutes * 60_000 : undefined,
    );
    lobby.join(userInfo(interaction.user)); // the host joins automatically
    Game.lobby = lobby;

    let message;
    try {
      const response = await interaction.reply({
        ...lobby.render(),
        withResponse: true,
      });
      message = response.resource?.message ?? (await interaction.fetchReply());
    } catch (error) {
      // Don't leave a lobby nobody can see blocking the next /setup
      if (Game.lobby === lobby) Game.lobby = null;
      throw error;
    }
    lobby.message = message;

    const collector = message.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: GameConfig.timings.lobbyMs,
    });

    const close = (reason: string) => {
      lobby.closed = true;
      if (Game.lobby === lobby) Game.lobby = null;
      collector.stop("closed");
      return lobby.renderClosed(reason);
    };
    lobby.setDisposer((reason) => {
      collector.stop("closed");
      message.edit(lobby.renderClosed(reason)).catch(() => undefined);
    });

    collector.on("collect", async (click) => {
      try {
        const action = click.customId.split(":")[2];
        if (lobby.closed) {
          await replyEphemeral(click, "This game setup has closed.");
          return;
        }

        switch (action) {
          case "join": {
            const joined = lobby.join(userInfo(click.user));
            if ("error" in joined) {
              await replyEphemeral(click, joined.error);
              return;
            }
            await click.update(lobby.render());
            return;
          }
          case "pick":
            await handlePick(lobby, click);
            return;
          case "leave": {
            if (!lobby.leave(click.user.id)) {
              await replyEphemeral(click, "You're not in this game.");
              return;
            }
            await click.update(lobby.render());
            return;
          }
          case "start": {
            if (click.user.id !== lobby.hostId) {
              await replyEphemeral(click, `Only the host (<@${lobby.hostId}>) can start the game.`);
              return;
            }
            if (lobby.entries.length < GameConfig.minPlayers) {
              await replyEphemeral(
                click,
                `You need at least ${GameConfig.minPlayers} players to start.`,
              );
              return;
            }
            if (Game.active) {
              await replyEphemeral(click, "Another game is already in progress.");
              return;
            }
            const players = lobby.entries.map(toPlayer);
            await click.update(close("The game has started! Good luck, castaways. 🔥"));
            Game.startGame(players, {
              channel: sendableChannel(click.channel),
              discussionMs: lobby.discussionMs,
            });
            const first = Game.currentPlayer();
            await click.followUp(
              await buildBoardMessage({
                content: `Game started! <@${first?.id}> is going first!`,
              }),
            );
            return;
          }
          case "cancel": {
            if (click.user.id !== lobby.hostId) {
              await replyEphemeral(click, `Only the host (<@${lobby.hostId}>) can cancel.`);
              return;
            }
            await click.update(close(`<@${lobby.hostId}> cancelled this game setup.`));
            return;
          }
        }
      } catch (error) {
        console.error("Lobby button failed:", error);
        if (!click.replied && !click.deferred) {
          await click
            .reply({ content: "Something went wrong.", flags: MessageFlags.Ephemeral })
            .catch(() => undefined);
        }
      }
    });

    collector.on("end", async (_collected, reason) => {
      if (reason === "time" && !lobby.closed) {
        await message
          .edit(close("This game setup expired. Run /setup to start a new one."))
          .catch(() => undefined);
      }
    });
  },
};
