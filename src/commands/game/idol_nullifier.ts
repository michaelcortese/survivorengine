import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  MessageFlags,
} from "discord.js";
import { Game, TribalCouncilState } from "../../game/game";

const HAS_TARGET = true;
const REQUIRED_CARD = "Idol Nullifier";
const INTERRUPTABLE = false;
const STOPPING_INTERACTION = true;
const CAN_PLAY_DURING_TRIBAL_COUNCIL = true;
const ONLY_DURING_TRIBAL_COUNCIL = true;

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
    // Check if we're in the nullify phase of tribal council
    if (Game.tribalCouncilState !== TribalCouncilState.Nullify) {
      return interaction.reply({
        content:
          "Idol Nullifiers can only be played after an immunity idol but before votes are tallied!",
        flags: MessageFlags.Ephemeral,
      });
    }

    const result = Game.checkForError(
      interaction,
      false, // We'll handle target manually
      null, // Don't check for card yet, we'll do it after target validation
      INTERRUPTABLE,
      STOPPING_INTERACTION,
      CAN_PLAY_DURING_TRIBAL_COUNCIL,
      ONLY_DURING_TRIBAL_COUNCIL,
    );

    if ("error" in result) {
      return interaction.reply({
        content: result.error.content,
        flags: MessageFlags.Ephemeral,
      });
    }

    const { player } = result;

    // Check if player has the required card before validating target
    if (!player.hasCard(REQUIRED_CARD)) {
      return interaction.reply({
        content: `You must have the ${REQUIRED_CARD} card to play this action!`,
        flags: MessageFlags.Ephemeral,
      });
    }

    // Get the target player manually
    const targetUserId = interaction.options.getUser("player")?.id;
    if (!targetUserId) {
      return interaction.reply({
        content: "You must specify which player's idol to nullify!",
        flags: MessageFlags.Ephemeral,
      });
    }

    const targetPlayer = Game.getPlayerFromUserId(targetUserId);
    if (!targetPlayer) {
      return interaction.reply({
        content: "The specified player is not in the game!",
        flags: MessageFlags.Ephemeral,
      });
    }

    // Check if there's an active tribal council and idol protection
    if (!Game.tribalCouncil) {
      return interaction.reply({
        content: "No tribal council is currently active!",
        flags: MessageFlags.Ephemeral,
      });
    }

    const tribalCouncil = Game.tribalCouncil as any;

    // Find the idol played by the target player
    const targetIdol = tribalCouncil.idolProtections.find(
      (protection: any) => protection.playedBy === targetPlayer,
    );

    if (!targetIdol) {
      const playersWithIdols = tribalCouncil.idolProtections.map(
        (protection: any) => `<@${protection.playedBy.id}>`,
      );

      let errorMessage = `<@${targetPlayer.id}> has not played an immunity idol to nullify!`;

      if (playersWithIdols.length > 0) {
        errorMessage += ` Players who have played idols: ${playersWithIdols.join(", ")}`;
      } else {
        errorMessage += ` No players have played immunity idols yet.`;
      }

      return interaction.reply({
        content: errorMessage,
        flags: MessageFlags.Ephemeral,
      });
    }

    // Check if this idol was already nullified
    const alreadyNullified = tribalCouncil.idolNullifications.some(
      (nullification: any) =>
        nullification.originalIdolPlayer === targetIdol.playedBy &&
        nullification.originalProtectedPlayer === targetIdol.protectedPlayer,
    );

    if (alreadyNullified) {
      return interaction.reply({
        content: `<@${targetPlayer.id}>'s immunity idol has already been nullified!`,
        flags: MessageFlags.Ephemeral,
      });
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

    await interaction.reply({
      content: `<@${player.id}> has played an **Idol Nullifier** targeting <@${targetPlayer.id}>! <@${targetIdol.playedBy.id}>'s immunity idol that was protecting ${protectedText} has been canceled. Votes for ${protectedText} will now count.`,
      ephemeral: false,
    });
  },
};
