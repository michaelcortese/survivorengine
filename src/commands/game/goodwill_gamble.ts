import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  MessageFlags,
} from "discord.js";
import { Game, TribalCouncilState } from "../../game/game";
import { CardName } from "../../game/cards";
import { replyEphemeral, sendDM } from "../../util/discord";

const REQUIRED_CARD = CardName.GoodwillGamble;

export default {
  data: new SlashCommandBuilder()
    .setName("goodwill_gamble")
    .setDescription("Play Tribal Advantage: Goodwill Gamble - Give an extra vote to another player at Tribal Council")
    .addUserOption((option) =>
      option
        .setName("player")
        .setDescription("The player to give the extra vote to")
        .setRequired(true),
    ),
  async execute(interaction: ChatInputCommandInteraction) {
    const result = Game.validateAction(interaction, {
      target: true,
      requiredCard: REQUIRED_CARD,
      tribalCouncil: [TribalCouncilState.Discussion, TribalCouncilState.Voting],
      phaseError: "Voting is over, so Goodwill Gamble can't be used now.",
    });
    if ("error" in result) {
      return replyEphemeral(interaction, result.error);
    }
    const { player, targetPlayer } = result;
    if (!targetPlayer) {
      return replyEphemeral(interaction, "Target player not found.");
    }

    // Increment the target player's votes
    player.removeCard(REQUIRED_CARD);
    targetPlayer.votes += 1;

    // Reply first: Discord only waits 3 seconds for it
    await interaction.reply({
      content: `You have given an extra vote to <@${targetPlayer.id}> using Tribal Advantage: Goodwill Gamble.`,
      flags: MessageFlags.Ephemeral,
    });
    await sendDM(
      interaction.client,
      targetPlayer.id,
      `You have received an extra vote from <@${player.id}> via Tribal Advantage: Goodwill Gamble! You now have ${targetPlayer.votes} vote(s) for this Tribal Council.`,
    );
  },
};
