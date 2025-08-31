import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
} from "discord.js";

// Import card data
import { cards } from "../../game/cardlist.json";

interface CardData {
  name: string;
  description?: string | null;
  compactDescription?: string | null;
  imageUrl?: string | null;
  quantity?: number;
  tribalValue?: number;
}

function findCard(query: string): CardData | null {
  const normalized = query.trim().toLowerCase();
  // Exact match first
  let card = (cards as CardData[]).find(
    (c) => c.name.toLowerCase() === normalized,
  );
  if (card) return card;
  // Starts with
  card = (cards as CardData[]).find((c) =>
    c.name.toLowerCase().startsWith(normalized),
  );
  if (card) return card;
  // Includes
  card = (cards as CardData[]).find((c) =>
    c.name.toLowerCase().includes(normalized),
  );
  return card || null;
}

export default {
  data: new SlashCommandBuilder()
    .setName("card_info")
    .setDescription("Get the description and image of a card by name")
    .addStringOption((opt) =>
      opt
        .setName("name")
        .setDescription("Full or partial card name (case insensitive)")
        .setRequired(true),
    ),
  async execute(interaction: ChatInputCommandInteraction) {
    const query = interaction.options.getString("name", true);

    const card = findCard(query);
    if (!card) {
      return interaction.reply({
        content: `No card found matching "${query}"`,
        flags: MessageFlags.Ephemeral,
      });
    }

    const embed = new EmbedBuilder()
      .setTitle(card.name)
      .setDescription(
        (card.description || card.compactDescription || "No description.").slice(
          0,
          4000,
        ),
      )
      .setColor(0x00_99_ff);

    if (card.imageUrl) embed.setImage(card.imageUrl);
    if (card.quantity !== undefined)
      embed.addFields({
        name: "Quantity in Deck",
        value: String(card.quantity),
        inline: true,
      });
    if (card.tribalValue !== undefined)
      embed.addFields({
        name: "Tribal Value",
        value: String(card.tribalValue),
        inline: true,
      });

    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  },
};
