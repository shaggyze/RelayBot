// utils/voteEmbed.js
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

// This function creates and returns the message payload for voting/support.
function createVoteMessage() {
    const voteEmbed = new EmbedBuilder()
        .setColor('#5865F2')
        .setTitle('Enjoying RelayBot?')
        .setDescription('Your support helps the bot grow and stay active. Please consider voting for us on Top.gg once every 24 hr or becoming a patron on the developer\'s Patreon to remove this message.')
        .setTimestamp();

    const actionRow = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setLabel('Vote on Top.gg')
                .setStyle(ButtonStyle.Link)
                .setURL('https://top.gg/bot/1397069734469435446/vote'),
            new ButtonBuilder()
                .setLabel('Support on Patreon')
                .setStyle(ButtonStyle.Link)
                .setURL('https://patreon.com/shaggyze')
        );

    // We return it in the format that Discord's API expects.
    return {
        embeds: [voteEmbed],
        components: [actionRow]
    };
}

module.exports = { createVoteMessage };