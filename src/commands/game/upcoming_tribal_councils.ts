import { SlashCommandBuilder, ChatInputCommandInteraction } from "discord.js";
import { Game } from "../../game/game";
import { replyEphemeral } from "../../util/discord";

export default {
  data: new SlashCommandBuilder()
    .setName("upcoming_tribal_councils")
    .setDescription("View the number of draws until the next tribal council"),
  async execute(interaction: ChatInputCommandInteraction) {
    const result = Game.validateAction(interaction, {
      tribalCouncil: "allowed",
      allowEliminated: true,
    });
    if ("error" in result) {
      return replyEphemeral(interaction, result.error);
    }

    const drawsUntilTribal = Game.deck.getDrawsUntilNextTribalCouncil();
    if (drawsUntilTribal.length === 0) {
      return replyEphemeral(
        interaction,
        "There are no more tribal council cards in the deck. Once the draw pile runs out, every draw sends the tribe to Tribal Council.",
      );
    }

    const draws = (count: number) => `**${count} draw${count === 1 ? "" : "s"}**`;
    return replyEphemeral(
      interaction,
      drawsUntilTribal
        .map((count, index) =>
          index === 0
            ? `Next tribal council is in ${draws(count)}`
            : `tribal council ${index + 1} is in ${draws(count)}`,
        )
        .join(",\n"),
    );
  },
};
