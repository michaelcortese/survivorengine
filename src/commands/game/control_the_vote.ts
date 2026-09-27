import { SlashCommandBuilder, ChatInputCommandInteraction } from "discord.js";
import { Game, TribalCouncilState } from "../../game/game";
import { CardName } from "../../game/cards";
import { replyEphemeral } from "../../util/discord";

const REQUIRED_CARD = CardName.ControlTheVote;

export default {
  data: new SlashCommandBuilder()
    .setName("control_the_vote")
    .setDescription("Play Tribal Advantage: Control the Vote - Steal another player's vote at Tribal Council")
    .addUserOption((option) =>
      option
        .setName("player")
        .setDescription("The player whose vote to steal")
        .setRequired(true),
    ),
  async execute(interaction: ChatInputCommandInteraction) {
    const result = Game.validateAction(interaction, {
      target: true,
      requiredCard: REQUIRED_CARD,
      tribalCouncil: [TribalCouncilState.Discussion, TribalCouncilState.Voting],
      phaseError: "Voting is over, so Control the Vote can't be used now.",
    });
    if ("error" in result) {
      return replyEphemeral(interaction, result.error);
    }
    const { player, targetPlayer } = result;
    if (!targetPlayer) {
      return replyEphemeral(interaction, "Target player not found.");
    }

    // Check if target has votes to steal (before the card is used up)
    if (targetPlayer.votes === 0) {
      return replyEphemeral(interaction, `<@${targetPlayer.id}> has no votes to steal.`);
    }

    // Steal the vote: decrement target's votes, increment player's votes
    player.removeCard(REQUIRED_CARD);
    targetPlayer.votes -= 1;
    player.votes += 1;

    // Announce the vote steal publicly
    await interaction.reply({
      content: `<@${player.id}> has stolen a vote from <@${targetPlayer.id}> using Tribal Advantage: Control the Vote! https://i.imgur.com/jNlZ87z.jpeg`,
    });
  },
};
