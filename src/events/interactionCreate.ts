import {
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  Collection,
  Events,
  Interaction,
  MessageFlags,
} from 'discord.js';

interface Command {
  data: any;
  execute: (interaction: ChatInputCommandInteraction) => Promise<unknown>;
  autocomplete?: (interaction: AutocompleteInteraction) => Promise<void>;
}

declare module 'discord.js' {
  interface Client {
    commands: Collection<string, Command>;
  }
}

export default {
  name: Events.InteractionCreate,
  async execute(interaction: Interaction) {
    if (interaction.isAutocomplete()) {
      const command = interaction.client.commands.get(interaction.commandName);
      try {
        await command?.autocomplete?.(interaction);
      } catch (error) {
        console.error(`Autocomplete for ${interaction.commandName} failed:`, error);
      }
      return;
    }

    // Buttons, menus and modals are handled by collectors in the commands
    if (!interaction.isChatInputCommand()) return;

    const command = interaction.client.commands.get(interaction.commandName);

    if (!command) {
      console.error(`No command matching ${interaction.commandName} was found.`);
      return;
    }

    try {
      await command.execute(interaction);
    }
    catch (error) {
      console.error(error);
      const payload = {
        content: 'There was an error while executing this command!',
        flags: MessageFlags.Ephemeral,
      } as const;
      try {
        if (interaction.replied || interaction.deferred) {
          await interaction.followUp(payload);
        }
        else {
          await interaction.reply(payload);
        }
      }
      catch (replyError) {
        console.error('Could not tell the user about the error:', replyError);
      }
    }
  },
};
