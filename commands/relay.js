// commands/relay.js
const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const db = require('../db/database.js');
const { isSupporter } = require('../utils/supporterManager.js');

const BOT_OWNER_ID = '182938628643749888';

module.exports = {
    data: new SlashCommandBuilder()
        .setName('relay')
        .setDescription('Configure the message relay system.')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addSubcommand(subcommand => subcommand.setName('help').setDescription('Shows a guide on how to set up and use the relay bot.'))
        .addSubcommand(subcommand => subcommand.setName('create_group').setDescription('Creates a new GLOBAL relay group that other servers can link to.').addStringOption(option => option.setName('name').setDescription('The globally unique name for the new group').setRequired(true)))
        .addSubcommand(subcommand => subcommand.setName('delete_group').setDescription('Deletes a global relay group. (Must be the server that created it).').addStringOption(option => option.setName('name').setDescription('The name of the global group to permanently delete').setRequired(true)))
        .addSubcommand(subcommand => subcommand.setName('kick_server').setDescription('Forcibly removes a server from a group you own.').addStringOption(option => option.setName('group_name').setDescription('The name of the group you own').setRequired(true)).addStringOption(option => option.setName('server_id').setDescription('The ID of the server to kick').setRequired(true)))
        .addSubcommand(subcommand => subcommand.setName('link_channel').setDescription('Links this channel to a global relay group.').addStringOption(option => option.setName('group_name').setDescription('The name of the global group to link to').setRequired(true)).addStringOption(option => option.setName('direction').setDescription('Set the message direction for this channel (default: Both Ways).').setRequired(false).addChoices({ name: 'Both Ways (Send & Receive)', value: 'BOTH' }, { name: 'One Way (Send messages FROM this channel only)', value: 'SEND_ONLY' }, { name: 'Reverse (Receive messages IN this channel only)', value: 'RECEIVE_ONLY' })))
        .addSubcommand(subcommand => subcommand.setName('unlink_channel').setDescription('Unlinks the current channel from its relay group.'))
        .addSubcommand(subcommand => subcommand.setName('list_servers').setDescription('Lists all servers and their linked channels for a global group.').addStringOption(option => option.setName('group_name').setDescription('The name of the group to list servers for').setRequired(true)))
        .addSubcommand(subcommand => 
            subcommand.setName('map_role')
                .setDescription('Maps a server role to a common name (alias) for relaying.')
                .addStringOption(option => option.setName('group_name').setDescription('The global group this mapping applies to').setRequired(true))
                .addStringOption(option => 
                    option.setName('common_name')
                        .setDescription('The shared alias (name) for the role. Shows existing aliases.')
                        .setRequired(true)
                        .setMaxLength(100)
                        .setAutocomplete(true)) 
                .addRoleOption(option => option.setName('role').setDescription('The actual role to map').setRequired(true)))
        .addSubcommand(subcommand => subcommand.setName('list_mappings').setDescription('Lists all configured role mappings for a group on this server.').addStringOption(option => option.setName('group_name').setDescription('The name of the group to list mappings for').setRequired(true)))
        .addSubcommand(subcommand => subcommand.setName('unmap_role').setDescription('Removes a role mapping from a group.').addStringOption(option => option.setName('group_name').setDescription('The global group to unmap from').setRequired(true)).addStringOption(option => option.setName('common_name').setDescription('The common name of the role to unmap').setRequired(true)))
        .addSubcommand(subcommand => subcommand.setName('set_direction').setDescription('Sets the direction of a channel from a group you own.').addStringOption(option => option.setName('group_name').setDescription('The name of the relay group.').setRequired(true)).addStringOption(option => option.setName('channel_id').setDescription('The ID of the channel you want to modify.').setRequired(true)).addStringOption(option => option.setName('direction').setDescription('The new relay direction for this channel.').setRequired(true).addChoices({ name: 'Both (Send & Receive)', value: 'BOTH' }, { name: 'Send Only', value: 'SEND_ONLY' }, { name: 'Receive Only', value: 'RECEIVE_ONLY' })))
		.addSubcommand(subcommand => subcommand.setName('set_delete_delay').setDescription('Sets the auto-delete delay for messages in this channel (0 to disable).').addIntegerOption(option => option.setName('hours').setDescription('How many hours before messages are deleted').setRequired(true).setMinValue(0).setMaxValue(720)))
        .addSubcommand(subcommand => subcommand.setName('toggle_forward_delete').setDescription('Toggle if deleting an original message also deletes its copies (ON by default).'))
        .addSubcommand(subcommand => subcommand.setName('toggle_reverse_delete').setDescription('Toggle if deleting a relayed copy also deletes the original message (OFF by default).'))
        .addSubcommand(subcommand => subcommand.setName('set_brand').setDescription('Sets a custom server brand/name for messages from this channel.').addStringOption(option => option.setName('name').setDescription('The custom name to display (e.g., "UGW"). Leave blank to remove.').setMaxLength(40)))
        .addSubcommand(subcommand => subcommand.setName('block').setDescription('Blocks a user or server from being relayed in a group you own.').addStringOption(option => option.setName('group_name').setDescription('The name of the group you own.').setRequired(true)).addStringOption(option => option.setName('target_id').setDescription('The User ID or Server ID to block.').setRequired(true)))
        .addSubcommand(subcommand => subcommand.setName('unblock').setDescription('Unblocks a user or server from a group you own.').addStringOption(option => option.setName('group_name').setDescription('The name of the group you own.').setRequired(true)).addStringOption(option => option.setName('target_id').setDescription('The User ID or Server ID to unblock.').setRequired(true)))
        .addSubcommand(subcommand => subcommand.setName('toggle_auto_role').setDescription('Toggle auto-role creation/linking when linking this channel to a group.'))
	,
    async execute(interaction) {
        if (!interaction.inGuild()) {
            return await interaction.reply({ content: 'This command can only be used inside a server.', ephemeral: true });
        }

        const subcommand = interaction.options.getSubcommand();
        const guildId = interaction.guild.id;
        const channelId = interaction.channel.id;

        try {
            if (subcommand === 'help') {
                const helpEmbed = new EmbedBuilder().setTitle('How to Set Up the Relay Bot').setColor('#5865F2').setDescription('Follow these steps to connect channels across different servers using global groups.').addFields({ name: 'Step 1: Create a GLOBAL Group (On ONE Server Only)', value: 'One server must create the "global" group. The name must be unique across all servers using this bot.\n`Ex: /relay create_group name: my-super-unique-alliance`' }, { name: 'Step 2: Link Channels (On ALL Servers)', value: 'Admins on all participating servers can now link their channels to the *same* global group by name.\n`Ex: /relay link_channel group_name: my-super-unique-alliance direction: Both Ways`' }, { name: 'Step 3: Map Roles (Optional)', value: 'To sync role pings, map your server\'s roles to a shared "common name" within that group.\n`Ex: /relay map_role group_name: my-super-unique-alliance common_name: K30-31 role: @30-31`' }, { name: 'Step 4: Managing Your Setup', value: '• `/relay list_servers`: See all servers in a group.\n' + '• `/relay list_mappings`: See all role mappings for a group.\n' + '• `/relay kick_server`: Forcibly remove a server from a group you own.\n' + '• `/relay delete_group`: Deletes a global group (owner only).\n' + '• `/relay toggle_forward_delete`: Toggle if deleting an original message also deletes its copies.\n' + '• `/relay toggle_reverse_delete`: Toggle if deleting a relayed message deletes the original.\n' + '• `/relay unlink_channel`: Removes only this channel from a relay.\n' + '• `/relay unmap_role`: Removes a role mapping.\n' + '• `/relay set_direction`: Sets the direction of a channel.\n' + '• `/relay set_brand`: Sets a custom server brand.\n' + '• `/relay set_delete_delay`: Sets message auto-delete delay.\n' + '• `/relay toggle_auto_role`: Toggles auto-role syncing.\n' + '• `/version`, `/invite` & `/vote` : Get bot info.' }).setFooter({ text: `RelayBot v${require('../package.json').version}` });
                await interaction.reply({ embeds: [helpEmbed], ephemeral: true });

            } else if (subcommand === 'create_group') {
                const groupName = interaction.options.getString('name');
                try {
                    db.prepare('INSERT INTO relay_groups (group_name, owner_guild_id) VALUES (?, ?)').run(groupName, guildId);
                    await interaction.reply({ content: `✅ **Global** relay group "**${groupName}**" has been created! Other servers can now link their channels to this group by name.`, ephemeral: true });
                } catch (error) {
                    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
                        await interaction.reply({ content: `❌ **Error:** A global group named "**${groupName}**" already exists. You don't need to create it again. You can link your channel directly to the existing group with \`/relay link_channel\`.`, ephemeral: true });
                    } else { throw error; }
                }

            } else if (subcommand === 'delete_group') {
                const groupName = interaction.options.getString('name');
                const group = db.prepare('SELECT group_id, owner_guild_id FROM relay_groups WHERE group_name = ?').get(groupName);
                if (!group) return interaction.reply({ content: `❌ No global group named "**${groupName}**" exists.`, ephemeral: true });
                if (group.owner_guild_id !== guildId) return interaction.reply({ content: `❌ You cannot delete this group because your server did not create it.`, ephemeral: true });
                db.prepare('DELETE FROM relay_groups WHERE group_id = ?').run(group.group_id);
                await interaction.reply({ content: `✅ Successfully deleted global group "**${groupName}**" and all of its associated data.`, ephemeral: true });

            } else if (subcommand === 'kick_server') {
                const groupName = interaction.options.getString('group_name');
                const serverIdToKick = interaction.options.getString('server_id');
                const group = db.prepare('SELECT group_id, owner_guild_id FROM relay_groups WHERE group_name = ?').get(groupName);
                if (!group) return interaction.reply({ content: `❌ No global group named "**${groupName}**" exists.`, ephemeral: true });
                if (group.owner_guild_id !== guildId) return interaction.reply({ content: `❌ You cannot manage this group because your server did not create it.`, ephemeral: true });
                if (serverIdToKick === guildId) return interaction.reply({ content: `❌ You cannot kick your own server.`, ephemeral: true });
                const kickChannels = db.prepare('DELETE FROM linked_channels WHERE group_id = ? AND guild_id = ?').run(group.group_id, serverIdToKick);
                db.prepare('DELETE FROM role_mappings WHERE group_id = ? AND guild_id = ?').run(group.group_id, serverIdToKick);
                if (kickChannels.changes > 0) {
                    await interaction.reply({ content: `✅ Successfully kicked server \`${serverIdToKick}\` from the "**${groupName}**" group. All its linked channels and role mappings have been removed.`, ephemeral: true });
                } else {
                    await interaction.reply({ content: `That server was not found in the "**${groupName}**" group. No action was taken.`, ephemeral: true });
                }

            } else if (subcommand === 'link_channel') {
				await interaction.deferReply({ ephemeral: true });

				const groupName = interaction.options.getString('group_name');
				const direction = interaction.options.getString('direction') ?? 'BOTH';
				const channelId = interaction.channel.id;
				const guildId = interaction.guild.id;

				// --- Minimal Overwrite Fix ---
				const existingLink = db.prepare('SELECT group_id, webhook_url FROM linked_channels WHERE channel_id = ?').get(channelId);

				// Check webhook permission regardless of existing link status
				const botPermissions = interaction.guild.members.me.permissionsIn(interaction.channel);
				if (!botPermissions.has(PermissionFlagsBits.ManageWebhooks)) {
					// ... (Error embed for missing webhook permission)
        			return interaction.editReply({ content: '❌ **Error:** I am missing the **Manage Webhooks** permission in this channel. I need this to create the link.' });
				}

				const group = db.prepare('SELECT group_id FROM relay_groups WHERE group_name = ?').get(groupName);
				if (!group) return interaction.editReply({ content: `❌ No global group named "**${groupName}**" exists. An admin on one server must create it first.` });

				let webhookUrl;
				let syncReport = '';

				if (existingLink) {
					// [THE FIX - Overwrite Logic]

					// Use the existing webhook to avoid creating a new one (and orphaned ones).
					webhookUrl = existingLink.webhook_url; 

					// Update the existing row instead of deleting/re-inserting the link
					db.prepare('UPDATE linked_channels SET group_id = ?, direction = ? WHERE channel_id = ?').run(group.group_id, direction, channelId);
				
					// Send a temporary notification (ephemeral so it doesn't clutter the channel)
					await interaction.followUp({ content: '⚠️ **Link Overwritten:** This channel was already linked. Settings have been updated. Triggering sync/update...', ephemeral: true });

					// **Issue:** If the user changed the group, the old auto-role setting is lost.
					// We accept this for the minimal fix. We assume the user wants the new settings.

				} else {
					// Normal first-time link. Create the webhook.
					const webhook = await interaction.channel.createWebhook({ name: 'RelayBot', reason: `Relay link for group ${groupName}` });
					webhookUrl = webhook.url;

					// Get auto-role setting from the server (assuming simple logic for now)
					const channelSettings = db.prepare('SELECT allow_auto_role_creation FROM linked_channels WHERE guild_id = ? LIMIT 1').get(guildId);
					const allowAutoRole = channelSettings ? channelSettings.allow_auto_role_creation : 0; // Default to 0 (false)

					// CRUCIAL: Insert the NEW link record
					db.prepare('INSERT INTO linked_channels (channel_id, guild_id, group_id, webhook_url, direction, allow_auto_role_creation) VALUES (?, ?, ?, ?, ?, ?)').run(channelId, guildId, group.group_id, webhookUrl, direction, allowAutoRole);
				}

                // --- Auto-Role Syncing Logic ---
                const channelSettings = db.prepare('SELECT allow_auto_role_creation FROM linked_channels WHERE channel_id = ?').get(channelId);
                if (channelSettings && channelSettings.allow_auto_role_creation) {
                    if (!canManageRoles) {
                        syncReport = '\n⚠️ **Warning:** Auto-role sync skipped. I am missing the `Manage Roles` permission in this server.';
                    } else {
                        await interaction.followUp({ content: 'Attempting to sync roles...', ephemeral: true });

                        const masterRoleNames = db.prepare('SELECT DISTINCT role_name FROM role_mappings WHERE group_id = ?').all(group.group_id).map(r => r.role_name);
                        
                        if (masterRoleNames.length > 0) {
                            await interaction.guild.roles.fetch();
                            const serverRoles = interaction.guild.roles.cache;

                            let linkedCount = 0;
                            let createdCount = 0;

                            for (const commonName of masterRoleNames) {
                                const existingMapping = db.prepare('SELECT 1 FROM role_mappings WHERE group_id = ? AND guild_id = ? AND role_name = ?').get(group.group_id, guildId, commonName);
                                if (existingMapping) continue;

                                const existingRole = serverRoles.find(r => r.name === commonName);
                                
                                if (existingRole) {
                                    // Auto-Link: Role exists, save the mapping
                                    db.prepare('INSERT INTO role_mappings (group_id, guild_id, role_name, role_id) VALUES (?, ?, ?, ?)').run(group.group_id, guildId, commonName, existingRole.id);
                                    linkedCount++;
                                } else {
                                    // Auto-Create: Role does not exist, so create it
                                    try {
                                        const newRole = await interaction.guild.roles.create({
                                            name: commonName,
                                            mentionable: false, // Safer default
                                            reason: `Auto-creating role for RelayBot group: ${groupName}`
                                        });
                                        db.prepare('INSERT INTO role_mappings (group_id, guild_id, role_name, role_id) VALUES (?, ?, ?, ?)').run(group.group_id, guildId, commonName, newRole.id);
                                        createdCount++;
                                    } catch (roleError) {
                                        console.error(`[AUTO-ROLE] Failed to create role "${commonName}" in server "${interaction.guild.name}":`, roleError);
                                    }
                                }
                            }
                            syncReport = `\n🔄 **Role Sync Complete:** Successfully linked **${linkedCount}** existing roles and created **${createdCount}** new roles.`;
                        } else {
                            syncReport = '\nℹ️ **Role Sync Info:** No mapped roles found in the group to sync.';
                        }
                    }
                }

                await interaction.editReply({ content: `✅ This channel has been successfully linked/updated to the global "**${groupName}**" group with direction set to **${direction}**.${syncReport}` });

            } else if (subcommand === 'unlink_channel') {
                await interaction.deferReply({ ephemeral: true });
                const link = db.prepare('SELECT 1 FROM linked_channels WHERE channel_id = ?').get(channelId);
                if (!link) {
                    return interaction.editReply({ content: `This channel is not linked to any relay group.` });
                }
                let deletedCount = 0;
                try {
                    const webhooks = await interaction.channel.fetchWebhooks();
                    for (const webhook of webhooks.values()) {
                        if (webhook.owner.id === interaction.client.user.id) {
                            await webhook.delete('Relay channel unlinked.');
                            deletedCount++;
                        }
                    }
                } catch (error) {
                    console.error(`[UNLINK] Could not fetch or delete webhooks in channel ${channelId}:`, error.message);
                }
                db.prepare('DELETE FROM linked_channels WHERE channel_id = ?').run(channelId);
                await interaction.editReply({ content: `✅ This channel has been unlinked. Found and deleted ${deletedCount} bot-owned webhook(s).` });

            } else if (subcommand === 'list_servers') {
                await interaction.deferReply({ ephemeral: true });
                const groupName = interaction.options.getString('group_name');
                const group = db.prepare('SELECT group_id, owner_guild_id FROM relay_groups WHERE group_name = ?').get(groupName);
                if (!group) return interaction.editReply({ content: `❌ No global group named "**${groupName}**" exists.` });
                const allLinks = db.prepare('SELECT guild_id, channel_id, direction FROM linked_channels WHERE group_id = ?').all(group.group_id);
                const guildsToChannels = new Map();
                if (!guildsToChannels.has(group.owner_guild_id)) {
                    guildsToChannels.set(group.owner_guild_id, []);
                }
                for (const link of allLinks) {
                    if (!guildsToChannels.has(link.guild_id)) {
                        guildsToChannels.set(link.guild_id, []);
                    }
                    guildsToChannels.get(link.guild_id).push({ id: link.channel_id, dir: link.direction });
                }
                let description = '';
                for (const [guildId, channelInfos] of guildsToChannels.entries()) {
                    const guild = interaction.client.guilds.cache.get(guildId);
                    if (guild) {
                        const memberCount = guild.memberCount;
                        const supporterCount = guild.members.cache.filter(member => !member.user.bot && isSupporter(member.id)).size;
                        description += `• **${guild.name}** (ID: \`${guildId}\`) (${memberCount} Members / ${supporterCount} Supporters)\n`;
                    } else {
                        description += `• **Unknown Server** (ID: \`${guildId}\`)\n`;
                    }
                    if (channelInfos.length > 0) {
                        for (const info of channelInfos) {
                            const channel = interaction.client.channels.cache.get(info.id);
                            const directionFormatted = `(Direction: **${info.dir}**)`;
                            description += `  └─ ${channel ? `<#${info.id}> (#${channel.name}) (ID: \`${info.id}\`)` : `Inaccessible Channel (ID: \`${info.id}\`)`} ${directionFormatted}\n`;
                        }
                    } else {
                        description += `  └─ *(No channels linked from this server)*\n`;
                    }
                }
                const listEmbed = new EmbedBuilder().setTitle(`Servers & Channels in Group "${groupName}"`).setColor('#5865F2').setDescription(description.trim());
                await interaction.editReply({ embeds: [listEmbed] });
            
            } else if (subcommand === 'map_role') {
                const groupName = interaction.options.getString('group_name');
                const commonName = interaction.options.getString('common_name');
                const role = interaction.options.getRole('role');
                const group = db.prepare('SELECT group_id FROM relay_groups WHERE group_name = ?').get(groupName);
                if (!group) return interaction.reply({ content: `❌ No global group named "**${groupName}**" exists.`, ephemeral: true });
                db.prepare('INSERT OR REPLACE INTO role_mappings (group_id, guild_id, role_name, role_id) VALUES (?, ?, ?, ?)').run(group.group_id, guildId, commonName, role.id);
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
            
            } else if (subcommand === 'toggle_forward_delete') {
                const channelLink = db.prepare('SELECT allow_forward_delete FROM linked_channels WHERE channel_id = ?').get(channelId);
                if (!channelLink) return interaction.reply({ content: 'This channel is not a linked relay channel.', ephemeral: true });
                const newValue = !channelLink.allow_forward_delete;
                db.prepare('UPDATE linked_channels SET allow_forward_delete = ? WHERE channel_id = ?').run(newValue ? 1 : 0, channelId);
                const status = newValue ? 'ENABLED' : 'DISABLED';
                await interaction.reply({ content: `✅ Forward deletion for this channel is now **${status}**.`, ephemeral: true });
            
            } else if (subcommand === 'toggle_reverse_delete') {
                const channelLink = db.prepare('SELECT allow_reverse_delete FROM linked_channels WHERE channel_id = ?').get(channelId);
                if (!channelLink) return interaction.reply({ content: 'This channel is not a linked relay channel.', ephemeral: true });
                const newValue = !channelLink.allow_reverse_delete;
                db.prepare('UPDATE linked_channels SET allow_reverse_delete = ? WHERE channel_id = ?').run(newValue ? 1 : 0, channelId);
                const status = newValue ? 'ENABLED' : 'DISABLED';
                await interaction.reply({ content: `✅ Reverse deletion for this channel is now **${status}**.`, ephemeral: true });

            } else if (subcommand === 'set_direction') {
				await interaction.deferReply({ ephemeral: true });
				const groupName = interaction.options.getString('group_name');
				const targetChannelId = interaction.options.getString('channel_id');
				const newDirection = interaction.options.getString('direction');
				try {
					const group = db.prepare('SELECT group_id, owner_guild_id FROM relay_groups WHERE group_name = ?').get(groupName);
					if (!group) return interaction.editReply({ content: `❌ **Error:** No relay group found with the name "${groupName}".` });
					const isBotOwner = interaction.user.id === BOT_OWNER_ID;
					const isGroupOwnerAdmin = interaction.guild.id === group.owner_guild_id && interaction.member.permissions.has(PermissionFlagsBits.Administrator);
					if (!isBotOwner && !isGroupOwnerAdmin) return interaction.editReply({ content: `❌ **Permission Denied:** This command can only be run by the bot owner or an administrator on the server that owns the "${groupName}" group.` });
					const link = db.prepare('SELECT channel_id FROM linked_channels WHERE group_id = ? AND channel_id = ?').get(group.group_id, targetChannelId);
					if (!link) return interaction.editReply({ content: `❌ **Error:** The channel ID \`${targetChannelId}\` is not part of the "${groupName}" relay group.` });
					const result = db.prepare('UPDATE linked_channels SET direction = ? WHERE channel_id = ? AND group_id = ?').run(newDirection, targetChannelId, group.group_id);
					const targetChannel = await interaction.client.channels.fetch(targetChannelId).catch(() => null);
					const channelMention = targetChannel ? `<#${targetChannel.id}>` : `channel \`${targetChannelId}\``;
					if (result.changes > 0) {
						await interaction.editReply({ content: `✅ **Success!** The direction for ${channelMention} in the **${groupName}** group has been set to \`${newDirection}\`.` });
					} else {
						await interaction.editReply({ content: `⚠️ **Warning:** The ${channelMention} already had that direction set. No changes were made.` });
					}
				} catch (error) {
					console.error('Error in /relay set_direction:', error);
					await interaction.editReply({ content: 'An unexpected error occurred while trying to set the channel direction. Please check the logs.' });
				}
            
            // --- NEW FEATURE LOGIC STARTS HERE ---
            
            } else if (subcommand === 'set_brand') {
                const newBrand = interaction.options.getString('name') || null; 
                const channelLink = db.prepare('SELECT 1 FROM linked_channels WHERE channel_id = ?').get(channelId);
                if (!channelLink) {
                    return interaction.reply({ content: '❌ **Error:** This channel is not linked to any relay group.', ephemeral: true });
                }
                db.prepare('UPDATE linked_channels SET brand_name = ? WHERE channel_id = ?').run(newBrand, channelId);
                if (newBrand) {
                    await interaction.reply({ content: `✅ **Success!** Messages from this channel will now be branded with "**${newBrand}**".`, ephemeral: true });
                } else {
                    await interaction.reply({ content: `✅ **Success!** The custom brand for this channel has been removed.`, ephemeral: true });
                }

            } else if (subcommand === 'block' || subcommand === 'unblock') {
                await interaction.deferReply({ ephemeral: true });
                const groupName = interaction.options.getString('group_name');
                const targetId = interaction.options.getString('target_id');
    
                const group = db.prepare('SELECT group_id, owner_guild_id FROM relay_groups WHERE group_name = ?').get(groupName);
                if (!group) return interaction.editReply({ content: `❌ **Error:** No group found with the name "${groupName}".` });
                if (interaction.guild.id !== group.owner_guild_id) return interaction.editReply({ content: `❌ **Permission Denied:** You can only manage the blocklist from the server that owns this group.` });
                
                // Determine if the ID is a user or a guild
                let type = null;
                if (/^\d{17,19}$/.test(targetId)) {
                    // It's a valid ID format. We'll assume GUILD if it's in the bot's cache, otherwise USER.
                    // This is a heuristic but covers most cases without expensive lookups.
                    if (interaction.client.guilds.cache.has(targetId)) {
                        type = 'GUILD';
                    } else {
                        type = 'USER'; // Default to user if not a cached guild
                    }
                } else {
                    return interaction.editReply({ content: '❌ **Error:** The provided ID is not a valid User or Server ID.' });
                }
    
                if (subcommand === 'block') {
                    try {
                        db.prepare('INSERT INTO group_blacklist (group_id, blocked_id, type) VALUES (?, ?, ?)').run(group.group_id, targetId, type);
                        await interaction.editReply({ content: `✅ **Blocked:** The ${type} with ID \`${targetId}\` will no longer be relayed in the "**${groupName}**" group.` });
                    } catch (error) {
                        if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
                            await interaction.editReply({ content: `⚠️ That ID is already blocked.` });
                        } else { throw error; }
                    }
                } else { // unblock
                    const result = db.prepare('DELETE FROM group_blacklist WHERE group_id = ? AND blocked_id = ?').run(group.group_id, targetId);
                    if (result.changes > 0) {
                        await interaction.editReply({ content: `✅ **Unblocked:** The ${type} with ID \`${targetId}\` can now be relayed again in the "**${groupName}**" group.` });
                    } else {
                        await interaction.editReply({ content: `⚠️ That ID was not found in the blocklist.` });
                    }
                }
                const newValue = !channelLink.allow_auto_role_creation;
                db.prepare('UPDATE linked_channels SET allow_auto_role_creation = ? WHERE channel_id = ?').run(newValue ? 1 : 0, channelId);
                const status = newValue ? 'ENABLED' : 'DISABLED';
                await interaction.reply({ content: `✅ Auto-role syncing for this channel is now **${status}**.\n*Run \`/relay link_channel\` again to trigger a manual sync.*`, ephemeral: true });

			} else if (subcommand === 'toggle_auto_role') {
				// [THE FIX] Check the setting on ANY channel first.
				const channelLink = db.prepare('SELECT allow_auto_role_creation FROM linked_channels WHERE guild_id = ? LIMIT 1').get(guildId);

				// If no channels are linked, we can't toggle a setting tied to a link.
				if (!channelLink) {
					return interaction.reply({ content: '❌ **Error:** This server has no channels linked to any relay group. Link a channel first.', ephemeral: true });
				}

				// Get the current value from the first found channel, and flip it.
				const currentValue = channelLink.allow_auto_role_creation;
				const newValue = !currentValue;

				// [THE FIX] Update ALL linked channels on this server.
				db.prepare('UPDATE linked_channels SET allow_auto_role_creation = ? WHERE guild_id = ?').run(newValue ? 1 : 0, guildId);

				const status = newValue ? 'ENABLED' : 'DISABLED';
				await interaction.reply({ content: `✅ Auto-role syncing for **ALL** linked channels on this server is now **${status}**.\n*Run \`/relay link_channel\` again on any linked channel to trigger a manual sync.*`, ephemeral: true });
			}


		} catch (error) {
           console.error(`Error in /relay ${subcommand}:`, error);
           if (interaction.deferred) {
               await interaction.editReply({ content: 'An unknown error occurred while executing this command.' }).catch(() => {});
           } else if (!interaction.replied) {
               await interaction.reply({ content: 'An unknown error occurred while executing this command.', ephemeral: true }).catch(() => {});
           }
        }
    },

    // --- AUTOCOMPLETE HANDLER ---
    async autocomplete(interaction) {
        const focusedOption = interaction.options.getFocused(true);
        const subcommand = interaction.options.getSubcommand();
        const choices = [];

        if (subcommand === 'map_role' && focusedOption.name === 'common_name') {
            const groupName = interaction.options.getString('group_name');
            
            const group = db.prepare('SELECT group_id FROM relay_groups WHERE group_name = ?').get(groupName);
            
            if (group) {
                // Query the database for all existing unique role_names in this group
                const aliases = db.prepare('SELECT DISTINCT role_name FROM role_mappings WHERE group_id = ? AND role_name LIKE ? LIMIT 25')
                    .all(group.group_id, `%${focusedOption.value}%`);
                
                // Format the results for Discord
                aliases.forEach(alias => {
                    choices.push({
                        name: alias.role_name,
                        value: alias.role_name,
                    });
                });
            }
            // Fallback if no group is selected, but the user is typing
            else if (!group && focusedOption.value.length > 0) {
                 choices.push({
                    name: `No group '${groupName}' found.`,
                    value: focusedOption.value,
                });
            }

            await interaction.respond(choices);
        }
    },
};