import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';
import Game from '../../game/game';

export default {
    data: new SlashCommandBuilder()
        .setName('draw')
        .setDescription('Draw a card from the deck'),
    async execute(interaction: ChatInputCommandInteraction) {
        await interaction.deferReply();

        const player = Game.getPlayerFromUserId(interaction.user.id);
        if (!player) {
            await interaction.editReply('You are not in a game.');
            return;
        }

        const card = Game.deck.drawCard();
        if (card === undefined) {
            await interaction.editReply('No cards left in the deck.');
        } else {
            player.hand.push(card);
            await interaction.editReply(`You drew a ${card}.`);
        }
    },
};