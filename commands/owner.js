// commands/owner.js
const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const { exec } = require('child_process');
const db = require('../db/database.js');
const { getRateLimitDayString } = require('../utils/time.js');
const { isSupporter } = require('../utils/supporterManager.js');

const BOT_OWNER_ID = '182938628643749888';

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
                .addStringOption(option => option.setName('name').setDescription('The exact name of the group to delete.').setRequired(true)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('prune_db')
                .setDescription('Removes orphaned server data and optionally inactive groups/webhooks.')
                .addBooleanOption(option =>
                    option.setName('include_inactive')
                        .setDescription('Also prune groups with zero total character usage? (Default: False)'))
                .addIntegerOption(option =>
                    option.setName('days')
                        .setDescription('Also prune groups inactive for this many days.')))
        .addSubcommand(subcommand =>
            subcommand
                .setName('upload_db')
                .setDescription('Uploads the database to your secure web server endpoint.')),

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

                const today = getRateLimitDayString();
                const todaysStatsRaw = db.prepare('SELECT group_id, character_count, warning_sent_at FROM group_stats WHERE day = ?').all(today);
                const todaysStatsMap = new Map(todaysStatsRaw.map(stat => [stat.group_id, { count: stat.character_count, paused: !!stat.warning_sent_at }]));

                const sevenDaysAgo = new Date();
                sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

                const descriptions = [];
                let currentDescription = '';

                for (const group of allGroups) {
                    const ownerGuild = interaction.client.guilds.cache.get(group.owner_guild_id);
                    const ownerInfo = ownerGuild ? ownerGuild.name : `Unknown Server`;
                    
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
                    
                    const groupLine = `${statusEmoji} ${star} **${group.group_name}** (Owner: ${ownerInfo})\n`;
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
            } 
            
            else if (subcommand === 'delete_group') {
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
                const inactiveDays = interaction.options.getInteger('days');

                let prunedGroups = 0, prunedLinks = 0, prunedMappings = 0, prunedWebhooks = 0;
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
                    for (const guildId of guildsToPrune) {
                        const groups = db.prepare('DELETE FROM relay_groups WHERE owner_guild_id = ?').run(guildId);
                        const links = db.prepare('DELETE FROM linked_channels WHERE guild_id = ?').run(guildId);
                        const mappings = db.prepare('DELETE FROM role_mappings WHERE guild_id = ?').run(guildId);
                        prunedGroups += groups.changes;
                        prunedLinks += links.changes;
                        prunedMappings += mappings.changes;
                        prunedGuilds.push(guildId);
                    }
                }

                // --- 2. Prune Inactive Groups (if requested) ---
                if (includeInactive) {
                    const inactiveGroups = db.prepare(`SELECT rg.group_id FROM relay_groups rg LEFT JOIN group_stats gs ON rg.group_id = gs.group_id GROUP BY rg.group_id HAVING SUM(gs.character_count) IS NULL OR SUM(gs.character_count) = 0`).all();
                    inactiveGroups.forEach(g => groupIdsToDelete.add(g.group_id));
                }

                // --- 3. Prune Stale Groups (if requested) ---
                if (inactiveDays !== null && inactiveDays > 0) {
                    const cutoffDate = new Date();
                    cutoffDate.setDate(cutoffDate.getDate() - inactiveDays);
                    const cutoffDateString = cutoffDate.toISOString().slice(0, 10);

                    const staleGroups = db.prepare(`
                        SELECT group_id FROM relay_groups WHERE group_id NOT IN (
                            SELECT DISTINCT group_id FROM group_stats WHERE day >= ?
                        )
                    `).all(cutoffDateString);
                    staleGroups.forEach(g => groupIdsToDelete.add(g.group_id));
                }

                // Delete all collected inactive/stale groups
                if (groupIdsToDelete.size > 0) {
                    const ids = Array.from(groupIdsToDelete);
                    const stmt = db.prepare(`DELETE FROM relay_groups WHERE group_id IN (${ids.map(() => '?').join(',')})`);
                    const result = stmt.run(...ids);
                    prunedGroups += result.changes;
                }

                // --- 4. Prune Orphaned Webhooks ---
                if (includeInactive) {
                    const inactiveGroups = db.prepare(`SELECT rg.group_id FROM relay_groups rg LEFT JOIN group_stats gs ON rg.group_id = gs.group_id GROUP BY rg.group_id HAVING SUM(gs.character_count) IS NULL OR SUM(gs.character_count) = 0`).all();
                    if (inactiveGroups.length > 0) {
                        const idsToDelete = inactiveGroups.map(g => g.group_id);
                        const stmt = db.prepare(`DELETE FROM relay_groups WHERE group_id IN (${idsToDelete.map(() => '?').join(',')})`);
                        const result = stmt.run(...idsToDelete);
                        prunedGroups += result.changes;
                    }
                    inactiveGroups.forEach(g => groupIdsToDelete.add(g.group_id));
                }

                const allDbWebhooks = new Set(db.prepare('SELECT webhook_url FROM linked_channels').all().map(r => r.webhook_url));
                for (const guild of interaction.client.guilds.cache.values()) {
                    try {
                        if (!guild.members.me.permissions.has(PermissionFlagsBits.ManageWebhooks)) continue;
                        const webhooks = await guild.fetchWebhooks();
                        for (const webhook of webhooks.values()) {
                            if (webhook.owner.id === interaction.client.user.id && !allDbWebhooks.has(webhook.url)) {
                                await webhook.delete('Pruning orphaned RelayBot webhook.');
                                prunedWebhooks++;
                            }
                        }
                    } catch {}
                }

                // Build the final report embed
                const resultsEmbed = new EmbedBuilder()
                    .setTitle('Database & Webhook Pruning Complete')
                    .setColor('#5865F2')
                    .setDescription(`Cleanup operation finished. Pruned data for **${prunedGuilds.length}** orphaned server(s).`)
                    .addFields(
                        { name: 'Groups Deleted', value: `${prunedGroups}`, inline: true },
                        { name: 'Channel Links Deleted', value: `${prunedLinks}`, inline: true },
                        { name: 'Role Mappings Deleted', value: `${prunedMappings}`, inline: true },
                        { name: 'Orphaned Webhooks Pruned', value: `${prunedWebhooks}`, inline: true }
                    )
                    .setTimestamp();
                
                if (prunedGuilds.length > 0) {
                    resultsEmbed.addFields({ name: 'Orphaned Server IDs', value: `\`\`\`${prunedGuilds.join('\n')}\`\`\`` });
                }
                
                await interaction.editReply({ embeds: [resultsEmbed] });
            } else if (subcommand === 'upload_db') {
                await interaction.deferReply({ ephemeral: true });

                const uploadSecret = process.env.UPLOAD_SECRET_KEY;
                const clientId = process.env.CLIENT_ID; // Get the Client ID from environment
                if (!uploadSecret || !clientId) {
                    return interaction.editReply({ content: '❌ **Configuration Error:** `UPLOAD_SECRET_KEY` and `CLIENT_ID` must be set.' });
                }

                // [THE FIX - PART 1] Create the dynamic filename.
                const timestamp = new Date().toISOString().replace(/:/g, '-').slice(0, 19);
                const dynamicFilename = `database_${clientId}_${timestamp}.db`;

                const dbPath = '/data/database.db';
                const uploadUrl = 'https://shaggyze.website/railway-upload.php';

                // Add the filename to the curl command as a new form field.
                const command = `curl -s -X POST -H "X-Upload-Secret: ${uploadSecret}" -F "file=@${dbPath}" -F "filename=${dynamicFilename}" ${uploadUrl}`;

                exec(command, (error, stdout, stderr) => {
                    const stdoutStr = stdout.toString();
                    const stderrStr = stderr.toString();
                    if (error) {
                        console.error('[DB-UPLOAD] Exec error:', error);
                        return interaction.editReply({ content: `An error occurred while executing curl: \`\`\`${stderrStr}\`\`\`` });
                    }

                    try {
                        const response = JSON.parse(stdoutStr);
                        // [THE FIX - PART 2] The PHP script now returns a direct URL.
                        if (response.success && response.url) {
                            const successEmbed = new EmbedBuilder()
                                .setTitle('Database Upload Successful')
                                .setColor('#5865F2')
                                .setDescription(`The database has been uploaded and is ready for download.\n\n**[Click Here to Download](${response.url})**`)
                                .addFields({ name: 'Filename', value: `\`${response.filename}\`` })
                                .setFooter({ text: 'This is a one-time link for security.' })
                                .setTimestamp();
                            
                            interaction.editReply({ embeds: [successEmbed] });
                        } else {
                            interaction.editReply({ content: `The upload script returned an error: \`\`\`${response.message || stdoutStr}\`\`\`` });
                        }
                    } catch (parseError) {
                        interaction.editReply({ content: `Failed to parse the server response. Raw output: \`\`\`${stdoutStr}\`\`\`` });
                    }
                });
            }
        } catch (error) {
            console.error(`Error in /owner ${subcommand}:`, error);
            try {
                const content = 'An unknown error occurred. The developer has been notified.';
                if (interaction.deferred || interaction.replied) {
                    await interaction.editReply({ content });
                } else {
                    await interaction.reply({ content, ephemeral: true });
                }
            } catch (e) {
                console.error('Failed to send error response to user:', e);
            }
        }
    },
};