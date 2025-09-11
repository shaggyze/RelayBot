// events/interactionCreate.js
const { Events } = require('discord.js');

module.exports = {
	name: Events.InteractionCreate,
	async execute(interaction) {
		if (!interaction.isChatInputCommand()) return;

		const command = interaction.client.commands.get(interaction.commandName);

		if (!command) {
			console.error(`No command matching ${interaction.commandName} was found.`);
			return;
		}

		try {
			await command.execute(interaction);
		} catch (error) {
            // [THE DEFINITIVE FIX] This is the global error handler for all commands.
            if (error.code === 10062) {
                // 10062: Unknown Interaction. This means the 3-second window was missed.
                console.warn(`[WARN] An interaction for command "${interaction.commandName}" timed out and could not be replied to. The bot may have been slow to respond (e.g., during startup).`);
                
                // We can't reply, but we can try a followUp as a last resort. This may also fail, so we catch it.
                await interaction.followUp({ content: 'This command took too long to respond. Please try again in a moment.', ephemeral: true }).catch(() => {});
                
                // We stop here to prevent a crash.
                return;
            }

            // For all other errors, log them as usual.
			console.error(`Error executing ${interaction.commandName}`, error);

            // Try to inform the user that something went wrong.
            // This might fail if the interaction is already dead, so we add catches.
            if (interaction.replied || interaction.deferred) {
                await interaction.followUp({ content: 'There was an error while executing this command!', ephemeral: true }).catch(() => {});
			} else {
                await interaction.reply({ content: 'There was an error while executing this command!', ephemeral: true }).catch(() => {});
			}
		}
	},
};