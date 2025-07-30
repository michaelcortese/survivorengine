// TODO add draw TRIBAL
import { TribalCouncil, TribalCouncilType } from "../../game/tribal_council";
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  MessageFlags,
} from "discord.js";
import { Game, TribalCouncilState } from "../../game/game";
const HAS_TARGET = false;
const REQUIRED_CARD = null;
const INTERUPTABLE = false;
const STOPPING_INTERACTION = false;

export default {
  data: new SlashCommandBuilder()
    .setName("draw")
    .setDescription("Draw a card from the deck"),
  async execute(interaction: ChatInputCommandInteraction) {
    const result = Game.checkForError(
      interaction,
      HAS_TARGET,
      REQUIRED_CARD,
      INTERUPTABLE,
      STOPPING_INTERACTION,
    );
    if ("error" in result) {
      return interaction.reply({
        content: result.error.content,
        flags: MessageFlags.Ephemeral,
      });
    }
    const { player } = result;
    const card = Game.deck.drawCard();
    if (card === undefined) {
      return interaction.reply("No cards left in the deck.");
    }
    // CHECK FOR TRIBAL COUNCIL
    if (card.getName() === "Tribal Council") {
      // Card drawn was tribal council, tell game
      Game.tribalCouncilState = TribalCouncilState.Discussion;
      // TODO add enum property for card
      Game.setTribalCouncil(
        new TribalCouncil(interaction, TribalCouncilType.SINGLE),
      );
      await Game.tribalCouncil?.init();
      return;
    }
    player.hand.push(card);
    await interaction.reply({
      content: `You drew a ${card.getName()} (${card.getImage()}).`,
      flags: MessageFlags.Ephemeral,
    });
    return await interaction.followUp({
      content: `<@${player.id}> drew a card.`,
      flags: undefined,
    });
  },
};
