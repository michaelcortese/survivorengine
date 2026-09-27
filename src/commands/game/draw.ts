import { TribalCouncil, TribalCouncilType } from "../../game/tribal_council";
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  MessageFlags,
} from "discord.js";
import { Game, TribalCouncilState } from "../../game/game";
import type Player from "../../game/player";
import { CardName } from "../../game/cards";
import {
  replyEphemeral,
  runSorryForYouWindow,
  sendDM,
} from "../../util/discord";

async function goToTribalCouncil(
  interaction: ChatInputCommandInteraction,
  drawer: Player,
  type: TribalCouncilType,
) {
  Game.tribalCouncilState = TribalCouncilState.Discussion;
  const tribalCouncil = new TribalCouncil(interaction, type, drawer);
  Game.setTribalCouncil(tribalCouncil);
  await tribalCouncil.init();
}

export default {
  data: new SlashCommandBuilder()
    .setName("draw")
    .setDescription("Draw a card from the deck (this ends your turn)"),
  async execute(interaction: ChatInputCommandInteraction) {
    const result = Game.validateAction(interaction, { interruptible: true });
    if ("error" in result) {
      return replyEphemeral(interaction, result.error);
    }
    const { player } = result;

    const current = Game.currentPlayer();
    if (current && current !== player) {
      return replyEphemeral(
        interaction,
        `It's not your turn! Waiting on <@${current.id}> to draw. (If they're away, anyone can use /skip_turn.)`,
      );
    }

    const card = Game.deck.drawCard();
    if (card === undefined) {
      if (Game.getAlivePlayers().length > 2) {
        // Out of cards with no winner yet: every draw now means Tribal Council.
        return goToTribalCouncil(interaction, player, TribalCouncilType.SINGLE);
      }
      return interaction.reply("No cards left in the deck.");
    }

    // CHECK FOR TRIBAL COUNCIL
    if (card.getName() === CardName.TribalCouncil) {
      return goToTribalCouncil(
        interaction,
        player,
        card.tribalValue === 2 ? TribalCouncilType.DOUBLE : TribalCouncilType.SINGLE,
      );
    }

    // check for camp raid
    const raider = player.campRaid;
    if (raider) {
      let window;
      try {
        window = await runSorryForYouWindow(
          interaction,
          raider,
          player,
          (seconds) =>
            `<@${raider.id}> is attempting to steal <@${player.id}>'s draw... (<@${player.id}> has ~${seconds} seconds remaining to play "Sorry For You")`,
          // show player card
          () =>
            interaction.followUp({
              content: `You drew a ${card.getName()} (${card.getImage()}), and <@${raider.id}> is attempting to raid your camp and steal it`,
              flags: MessageFlags.Ephemeral,
            }),
        );
      } catch (error) {
        // Discord failed mid-draw: put the card back so it isn't lost
        Game.deck.addCard(card);
        throw error;
      }
      if (!window) {
        // Someone else's Sorry for You window is open; try again in a moment.
        Game.deck.addCard(card);
        return replyEphemeral(
          interaction,
          "This action cannot be played at this time. Wait a moment and try again.",
        );
      }

      player.campRaid = undefined;
      const next = Game.advanceTurn(player);
      const nextTurn = next ? ` It's <@${next.id}>'s turn.` : "";

      if (window.outcome === "stopped") {
        player.hand.push(card);
        await interaction.editReply({
          content: `Steal attempt was interrupted with ${window.secondsLeft} seconds remaining`,
        });
        await interaction.followUp({
          content: `You drew a ${card.getName()} (${card.getImage()}).`,
          flags: MessageFlags.Ephemeral,
        });
        return interaction.followUp({ content: `<@${player.id}> drew a card.${nextTurn}` });
      }

      // add card to camp raid hand
      raider.hand.push(card);
      await interaction.editReply({
        content: `<@${raider.id}> has stolen a card from <@${player.id}>!!!`,
      });
      await sendDM(
        interaction.client,
        raider.id,
        `You received **${card.getName()}** from <@${player.id}> from your camp raid!`,
      );
      return interaction.followUp({
        content: `<@${player.id}> drew a card, but it was stolen by <@${raider.id}>.${nextTurn}`,
      });
    }

    player.hand.push(card);
    const next = Game.advanceTurn(player);
    await interaction.reply({
      content: `You drew a ${card.getName()} (${card.getImage()}).`,
      flags: MessageFlags.Ephemeral,
    });
    return interaction.followUp({
      content: `<@${player.id}> drew a card.${next ? ` It's <@${next.id}>'s turn.` : ""}`,
    });
  },
};
