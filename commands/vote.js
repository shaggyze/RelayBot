// commands/vote.js
const { SlashCommandBuilder } = require('discord.js');
const { createVoteMessage } = require('../utils/voteEmbed.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('vote')
        .setDescription('Get links to vote for the bot and support the developer.'),
    async execute(interaction) {
        // Get the pre-built message payload from our utility file.
        const votePayload = createVoteMessage();

        // Add the 'ephemeral' flag so the reply is only visible to the user who ran the command.
        votePayload.ephemeral = true;

        await interaction.reply(votePayload);
    },
};