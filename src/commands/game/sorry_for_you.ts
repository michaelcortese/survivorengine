import { SlashCommandBuilder, ChatInputCommandInteraction } from "discord.js";
import { Game } from "../../game/game";
import { CardName } from "../../game/cards";
import { forceDiscard } from "../../game/forced_discard";
import { replyEphemeral } from "../../util/discord";

const REQUIRED_CARD = CardName.SorryForYou;

export default {
  data: new SlashCommandBuilder()
    .setName("sorry_for_you")
    .setDescription("Play the Sorry For You card, stopping an interaction"),
  async execute(interaction: ChatInputCommandInteraction) {
    const result = Game.validateAction(interaction, {
      requiredCard: REQUIRED_CARD,
      // Knowledge is Power can be played at Tribal Council, so this can be too
      tribalCouncil: "allowed",
    });
    if ("error" in result) {
      return replyEphemeral(interaction, result.error);
    }
    const defender = result.player; // player who plays Sorry For You

    const interruption = Game.interruption;
    if (!interruption) {
      return replyEphemeral(interaction, "There is no interaction to stop!");
    }
    // Ensure only the targeted player (victim) can play Sorry For You
    if (interruption.target !== defender) {
      return replyEphemeral(
        interaction,
        `Only the targeted player (<@${interruption.target.id}>) can play Sorry For You right now!`,
      );
    }
    if (interruption.attacker === defender) {
      return replyEphemeral(interaction, "You cannot play Sorry For You on your own action!");
    }

    defender.removeCard(REQUIRED_CARD);
    // Signal to the ongoing action that it was stopped
    const attacker = Game.blockInterruption();
    if (!attacker) {
      return replyEphemeral(interaction, "There is no interaction to stop!");
    }

    await interaction.reply({
      content: `<@${defender.id}> played **Sorry For You** and stopped <@${attacker.id}>'s action! <@${attacker.id}> must discard 1 card.`,
    });

    await forceDiscard(attacker, (payload) => interaction.followUp(payload));
  },
};
