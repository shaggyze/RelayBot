// commands/version.js
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { version } = require('../package.json');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('version')
        .setDescription('Displays the current version of the bot.'),
    async execute(interaction) {
        const versionEmbed = new EmbedBuilder()
            .setColor('#5865F2')
            .setTitle('RelayBot')
            .setDescription(`You are running version **v${version}**.`)
            .addFields(
                { name: 'Latest Changes', value: '• Added `/relay help` command.\n• Added auto messages edits, deletes, and role pings between channels on one or more  servers.\n• Added auto-creation of missing roles.\n• Public release with database support.' },
                { name: 'Source Code / Support', value: '[View on GitHub](https://github.com/shaggyze/RelayBot)' }
            )
            .setFooter({ text: 'Created by YuRaNnNzZZ and ShaggyZE' });

        await interaction.reply({ embeds: [versionEmbed], ephemeral: true });
    },
};