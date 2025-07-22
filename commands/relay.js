// commands/relay.js
const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const db = require('../db/database.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('relay')
        .setDescription('Configure the message relay system.')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addSubcommand(subcommand =>
            subcommand.setName('help').setDescription('Shows a guide on how to set up and use the relay bot.'))
        .addSubcommand(subcommand =>
            subcommand.setName('create_group').setDescription('Creates a new relay group for this server.')
                .addStringOption(option => option.setName('name').setDescription('The unique name for the new group (e.g., "alliance-chat")').setRequired(true)))
        .addSubcommand(subcommand =>
            subcommand.setName('link_channel').setDescription('Links this channel to a relay group.')
                .addStringOption(option => option.setName('group_name').setDescription('The name of the group to link to').setRequired(true)))
        .addSubcommand(subcommand =>
            subcommand.setName('unlink_channel').setDescription('Unlinks this channel from its relay group.'))
        .addSubcommand(subcommand =>
            subcommand.setName('map_role').setDescription('Maps a server role to a common name for relaying.')
                .addStringOption(option => option.setName('group_name').setDescription('The group this mapping applies to').setRequired(true))
                .addStringOption(option => option.setName('common_name').setDescription('The shared name for the role (e.g., "K30-31")').setRequired(true))
                .addRoleOption(option => option.setName('role').setDescription('The actual role to map').setRequired(true)))
        .addSubcommand(subcommand =>
            subcommand.setName('unmap_role').setDescription('Removes a role mapping from a group.')
                .addStringOption(option => option.setName('group_name').setDescription('The group to unmap from').setRequired(true))
                .addStringOption(option => option.setName('common_name').setDescription('The common name of the role to unmap').setRequired(true)))
        .addSubcommand(subcommand =>
            subcommand.setName('set_delete_delay').setDescription('Sets the auto-delete delay for messages in this channel (0 to disable).')
                .addIntegerOption(option => option.setName('hours').setDescription('How many hours before messages are deleted (0-720)').setRequired(true).setMinValue(0).setMaxValue(720))),

    async execute(interaction) {
        const subcommand = interaction.options.getSubcommand();
        const guildId = interaction.guild.id;
        const channelId = interaction.channel.id;

        try {
            if (subcommand === 'help') {
                const helpEmbed = new EmbedBuilder()
                    .setTitle('How to Set Up the Relay Bot')
                    .setColor('#5865F2')
                    .setDescription('Follow these steps to connect channels across different servers.')
                    .addFields(
                        {
                            name: 'Step 1: Create a Relay Group',
                            value: 'A "group" is the container for all channels that will talk to each other. **Admins on all participating servers must create a group with the exact same name.**\n`Ex: /relay create_group name: my-alliance-chat`'
                        },
                        {
                            name: 'Step 2: Link a Channel',
                            value: 'In the channel you want to relay messages from, link it to the group you created. The bot will automatically create a webhook to send messages.\n`Ex: /relay link_channel group_name: my-alliance-chat`'
                        },
                        {
                            name: 'Step 3: Map Roles (Optional)',
                            value: 'To make @role pings work across servers, you must map them. Give a role a "common name" in each server. If the role doesn\'t exist on a target server, the bot will create it!\n`Ex: /relay map_role group_name: my-alliance-chat common_name: K30-31 role: @Kingdom-30-31`'
                        },
                        {
                            name: 'Other Commands',
                            value: '• `/relay unlink_channel`: Removes this channel from a relay.\n' +
                                   '• `/relay unmap_role`: Removes a role mapping.\n' +
                                   '• `/relay set_delete_delay`: Sets how long until relayed messages are auto-deleted.\n' +
                                   '• `/version`: Check the bot\'s current version.\n' +
                                   '• `/invite`: Get a link to invite the bot to another server.'
                        }
                    )
                    .setFooter({ text: `Nexus Relay Bot v${require('../package.json').version}` });
                await interaction.reply({ embeds: [helpEmbed], ephemeral: true });

            } else if (subcommand === 'create_group') {
                const groupName = interaction.options.getString('name');
                db.prepare('INSERT INTO relay_groups (guild_id, group_name) VALUES (?, ?)')
                  .run(guildId, groupName);
                await interaction.reply({ content: `✅ Relay group "**${groupName}**" has been created! Now link channels to it with \`/relay link_channel\`.`, ephemeral: true });

            } else if (subcommand === 'link_channel') {
                const groupName = interaction.options.getString('group_name');
                const group = db.prepare('SELECT group_id FROM relay_groups WHERE guild_id = ? AND group_name = ?').get(guildId, groupName);
                if (!group) return interaction.reply({ content: `❌ Group "**${groupName}**" not found on this server. Please create it first or check the name.`, ephemeral: true });

                const webhook = await interaction.channel.createWebhook({ name: 'Nexus Relay', reason: `Relay link for group ${groupName}` });
                db.prepare('INSERT INTO linked_channels (channel_id, guild_id, group_id, webhook_url) VALUES (?, ?, ?, ?)')
                  .run(channelId, guildId, group.group_id, webhook.url);
                await interaction.reply({ content: `✅ This channel has been successfully linked to the "**${groupName}**" relay group.`, ephemeral: true });

            } else if (subcommand === 'unlink_channel') {
                const link = db.prepare('SELECT webhook_url FROM linked_channels WHERE channel_id = ?').get(channelId);
                if (!link) return interaction.reply({ content: `This channel is not linked to any relay group.`, ephemeral: true });

                const webhooks = await interaction.channel.fetchWebhooks();
                const webhookToDelete = webhooks.find(wh => wh.url === link.webhook_url);
                if (webhookToDelete) await webhookToDelete.delete('Relay channel unlinked.');

                db.prepare('DELETE FROM linked_channels WHERE channel_id = ?').run(channelId);
                await interaction.reply({ content: `✅ This channel has been unlinked.`, ephemeral: true });

            } else if (subcommand === 'map_role') {
                const groupName = interaction.options.getString('group_name');
                const commonName = interaction.options.getString('common_name');
                const role = interaction.options.getRole('role');
                const group = db.prepare('SELECT group_id FROM relay_groups WHERE guild_id = ? AND group_name = ?').get(guildId, groupName);
                if (!group) return interaction.reply({ content: `❌ Group "**${groupName}**" not found on this server.`, ephemeral: true });

                db.prepare('INSERT OR REPLACE INTO role_mappings (group_id, guild_id, role_name, role_id) VALUES (?, ?, ?, ?)')
                  .run(group.group_id, guildId, commonName, role.id);
                await interaction.reply({ content: `✅ Role **${role.name}** is now mapped to "**${commonName}**" for group "**${groupName}**".`, ephemeral: true });

            } else if (subcommand === 'unmap_role') {
                 const groupName = interaction.options.getString('group_name');
                 const commonName = interaction.options.getString('common_name');
                 const group = db.prepare('SELECT group_id FROM relay_groups WHERE guild_id = ? AND group_name = ?').get(guildId, groupName);
                 if (!group) return interaction.reply({ content: `❌ Group "**${groupName}**" not found on this server.`, ephemeral: true });
                 
                 const result = db.prepare('DELETE FROM role_mappings WHERE group_id = ? AND guild_id = ? AND role_name = ?').run(group.group_id, guildId, commonName);
                 if (result.changes > 0) await interaction.reply({ content: `✅ Mapping for "**${commonName}**" in group "**${groupName}**" removed.`, ephemeral: true });
                 else await interaction.reply({ content: `No mapping found for "**${commonName}**".`, ephemeral: true });

            } else if (subcommand === 'set_delete_delay') {
                const hours = interaction.options.getInteger('hours');
                db.prepare('UPDATE linked_channels SET delete_delay_hours = ? WHERE channel_id = ?').run(hours, channelId);
                await interaction.reply({ content: `✅ Auto-delete delay for this channel set to **${hours} hours**.`, ephemeral: true });
            }

        } catch (error) {
            console.error(`Error in /relay ${subcommand}:`, error);
            if (error.code === 50013) { // Missing Permissions
                await interaction.reply({ content: '❌ **Error:** I am missing permissions! Please ensure I can `Manage Webhooks` and `Manage Roles`.', ephemeral: true });
            } else if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
                await interaction.reply({ content: `❌ **Error:** An item with that name already exists. Please choose a unique name.`, ephemeral: true });
            } else {
                await interaction.reply({ content: 'An unknown error occurred. If this persists, please contact the bot developer.', ephemeral: true });
            }
        }
    },
};