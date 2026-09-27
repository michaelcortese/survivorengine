import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  MessageFlags,
} from "discord.js";
import { Game, TribalCouncilState } from "../../game/game";
import { CardName } from "../../game/cards";
import { replyEphemeral } from "../../util/discord";

const REQUIRED_CARD = CardName.ExtraVote;

export default {
  data: new SlashCommandBuilder()
    .setName("extra_vote")
    .setDescription(
      "Play the Extra Vote card, giving you and extra vote in the upcoming Tribal Council.",
    ),
  async execute(interaction: ChatInputCommandInteraction) {
    const result = Game.validateAction(interaction, {
      requiredCard: REQUIRED_CARD,
      tribalCouncil: [TribalCouncilState.Discussion, TribalCouncilState.Voting],
      phaseError: "Voting is over, so an Extra Vote can't be used now.",
    });
    if ("error" in result) {
      return replyEphemeral(interaction, result.error);
    }
    const { player } = result;
    player.removeCard(REQUIRED_CARD);
    player.votes++;
    await interaction.reply({
      content: `You played an **Extra Vote** and gave yourself an extra vote in the upcoming Tribal Council! You currently have ${player.votes} votes.`,
      flags: MessageFlags.Ephemeral,
    });
  },
};
