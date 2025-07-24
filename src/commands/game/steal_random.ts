import { SlashCommandBuilder, ChatInputCommandInteraction, MessageFlags } from 'discord.js';
import Game from '../../game/game';

const HAS_TARGET = true;
const REQUIRED_CARD = null;
const INTERRUPTABLE = true;

export default {
    data: new SlashCommandBuilder()
        .setName('steal_random')
        .setDescription('Steal a random card from another player')
        .addUserOption(option =>
            option.setName('player')
                .setDescription('The player whose card you want to steal')
                .setRequired(true)),
    async execute(interaction: ChatInputCommandInteraction) {

        const result = Game.checkForError(interaction, HAS_TARGET, REQUIRED_CARD, INTERRUPTABLE, false);
        if ('error' in result) {
            return interaction.reply({ content: result.error.content, flags: MessageFlags.Ephemeral });
        }
        const { player, targetPlayer } = result;
        if (!targetPlayer) {
            return interaction.reply({ content: 'You must specify a player to steal from.', flags: MessageFlags.Ephemeral });
        }
        if (targetPlayer.hand.length === 0) {
            return interaction.reply({ content: `${targetPlayer.username} has no cards to steal!`, flags: MessageFlags.Ephemeral });
        }

        // Respond immediately to Discord (public message)
        let msg = await interaction.reply({ 
            content: `Attempting to steal from <@${targetPlayer.id}>... (They have ~15 seconds remaining to play "Sorry For You")`
        });

        Game.startCooldown(player, targetPlayer);

        // Wait for interruption or timeout
        const startTime = Date.now();
        const countdownDuration = 15000; // 15 seconds in milliseconds
        let lastDisplayedSecond = 15;
        
        while (Game.interruption.active) {
            if (Game.interruption.stopped) {
                await interaction.editReply({ content: `Steal attempt was interrupted with ${lastDisplayedSecond} seconds remaining` });
                return interaction.followUp({ content: 'Your steal attempt was interrupted!', flags: MessageFlags.Ephemeral });
            }
            
            const elapsed = Date.now() - startTime;
            const remaining = Math.max(0, Math.ceil((countdownDuration - elapsed) / 1000));
            
            // Only update the message when the second actually changes
            if (remaining !== lastDisplayedSecond) {
                lastDisplayedSecond = remaining;
                await interaction.editReply({ content: `Attempting to steal from <@${targetPlayer.id}>... (They have ~${remaining} seconds remaining to play "Sorry For You")` });
            }
            
            await new Promise(resolve => setTimeout(resolve, 100)); // Check more frequently but update less
        }

        await interaction.editReply({ content: `<@${player.id}> has stolen a card from <@${targetPlayer.id}>!!!`});

        // Execute the steal
        const randomIndex = Math.floor(Math.random() * targetPlayer.hand.length);
        const cardToSteal = targetPlayer.hand[randomIndex];
        
        // Remove the card at the specific index
        targetPlayer.hand.splice(randomIndex, 1);
        player.hand.push(cardToSteal);
        
        await interaction.followUp({ content: `You successfully stole a ${cardToSteal.getName()} from ${targetPlayer.username}!`, flags: MessageFlags.Ephemeral });
    }
};