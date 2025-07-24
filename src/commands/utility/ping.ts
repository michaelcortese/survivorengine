import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';

export default {
    data: new SlashCommandBuilder()
        .setName('ping')
        .setDescription('Replies with Pong!'),
    async execute(interaction: ChatInputCommandInteraction) {
        const ping = interaction.client.ws.ping;
        await interaction.reply(`Pong! Latency: ${ping}ms`);
    },
};