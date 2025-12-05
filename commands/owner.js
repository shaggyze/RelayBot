// commands/owner.js
const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const { exec } = require('child_process');
const db = require('../db/database.js');
const { getRateLimitDayString } = require('../utils/time.js');
const { isSupporter, getSupporterSet } = require('../utils/supporterManager.js');
const { uploadDatabase } = require('../utils/backupManager.js');

const BOT_OWNER_ID = '182938628643749888';
const PREMIUM_SKU_ID = '1436488229455925299';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

module.exports = {
    data: new SlashCommandBuilder()
        .setName('owner')
        .setDescription('Owner-only commands for managing the bot.')
        .addSubcommand(subcommand => subcommand.setName('list_groups').setDescription('Lists all global relay groups and their character usage stats.'))
        .addSubcommand(subcommand => subcommand.setName('delete_group').setDescription('[DANGER] Forcibly deletes a global group.').addStringOption(option => option.setName('name').setDescription('The exact name of the group to delete.').setRequired(true).setAutocomplete(true)))
        .addSubcommand(subcommand => subcommand.setName('prune_db').setDescription('Removes orphaned data and optionally prunes old message history or groups.').addBooleanOption(option => option.setName('include_inactive').setDescription('Also prune groups with zero total character usage and orphaned webhooks? (Default: False)')).addIntegerOption(option => option.setName('days').setDescription('Also prune groups inactive for this many days.')).addIntegerOption(option => option.setName('message_history_days').setDescription('Prune relayed messages older than this many days (e.g., 30).')).addBooleanOption(option => option.setName('prune_stats').setDescription('When pruning message history, also prune group_stats? (Default: False)')).addIntegerOption(option => option.setName('batch_size').setDescription('Number of messages to delete per batch (e.g., 10000). Use if disk is full.')))
        .addSubcommand(subcommand => subcommand.setName('upload_db').setDescription('Uploads the database to your secure web server endpoint.'))
        .addSubcommand(subcommand => subcommand.setName('leave_inactive').setDescription('Leaves servers that have had no relay activity for a specified time.').addIntegerOption(option => option.setName('days_inactive').setDescription('The number of days a server must be inactive to be considered for leaving.').setRequired(true)).addBooleanOption(option => option.setName('dry_run').setDescription('If true, will only list servers to leave without actually leaving. (Default: True)')))
        .addSubcommand(subcommand => subcommand.setName('rename_group').setDescription('[DANGER] Forcibly renames a global group.').addStringOption(option => option.setName('current_name').setDescription('The current name of the group you want to rename.').setRequired(true).setAutocomplete(true)).addStringOption(option => option.setName('new_name').setDescription('The new, unique name for the group.').setRequired(true)).addStringOption(option => option.setName('reason').setDescription('An optional reason for the name change to send to server owners.')))
        
        // --- [UPDATED SUBCOMMAND] Uses group_name with autocomplete ---
        .addSubcommand(subcommand =>
            subcommand
                .setName('check_subscription')
                .setDescription('Checks the subscription status for the server that owns a specific group.')
                .addStringOption(option =>
                    option.setName('group_name')
                        .setDescription('The name of the group to check.')
                        .setRequired(true)
                        .setAutocomplete(true)))
        
        .addSubcommand(subcommand => 
            subcommand.setName('stats')
                .setDescription('View stats for ANY group by name.')
                .addStringOption(option => option.setName('group_name').setDescription('The name of the group to check.').setRequired(true).setAutocomplete(true)))
    ,

    async execute(interaction) {
        if (interaction.user.id !== BOT_OWNER_ID) {
            return interaction.reply({ content: 'You do not have permission to use this command.', ephemeral: true });
        }

        const subcommand = interaction.options.getSubcommand();

        try {
            if (subcommand === 'list_groups') {
                await interaction.deferReply({ ephemeral: true });
                const allGroups = db.prepare(`SELECT rg.group_id, rg.group_name, rg.owner_guild_id, SUM(gs.character_count) as total_chars, COUNT(DISTINCT gs.day) as active_days, MAX(gs.day) as last_active_day FROM relay_groups rg LEFT JOIN group_stats gs ON rg.group_id = gs.group_id GROUP BY rg.group_id ORDER BY rg.group_name ASC`).all();
                if (allGroups.length === 0) return interaction.editReply({ content: 'There are currently no relay groups in the database.' });
                const supporterGuilds = new Set();
                for (const guild of interaction.client.guilds.cache.values()) {
                    if (guild.members.cache.some(member => !member.user.bot && isSupporter(member.id))) supporterGuilds.add(guild.id);
                }
                const subscribedGuilds = db.prepare('SELECT guild_id FROM guild_subscriptions WHERE is_active = 1').all();
                for (const row of subscribedGuilds) supporterGuilds.add(row.guild_id);
                
                const today = getRateLimitDayString();
                const todaysStatsRaw = db.prepare('SELECT group_id, character_count, warning_sent_at FROM group_stats WHERE day = ?').all(today);
                const todaysStatsMap = new Map(todaysStatsRaw.map(stat => [stat.group_id, { count: stat.character_count, paused: !!stat.warning_sent_at }]));
                const sevenDaysAgo = new Date();
                sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
                const descriptions = [];
                let currentDescription = '';
                for (const group of allGroups) {
                    await sleep(50); 
                    const ownerGuild = interaction.client.guilds.cache.get(group.owner_guild_id);
                    let ownerUserDetails = '';
                    if (ownerGuild) {
                        try {
                            const ownerUser = await ownerGuild.fetchOwner(); 
                            ownerUserDetails = ownerUser && ownerUser.user ? ` (Owner: ${ownerUser.user.tag} ID: \`${ownerUser.user.id}\`)` : ` (Owner: Unknown User ID: \`${ownerGuild.ownerId}\`)`;
                        } catch (e) { ownerUserDetails = ` (Owner: Unknown User ID: \`${ownerGuild.ownerId}\`)`; }
                    } else { ownerUserDetails = ` (Owner: Unknown Server ID: \`${group.owner_guild_id}\`)`; }
                    const todaysStats = todaysStatsMap.get(group.group_id) || { count: 0, paused: false };
                    const isPaused = todaysStats.paused;
                    const totalChars = group.total_chars || 0;
                    const lastActiveDate = group.last_active_day ? new Date(group.last_active_day) : null;
                    let statusEmoji = isPaused ? '🟡' : (totalChars === 0 ? '🔴' : (lastActiveDate && lastActiveDate < sevenDaysAgo ? '🟠' : '🟢'));
                    const linkedGuildIds = db.prepare('SELECT DISTINCT guild_id FROM linked_channels WHERE group_id = ?').all(group.group_id).map(r => r.guild_id);
                    const isSupporterGroup = linkedGuildIds.some(id => supporterGuilds.has(id));
                    const star = isSupporterGroup ? '⭐' : '';
                    const todaysChars = todaysStats.count;
                    const dailyAvg = (group.active_days > 0) ? Math.round(totalChars / group.active_days) : 0;
                    const groupLine = `${statusEmoji} ${star} **${group.group_name}** (Server: ${ownerGuild ? ownerGuild.name : 'Unknown'} ID: \`${group.owner_guild_id}\`)${ownerUserDetails}\n`;
                    const statsLine = `  └─ *Stats: ${todaysChars.toLocaleString()} today / ${totalChars.toLocaleString()} total / ${dailyAvg.toLocaleString()} avg.*\n`;
                    const fullLine = groupLine + statsLine;
                    if (currentDescription.length + fullLine.length > 4000) { descriptions.push(currentDescription); currentDescription = ''; }
                    currentDescription += fullLine;
                }
                descriptions.push(currentDescription);
                const embeds = descriptions.map((desc, index) => new EmbedBuilder().setTitle(`Global Relay Groups (Page ${index + 1}/${descriptions.length})`).setColor('#FFD700').setDescription(desc).setTimestamp().setFooter({ text: `Total Groups: ${allGroups.length} | 🟢 Active / 🟡 Paused / 🟠 Stale / 🔴 Inactive | ⭐ Supporter` }));
                await interaction.editReply({ embeds: [embeds[0]] });
                for (let i = 1; i < embeds.length; i++) await interaction.followUp({ embeds: [embeds[i]], ephemeral: true });

            } else if (subcommand === 'delete_group') {
                await interaction.deferReply({ ephemeral: true });
                const groupName = interaction.options.getString('name');
                const group = db.prepare('SELECT group_id, owner_guild_id FROM relay_groups WHERE group_name = ?').get(groupName);
                if (!group) return interaction.editReply({ content: `❌ No global group named "**${groupName}**" exists.` });
                db.prepare('DELETE FROM relay_groups WHERE group_id = ?').run(group.group_id);
                await interaction.editReply({ content: `✅ Successfully deleted global group "**${groupName}**" and all of its associated data.` });

            } else if (subcommand === 'prune_db') {
                await interaction.deferReply({ ephemeral: true });
                const includeInactive = interaction.options.getBoolean('include_inactive') ?? false;
                const inactiveGroupDays = interaction.options.getInteger('days');
                const messageHistoryDays = interaction.options.getInteger('message_history_days');
                const pruneStats = interaction.options.getBoolean('prune_stats') ?? false;
                const batchSize = interaction.options.getInteger('batch_size') ?? 10000; 
                let prunedGroups = 0, prunedLinks = 0, prunedMappings = 0, prunedWebhooks = 0;
                let totalPrunedMessages = 0, prunedStats = 0;
                const prunedGuilds = [];
                const groupIdsToDelete = new Set();
                const currentGuildIds = new Set(interaction.client.guilds.cache.keys());
                const groupOwners = db.prepare('SELECT DISTINCT owner_guild_id FROM relay_groups').all().map(r => r.owner_guild_id);
                const linkedGuilds = db.prepare('SELECT DISTINCT guild_id FROM linked_channels').all().map(r => r.guild_id);
                const mappedGuilds = db.prepare('SELECT DISTINCT guild_id FROM role_mappings').all().map(r => r.guild_id);
                const uniqueDbGuildIds = [...new Set([...groupOwners, ...linkedGuilds, ...mappedGuilds])];
                const guildsToPrune = uniqueDbGuildIds.filter(id => id && !currentGuildIds.has(id));
                if (guildsToPrune.length > 0) {
                    console.log(`[Manual Prune] Found ${guildsToPrune.length} orphaned guild(s) to clean up.`);
                    for (const guildId of guildsToPrune) {
                        const groups = db.prepare('DELETE FROM relay_groups WHERE owner_guild_id = ?').run(guildId);
                        const links = db.prepare('DELETE FROM linked_channels WHERE guild_id = ?').run(guildId);
                        const mappings = db.prepare('DELETE FROM role_mappings WHERE guild_id = ?').run(guildId);
                        prunedGroups += groups.changes; prunedLinks += links.changes; prunedMappings += mappings.changes; prunedGuilds.push(guildId);
                    }
                }
                if (includeInactive) {
                    const groupsWithZeroUsage = db.prepare(`SELECT rg.group_id FROM relay_groups rg LEFT JOIN (SELECT group_id, SUM(character_count) as total_chars FROM group_stats GROUP BY group_id) gs ON rg.group_id = gs.group_id WHERE gs.total_chars IS NULL OR gs.total_chars = 0`).all();
                    groupsWithZeroUsage.forEach(g => groupIdsToDelete.add(g.group_id));
                }
                if (inactiveGroupDays !== null && inactiveGroupDays > 0) {
                    const cutoffDateForGroups = new Date(); cutoffDateForGroups.setDate(cutoffDateForGroups.getDate() - inactiveGroupDays);
                    const cutoffDateStringForGroups = cutoffDateForGroups.toISOString().slice(0, 10);
                    const staleGroups = db.prepare(`SELECT DISTINCT group_id FROM relay_groups WHERE group_id NOT IN (SELECT DISTINCT group_id FROM group_stats WHERE day >= ?)`).all(cutoffDateStringForGroups);
                    staleGroups.forEach(g => groupIdsToDelete.add(g.group_id));
                }
                if (groupIdsToDelete.size > 0) {
                    const ids = Array.from(groupIdsToDelete);
                    const placeholders = ids.map(() => '?').join(',');
                    const stmt = db.prepare(`DELETE FROM relay_groups WHERE group_id IN (${placeholders})`);
                    const result = stmt.run(...ids);
                    prunedGroups += result.changes;
                }
                if (includeInactive) {
                    console.log(`[Manual Prune] Scanning for orphaned webhooks.`);
                    const allDbWebhooks = new Set(db.prepare('SELECT webhook_url FROM linked_channels').all().map(r => r.webhook_url));
                    for (const guild of interaction.client.guilds.cache.values()) {
                        await sleep(200); 
                        try {
                            if (!guild.members.me?.permissions.has(PermissionFlagsBits.ManageWebhooks)) continue;
                            const webhooks = await guild.fetchWebhooks();
                            for (const webhook of webhooks.values()) {
                                if (webhook.owner.id === interaction.client.user.id && !allDbWebhooks.has(webhook.url)) {
                                    await webhook.delete('Pruning orphaned RelayBot webhook.');
                                    prunedWebhooks++;
                                }
                            }
                        } catch (error) { console.error(`[Manual Prune] Error fetching/deleting webhooks: ${error.message}`); }
                    }
                }
                if (messageHistoryDays !== null && messageHistoryDays > 0) {
                    await interaction.editReply({ content: `Pruning message history older than ${messageHistoryDays} days in batches of ${batchSize}...` });
                    const cutoffDate = new Date(); cutoffDate.setDate(cutoffDate.getDate() - messageHistoryDays);
                    const discordEpoch = 1420070400000n; const cutoffTimestamp = BigInt(cutoffDate.getTime()); 
                    const discordEpochCutoffBigInt = (cutoffTimestamp - discordEpoch) << 22n; const cutoffIdString = discordEpochCutoffBigInt.toString();
                    let prunedInBatch = 0;
                    const stmt = db.prepare(`DELETE FROM relayed_messages WHERE id IN (SELECT id FROM relayed_messages WHERE original_message_id < ? LIMIT ?)`);
                    do {
                        const result = stmt.run(cutoffIdString, batchSize);
                        prunedInBatch = result.changes;
                        totalPrunedMessages += prunedInBatch;
                    } while (prunedInBatch > 0);
                    if (pruneStats) {
                        const cutoffDayString = cutoffDate.toISOString().slice(0, 10);
                        const resultStats = db.prepare("DELETE FROM group_stats WHERE day < ?").run(cutoffDayString);
                        prunedStats = resultStats.changes;
                    }
                }
                const resultsEmbed = new EmbedBuilder().setTitle('Database & Pruning Operations Complete').setColor('#5865F2').setDescription(`Pruning tasks finished.`).addFields({ name: 'Orphaned Server Data', value: `Cleaned up data for **${prunedGuilds.length}** orphaned server(s).`, inline: true }, { name: 'Groups Deleted (Total)', value: `${prunedGroups}`, inline: true }, { name: 'Channel Links Deleted', value: `${prunedLinks}`, inline: true }, { name: 'Role Mappings Deleted', value: `${prunedMappings}`, inline: true }, { name: 'Orphaned Webhooks Pruned', value: `${prunedWebhooks}`, inline: true });
                if (messageHistoryDays !== null && messageHistoryDays > 0) {
                    let statsPruningStatus = `(Group stats were intentionally left intact)`;
                    if (pruneStats) { statsPruningStatus = `Pruned **${prunedStats}** group stats entries.`; }
                    resultsEmbed.addFields({ name: `Message History (Older than ${messageHistoryDays} days)`, value: `Pruned **${totalPrunedMessages}** message links. ${statsPruningStatus}`, inline: false });
                }
                await interaction.editReply({ content: "Pruning complete. Now reclaiming disk space...", embeds: [resultsEmbed] });
                try {
                    db.exec('VACUUM');
                    const finalEmbed = new EmbedBuilder(resultsEmbed.toJSON()).setFooter({ text: 'Disk space has been successfully reclaimed.' });
                    await interaction.editReply({ content: "Pruning and space reclamation complete!", embeds: [finalEmbed] });
                } catch (vacuumError) { await interaction.editReply({ content: 'Pruning complete, but VACUUM failed.' }); }

            } else if (subcommand === 'upload_db') {
                await interaction.deferReply({ ephemeral: true });
                try {
                    const response = await uploadDatabase();
                    const successEmbed = new EmbedBuilder().setTitle('Database Upload Successful').setColor('#5865F2').setDescription(`The database has been uploaded and is ready for download.\n\n**[Click Here to Download](${response.url})**`).addFields({ name: 'Filename', value: `\`${response.filename}\`` }).setFooter({ text: 'Do not share this link.' }).setTimestamp();
                    await interaction.editReply({ embeds: [successEmbed] });
                } catch (error) { await interaction.editReply({ content: `❌ **Upload Failed:** ${error.message}` }); }

            } else if (subcommand === 'leave_inactive') {
                await interaction.deferReply({ ephemeral: true });
                const daysInactive = interaction.options.getInteger('days_inactive');
                const isDryRun = interaction.options.getBoolean('dry_run') ?? true; 
                if (daysInactive <= 0) return interaction.editReply({ content: '❌ Please provide a positive number of days.' });
                const cutoffDate = new Date(); cutoffDate.setDate(cutoffDate.getDate() - daysInactive); const cutoffDateString = cutoffDate.toISOString().slice(0, 10);
                const activeGuildsQuery = db.prepare(`SELECT DISTINCT lc.guild_id FROM linked_channels lc JOIN group_stats gs ON lc.group_id = gs.group_id WHERE gs.day >= ?`).all(cutoffDateString);
                const activeGuildIds = new Set(activeGuildsQuery.map(row => row.guild_id));
                const allGuildsIn = Array.from(interaction.client.guilds.cache.values());
                const inactiveGuilds = allGuildsIn.filter(guild => !activeGuildIds.has(guild.id));
                if (inactiveGuilds.length === 0) return interaction.editReply({ content: `✅ No inactive servers found matching the criteria.` });
                if (isDryRun) {
                    const serverList = inactiveGuilds.slice(0, 20).map(g => `• ${g.name} (ID: \`${g.id}\`)`).join('\n');
                    const extraCount = inactiveGuilds.length - 20;
                    const extraText = extraCount > 0 ? `\n...and ${extraCount} more.` : '';
                    const embed = new EmbedBuilder().setTitle(`Dry Run: Inactive Servers to Leave (${inactiveGuilds.length})`).setColor('#FFA500').setDescription(`The following servers have had no relay activity in the last **${daysInactive}** days:\n\n${serverList}${extraText}`).setFooter({ text: 'To proceed, run this command again with the `dry_run` option set to `False`.' });
                    return interaction.editReply({ embeds: [embed] });
                } else {
                    let successCount = 0; let failCount = 0; let dbCleanupCount = 0; const failedGuilds = [];
                    await interaction.editReply({ content: `Leaving ${inactiveGuilds.length} inactive servers... This may take a moment.` });
                    for (const guild of inactiveGuilds) {
                        await sleep(1000); 
                        try {
                            await guild.leave(); console.log(`[INACTIVE-LEAVE] Successfully left guild: ${guild.name} (${guild.id})`); successCount++;
                            const links = db.prepare('DELETE FROM linked_channels WHERE guild_id = ?').run(guild.id);
                            const roles = db.prepare('DELETE FROM role_mappings WHERE guild_id = ?').run(guild.id);
                            const subs = db.prepare('DELETE FROM guild_subscriptions WHERE guild_id = ?').run(guild.id);
                            const groups = db.prepare('DELETE FROM relay_groups WHERE owner_guild_id = ?').run(guild.id);
                            if (links.changes > 0 || roles.changes > 0 || groups.changes > 0) dbCleanupCount++;
                        } catch (error) { console.error(`[INACTIVE-LEAVE] FAILED to leave guild: ${guild.name} (${guild.id}). Error: ${error.message}`); failCount++; if (failedGuilds.length < 10) failedGuilds.push(`• ${guild.name} (\`${guild.id}\`)`); }
                    }
                    const embed = new EmbedBuilder().setTitle('Inactive Server Cleanup Complete').setColor('#5865F2').setDescription(`Operation finished.`).addFields({ name: 'Servers Left', value: `${successCount}`, inline: true }, { name: 'DB Records Cleaned', value: `${dbCleanupCount} Servers`, inline: true }, { name: 'Failed to Leave', value: `${failCount}`, inline: true });
                    if (failCount > 0) { embed.addFields({ name: 'Failed Servers (Sample)', value: failedGuilds.join('\n') }); }
                    return interaction.editReply({ content: '', embeds: [embed] });
                }

            } else if (subcommand === 'rename_group') {
                await interaction.deferReply({ ephemeral: true });
                const currentName = interaction.options.getString('current_name');
                const newName = interaction.options.getString('new_name');
                const reason = interaction.options.getString('reason'); 
                const group = db.prepare('SELECT group_id, owner_guild_id FROM relay_groups WHERE group_name = ?').get(currentName);
                if (!group) return interaction.editReply({ content: `❌ **Error:** No relay group found with the name "${currentName}".` });
                const linkedGuildIds = db.prepare('SELECT DISTINCT guild_id FROM linked_channels WHERE group_id = ?').all(group.group_id).map(row => row.guild_id);
                const ownerNotificationMap = new Map();
                for (const guildId of linkedGuildIds) {
                    await sleep(100);
                    try {
                        const guild = await interaction.client.guilds.fetch(guildId);
                        const owner = await guild.fetchOwner();
                        if (!ownerNotificationMap.has(owner.id)) { ownerNotificationMap.set(owner.id, { ownerObject: owner, guilds: [] }); }
                        ownerNotificationMap.get(owner.id).guilds.push(guild.name);
                    } catch (e) {}
                }
                try {
                    const result = db.prepare('UPDATE relay_groups SET group_name = ? WHERE group_id = ?').run(newName, group.group_id);
                    if (result.changes > 0) {
                        let notifiedOwners = 0; let failedNotifications = 0;
                        let notificationMessage = `📢 **RelayBot Notification**\n\nThe relay group "**${currentName}**" has been renamed to "**${newName}**" by the Bot Owner.`;
                        if (reason) notificationMessage += `\n\n**Reason:** *${reason}*`;
                        notificationMessage += `\n\nYour relays will continue to function, but you must use the new name for any future commands. Please save this new name for your records.`;
                        for (const [ownerId, data] of ownerNotificationMap.entries()) {
                            if (ownerId === interaction.user.id) continue;
                            await sleep(500); 
                            try {
                                const finalMessage = `${notificationMessage}\n\n*This change affects your server(s): ${data.guilds.join(', ')}*`;
                                await data.ownerObject.send(finalMessage);
                                notifiedOwners++;
                            } catch (e) { failedNotifications++; }
                        }
                        let notificationReport = '';
                        if (notifiedOwners > 0 || failedNotifications > 0) { notificationReport = `\n\n📢 DMs were sent to **${notifiedOwners}** unique server owners. **${failedNotifications}** owners could not be reached.`; }
                        await interaction.editReply({ content: `✅ **Success!** Group "**${currentName}**" has been renamed to "**${newName}**".${notificationReport}` });
                    } else { await interaction.editReply({ content: 'An unexpected error occurred. The group name was not changed.' }); }
                } catch (error) {
                    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') { await interaction.editReply({ content: `❌ **Error:** A global group named "**${newName}**" already exists. Please choose a different name.` }); } else { throw error; }
                }

            // --- [UPDATED SUBCOMMAND] Logic ---
            } else if (subcommand === 'check_subscription') {
                await interaction.deferReply({ ephemeral: true });
                
                // [THE FIX] Get the group name
                const groupName = interaction.options.getString('group_name');

                // 1. Look up the group
                const group = db.prepare('SELECT group_id, owner_guild_id, group_name FROM relay_groups WHERE group_name = ?').get(groupName);

                if (!group) {
                    return interaction.editReply({ content: `❌ **Error:** No relay group found with the name "**${groupName}**".` });
                }

                const guildId = group.owner_guild_id;

                // 2. Fetch the guild (Owner's Server)
                const guild = await interaction.client.guilds.fetch(guildId).catch(() => null);
                
                if (!guild) {
                    return interaction.editReply({ content: `❌ **Error:** I am not a member of the group owner's server (ID: \`${guildId}\`). I cannot check their entitlements.` });
                }

                try {
                    const entitlements = await interaction.client.application.entitlements.fetch({ guildId: guild.id });
                    const activeSub = entitlements.find(e => e.skuId === PREMIUM_SKU_ID && e.isActive());
                    const dbSub = db.prepare('SELECT * FROM guild_subscriptions WHERE guild_id = ?').get(guild.id);
                    
                    const embed = new EmbedBuilder()
                        .setTitle(`Subscription Status for Group: ${group.group_name}`)
                        .setDescription(`**Owner Server:** ${guild.name} (ID: \`${guild.id}\`)`)
                        .setColor(activeSub ? '#23A559' : '#ED4245');

                    if (activeSub) {
                        const typeStr = activeSub.type === 8 ? 'TEST ENTITLEMENT' : 'Real Subscription';
                        embed.addFields(
                            { name: 'Live API Status', value: '✅ Active Subscription Found' },
                            { name: 'Entitlement Type', value: `**${typeStr}** (Type: ${activeSub.type})` },
                            { name: 'Created', value: `<t:${Math.floor(activeSub.createdTimestamp / 1000)}:R>`, inline: true },
                            { name: 'Ends/Renews', value: activeSub.endsTimestamp ? `<t:${Math.floor(activeSub.endsTimestamp / 1000)}:R>` : 'Never', inline: true },
                            { name: 'Entitlement ID', value: `\`${activeSub.id}\``, inline: false }
                        );
                    } else { 
                        embed.addFields({ name: 'Live API Status', value: '❌ No active subscription found for owner server.' }); 
                    }
                    
                    if (dbSub) { 
                        embed.addFields(
                            { name: 'Database Cache Status', value: dbSub.is_active ? '✅ Active' : '❌ Inactive' }, 
                            { name: 'Last Synced', value: `<t:${Math.floor(dbSub.updated_at / 1000)}:R>`, inline: true }
                        ); 
                    } else { 
                        embed.addFields({ name: 'Database Cache Status', value: '🤔 No record found.' }); 
                    }
                    
                    await interaction.editReply({ embeds: [embed] });

                } catch (error) {
                    console.error(`[SUB-CHECK] Failed to fetch entitlements for guild ${guild.id}:`, error);
                    await interaction.editReply({ content: `An error occurred while fetching entitlements for **${guild.name}**:\n\`\`\`${error.message}\`\`\`` });
                }

            } else if (subcommand === 'stats') {
                await interaction.deferReply({ ephemeral: true });
                const paramGroupName = interaction.options.getString('group_name');
                
                const group = db.prepare('SELECT group_id, group_name FROM relay_groups WHERE group_name = ?').get(paramGroupName);
                if (!group) {
                    return interaction.editReply({ content: `❌ **Error:** No relay group found with the name "${paramGroupName}".` });
                }
                const groupId = group.group_id;
                const groupNameDisplay = group.group_name;

                const uniqueGuildIds = db.prepare('SELECT DISTINCT guild_id FROM linked_channels WHERE group_id = ?').all(groupId).map(row => row.guild_id);
                let totalMembers = 0;
                let accessibleServerCount = 0;
                // Sets to store unique data
                const uniqueSupporterIds = new Set();
                const uniqueSupporterTags = new Set(); // Store usernames

                const supporterSet = getSupporterSet();

                for (const guildId of uniqueGuildIds) {
                    const guild = interaction.client.guilds.cache.get(guildId);
                    if (guild) {
                        try {
                            const members = await guild.members.fetch();
                            totalMembers += guild.memberCount;
                            accessibleServerCount++;
                            
                            members.forEach(member => {
                                if (supporterSet.has(member.user.id)) {
                                    uniqueSupporterIds.add(member.user.id);
                                    uniqueSupporterTags.add(member.user.tag); // Capture username/tag
                                }
                            });
                        } catch (fetchError) {
                            // Fallback if fetch fails (use cache)
                            totalMembers += guild.memberCount; 
                            accessibleServerCount++;
                            guild.members.cache.forEach(member => { 
                                if (supporterSet.has(member.user.id)) {
                                    uniqueSupporterIds.add(member.user.id);
                                    uniqueSupporterTags.add(member.user.tag);
                                }
                            });
                        }
                    }
                }
                
                const totalSupporters = uniqueSupporterIds.size;
                const serverCount = uniqueGuildIds.length;
                const channelCount = db.prepare('SELECT COUNT(channel_id) as count FROM linked_channels WHERE group_id = ?').get(groupId).count;
                
                const groupStatsSummary = db.prepare(`SELECT SUM(character_count) as total_chars, COUNT(DISTINCT day) as active_days, MIN(day) as first_active_day, MAX(day) as last_active_day FROM group_stats WHERE group_id = ?`).get(groupId);
                const totalChars = groupStatsSummary?.total_chars || 0;
                const activeDays = groupStatsSummary?.active_days || 0;
                const firstActiveDay = groupStatsSummary?.first_active_day || 'N/A';
                const lastActiveDay = groupStatsSummary?.last_active_day || 'N/A';
                const dailyAvg = (activeDays > 0) ? Math.round(totalChars / activeDays) : 0;

                const todayString = getRateLimitDayString();
                const todaysGroupStats = db.prepare('SELECT warning_sent_at FROM group_stats WHERE group_id = ? AND day = ?').get(groupId, todayString);
                
                let statusValue = '';
                if (totalSupporters > 0) { statusValue = '✅ Active (Supporter Bypass)'; } 
                else if (todaysGroupStats && todaysGroupStats.warning_sent_at) { statusValue = '🔴 Paused (Daily Limit Reached)'; } 
                else { statusValue = '🟢 Active'; }

                // Format Supporter List
                // Join everyone with a comma.
                let supporterListString = Array.from(uniqueSupporterTags).join(', ');

                // Discord Embed Field Limit is 1024 characters.
                // Only truncate if the generated string is actually too long for Discord.
                if (supporterListString.length > 1024) {
                    supporterListString = supporterListString.substring(0, 1000) + '... (list truncated)';
                }
                
                if (supporterListString === '') supporterListString = 'None';

                const statsEmbed = new EmbedBuilder()
                    .setTitle(`📊 Relay Group Statistics for "${groupNameDisplay}"`)
                    .setColor('#5865F2')
                    .addFields(
                        { name: 'Status', value: statusValue, inline: true }, 
                        { name: 'Linked Servers', value: `${serverCount} (Bot in ${accessibleServerCount})`, inline: true },
                        { name: 'Linked Channels', value: `${channelCount}`, inline: true },
                        { name: 'Active Supporters', value: `${totalSupporters}`, inline: true }, 
                        { name: 'Total Alliance Members', value: `${totalMembers.toLocaleString()}`, inline: true },
                        { name: 'Days with Activity', value: `${activeDays}`, inline: true },
                        { name: 'First Activity', value: `${firstActiveDay}`, inline: true },
                        { name: 'Last Activity', value: `${lastActiveDay}`, inline: true },
                        { name: 'Total Chars Relayed', value: `${(totalChars || 0).toLocaleString()}`, inline: true },
                        { name: 'Daily Average Chars', value: `${dailyAvg.toLocaleString()}`, inline: true },
                        // [UPDATED] Shows everyone unless it hits the 1024 char limit
                        { name: `Active Supporters List (${totalSupporters})`, value: `\`\`\`${supporterListString}\`\`\``, inline: false }
                    )
                    .setFooter({ text: `Owner view.` })
                    .setTimestamp();
                
                await interaction.editReply({ embeds: [statsEmbed] });
            }

        } catch (error) {
           console.error(`Error in /owner ${subcommand}:`, error);
           if (interaction.deferred || interaction.replied) {
               await interaction.editReply({ content: 'An unknown error occurred while executing this command.' }).catch(() => {});
           } else if (!interaction.replied) {
               await interaction.reply({ content: 'An unknown error occurred while executing this command.', ephemeral: true }).catch(() => {});
           }
        }
    },

    // --- Autocomplete Handler ---
    async autocomplete(interaction) {
        const focusedOption = interaction.options.getFocused(true);
        const subcommand = interaction.options.getSubcommand();
        const choices = [];

        if ((subcommand === 'delete_group' && focusedOption.name === 'name') ||
            (subcommand === 'rename_group' && focusedOption.name === 'current_name') ||
            (subcommand === 'stats' && focusedOption.name === 'group_name') ||
            // [THE FIX] Added check_subscription to autocomplete handler
            (subcommand === 'check_subscription' && focusedOption.name === 'group_name')) {
            
            const searchTerm = focusedOption.value.length > 0 ? `%${focusedOption.value}%` : '%';
            const groups = db.prepare('SELECT group_name FROM relay_groups WHERE group_name LIKE ? LIMIT 25').all(searchTerm);
            
            groups.forEach(group => {
                choices.push({ name: group.group_name, value: group.group_name });
            });
        }
        
        await interaction.respond(choices);
    },
};