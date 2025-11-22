// commands/owner.js
const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const { exec } = require('child_process');
const db = require('../db/database.js');
const { getRateLimitDayString } = require('../utils/time.js');
const { isSupporter } = require('../utils/supporterManager.js');
const { uploadDatabase } = require('../utils/backupManager.js');

const BOT_OWNER_ID = '182938628643749888';
const PREMIUM_SKU_ID = '1436488229455925299';

module.exports = {
    data: new SlashCommandBuilder()
        .setName('owner')
        .setDescription('Owner-only commands for managing the bot.')
        .addSubcommand(subcommand =>
            subcommand
                .setName('list_groups')
                .setDescription('Lists all global relay groups and their character usage stats.'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('delete_group')
                .setDescription('[DANGER] Forcibly deletes a global group and makes the bot leave the owner\'s server.')
                .addStringOption(option => option.setName('name').setDescription('The exact name of the group to delete.').setRequired(true).setAutocomplete(true)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('rename_group')
                .setDescription('[DANGER] Forcibly renames a global group.')
                .addStringOption(option => option.setName('current_name').setDescription('The current name of the group you want to rename.').setRequired(true).setAutocomplete(true))
                .addStringOption(option => option.setName('new_name').setDescription('The new, unique name for the group.').setRequired(true))
                .addStringOption(option => option.setName('reason').setDescription('An optional reason for the name change to send to server owners.').setRequired(false)))
        .addSubcommand(subcommand =>
            subcommand
				.setName('prune_db')
                .setDescription('Removes orphaned data and optionally prunes old message history or groups.')
                .addBooleanOption(option =>
                    option.setName('include_inactive')
                        .setDescription('Also prune groups with zero total character usage and orphaned webhooks? (Default: False)'))
                .addIntegerOption(option =>
                    option.setName('days') // For pruning GROUPS based on inactivity days
                        .setDescription('Also prune groups inactive for this many days.'))
                .addIntegerOption(option =>
                    option.setName('message_history_days')
                        .setDescription('Prune relayed messages older than this many days (e.g., 30).'))
                // NEW OPTION TO CONTROL group_stats pruning
                .addBooleanOption(option =>
                    option.setName('prune_stats')
                        .setDescription('Also prune group_stats older than message_history_days? (Default: False)') // Shortened description
                )
                .addIntegerOption(option =>
                    option.setName('batch_size')
                        .setDescription('Number of messages to delete per batch (e.g., 10000). Use if disk is full.')))
        .addSubcommand(subcommand =>
            subcommand
                .setName('upload_db')
                .setDescription('Uploads the database to your secure web server endpoint.'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('leave_inactive')
                .setDescription('Leaves servers that have had no relay activity for a specified time.')
                .addIntegerOption(option =>
                    option.setName('days_inactive')
                        .setDescription('The number of days a server must be inactive to be considered for leaving.')
                        .setRequired(true))
                .addBooleanOption(option =>
                    option.setName('dry_run')
                        .setDescription('If true, will only list servers to leave without actually leaving. (Default: True)')))
        // --- [MODIFIED SUBCOMMAND] ---
        .addSubcommand(subcommand =>
            subcommand
                .setName('check_subscription')
                .setDescription('Checks the subscription status of a group\'s owner server.')
                .addStringOption(option =>
                    option.setName('group_name')
                        .setDescription('The name of the group to check.')
                        .setRequired(true)
                        .setAutocomplete(true))) // Enable autocomplete
    ,
    async execute(interaction) {
        if (interaction.user.id !== BOT_OWNER_ID) {
            return interaction.reply({ content: 'You do not have permission to use this command.', ephemeral: true });
        }

        const subcommand = interaction.options.getSubcommand();

        try {
            if (subcommand === 'list_groups') {
                await interaction.deferReply({ ephemeral: true });

                const allGroups = db.prepare(`
                    SELECT 
                        rg.group_id, rg.group_name, rg.owner_guild_id,
                        SUM(gs.character_count) as total_chars,
                        COUNT(DISTINCT gs.day) as active_days,
                        MAX(gs.day) as last_active_day
                    FROM relay_groups rg
                    LEFT JOIN group_stats gs ON rg.group_id = gs.group_id
                    GROUP BY rg.group_id ORDER BY rg.group_name ASC
                `).all();

                if (allGroups.length === 0) {
                    return interaction.editReply({ content: 'There are currently no relay groups in the database.' });
                }

                const supporterGuilds = new Set();
                for (const guild of interaction.client.guilds.cache.values()) {
                    if (guild.members.cache.some(member => !member.user.bot && isSupporter(member.id))) {
                        supporterGuilds.add(guild.id);
                    }
                }


                const subscribedGuilds = db.prepare('SELECT guild_id FROM guild_subscriptions WHERE is_active = 1').all();
                for (const row of subscribedGuilds) {
                    supporterGuilds.add(row.guild_id);
                }

                const today = getRateLimitDayString(); // Assuming getRateLimitDayString is in scope
                const todaysStatsRaw = db.prepare('SELECT group_id, character_count, warning_sent_at FROM group_stats WHERE day = ?').all(today);
                const todaysStatsMap = new Map(todaysStatsRaw.map(stat => [stat.group_id, { count: stat.character_count, paused: !!stat.warning_sent_at }]));

                const sevenDaysAgo = new Date();
                sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

                const descriptions = [];
                let currentDescription = '';

                for (const group of allGroups) {
                    const ownerGuild = interaction.client.guilds.cache.get(group.owner_guild_id);
                    
                    // [THE FIX] Get owner user info for THIS group's owner guild
                    let ownerUserDetails = '';
                    if (ownerGuild) {
                        try {
                            const ownerUser = await ownerGuild.fetchOwner(); // Fetch the owner's user object
                            if (ownerUser && ownerUser.user) {
                                ownerUserDetails = ` (Owner: ${ownerUser.user.tag} ID: \`${ownerUser.user.id}\`)`;
                            } else if (ownerUser) {
                                ownerUserDetails = ` (Owner: ${ownerUser.tag} ID: \`${ownerUser.id}\`)`;
                            } else {
                                ownerUserDetails = ` (Owner: Unknown User ID: \`${ownerGuild.ownerId}\`)`;
                            }
                        } catch (e) {
                            console.warn(`[LIST_GROUPS] Could not fetch owner for group owner guild ${ownerGuild.name} (${group.owner_guild_id}): ${e.message}`);
                            ownerUserDetails = ` (Owner: Unknown User ID: \`${ownerGuild.ownerId}\`)`;
                        }
                    } else {
                        ownerUserDetails = ` (Owner: Unknown Server ID: \`${group.owner_guild_id}\`)`;
                    }
                    
                    const todaysStats = todaysStatsMap.get(group.group_id) || { count: 0, paused: false };
                    const isPaused = todaysStats.paused;
                    const totalChars = group.total_chars || 0;
                    const lastActiveDate = group.last_active_day ? new Date(group.last_active_day) : null;

                    let statusEmoji;
                    if (isPaused) {
                        statusEmoji = '🟡'; // Paused (rate-limited)
                    } else if (totalChars === 0) {
                        statusEmoji = '🔴'; // Inactive (zero total usage)
                    } else if (lastActiveDate && lastActiveDate < sevenDaysAgo) {
                        statusEmoji = '🟠'; // Stale (inactive for 7+ days)
                    } else {
                        statusEmoji = '🟢'; // Active
                    }
                    
                    const linkedGuildIds = db.prepare('SELECT DISTINCT guild_id FROM linked_channels WHERE group_id = ?').all(group.group_id).map(r => r.guild_id);
                    const isSupporterGroup = linkedGuildIds.some(id => supporterGuilds.has(id));
                    const star = isSupporterGroup ? '⭐' : '';
                    
                    const todaysChars = todaysStats.count;
                    const dailyAvg = (group.active_days > 0) ? Math.round(totalChars / group.active_days) : 0;
                    
                    // [THE FIX] Append owner user details to the group line
                    const groupLine = `${statusEmoji} ${star} **${group.group_name}** (Server: ${ownerGuild ? ownerGuild.name : 'Unknown'} ID: \`${group.owner_guild_id}\`)${ownerUserDetails}\n`;
                    const statsLine = `  └─ *Stats: ${todaysChars.toLocaleString()} today / ${totalChars.toLocaleString()} total / ${dailyAvg.toLocaleString()} avg.*\n`;
                    const fullLine = groupLine + statsLine;

                    if (currentDescription.length + fullLine.length > 4000) {
                        descriptions.push(currentDescription);
                        currentDescription = '';
                    }
                    currentDescription += fullLine;
                }
                descriptions.push(currentDescription);

                const embeds = descriptions.map((desc, index) => {
                    return new EmbedBuilder()
                        .setTitle(`Global Relay Groups (Page ${index + 1}/${descriptions.length})`)
                        .setColor('#FFD700')
                        .setDescription(desc)
                        .setTimestamp()
                        .setFooter({ text: `Total Groups: ${allGroups.length} | 🟢 Active / 🟡 Paused / 🟠 Stale / 🔴 Inactive | ⭐ Supporter` });
                });

                await interaction.editReply({ embeds: [embeds[0]] });
                for (let i = 1; i < embeds.length; i++) {
                    await interaction.followUp({ embeds: [embeds[i]], ephemeral: true });
                }
            } else if (subcommand === 'delete_group') {
                await interaction.deferReply({ ephemeral: true });
                const groupName = interaction.options.getString('name');
                const group = db.prepare('SELECT group_id, owner_guild_id FROM relay_groups WHERE group_name = ?').get(groupName);
                if (!group) return interaction.editReply({ content: `Error: No group found with the exact name "${groupName}".` });

                const result = db.prepare('DELETE FROM relay_groups WHERE group_id = ?').run(group.group_id);
                let responseMessage = '';
                if (result.changes > 0) {
                    responseMessage += `✅ **Success:** Forcibly deleted the global group "**${groupName}**".`;
                } else {
                    return interaction.editReply({ content: 'An unexpected error occurred. The group was not deleted.' });
                }
                try {
                    const guildToLeave = await interaction.client.guilds.fetch(group.owner_guild_id);
                    if (guildToLeave) {
                        await guildToLeave.leave();
                        responseMessage += `\n\nAdditionally, I have successfully left the owner's server, **${guildToLeave.name}**.`;
                    }
                } catch (error) {
                    responseMessage += `\n\nI was unable to leave the owner's server (ID: \`${group.owner_guild_id}\`).`;
                }
                await interaction.editReply({ content: responseMessage });
            } else if (subcommand === 'prune_db') {
                await interaction.deferReply({ ephemeral: true });
                const includeInactive = interaction.options.getBoolean('include_inactive') ?? false;
                const inactiveGroupDays = interaction.options.getInteger('days');
                const messageHistoryDays = interaction.options.getInteger('message_history_days');
                const pruneStats = interaction.options.getBoolean('prune_stats') ?? false;
                // [THE FIX] Get the batch size, with a default value.
                const batchSize = interaction.options.getInteger('batch_size') ?? 10000; // Default to 10,000 if not provided

                let prunedGroups = 0, prunedLinks = 0, prunedMappings = 0, prunedWebhooks = 0;
                let totalPrunedMessages = 0, prunedStats = 0;
                const prunedGuilds = [];
                const groupIdsToDelete = new Set();

                // --- 1. Prune Data from Orphaned Servers ---
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
                        prunedGroups += groups.changes;
                        prunedLinks += links.changes;
                        prunedMappings += mappings.changes;
                        prunedGuilds.push(guildId);
                    }
                    console.log(`[Manual Prune] Cleaned up orphaned server data.`);
                }

                // --- 2. Prune Inactive Groups (if requested by 'include_inactive') ---
                if (includeInactive) {
                    console.log(`[Manual Prune] Identifying groups with zero total character usage.`);
                    const groupsWithZeroUsage = db.prepare(`
                        SELECT rg.group_id 
                        FROM relay_groups rg 
                        LEFT JOIN (
                            SELECT group_id, SUM(character_count) as total_chars 
                            FROM group_stats 
                            GROUP BY group_id
                        ) gs ON rg.group_id = gs.group_id 
                        WHERE gs.total_chars IS NULL OR gs.total_chars = 0
                    `).all();
                    
                    groupsWithZeroUsage.forEach(g => groupIdsToDelete.add(g.group_id));
                    console.log(`[Manual Prune] Found ${groupsWithZeroUsage.length} groups with zero usage to be deleted.`);
                }

                // --- 3. Prune Stale Groups (if requested by 'days' option) ---
                if (inactiveGroupDays !== null && inactiveGroupDays > 0) {
                    console.log(`[Manual Prune] Identifying groups inactive for more than ${inactiveGroupDays} days.`);
                    const cutoffDateForGroups = new Date();
                    cutoffDateForGroups.setDate(cutoffDateForGroups.getDate() - inactiveGroupDays);
                    const cutoffDateStringForGroups = cutoffDateForGroups.toISOString().slice(0, 10);

                    const staleGroups = db.prepare(`
                        SELECT DISTINCT group_id FROM relay_groups 
                        WHERE group_id NOT IN (
                            SELECT DISTINCT group_id FROM group_stats WHERE day >= ?
                        )
                    `).all(cutoffDateStringForGroups);
                    
                    staleGroups.forEach(g => groupIdsToDelete.add(g.group_id));
                    console.log(`[Manual Prune] Found ${staleGroups.length} stale groups (based on days) to be deleted.`);
                }

                // Delete all collected inactive/stale groups from relay_groups
                if (groupIdsToDelete.size > 0) {
                    const ids = Array.from(groupIdsToDelete);
                    const placeholders = ids.map(() => '?').join(',');
                    const stmt = db.prepare(`DELETE FROM relay_groups WHERE group_id IN (${placeholders})`);
                    const result = stmt.run(...ids);
                    prunedGroups += result.changes;
                    console.log(`[Manual Prune] Deleted ${result.changes} groups based on inactivity/zero usage.`);
                }

                // --- 4. Prune Orphaned Webhooks ---
                if (includeInactive) {
                    console.log(`[Manual Prune] Scanning for orphaned webhooks.`);
                    const allDbWebhooks = new Set(db.prepare('SELECT webhook_url FROM linked_channels').all().map(r => r.webhook_url));
                    let webhooksScannedInGuilds = 0;
                    for (const guild of interaction.client.guilds.cache.values()) {
                        try {
                            if (!guild.members.me?.permissions.has(PermissionFlagsBits.ManageWebhooks)) continue;
                            const webhooks = await guild.fetchWebhooks();
                            for (const webhook of webhooks.values()) {
                                if (webhook.owner.id === interaction.client.user.id && !allDbWebhooks.has(webhook.url)) {
                                    console.log(`[Manual Prune] Deleting orphaned webhook on guild ${guild.name} (${guild.id}). Hook: ${webhook.url}`);
                                    await webhook.delete('Pruning orphaned RelayBot webhook.');
                                    prunedWebhooks++;
                                }
                            }
                            webhooksScannedInGuilds++;
                        } catch (error) {
                            console.error(`[Manual Prune] Error fetching/deleting webhooks for guild ${guild.id}: ${error.message}`);
                        }
                    }
                    console.log(`[Manual Prune] Scanned ${webhooksScannedInGuilds} guilds for orphaned webhooks.`);
                }
                
                // --- SECTION: Prune Old Message Links AND Group Stats (if requested) ---
                if (messageHistoryDays !== null && messageHistoryDays > 0) {
                    await interaction.editReply({ content: `Pruning message history older than ${messageHistoryDays} days in batches of ${batchSize}. This may take a while...` });

                    const cutoffDate = new Date();
                    cutoffDate.setDate(cutoffDate.getDate() - messageHistoryDays);

                    // --- [THE FIX] Relayed Messages Pruning (in batches) ---
                    const discordEpoch = 1420070400000n; 
                    const cutoffTimestamp = BigInt(cutoffDate.getTime()); 
                    const discordEpochCutoffBigInt = (cutoffTimestamp - discordEpoch) << 22n; 
                    const cutoffIdString = discordEpochCutoffBigInt.toString();

                    let prunedInBatch = 0;
                    console.log(`[Manual Prune] Starting batched pruning of relayed_messages older than ${cutoffIdString} in batches of ${batchSize}.`);

                    // Prepare the statement once for efficiency. This is a safe way to delete with a limit.
                    const stmt = db.prepare(`DELETE FROM relayed_messages WHERE id IN (SELECT id FROM relayed_messages WHERE original_message_id < ? LIMIT ?)`);
                    
                    do {
                        const result = stmt.run(cutoffIdString, batchSize);
                        prunedInBatch = result.changes;
                        totalPrunedMessages += prunedInBatch;
                        console.log(`[Manual Prune] Deleted ${prunedInBatch} messages in this batch. Total so far: ${totalPrunedMessages}`);
                    } while (prunedInBatch > 0);

                    console.log(`[Manual Prune] Finished batched pruning. Deleted a total of ${totalPrunedMessages} relayed messages.`);

                    // --- Group Stats Pruning (if requested) ---
                    if (pruneStats) {
                        const cutoffDayString = cutoffDate.toISOString().slice(0, 10);
                        console.log(`[Manual Prune] Pruning group_stats with day < ${cutoffDayString}`);
                        const resultStats = db.prepare("DELETE FROM group_stats WHERE day < ?").run(cutoffDayString);
                        prunedStats = resultStats.changes;
                        console.log(`[Manual Prune] Deleted ${prunedStats} group stats entries.`);
                    }
                }

                // --- Build the final report embed ---
                const resultsEmbed = new EmbedBuilder()
                    .setTitle('Database & Pruning Operations Complete')
                    .setColor('#5865F2') // Discord's blurple color
                    .setDescription(`Pruning tasks finished. Check bot logs for full details.`)
                    .addFields(
                        { name: 'Orphaned Server Data', value: `Cleaned up data for **${prunedGuilds.length}** orphaned server(s).`, inline: true },
                        { name: '\u200B', value: '\u200B', inline: true }, // Placeholder for spacing
                        { name: '\u200B', value: '\u200B', inline: true },
                        { name: 'Groups Deleted (Total)', value: `${prunedGroups}`, inline: true },
                        { name: 'Channel Links Deleted', value: `${prunedLinks}`, inline: true },
                        { name: 'Role Mappings Deleted', value: `${prunedMappings}`, inline: true },
                        { name: 'Orphaned Webhooks Pruned', value: `${prunedWebhooks}`, inline: true }
                    );

                // Add message history results if the operation ran
                if (messageHistoryDays !== null && messageHistoryDays > 0) {
                    let statsPruningStatus = `(Group stats were intentionally left intact)`;
                    if (pruneStats) {
                         statsPruningStatus = `Pruned **${prunedStats}** group stats entries.`;
                    }
                    resultsEmbed.addFields({
                        name: `Message History (Older than ${messageHistoryDays} days)`,
                        value: `Pruned **${totalPrunedMessages}** message links. ${statsPruningStatus}`,
                        inline: false
                    });
                }
                
                if (prunedGuilds.length > 0) {
                    const guildIdsString = prunedGuilds.join('\n');
                    const displayGuildIds = guildIdsString.length > 1000 ? guildIdsString.substring(0, 1000) + '\n...' : guildIdsString;
                    resultsEmbed.addFields({ name: 'Orphaned Server IDs', value: `\`\`\`${displayGuildIds}\`\`\``, inline: false });
                }

                await interaction.editReply({ content: "Pruning complete. Now reclaiming disk space... (This may take a moment)", embeds: [resultsEmbed] });
            
				// [THE FIX] Add the VACUUM command here.
				try {
					console.log('[Manual Prune] Starting VACUUM to reclaim disk space...');
					db.exec('VACUUM');
					console.log('[Manual Prune] VACUUM complete.');
                
					const finalEmbed = new EmbedBuilder(resultsEmbed.toJSON()) // Re-use the existing embed data
						.setFooter({ text: 'Disk space has been successfully reclaimed.' });

					await interaction.editReply({ content: "Pruning and space reclamation complete!", embeds: [finalEmbed] });
				} catch (vacuumError) {
					console.error('[Manual Prune] Could not complete VACUUM:', vacuumError);
					await interaction.editReply({ content: 'Pruning complete, but an error occurred while reclaiming disk space. The file may still be large.' });
				}
                console.log(`[Manual Prune] Summary Report: ${prunedGroups} groups, ${prunedLinks} links, ${prunedMappings} mappings, ${prunedWebhooks} webhooks, ${totalPrunedMessages} messages, ${prunedStats} stats.`);

            } else if (subcommand === 'upload_db') {
                await interaction.deferReply({ ephemeral: true });

                try {
                    const response = await uploadDatabase();
                    
                    const successEmbed = new EmbedBuilder()
                        .setTitle('Database Upload Successful')
                        .setColor('#5865F2')
                        .setDescription(`The database has been uploaded and is ready for download.\n\n**[Click Here to Download](${response.url})**`)
                        .addFields({ name: 'Filename', value: `\`${response.filename}\`` })
                        .setFooter({ text: 'Do not share this link.' })
                        .setTimestamp();
                    
                    await interaction.editReply({ embeds: [successEmbed] });

                } catch (error) {
                    await interaction.editReply({ content: `❌ **Upload Failed:** ${error.message}` });
                }

            } else if (subcommand === 'leave_inactive') {
                await interaction.deferReply({ ephemeral: true });

                const daysInactive = interaction.options.getInteger('days_inactive');
                const isDryRun = interaction.options.getBoolean('dry_run') ?? true; // Default to a safe dry run

                if (daysInactive <= 0) {
                    return interaction.editReply({ content: '❌ Please provide a positive number of days.' });
                }

                // --- LOGIC TO FIND INACTIVE SERVERS ---

                // 1. Calculate the cutoff date.
                const cutoffDate = new Date();
                cutoffDate.setDate(cutoffDate.getDate() - daysInactive);
                const cutoffDateString = cutoffDate.toISOString().slice(0, 10);

                // 2. Get a set of all guild IDs that HAVE been active recently.
                const activeGuildsQuery = db.prepare(`
                    SELECT DISTINCT lc.guild_id
                    FROM linked_channels lc
                    JOIN group_stats gs ON lc.group_id = gs.group_id
                    WHERE gs.day >= ?
                `).all(cutoffDateString);
                const activeGuildIds = new Set(activeGuildsQuery.map(row => row.guild_id));

                // 3. Get a list of all guilds the bot is currently in.
                const allGuildsIn = Array.from(interaction.client.guilds.cache.values());

                // 4. Determine which guilds are inactive by finding the ones not in the active set.
                const inactiveGuilds = allGuildsIn.filter(guild => !activeGuildIds.has(guild.id));

                if (inactiveGuilds.length === 0) {
                    return interaction.editReply({ content: `✅ No inactive servers found matching the criteria.` });
                }

                // --- EXECUTE THE ACTION (DRY RUN OR ACTUAL LEAVE) ---

                if (isDryRun) {
                    // DRY RUN: Just list the servers that would be left.
                    const serverList = inactiveGuilds.map(g => `• ${g.name} (ID: \`${g.id}\`)`).join('\n');
                    
                    const embed = new EmbedBuilder()
                        .setTitle(`Dry Run: Inactive Servers to Leave (${inactiveGuilds.length})`)
                        .setColor('#FFA500') // Orange for warning
                        .setDescription(`The following servers have had no relay activity in the last **${daysInactive}** days. If this were not a dry run, the bot would leave them.\n\n${serverList}`)
                        .setFooter({ text: 'To proceed, run this command again with the `dry_run` option set to `False`.' });
                    
                    return interaction.editReply({ embeds: [embed] });

                } else {
                    // ACTUAL LEAVE: Iterate and leave the servers.
                    let successCount = 0;
                    let failCount = 0;
                    const failedGuilds = [];

                    await interaction.editReply({ content: `Leaving ${inactiveGuilds.length} inactive servers... This may take a moment.` });

                    for (const guild of inactiveGuilds) {
                        try {
                            await guild.leave();
                            console.log(`[INACTIVE-LEAVE] Successfully left guild: ${guild.name} (${guild.id})`);
                            successCount++;
                        } catch (error) {
                            console.error(`[INACTIVE-LEAVE] FAILED to leave guild: ${guild.name} (${guild.id}). Error: ${error.message}`);
                            failCount++;
                            failedGuilds.push(`• ${guild.name} (\`${guild.id}\`)`);
                        }
                    }

                    const embed = new EmbedBuilder()
                        .setTitle('Inactive Server Cleanup Complete')
                        .setColor('#5865F2')
                        .setDescription(`Operation finished.`)
                        .addFields(
                            { name: 'Servers Left Successfully', value: `${successCount}`, inline: true },
                            { name: 'Failed to Leave', value: `${failCount}`, inline: true }
                        );
                    
                    if (failCount > 0) {
                        embed.addFields({ name: 'Failed Servers', value: failedGuilds.join('\n') });
                    }

                    return interaction.editReply({ content: '', embeds: [embed] });
                }
            } else if (subcommand === 'rename_group') {
                await interaction.deferReply({ ephemeral: true });

                const currentName = interaction.options.getString('current_name');
                const newName = interaction.options.getString('new_name');
                const reason = interaction.options.getString('reason'); // Get the optional reason

                const group = db.prepare('SELECT group_id FROM relay_groups WHERE group_name = ?').get(currentName);
                if (!group) {
                    return interaction.editReply({ content: `❌ **Error:** No relay group found with the name "${currentName}".` });
                }

                // --- [THE FIX] Find all unique server owners in the group BEFORE renaming ---
                const linkedGuildIds = db.prepare('SELECT DISTINCT guild_id FROM linked_channels WHERE group_id = ?').all(group.group_id).map(row => row.guild_id);
                
                // Use a Map to store owner IDs and their associated guilds to prevent duplicate DMs
                const ownerNotificationMap = new Map();

                for (const guildId of linkedGuildIds) {
                    try {
                        const guild = await interaction.client.guilds.fetch(guildId);
                        const owner = await guild.fetchOwner();
                        
                        if (!ownerNotificationMap.has(owner.id)) {
                            ownerNotificationMap.set(owner.id, { ownerObject: owner, guilds: [] });
                        }
                        ownerNotificationMap.get(owner.id).guilds.push(guild.name);

                    } catch (e) {
                        console.error(`[RENAME-PREP] Could not fetch owner for server ${guildId}:`, e.message);
                    }
                }
                
                // Perform the update.
                try {
                    const result = db.prepare('UPDATE relay_groups SET group_name = ? WHERE group_id = ?').run(newName, group.group_id);
                    
                    if (result.changes > 0) {
                        let notifiedOwners = 0;
                        let failedNotifications = 0;

                        // Create the base notification message.
                        let notificationMessage = `📢 **RelayBot Notification**\n\nThe relay group "**${currentName}**" has been renamed to "**${newName}**" by the Bot Owner.`;
                        
                        // Add the reason if one was provided.
                        if (reason) {
                            notificationMessage += `\n\n**Reason:** *${reason}*`;
                        }
                        
                        notificationMessage += `\n\nYour relays will continue to function, but you must use the new name for any future commands. Please save this new name for your records.`;

                        // --- [THE FIX] Iterate over the unique owners ---
                        for (const [ownerId, data] of ownerNotificationMap.entries()) {
                            // Don't notify the bot owner running the command.
                            if (ownerId === interaction.user.id) continue;

                            try {
                                // Add a list of their affected servers to the message for clarity
                                const finalMessage = `${notificationMessage}\n\n*This change affects your server(s): ${data.guilds.join(', ')}*`;
                                await data.ownerObject.send(finalMessage);

                                notifiedOwners++;
                            } catch (e) {
                                console.error(`[RENAME-NOTIFY] Failed to DM owner ${ownerId}:`, e.message);
                                failedNotifications++;
                            }
                        }

                        let notificationReport = '';
                        if (notifiedOwners > 0 || failedNotifications > 0) {
                            notificationReport = `\n\n📢 DMs were sent to **${notifiedOwners}** unique server owners. **${failedNotifications}** owners could not be reached.`;
                        }

                        await interaction.editReply({ content: `✅ **Success!** Group "**${currentName}**" has been renamed to "**${newName}**".${notificationReport}` });
                    } else {
                        await interaction.editReply({ content: 'An unexpected error occurred. The group name was not changed.' });
                    }
                } catch (error) {
                    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
                        await interaction.editReply({ content: `❌ **Error:** A global group named "**${newName}**" already exists. Please choose a different name.` });
                    } else {
                        throw error;
                    }
                }
            // --- [NEW LOGIC BLOCK] ---
            } else if (subcommand === 'check_subscription') {
                await interaction.deferReply({ ephemeral: true });
                // [THE FIX] Use 'group_name' instead of 'server_id'
                const groupName = interaction.options.getString('group_name');

                // 1. Look up the group to find the owner's guild ID
                const group = db.prepare('SELECT group_id, owner_guild_id FROM relay_groups WHERE group_name = ?').get(groupName);
                
                if (!group) {
                    return interaction.editReply({ content: `❌ **Error:** No relay group found with the name "${groupName}".` });
                }

                const guildId = group.owner_guild_id;
                const guild = await interaction.client.guilds.fetch(guildId).catch(() => null);
                
                if (!guild) {
                    return interaction.editReply({ content: `❌ **Error:** I am not a member of the group owner's server (ID: \`${guildId}\`). Unable to check subscription.` });
                }

                try {
                    // 2. Live API Check
                    const entitlements = await interaction.client.application.entitlements.fetch({ guildId: guild.id });
                    const activeSub = entitlements.find(e => e.skuId === PREMIUM_SKU_ID && e.isActive());
                    
                    // 3. Database Cache Check
                    const dbSub = db.prepare('SELECT * FROM guild_subscriptions WHERE guild_id = ?').get(guild.id);

                    // 4. Build Response
                    const embed = new EmbedBuilder()
                        .setTitle(`Subscription Status for Group: ${groupName}`) // Updated Title
                        .setDescription(`Owner Server: **${guild.name}** (\`${guild.id}\`)`) // Added Server Info
                        .setColor(activeSub ? '#23A559' : '#ED4245')
                        .addFields(
                            { name: 'Server ID', value: `\`${guild.id}\`` }
                        );

                    if (activeSub) {
                        embed.addFields(
                            { name: 'Live API Status', value: '✅ Active Subscription Found' },
                            { name: 'SKU ID', value: `\`${activeSub.skuId}\``, inline: true },
                            { name: 'Entitlement ID', value: `\`${activeSub.id}\``, inline: true },
                            { name: 'Expires At', value: activeSub.endsTimestamp ? `<t:${Math.floor(activeSub.endsTimestamp / 1000)}:R>` : 'Never', inline: true }
                        );
                    } else {
                        embed.addFields({ name: 'Live API Status', value: '❌ No active subscription found for the premium SKU.' });
                    }

                    if (dbSub) {
                        embed.addFields(
                            { name: 'Database Cache Status', value: dbSub.is_active ? '✅ Active' : '❌ Inactive' },
                            { name: 'Last Synced', value: `<t:${Math.floor(dbSub.updated_at / 1000)}:R>`, inline: true }
                        );
                    } else {
                        embed.addFields({ name: 'Database Cache Status', value: '🤔 No record found in the database.' });
                    }

                    await interaction.editReply({ embeds: [embed] });

                } catch (error) {
                    console.error(`[SUB-CHECK] Failed to fetch entitlements for guild ${guild.id}:`, error);
                    await interaction.editReply({ content: `An error occurred while fetching entitlements for **${guild.name}**:\n\`\`\`${error.message}\`\`\`` });
                }
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

    // --- [NEW AUTOCOMPLETE FUNCTION] ---
    async autocomplete(interaction) {
        // Since all owner commands are restricted, we don't need to re-check the user's ID here.
        const focusedOption = interaction.options.getFocused(true);
        const subcommand = interaction.options.getSubcommand();
        const choices = [];

        // Check for the subcommands and options that need autocomplete
        if ((subcommand === 'delete_group' && focusedOption.name === 'name') ||
            (subcommand === 'rename_group' && focusedOption.name === 'current_name') ||
            (subcommand === 'check_subscription' && focusedOption.name === 'group_name')) {

            const searchTerm = focusedOption.value.length > 0 ? `%${focusedOption.value}%` : '%';
            const groups = db.prepare('SELECT group_name FROM relay_groups WHERE group_name LIKE ? LIMIT 25')
                .all(searchTerm);
            
            groups.forEach(group => {
                choices.push({
                    name: group.group_name,
                    value: group.group_name,
                });
            });
        }
        
        await interaction.respond(choices);
    },
};