import {
  AutocompleteInteraction,
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  MessageFlags,
} from "discord.js";
import { Game } from "../../game/game";
import {
  ACTION_CARD_NAMES,
  CardName,
  inheritanceCardName,
} from "../../game/cards";
import { replyEphemeral, runSorryForYouWindow, sendDM } from "../../util/discord";

const REQUIRED_CARD = CardName.KnowledgeIsPower;

/** Every card name a player could be holding. */
function knownCardNames(): string[] {
  return [
    ...ACTION_CARD_NAMES,
    ...Game.players.map((player) => inheritanceCardName(player.username)),
  ];
}

export default {
  data: new SlashCommandBuilder()
    .setName("knowledge_is_power")
    .setDescription("Play Knowledge is Power - Ask another player for a specific card")
    .addUserOption((option) =>
      option
        .setName("player")
        .setDescription("The player to ask for the card")
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("card_name")
        .setDescription("The name of the card to ask for")
        .setRequired(true)
        .setAutocomplete(true),
    ),

  async autocomplete(interaction: AutocompleteInteraction) {
    const typed = interaction.options.getFocused().toLowerCase();
    const matches = knownCardNames()
      .filter((name) => name.toLowerCase().includes(typed))
      .slice(0, 25);
    await interaction.respond(matches.map((name) => ({ name, value: name })));
  },

  async execute(interaction: ChatInputCommandInteraction) {
    const result = Game.validateAction(interaction, {
      target: true,
      requiredCard: REQUIRED_CARD,
      interruptible: true,
      tribalCouncil: "allowed", // Can be played anytime
    });
    if ("error" in result) {
      return replyEphemeral(interaction, result.error);
    }
    const { player, targetPlayer } = result;
    if (!targetPlayer) {
      return replyEphemeral(interaction, "Target player not found.");
    }

    const typedName = interaction.options.getString("card_name", true).trim();
    const cardName = knownCardNames().find(
      (name) => name.toLowerCase() === typedName.toLowerCase(),
    );
    if (!cardName) {
      // Not a real card, so don't waste their Knowledge is Power
      return replyEphemeral(
        interaction,
        `There's no card called "${typedName}". Pick one of the suggestions as you type.`,
      );
    }

    // Asking is public, and the card is used up whatever the answer
    if (!targetPlayer.hasCard(cardName)) {
      player.removeCard(REQUIRED_CARD);
      return interaction.reply({
        content: `<@${player.id}> used **Knowledge is Power** to ask <@${targetPlayer.id}> for "${cardName}"... but they don't have it.`,
      });
    }

    // Taking a card can be blocked with Sorry for You
    const played = player.removeCard(REQUIRED_CARD)!;
    const window = await runSorryForYouWindow(
      interaction,
      player,
      targetPlayer,
      (seconds) =>
        `<@${player.id}> used **Knowledge is Power** to ask <@${targetPlayer.id}> for "${cardName}"! (They have ~${seconds} seconds remaining to play "Sorry For You")`,
    );
    if (!window) {
      player.hand.push(played);
      return replyEphemeral(
        interaction,
        "This action cannot be played at this time. Wait a moment and try again.",
      );
    }

    if (window.outcome === "stopped") {
      return interaction.editReply({
        content: `<@${player.id}> asked <@${targetPlayer.id}> for "${cardName}", but it was blocked with ${window.secondsLeft} seconds remaining!`,
      });
    }

    const card = targetPlayer.removeCard(cardName);
    if (!card) {
      return interaction.editReply({
        content: `<@${player.id}> asked <@${targetPlayer.id}> for "${cardName}", but it was already gone.`,
      });
    }
    player.hand.push(card);
    await interaction.editReply({
      content: `<@${player.id}> asked <@${targetPlayer.id}> for "${cardName}" and received it!`,
    });
    await sendDM(
      interaction.client,
      targetPlayer.id,
      `You had to give **${cardName}** to <@${player.id}> (Knowledge is Power).`,
    );
    await interaction.followUp({
      content: `You received **${cardName}** from <@${targetPlayer.id}>.`,
      flags: MessageFlags.Ephemeral,
    });
  },
};
