// commands/invite.js
const {
    SlashCommandBuilder,
    PermissionsBitField,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle
} = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('invite')
        .setDescription('Get the invite link to add this bot to another server.'),
    async execute(interaction) {
        // This is the corrected way to define permissions
        const permissions = new PermissionsBitField([
            PermissionsBitField.Flags.ViewChannel,
            PermissionsBitField.Flags.SendMessages,
            PermissionsBitField.Flags.ManageWebhooks,
            PermissionsBitField.Flags.ManageMessages,
            PermissionsBitField.Flags.ReadMessageHistory,
            PermissionsBitField.Flags.ManageRoles,
			PermissionsBitField.Flags.EmbedLinks,
			PermissionsBitField.Flags.AttachFiles,
        ]);

        // Generate the invite link
        const inviteUrl = `https://discord.com/api/oauth2/authorize?client_id=${interaction.client.user.id}&permissions=${permissions.valueOf()}&scope=bot%20applications.commands`;

        const embed = new EmbedBuilder()
            .setTitle('Invite Me to Your Server!')
            .setColor('#0099ff')
            .setDescription('Click the button below to invite the bot. The required permissions are already configured in the link for all features to work correctly.')
            .addFields({
                name: 'Required Permissions',
                value: '• View Channels, Send Messages & Read History\n• Manage Webhooks & Manage Messages\n• Manage Roles, Embed Links & Attach Files\n• '
            });

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setLabel('Invite Bot').setStyle(ButtonStyle.Link).setURL(inviteUrl)
        );

        await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
    },
};