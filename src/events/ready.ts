import { Events, Client } from 'discord.js';
import { resumeSavedGame } from '../game/persistence';

export default {
    name: Events.ClientReady,
    once: true,
    async execute(client: Client) {
        console.log(`Ready! Logged in as ${client.user?.tag}`);
        // Pick up the game that was running when the bot last stopped.
        await resumeSavedGame(client);
    },
};
