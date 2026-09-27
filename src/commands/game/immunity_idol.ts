import { SlashCommandBuilder, ChatInputCommandInteraction } from "discord.js";
import { Game, TribalCouncilState } from "../../game/game";
import { CardName } from "../../game/cards";
import { replyEphemeral } from "../../util/discord";

const REQUIRED_CARD = CardName.ImmunityIdol;

export default {
  data: new SlashCommandBuilder()
    .setName("immunity_idol")
    .setDescription(
      "Play the Immunity Idol card to protect yourself or another player",
    )
    .addUserOption((option) =>
      option
        .setName("player")
        .setDescription(
          "The player to protect (leave blank to protect yourself)",
        )
        .setRequired(false),
    ),
  async execute(interaction: ChatInputCommandInteraction) {
    const result = Game.validateAction(interaction, {
      target: "optional",
      allowSelfTarget: true,
      requiredCard: REQUIRED_CARD,
      tribalCouncil: [TribalCouncilState.Immunity],
      phaseError:
        "Immunity Idols can only be played after voting but before votes are tallied!",
    });
    if ("error" in result) {
      return replyEphemeral(interaction, result.error);
    }
    const { player } = result;
    // Default to self
    const targetPlayer = result.targetPlayer ?? player;

    const tribalCouncil = Game.tribalCouncil;
    if (!tribalCouncil) {
      return replyEphemeral(interaction, "No tribal council is currently active!");
    }

    // All validations passed, now remove the card
    player.removeCard(REQUIRED_CARD);

    // Add idol protection to the tribal council; multiple idols may be played
    tribalCouncil.idolProtections.push({
      protectedPlayer: targetPlayer,
      playedBy: player,
    });

    const targetText = `<@${targetPlayer.id}>`;
    await interaction.reply({
      content: `<@${player.id}> has played an **Immunity Idol** to protect ${targetText}! Any votes cast for ${targetText} will not count.`,
    });
  },
};
