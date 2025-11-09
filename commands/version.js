// commands/version.js
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { version } = require('../package.json');
const { isSupporter, getSupporterSet } = require('../utils/supporterManager.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('version')
        .setDescription('Shows the bot\'s current version and information.'),
    async execute(interaction) {
        const supporterCount = getSupporterSet().size;
        const versionEmbed = new EmbedBuilder()
            .setTitle(`RelayBot v${version}`)
            .setColor('#5865F2')
            .setDescription('A powerful and easy-to-use bot for relaying messages between Discord servers.')
            .addFields(
                { name: 'Active Supporters', value: `${supporterCount}`, inline: true },
                { name: 'RelayBot', value: '[Official Website](https://shaggyze.website/RelayBot)', inline: true },
                { name: 'GitHub', value: '[shaggyze/RelayBot](https://github.com/shaggyze/RelayBot)', inline: true },
                { name: 'Support Server', value: '[Join Here](https://discord.gg/tbDeymDm2B)', inline: true },
                // --- [NEW FEATURE] List of new features ---
                { name: 'What\'s New in This Version', value: '• **Group Moderation:** Group owners can now block/unblock users or entire servers from their relays using `/relay block` and `/relay unblock`.\n• **Channel Branding:** Customize the server name displayed in relayed messages with `/relay set_brand`.\n• **Public Stats:** View statistics for your group with `/stats`.\n• **Auto-Role Syncing:** Opt-in to automatically create and link mapped roles when joining a group with `/relay toggle_auto_role or /relay link_chanel for pre-existing channels`.' }
			)
            .setFooter({ text: 'Thank you for using RelayBot!' });

        await interaction.reply({ embeds: [versionEmbed], ephemeral: true });
    },
};