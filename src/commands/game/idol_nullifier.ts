import { SlashCommandBuilder, ChatInputCommandInteraction } from "discord.js";
import { Game, TribalCouncilState } from "../../game/game";
import { CardName } from "../../game/cards";
import { replyEphemeral } from "../../util/discord";

const REQUIRED_CARD = CardName.IdolNullifier;

export default {
  data: new SlashCommandBuilder()
    .setName("idol_nullifier")
    .setDescription(
      "Play the Idol Nullifier card to cancel a specific player's immunity idol",
    )
    .addUserOption((option) =>
      option
        .setName("player")
        .setDescription(
          "The player who played the immunity idol you want to nullify (NOT the protected player)",
        )
        .setRequired(true),
    ),
  async execute(interaction: ChatInputCommandInteraction) {
    const result = Game.validateAction(interaction, {
      target: true,
      requiredCard: REQUIRED_CARD,
      tribalCouncil: [TribalCouncilState.Nullify],
      phaseError:
        "Idol Nullifiers can only be played after an immunity idol but before votes are tallied!",
    });
    if ("error" in result) {
      return replyEphemeral(interaction, result.error);
    }
    const { player, targetPlayer } = result;
    if (!targetPlayer) {
      return replyEphemeral(interaction, "You must specify which player's idol to nullify!");
    }

    const tribalCouncil = Game.tribalCouncil;
    if (!tribalCouncil) {
      return replyEphemeral(interaction, "No tribal council is currently active!");
    }

    // Find the idol played by the target player
    const targetIdol = tribalCouncil.idolProtections.find(
      (protection) => protection.playedBy === targetPlayer,
    );

    if (!targetIdol) {
      const playersWithIdols = tribalCouncil.idolProtections.map(
        (protection) => `<@${protection.playedBy.id}>`,
      );
      let errorMessage = `<@${targetPlayer.id}> has not played an immunity idol to nullify!`;
      if (playersWithIdols.length > 0) {
        errorMessage += ` Players who have played idols: ${playersWithIdols.join(", ")}`;
      } else {
        errorMessage += ` No players have played immunity idols yet.`;
      }
      return replyEphemeral(interaction, errorMessage);
    }

    // Check if this idol was already nullified
    const alreadyNullified = tribalCouncil.idolNullifications.some(
      (nullification) =>
        nullification.originalIdolPlayer === targetIdol.playedBy &&
        nullification.originalProtectedPlayer === targetIdol.protectedPlayer,
    );
    if (alreadyNullified) {
      return replyEphemeral(
        interaction,
        `<@${targetPlayer.id}>'s immunity idol has already been nullified!`,
      );
    }

    // All validations passed, now remove the card
    player.removeCard(REQUIRED_CARD);

    // Add the nullification
    tribalCouncil.idolNullifications.push({
      nullifiedBy: player,
      targetPlayer: targetPlayer,
      originalIdolPlayer: targetIdol.playedBy,
      originalProtectedPlayer: targetIdol.protectedPlayer,
    });

    const protectedText =
      targetIdol.protectedPlayer === targetIdol.playedBy
        ? "themselves"
        : `<@${targetIdol.protectedPlayer.id}>`;
    const votesFor =
      targetIdol.protectedPlayer === targetIdol.playedBy
        ? `<@${targetIdol.protectedPlayer.id}>`
        : protectedText;

    await interaction.reply({
      content: `<@${player.id}> has played an **Idol Nullifier** targeting <@${targetPlayer.id}>! <@${targetIdol.playedBy.id}>'s immunity idol that was protecting ${protectedText} has been canceled. Votes for ${votesFor} will now count.`,
    });
  },
};
