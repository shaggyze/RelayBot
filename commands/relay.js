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
            subcommand.setName('create_group').setDescription('Creates a new GLOBAL relay group that other servers can link to.')
                .addStringOption(option => option.setName('name').setDescription('The globally unique name for the new group (e.g., "my-super-unique-alliance")').setRequired(true)))
        .addSubcommand(subcommand =>
            subcommand.setName('delete_group').setDescription('Deletes a global relay group. (Must be the server that created it).')
                .addStringOption(option => option.setName('name').setDescription('The name of the global group to permanently delete').setRequired(true)))
        .addSubcommand(subcommand =>
            subcommand.setName('kick_server').setDescription('Forcibly removes a server from a group you own.')
                .addStringOption(option => option.setName('group_name').setDescription('The name of the group you own').setRequired(true))
                .addStringOption(option => option.setName('server_id').setDescription('The ID of the server to kick').setRequired(true)))
        .addSubcommand(subcommand =>
            subcommand.setName('link_channel').setDescription('Links this channel to a global relay group.')
                .addStringOption(option => option.setName('group_name').setDescription('The name of the global group to link to').setRequired(true)))
        .addSubcommand(subcommand =>
            subcommand.setName('unlink_channel').setDescription('Unlinks this channel from its relay group.'))
        .addSubcommand(subcommand =>
            subcommand.setName('list_servers').setDescription('Lists all servers currently linked to a global group.')
                .addStringOption(option => option.setName('group_name').setDescription('The name of the group to list servers for').setRequired(true)))
        .addSubcommand(subcommand =>
            subcommand.setName('map_role').setDescription('Maps a server role to a common name for relaying.')
                .addStringOption(option => option.setName('group_name').setDescription('The global group this mapping applies to').setRequired(true))
                .addStringOption(option => option.setName('common_name').setDescription('The shared name for the role (e.g., "K30-31")').setRequired(true))
                .addRoleOption(option => option.setName('role').setDescription('The actual role to map').setRequired(true)))
        .addSubcommand(subcommand =>
            subcommand.setName('list_mappings').setDescription('Lists all configured role mappings for a group on this server.')
                .addStringOption(option => option.setName('group_name').setDescription('The name of the group to list mappings for').setRequired(true)))
        .addSubcommand(subcommand =>
            subcommand.setName('unmap_role').setDescription('Removes a role mapping from a group.')
                .addStringOption(option => option.setName('group_name').setDescription('The global group to unmap from').setRequired(true))
                .addStringOption(option => option.setName('common_name').setDescription('The common name of the role to unmap').setRequired(true)))
        .addSubcommand(subcommand =>
            subcommand.setName('set_delete_delay').setDescription('Sets the auto-delete delay for messages in this channel (0 to disable).')
                .addIntegerOption(option => option.setName('hours').setDescription('How many hours before messages are deleted (0-720)').setRequired(true).setMinValue(0).setMaxValue(720)))
        .addSubcommand(subcommand =>
            subcommand.setName('toggle_reverse_delete').setDescription('Toggle if deleting a relayed message deletes the original. (Default: OFF)')),

    async execute(interaction) {
        if (!interaction.inGuild()) {
            await interaction.reply({ content: 'This command can only be used inside a server.', ephemeral: true });
            return;
        }

        const subcommand = interaction.options.getSubcommand();
        const guildId = interaction.guild.id;
        const channelId = interaction.channel.id;

        try {
            if (subcommand === 'help') {
                const helpEmbed = new EmbedBuilder()
                    .setTitle('How to Set Up the Relay Bot')
                    .setColor('#5865F2')
                    .setDescription('Follow these steps to connect channels across different servers using global groups.')
                    .addFields(
                        { name: 'Step 1: Create a GLOBAL Group (On ONE Server Only)', value: 'One server must create the "global" group. The name must be unique across all servers using this bot.\n`Ex: /relay create_group name: my-cool-alliance-chat`' },
                        { name: 'Step 2: Link Channels (On ALL Servers)', value: 'Once a global group exists, any server with the bot can link a channel to it by using its name.\n`Ex: /relay link_channel group_name: my-cool-alliance-chat`' },
                        { name: 'Step 3: Map Roles (Optional)', value: 'To sync role pings, map your server\'s roles to a common name within that group.\n`Ex: /relay map_role group_name: my-cool-alliance-chat common_name: K30-31 role: @Kingdom-30-31`' },
                        { name: 'Step 4: Managing Your Setup', value: '• `/relay list_servers`: See all servers in a group.\n' + '• `/relay list_mappings`: See all role mappings for a group.\n' + '• `/relay kick_server`: Forcibly remove a server from a group you own.\n' + '• `/relay delete_group`: Deletes a global group (owner only).\n' + '• `/relay toggle_reverse_delete`: Toggle if deleting a relayed message deletes the original.\n' + '• `/relay unlink_channel`: Removes only this channel from a relay.\n' + '• `/relay unmap_role`: Removes a role mapping.\n' + '• `/relay set_delete_delay`: Sets message auto-delete delay.\n' + '• `/version` & `/invite`: Get bot info.' }
                    )
                    .setFooter({ text: `RelayBot v${require('../package.json').version}` });
                await interaction.reply({ embeds: [helpEmbed], ephemeral: true });

            } else if (subcommand === 'create_group') {
                const groupName = interaction.options.getString('name');
                // Add a dedicated try/catch for this specific, expected error.
                try {
                    db.prepare('INSERT INTO relay_groups (group_name, owner_guild_id) VALUES (?, ?)').run(groupName, guildId);
                    await interaction.reply({ content: `✅ **Global** relay group "**${groupName}**" has been created! Other servers can now link their channels to this group by name.`, ephemeral: true });
                } catch (error) {
                    // If the error is a UNIQUE constraint failure, handle it gracefully without logging a scary error.
                    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
                        await interaction.reply({ content: `❌ **Error:** A global group named "**${groupName}**" already exists. You don't need to create it again. You can link your channel directly to the existing group with \`/relay link_channel\`.`, ephemeral: true });
                    } else {
                        // If it's a different, unexpected error, let the main catch block at the bottom of the file handle it.
                        throw error;
                    }
                }
            } else if (subcommand === 'delete_group') {
                const groupName = interaction.options.getString('name');
                const group = db.prepare('SELECT group_id, owner_guild_id FROM relay_groups WHERE group_name = ?').get(groupName);
                if (!group) return interaction.reply({ content: `❌ No global group named "**${groupName}**" exists.`, ephemeral: true });
                if (group.owner_guild_id !== guildId) return interaction.reply({ content: `❌ You cannot delete this group because your server did not create it.`, ephemeral: true });

                db.prepare('DELETE FROM relay_groups WHERE group_id = ?').run(group.group_id);
                await interaction.reply({ content: `✅ Successfully deleted global group "**${groupName}**". All linked channels across all servers have been disconnected.`, ephemeral: true });

            } else if (subcommand === 'kick_server') {
                const groupName = interaction.options.getString('group_name');
                const serverIdToKick = interaction.options.getString('server_id');
                const group = db.prepare('SELECT group_id, owner_guild_id FROM relay_groups WHERE group_name = ?').get(groupName);

                if (!group) return interaction.reply({ content: `❌ No global group named "**${groupName}**" exists.`, ephemeral: true });
                if (group.owner_guild_id !== guildId) return interaction.reply({ content: `❌ You cannot manage this group because your server did not create it.`, ephemeral: true });
                if (serverIdToKick === guildId) return interaction.reply({ content: `❌ You cannot kick your own server. Use \`/relay delete_group\` to delete the whole group instead.`, ephemeral: true });

                const kickChannels = db.prepare('DELETE FROM linked_channels WHERE group_id = ? AND guild_id = ?').run(group.group_id, serverIdToKick);
                db.prepare('DELETE FROM role_mappings WHERE group_id = ? AND guild_id = ?').run(group.group_id, serverIdToKick);

                if (kickChannels.changes > 0) {
                    await interaction.reply({ content: `✅ Successfully kicked server \`${serverIdToKick}\` from the "**${groupName}**" group. All its linked channels and role mappings have been removed.`, ephemeral: true });
                } else {
                    await interaction.reply({ content: `That server was not found in the "**${groupName}**" group. No action was taken.`, ephemeral: true });
                }

            } else if (subcommand === 'link_channel') {
                // [FIX 1] Proactively check if this channel is already linked.
                const existingLink = db.prepare('SELECT 1 FROM linked_channels WHERE channel_id = ?').get(channelId);
                if (existingLink) {
                    return interaction.reply({ content: '❌ **Error:** This channel is already linked to a relay group. Please use `/relay unlink_channel` before trying to link it to a new one.', ephemeral: true });
                }

                // Proactively check for webhook permissions.
                const botPermissions = interaction.guild.members.me.permissionsIn(interaction.channel);
                if (!botPermissions.has(PermissionFlagsBits.ManageWebhooks)) {
                    const errorEmbed = new EmbedBuilder()
                        .setColor('#ED4245').setTitle('Permission Error')
                        .setDescription(`I am missing the **Manage Webhooks** permission in this specific channel (\`#${interaction.channel.name}\`).`)
                        .addFields({ name: 'How to Fix', value: 'An admin needs to go to `Edit Channel` > `Permissions` and ensure my role ("RelayBot") has the "Manage Webhooks" permission enabled here.' });
                    return interaction.reply({ embeds: [errorEmbed], ephemeral: true });
                }

                const groupName = interaction.options.getString('group_name');
                const group = db.prepare('SELECT group_id FROM relay_groups WHERE group_name = ?').get(groupName);
                if (!group) return interaction.reply({ content: `❌ No global group named "**${groupName}**" exists. An admin on one server must create it first.`, ephemeral: true });

                const webhook = await interaction.channel.createWebhook({ name: 'RelayBot', reason: `Relay link for group ${groupName}` });
                db.prepare('INSERT INTO linked_channels (channel_id, guild_id, group_id, webhook_url) VALUES (?, ?, ?, ?)').run(channelId, guildId, group.group_id, webhook.url);
                await interaction.reply({ content: `✅ This channel has been successfully linked to the global "**${groupName}**" relay group.`, ephemeral: true });

            } else if (subcommand === 'unlink_channel') {
                const link = db.prepare('SELECT webhook_url FROM linked_channels WHERE channel_id = ?').get(channelId);
                if (!link) return interaction.reply({ content: `This channel is not linked to any relay group.`, ephemeral: true });

                const webhooks = await interaction.channel.fetchWebhooks();
                const webhookToDelete = webhooks.find(wh => wh.url === link.webhook_url);
                if (webhookToDelete) await webhookToDelete.delete('Relay channel unlinked.');

                db.prepare('DELETE FROM linked_channels WHERE channel_id = ?').run(channelId);
                await interaction.reply({ content: `✅ This channel has been unlinked from its group.`, ephemeral: true });

            } else if (subcommand === 'list_servers') {
                const groupName = interaction.options.getString('group_name');
                const group = db.prepare('SELECT group_id FROM relay_groups WHERE group_name = ?').get(groupName);
                if (!group) return interaction.reply({ content: `❌ No global group named "**${groupName}**" exists.`, ephemeral: true });

                const linkedGuilds = db.prepare('SELECT DISTINCT guild_id FROM linked_channels WHERE group_id = ?').all(group.group_id);
                if (linkedGuilds.length === 0) return interaction.reply({ content: `There are no servers currently linked to group "**${groupName}**".`, ephemeral: true });
                
                const serverList = linkedGuilds.map(row => {
                    const guild = interaction.client.guilds.cache.get(row.guild_id);
                    return `• **${guild ? guild.name : 'Unknown Server'}** (ID: \`${row.guild_id}\`)`;
                }).join('\n');

                const listEmbed = new EmbedBuilder().setTitle(`Servers in Group "${groupName}"`).setColor('#5865F2').setDescription(serverList);
                await interaction.reply({ embeds: [listEmbed], ephemeral: true });

            } else if (subcommand === 'map_role') {
                const groupName = interaction.options.getString('group_name');
                const commonName = interaction.options.getString('common_name');
                const role = interaction.options.getRole('role');
                const group = db.prepare('SELECT group_id FROM relay_groups WHERE group_name = ?').get(groupName);
                if (!group) return interaction.reply({ content: `❌ No global group named "**${groupName}**" exists.`, ephemeral: true });

                db.prepare('INSERT OR REPLACE INTO role_mappings (group_id, guild_id, role_name, role_id) VALUES (?, ?, ?, ?)')
                  .run(group.group_id, guildId, commonName, role.id);
                await interaction.reply({ content: `✅ Role **${role.name}** is now mapped to "**${commonName}**" for group "**${groupName}**".`, ephemeral: true });

            } else if (subcommand === 'list_mappings') {
                const groupName = interaction.options.getString('group_name');
                const group = db.prepare('SELECT group_id FROM relay_groups WHERE group_name = ?').get(groupName);
                if (!group) return interaction.reply({ content: `❌ No global group named "**${groupName}**" exists.`, ephemeral: true });

                const mappings = db.prepare('SELECT role_name, role_id FROM role_mappings WHERE group_id = ? AND guild_id = ? ORDER BY role_name').all(group.group_id, guildId);
                if (mappings.length === 0) return interaction.reply({ content: `There are no role mappings configured for group "**${groupName}**" on this server.`, ephemeral: true });

                const description = mappings.map(m => `**${m.role_name}** → <@&${m.role_id}>`).join('\n');
                const listEmbed = new EmbedBuilder().setTitle(`Role Mappings for Group "${groupName}"`).setColor('#5865F2').setDescription(description).setFooter({ text: `Showing mappings for this server only.` });
                await interaction.reply({ embeds: [listEmbed], ephemeral: true });
            
            } else if (subcommand === 'unmap_role') {
                 const groupName = interaction.options.getString('group_name');
                 const commonName = interaction.options.getString('common_name');
                 const group = db.prepare('SELECT group_id FROM relay_groups WHERE group_name = ?').get(groupName);
                 if (!group) return interaction.reply({ content: `❌ No global group named "**${groupName}**" exists.`, ephemeral: true });
                 
                 const result = db.prepare('DELETE FROM role_mappings WHERE group_id = ? AND guild_id = ? AND role_name = ?').run(group.group_id, guildId, commonName);
                 if (result.changes > 0) await interaction.reply({ content: `✅ Mapping for "**${commonName}**" in group "**${groupName}**" removed from this server.`, ephemeral: true });
                 else await interaction.reply({ content: `No mapping found for "**${commonName}**" on this server.`, ephemeral: true });

            } else if (subcommand === 'set_delete_delay') {
                const hours = interaction.options.getInteger('hours');
                db.prepare('UPDATE linked_channels SET delete_delay_hours = ? WHERE channel_id = ?').run(hours, channelId);
                await interaction.reply({ content: `✅ Auto-delete delay for this channel set to **${hours} hours**.`, ephemeral: true });
            
            } else if (subcommand === 'toggle_reverse_delete') {
                const channelLink = db.prepare('SELECT reverse_delete_enabled FROM linked_channels WHERE channel_id = ?').get(channelId);
                if (!channelLink) return interaction.reply({ content: 'This channel is not a linked relay channel.', ephemeral: true });

                const newValue = !channelLink.reverse_delete_enabled;
                db.prepare('UPDATE linked_channels SET reverse_delete_enabled = ? WHERE channel_id = ?').run(newValue ? 1 : 0, channelId);
                
                const status = newValue ? 'ENABLED' : 'DISABLED';
                await interaction.reply({ content: `✅ Reverse deletion for this channel is now **${status}**. When a relayed message is deleted in another server, the original message in this channel will also be deleted.`, ephemeral: true });
            }

        } catch (error) {
            console.error(`Error in /relay ${subcommand}:`, error);
			// [FIX 2] Add a specific catch for the webhook limit error.
            if (error.code === 30007) {
                await interaction.reply({ content: `❌ **Error:** This channel has reached the maximum number of webhooks (15). I cannot create a new one. An admin must delete an unused webhook from \`Edit Channel\` > \`Integrations\` > \`Webhooks\` before I can link this channel.`, ephemeral: true });
            } else if (error.code === 50013) {
                await interaction.reply({ content: '❌ **Error:** I am missing critical permissions! Please ensure I have the `Manage Webhooks` and `Manage Roles` permissions.', ephemeral: true });
            } else if (error.code === 'SQLITE_CONSTRAINT_UNIQUE' || error.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
                // This is now a fallback, but the proactive check should catch it first.
                await interaction.reply({ content: `❌ **Error:** An item with that name or ID already exists in the database.`, ephemeral: true });
            } else {
                console.error(`Error in /relay ${subcommand}:`, error);
                if (interaction.replied || interaction.deferred) {
                    await interaction.followUp({ content: 'An unknown error occurred.', ephemeral: true });
                } else {
                    await interaction.reply({ content: 'An unknown error occurred.', ephemeral: true });
                }
            }
        }
    },
};