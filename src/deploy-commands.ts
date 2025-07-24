import { REST, Routes } from 'discord.js';
import { clientId, guildId, token } from '../config.json';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

console.log('Script started...');

// Create __dirname equivalent for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('__dirname:', __dirname);

const commands: any[] = [];

async function loadCommands() {
    console.log('loadCommands function called');
    // Grab all the command folders from the commands directory you created earlier
    const foldersPath = path.join(__dirname, 'commands');
    console.log(`Looking for commands in: ${foldersPath}`);
    
    if (!fs.existsSync(foldersPath)) {
        console.error(`Commands directory does not exist: ${foldersPath}`);
        return;
    }
    
    const commandFolders = fs.readdirSync(foldersPath);
    console.log(`Found command folders: ${commandFolders.join(', ')}`);

    for (const folder of commandFolders) {
        // Grab all the command files from the commands directory you created earlier
        const commandsPath = path.join(foldersPath, folder);
        console.log(`Looking in folder: ${commandsPath}`);
        
        if (!fs.existsSync(commandsPath)) {
            console.error(`Folder does not exist: ${commandsPath}`);
            continue;
        }
        
        const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.ts'));
        console.log(`Found ${commandFiles.length} .ts files in ${folder}: ${commandFiles.join(', ')}`);
        
        // Grab the SlashCommandBuilder#toJSON() output of each command's data for deployment
        for (const file of commandFiles) {
            const filePath = path.join(commandsPath, file);
            console.log(`Loading command from: ${filePath}`);
            try {
                const command = await import(filePath);
                // Handle ES6 default exports
                const commandModule = command.default || command;
                if ('data' in commandModule && 'execute' in commandModule) {
                    commands.push(commandModule.data.toJSON());
                    console.log(`✓ Loaded command: ${commandModule.data.name}`);
                }
                else {
                    console.log(`[WARNING] The command at ${filePath} is missing a required "data" or "execute" property.`);
                }
            } catch (error) {
                console.error(`Error loading command ${filePath}:`, error);
            }
        }
    }
    console.log('loadCommands function completed');
}

console.log('About to create REST client...');

// Construct and prepare an instance of the REST module
const rest = new REST().setToken(token);

console.log('REST client created, starting deployment...');

// and deploy your commands!
(async () => {
    try {
        console.log('Starting command deployment...');
        await loadCommands();
        
        console.log(`Started refreshing ${commands.length} application (/) commands.`);

        if (commands.length === 0) {
            console.log('No commands found to deploy!');
            return;
        }

        // The put method is used to fully refresh all commands in the guild with the current set
        const data = await rest.put(
            Routes.applicationGuildCommands(clientId, guildId),
            { body: commands },
        ) as any[];

        console.log(`Successfully reloaded ${data.length} application (/) commands.`);
    } catch (error) {
        // And of course, make sure you catch and log any errors!
        console.error('Error in deployment:', error);
    }
})();

console.log('Script setup completed');