import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, Collection, Events, GatewayIntentBits } from 'discord.js';
import { token } from '../config.json';

// Create __dirname equivalent for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface CustomClient extends Client {
    commands: Collection<string, any>;
}

// Create a new client instance
const client = new Client({ intents: [GatewayIntentBits.Guilds] }) as CustomClient;

client.commands = new Collection();

async function loadCommands() {
    const foldersPath = path.join(__dirname, 'commands');
    const commandFolders = fs.readdirSync(foldersPath);

    for (const folder of commandFolders) {
        const commandsPath = path.join(foldersPath, folder);
        const commandFiles: string[] = fs.readdirSync(commandsPath).filter((file: string) => file.endsWith('.ts'));
        for (const file of commandFiles) {
            const filePath = path.join(commandsPath, file);
            try {
                const command = await import(filePath);
                // Handle ES6 default exports
                const commandModule = command.default || command;
                if ('data' in commandModule && 'execute' in commandModule) {
                    client.commands.set(commandModule.data.name, commandModule);
                    console.log(`✓ Loaded command: ${commandModule.data.name}`);
                } else {
                    console.log(`[WARNING] The command at ${filePath} is missing a required "data" or "execute" property.`);
                }
            } catch (error) {
                console.error(`Error loading command ${filePath}:`, error);
            }
        }
    }
}

async function loadEvents() {
    const eventsPath = path.join(__dirname, 'events');
    const eventFiles = fs.readdirSync(eventsPath).filter((file: string) => file.endsWith('.ts'));

    for (const file of eventFiles) {
        const filePath = path.join(eventsPath, file);
        try {
            const event = await import(filePath);
            // Handle ES6 default exports
            const eventModule = event.default || event;
            if (eventModule.once) {
                client.once(eventModule.name, (...args: any[]) => eventModule.execute(...args));
            } else {
                client.on(eventModule.name, (...args: any[]) => eventModule.execute(...args));
            }
            console.log(`✓ Loaded event: ${eventModule.name}`);
        } catch (error) {
            console.error(`Error loading event ${filePath}:`, error);
        }
    }
}

async function startBot() {
    try {
        await loadCommands();
        await loadEvents();
        
        // Log in to Discord with your client's token
        await client.login(token);
    } catch (error) {
        console.error('Error starting bot:', error);
    }
}

startBot();