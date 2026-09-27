import { SlashCommandBuilder, ChatInputCommandInteraction } from "discord.js";
import { Game } from "../../game/game";
import { CardName } from "../../game/cards";
import { replyEphemeral } from "../../util/discord";

const REQUIRED_CARD = CardName.CampRaid;

export default {
  data: new SlashCommandBuilder()
    .setName("camp_raid")
    .setDescription("Raid another player's camp, steal their next draw")
    .addUserOption((option) =>
      option
        .setName("player")
        .setDescription("The player whose camp you want to raid")
        .setRequired(true),
    ),
  async execute(interaction: ChatInputCommandInteraction) {
    const result = Game.validateAction(interaction, {
      target: true,
      requiredCard: REQUIRED_CARD,
    });
    if ("error" in result) {
      return replyEphemeral(interaction, result.error);
    }
    const { player, targetPlayer } = result;
    if (!targetPlayer) {
      return replyEphemeral(interaction, "You must specify a player to raid.");
    }
    if (targetPlayer.campRaid) {
      return replyEphemeral(
        interaction,
        `<@${targetPlayer.id}>'s camp has already been raided by <@${targetPlayer.campRaid.id}>. Their next draw is spoken for.`,
      );
    }

    // Execute the raid. The steal happens (and can be blocked with Sorry for You)
    // when the target draws.
    player.removeCard(REQUIRED_CARD);
    targetPlayer.campRaid = player;

    return interaction.reply({
      content: `<@${player.id}> successfully raided <@${targetPlayer.id}>'s camp! Their next draw will be given to <@${player.id}>!!!`,
    });
  },
};
