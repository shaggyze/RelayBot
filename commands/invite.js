// commands/invite.js
const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('invite')
        .setDescription('Get the invite link to add this bot to another server.'),
    async execute(interaction) {
        const permissions = new PermissionFlagsBits([
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ManageWebhooks,
            PermissionFlagsBits.ManageMessages,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.ManageRoles,
        ]);

        const inviteUrl = `https://discord.com/api/oauth2/authorize?client_id=${interaction.client.user.id}&permissions=${permissions.valueOf()}&scope=bot%20applications.commands`;

        const embed = new EmbedBuilder()
            .setTitle('Invite Me to Your Server!')
            .setColor('#0099ff')
            .setDescription('Click the button below to invite the bot. The required permissions are already configured in the link for all features to work correctly.')
            .addFields({
                name: 'Required Permissions',
                value: '• Manage Webhooks\n• Manage Messages\n• Manage Roles\n• Send Messages & Read History'
            });

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setLabel('Invite Bot').setStyle(ButtonStyle.Link).setURL(inviteUrl)
        );

        await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
    },
};