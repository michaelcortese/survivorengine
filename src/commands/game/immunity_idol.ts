import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  MessageFlags,
} from "discord.js";
import { Game, TribalCouncilState } from "../../game/game";

const HAS_TARGET = true;
const REQUIRED_CARD = "Immunity Idol";
const INTERRUPTABLE = false;
const STOPPING_INTERACTION = true;
const CAN_PLAY_DURING_TRIBAL_COUNCIL = true;
const ONLY_DURING_TRIBAL_COUNCIL = true;

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
    // Check if we're in the immunity phase of tribal council
    if (Game.tribalCouncilState !== TribalCouncilState.Immunity) {
      return interaction.reply({
        content:
          "Immunity Idols can only be played after voting but before votes are tallied!",
        flags: MessageFlags.Ephemeral,
      });
    }

    const result = Game.checkForError(
      interaction,
      false, // We'll handle target manually since it's optional
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

    // Determine the target (self if no target specified)
    const targetUserId = interaction.options.getUser("target")?.id;
    let targetPlayer = player; // Default to self

    if (targetUserId) {
      const specifiedTarget = Game.getPlayerFromUserId(targetUserId);
      if (!specifiedTarget) {
        return interaction.reply({
          content: "The specified player is not in the game!",
          flags: MessageFlags.Ephemeral,
        });
      }
      if (!specifiedTarget.isAlive()) {
        return interaction.reply({
          content: "You cannot play an idol on an eliminated player!",
          flags: MessageFlags.Ephemeral,
        });
      }
      targetPlayer = specifiedTarget;
    }

    // Store the idol information in the game state for vote tallying
    if (!Game.tribalCouncil) {
      return interaction.reply({
        content: "No tribal council is currently active!",
        flags: MessageFlags.Ephemeral,
      });
    }

    // All validations passed, now remove the card
    player.removeCard(REQUIRED_CARD);

    // Add idol protection to the tribal council
    (Game.tribalCouncil as any).idolProtections.push({
      protectedPlayer: targetPlayer,
      playedBy: player,
    });

    // Check if we should end the idol period (could add logic here for max idols, etc.)
    // For now, let the timer continue to allow multiple idols

    const targetText =
      targetPlayer === player ? `<@${player.id}>` : `<@${targetPlayer.id}>`;

    await interaction.reply({
      content: `<@${player.id}> has played an **Immunity Idol** to protect ${targetText}! Any votes cast for ${targetText} will not count.`,
      flags: MessageFlags.Ephemeral,
    });
  },
};
