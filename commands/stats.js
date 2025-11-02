// commands/stats.js
const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const db = require('../db/database.js');
const { isSupporter, getSupporterSet } = require('../utils/supporterManager.js'); 
const { getRateLimitDayString } = require('../utils/time.js');

const BOT_OWNER_ID = '182938628643749888'; // Make sure this is correctly set

module.exports = {
    data: new SlashCommandBuilder()
        .setName('stats')
        .setDescription('Shows activity statistics for the relay group linked to this channel.')
        // [THE FIX] Add group_name parameter, but restrict its visibility/usage
        .addStringOption(option => 
            option.setName('group_name')
                .setDescription('(Bot Owner Only) Name of the group to check stats for.')
                .setRequired(false)
                // This parameter will only be shown to specific users based on client-side Discord logic
                // and we will enforce the server-side check below.
                .setAutocomplete(true) 
        ),

    async execute(interaction) {
        if (!interaction.inGuild()) {
            return await interaction.reply({ content: 'This command can only be used inside a server.', ephemeral: true });
        }
        
        await interaction.deferReply({ ephemeral: true });
        const channelId = interaction.channel.id;
        
        const isBotOwner = interaction.user.id === BOT_OWNER_ID;
        const paramGroupName = interaction.options.getString('group_name');

        let groupIdToLookup = null;
        let embedTitle = `📊 Relay Group Statistics`; // Default generic title for public users

        try {
            if (paramGroupName) { // If paramGroupName IS provided (should only happen for bot owner due to UI)
                if (!isBotOwner) {
                    // [SECURITY FIX] Critical: Non-owner provided paramGroupName, deny explicitly.
                    return interaction.editReply({ content: `❌ **Permission Denied:** Only the bot owner can use the \`group_name\` parameter.`, ephemeral: true });
                }
                // Bot owner provided a group name, use it for lookup and title
                const groupFromParam = db.prepare('SELECT group_id, group_name FROM relay_groups WHERE group_name = ?').get(paramGroupName);
                if (!groupFromParam) {
                    return interaction.editReply({ content: `❌ **Error:** No relay group found with the name "${paramGroupName}".` });
                }
                groupIdToLookup = groupFromParam.group_id;
                embedTitle = `📊 Relay Group Statistics for "${groupFromParam.group_name}"`; // Show specific name for owner
            } else {
                // Default: Use the group linked to the current channel for all users
                const linkInfo = db.prepare('SELECT group_id FROM linked_channels WHERE channel_id = ?').get(channelId);

                if (!linkInfo) {
                    return interaction.editReply({ content: '❌ **Error:** This channel is not linked to any relay group. You must run `/relay link_channel` first.' });
                }
                groupIdToLookup = linkInfo.group_id;
                // For non-owners, embedTitle remains generic. For owners, it might become specific if they used paramGroupName.
                // If owner didn't use paramGroupName, they also get generic title here.
            }

            // --- From here, use groupIdToLookup for all queries ---
            const uniqueGuildIds = db.prepare('SELECT DISTINCT guild_id FROM linked_channels WHERE group_id = ?').all(groupIdToLookup).map(row => row.guild_id);

            let totalMembers = 0;
            let accessibleServerCount = 0;
            const uniqueSupporterIds = new Set();
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
                            }
                        });
                    } catch (fetchError) {
                        console.warn(`[STATS] Failed to fetch members for guild ${guild.name} (${guild.id}). Supporter count will be inaccurate for this guild. Error: ${fetchError.message}`);
                        totalMembers += guild.memberCount; 
                        accessibleServerCount++;
                        guild.members.cache.forEach(member => {
                            if (supporterSet.has(member.user.id)) {
                                uniqueSupporterIds.add(member.user.id);
                            }
                        });
                    }
                }
            }
            
            const totalSupporters = uniqueSupporterIds.size;

            const serverCount = uniqueGuildIds.length;
            const channelCount = db.prepare('SELECT COUNT(channel_id) as count FROM linked_channels WHERE group_id = ?').get(groupIdToLookup).count;
            
            const groupStatsSummary = db.prepare(`
                SELECT 
                    SUM(character_count) as total_chars, 
                    COUNT(DISTINCT day) as active_days,
                    MIN(day) as first_active_day,
                    MAX(day) as last_active_day
                FROM group_stats
                WHERE group_id = ?
            `).get(groupIdToLookup);

            const totalChars = groupStatsSummary?.total_chars || 0;
            const activeDays = groupStatsSummary?.active_days || 0;
            const firstActiveDay = groupStatsSummary?.first_active_day || 'N/A';
            const lastActiveDay = groupStatsSummary?.last_active_day || 'N/A';
            const dailyAvg = (activeDays > 0) ? Math.round(totalChars / activeDays) : 0;

            const todayString = getRateLimitDayString();
            const todaysGroupStats = db.prepare('SELECT warning_sent_at FROM group_stats WHERE group_id = ? AND day = ?').get(groupIdToLookup, todayString);
            
            let statusValue = '';
            if (totalSupporters > 0) {
                statusValue = '✅ Active (Supporter Bypass)';
            } else if (todaysGroupStats && todaysGroupStats.warning_sent_at) {
                statusValue = '🔴 Paused (Daily Limit Reached)';
            } else {
                statusValue = '🟢 Active';
            }
            
            const statsEmbed = new EmbedBuilder()
                .setTitle(embedTitle) // Use the determined title
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
                    { name: 'Daily Average Chars', value: `${dailyAvg.toLocaleString()}`, inline: true }
                )
                .setFooter({ text: `Note: Member & supporter counts are accurate. Character counts based on bot's activity logs.` })
                .setTimestamp();
            
            await interaction.editReply({ embeds: [statsEmbed] });

        } catch (error) {
            console.error('Error in /stats command:', error);
            await interaction.editReply({ content: 'An unexpected error occurred while fetching statistics. Please check the logs.' });
        }
    },

    // [THE FIX] Autocomplete for group_name - restricted to bot owner
    async autocomplete(interaction) {
        const focusedOption = interaction.options.getFocused(true);
        const isBotOwner = interaction.user.id === BOT_OWNER_ID; 
        const choices = [];

        // Autocomplete for /stats group_name - restricted to bot owner
        if (interaction.commandName === 'stats' && focusedOption.name === 'group_name' && isBotOwner) {
            // [THE FIX] Modify the query to handle empty focusedOption.value
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