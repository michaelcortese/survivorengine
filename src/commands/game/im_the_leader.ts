import { SlashCommandBuilder, ChatInputCommandInteraction } from "discord.js";
import { Game, TribalCouncilState } from "../../game/game";
import { CardName } from "../../game/cards";
import { replyEphemeral } from "../../util/discord";

const REQUIRED_CARD = CardName.ImTheLeaderNow;

export default {
  data: new SlashCommandBuilder()
    .setName("im_the_leader")
    .setDescription(
      "TRIBAL COUNCIL ONLY: make yourself the leader of the current tribal council.",
    ),
  async execute(interaction: ChatInputCommandInteraction) {
    const result = Game.validateAction(interaction, {
      requiredCard: REQUIRED_CARD,
      tribalCouncil: [
        TribalCouncilState.Discussion,
        TribalCouncilState.Voting,
        TribalCouncilState.Immunity,
        TribalCouncilState.Nullify,
      ],
      phaseError: "The votes are being read, so it's too late to take over as leader.",
    });
    if ("error" in result) {
      return replyEphemeral(interaction, result.error);
    }
    const { player } = result;

    const tribalCouncil = Game.tribalCouncil;
    if (!tribalCouncil) {
      return replyEphemeral(interaction, "Unable to play card. Tribal Council has not started.");
    }
    if (tribalCouncil.leader === player) {
      return replyEphemeral(interaction, "You are already the leader of the tribal council.");
    }

    player.removeCard(REQUIRED_CARD);
    tribalCouncil.leader = player;
    // The new leader also takes the next turn once the council ends
    tribalCouncil.leaderChangedByCard = true;
    return interaction.reply({
      content: `<@${player.id}> has played **Tribal Advantage: I'm the Leader Now**, and is the NEW leader of the tribal council. It will be their turn when Tribal Council ends. https://i.imgur.com/jBGDVDm.jpeg`,
    });
  },
};
