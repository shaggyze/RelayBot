// commands/stats.js
const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const db = require('../db/database.js');
const { isSupporter, getSupporterSet } = require('../utils/supporterManager.js'); // Assuming this is needed for supporter counts

module.exports = {
    data: new SlashCommandBuilder()
        .setName('stats')
        .setDescription('Shows activity statistics for the relay group linked to this channel.')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

    async execute(interaction) {
        if (!interaction.inGuild()) {
            return await interaction.reply({ content: 'This command can only be used inside a server.', ephemeral: true });
        }
        
        await interaction.deferReply({ ephemeral: true });
        const channelId = interaction.channel.id;
        
        try {
            // 1. Find the group linked to the current channel.
            const linkInfo = db.prepare('SELECT group_id FROM linked_channels WHERE channel_id = ?').get(channelId);

            if (!linkInfo) {
                return interaction.editReply({ content: '❌ **Error:** This channel is not linked to any relay group. You must run `/relay link_channel` first.' });
            }
            
            // 2. Get the group name (optional, but good for display in logs).
            const group = db.prepare('SELECT group_name FROM relay_groups WHERE group_id = ?').get(linkInfo.group_id);
            // const groupName = group ? group.group_name : 'Unknown Group'; // Removed, but kept for logging context


            // 3. Fetch unique guild IDs that are part of the group.
            const uniqueGuildIds = db.prepare('SELECT DISTINCT guild_id FROM linked_channels WHERE group_id = ?').all(linkInfo.group_id).map(row => row.guild_id);

            let totalMembers = 0;
            let accessibleServerCount = 0;
            let totalSupporters = 0;
            const supporterSet = getSupporterSet(); // Get the global set of supporter IDs

            // Iterate through unique guilds to sum members and count accessible servers.
            for (const guildId of uniqueGuildIds) {
                const guild = interaction.client.guilds.cache.get(guildId);
                if (guild) {
                    totalMembers += guild.memberCount;
                    accessibleServerCount++;
                    
                    // Sum up the supporters in this guild who are in the global supporter set
                    const supportersInGuild = guild.members.cache.filter(member => supporterSet.has(member.user.id)).size;
                    totalSupporters += supportersInGuild;
                }
            }

            // 4. Fetch other group-wide stats.
            const serverCount = uniqueGuildIds.length;
            const channelCount = db.prepare('SELECT COUNT(channel_id) as count FROM linked_channels WHERE group_id = ?').get(linkInfo.group_id).count;
            const totalCharsResult = db.prepare('SELECT SUM(character_count) as total FROM group_stats WHERE group_id = ?').get(linkInfo.group_id);
            const totalChars = totalCharsResult ? totalCharsResult.total : 0;
            
            const statsEmbed = new EmbedBuilder()
                .setTitle(`📊 RelayBot Group Statistics`)
                .setColor('#5865F2')
                .addFields(
                    { name: 'Linked Servers', value: `${serverCount} (Bot in ${accessibleServerCount})`, inline: true },
                    { name: 'Linked Channels', value: `${channelCount}`, inline: true },
                    { name: 'Active Supporters', value: `${totalSupporters}`, inline: true }, 
                    { name: 'Total Alliance Members', value: `${totalMembers.toLocaleString()}`, inline: false },
                    { name: 'Total Characters Relayed', value: `${(totalChars || 0).toLocaleString()}`, inline: false }
                )
                .setFooter({ text: `Note: Member and supporter counts are approximate based on bot's visible guilds.` })
                .setTimestamp();
            
            await interaction.editReply({ embeds: [statsEmbed] });

        } catch (error) {
            console.error('Error in /stats command:', error);
            await interaction.editReply({ content: 'An unexpected error occurred while fetching statistics. Please check the logs.' });
        }
    },
};