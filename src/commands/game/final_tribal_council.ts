import { SlashCommandBuilder, ChatInputCommandInteraction } from "discord.js";
import { Game, TribalCouncilState } from "../../game/game";
import { startFinalTribalCouncil } from "../../game/final_tribal_council";
import { createAnnouncer, replyEphemeral } from "../../util/discord";

export default {
  data: new SlashCommandBuilder()
    .setName("final_tribal_council")
    .setDescription("Start the Final Tribal Council (only when 2 players remain; normally starts on its own)"),
  async execute(interaction: ChatInputCommandInteraction) {
    const council = Game.finalTribalCouncil;
    if (council) {
      return replyEphemeral(
        interaction,
        `Final Tribal Council is underway. Votes cast: ${council.votes.size}/${council.jury.length}.`,
      );
    }
    if (!Game.active) {
      return replyEphemeral(interaction, "No game is currently in progress!");
    }
    if (Game.tribalCouncilState === TribalCouncilState.FINAL) {
      return replyEphemeral(interaction, "The Final Tribal Council is starting now.");
    }
    if (Game.tribalCouncil) {
      return replyEphemeral(interaction, "Wait for the current Tribal Council to finish.");
    }
    if (Game.getAlivePlayers().length !== 2) {
      return replyEphemeral(
        interaction,
        "Final Tribal Council can only be started when exactly 2 players remain.",
      );
    }

    await interaction.reply({ content: "STOP PLAYING! The Final Tribal Council is starting..." });
    const started = await startFinalTribalCouncil(createAnnouncer(interaction));
    if (typeof started === "string") {
      await replyEphemeral(interaction, started);
    }
  },
};
