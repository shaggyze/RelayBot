// events/interactionCreate.js
const { Events } = require('discord.js');

module.exports = {
	name: Events.InteractionCreate,
	async execute(interaction) {
		const client = interaction.client;
		
		if (!client.commands) return; // Commands collection must be loaded

		const command = client.commands.get(interaction.commandName);

		if (!command) {
			if (interaction.isChatInputCommand()) {
				// This should not happen if commands are deployed correctly
				console.error(`No command matching ${interaction.commandName} was found.`);
			}
			return;
		}

		if (interaction.isChatInputCommand()) {
			// This is your standard command logic
			try {
				await command.execute(interaction);
			} catch (error) {
				console.error(`Error executing ${interaction.commandName}`);
				console.error(error);
				if (interaction.deferred || interaction.replied) {
					await interaction.editReply({ content: 'There was an error while executing this command!', ephemeral: true }).catch(() => {});
				} else {
					await interaction.reply({ content: 'There was an error while executing this command!', ephemeral: true }).catch(() => {});
				}
			}
		} 
		// [THE FIX] ADD THE AUTOCOMPLETE HANDLER
		else if (interaction.isAutocomplete()) {
            // Find the command again since we are in a new interaction type
			const command = client.commands.get(interaction.commandName); 

            if (!command) {
                console.error(`No command matching ${interaction.commandName} was found during autocomplete.`);
                return;
            }

            try {
                // Check if the command has an autocomplete method defined
                if (command.autocomplete) {
                    await command.autocomplete(interaction);
                }
            } catch (error) {
                console.error(`Error during autocomplete for ${interaction.commandName}:`, error);
            }
        }
	},
};