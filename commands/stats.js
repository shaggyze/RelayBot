// commands/stats.js
const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const db = require('../db/database.js');
const { getSupporterSet, isGroupSupported } = require('../utils/supporterManager.js'); 
const { getRateLimitDayString } = require('../utils/time.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('stats')
        .setDescription('Shows activity statistics for the relay group linked to this channel.'),

    async execute(interaction) {
        if (!interaction.inGuild()) {
            return await interaction.reply({ content: 'This command can only be used inside a server.', ephemeral: true });
        }
        
        await interaction.deferReply({ ephemeral: true });
        const channelId = interaction.channel.id;
        
        try {
            const linkInfo = db.prepare('SELECT group_id FROM linked_channels WHERE channel_id = ?').get(channelId);

            if (!linkInfo) {
                return interaction.editReply({ content: '❌ **Error:** This channel is not linked to any relay group. You must run `/relay link_channel` first.' });
            }
            
            const uniqueGuildIds = db.prepare('SELECT DISTINCT guild_id FROM linked_channels WHERE group_id = ?').all(linkInfo.group_id).map(row => row.guild_id);

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
            const channelCount = db.prepare('SELECT COUNT(channel_id) as count FROM linked_channels WHERE group_id = ?').get(linkInfo.group_id).count;
            
            const groupStatsSummary = db.prepare(`
                SELECT 
                    SUM(character_count) as total_chars, 
                    COUNT(DISTINCT day) as active_days,
                    MIN(day) as first_active_day,
                    MAX(day) as last_active_day
                FROM group_stats
                WHERE group_id = ?
            `).get(linkInfo.group_id);

            const totalChars = groupStatsSummary?.total_chars || 0;
            const activeDays = groupStatsSummary?.active_days || 0;
            const firstActiveDay = groupStatsSummary?.first_active_day || 'N/A';
            const lastActiveDay = groupStatsSummary?.last_active_day || 'N/A';
            const dailyAvg = (activeDays > 0) ? Math.round(totalChars / activeDays) : 0;

            const todayString = getRateLimitDayString();
            const todaysGroupStats = db.prepare('SELECT warning_sent_at FROM group_stats WHERE group_id = ? AND day = ?').get(linkInfo.group_id, todayString);
            
            // [THE FIX] Use efficient cache check for status
            let statusValue = '';
            if (isGroupSupported(linkInfo.group_id)) {
                statusValue = '✅ Active (Supporter Bypass)';
            } else if (todaysGroupStats && todaysGroupStats.warning_sent_at) {
                statusValue = '🔴 Paused (Daily Limit Reached)';
            } else {
                statusValue = '🟢 Active';
            }
            
            const statsEmbed = new EmbedBuilder()
                .setTitle(`📊 Relay Group Statistics`)
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
};