// commands/owner.js
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const db = require('../db/database.js');

const BOT_OWNER_ID = '182938628643749888';

module.exports = {
    data: new SlashCommandBuilder()
        .setName('owner')
        .setDescription('Owner-only commands for managing the bot.')
        .addSubcommand(subcommand =>
            subcommand
                .setName('list_groups')
                .setDescription('Lists all global relay groups in the database.'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('delete_group')
                .setDescription('[DANGER] Forcibly deletes a global group and makes the bot leave the owner\'s server.')
                .addStringOption(option =>
                    option.setName('name')
                        .setDescription('The exact name of the group to delete.')
                        .setRequired(true)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('prune_db')
                .setDescription('Removes all data from servers where the bot is no longer a member.')),
    
    async execute(interaction) {
        if (interaction.user.id !== BOT_OWNER_ID) {
            return interaction.reply({ content: 'You do not have permission to use this command.', ephemeral: true });
        }

        const subcommand = interaction.options.getSubcommand();

        try {
            // [THE FIX] The command logic is now in a single, unbroken if/else if chain.
            if (subcommand === 'list_groups') {
                await interaction.deferReply({ ephemeral: true });

                const allGroups = db.prepare('SELECT group_name, owner_guild_id FROM relay_groups ORDER BY group_name ASC').all();

                if (allGroups.length === 0) {
                    return interaction.editReply({ content: 'There are currently no relay groups in the database.' });
                }

                const descriptions = [];
                let currentDescription = '';

                for (const group of allGroups) {
                    const ownerGuild = interaction.client.guilds.cache.get(group.owner_guild_id);
                    const ownerInfo = ownerGuild ? `${ownerGuild.name} (\`${group.owner_guild_id}\`)` : `Unknown Server (\`${group.owner_guild_id}\`)`;
                    const line = `• **${group.group_name}** (Owner: ${ownerInfo})\n`;
                    
                    if (currentDescription.length + line.length > 4000) {
                        descriptions.push(currentDescription);
                        currentDescription = '';
                    }
                    currentDescription += line;
                }
                descriptions.push(currentDescription);

                const embeds = descriptions.map((desc, index) => {
                    return new EmbedBuilder()
                        .setTitle(`Global Relay Groups (Page ${index + 1}/${descriptions.length})`)
                        .setColor('#FFD700')
                        .setDescription(desc)
                        .setTimestamp()
                        .setFooter({ text: `Total Groups: ${allGroups.length}` });
                });

                await interaction.editReply({ embeds: [embeds[0]] });
                for (let i = 1; i < embeds.length; i++) {
                    await interaction.followUp({ embeds: [embeds[i]], ephemeral: true });
                }

            } else if (subcommand === 'delete_group') {
                await interaction.deferReply({ ephemeral: true });

                const groupName = interaction.options.getString('name');
                const group = db.prepare('SELECT group_id, owner_guild_id FROM relay_groups WHERE group_name = ?').get(groupName);

                if (!group) {
                    return interaction.editReply({ content: `Error: No group found with the exact name "${groupName}".` });
                }

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
                    responseMessage += `\n\nI was unable to leave the owner's server (ID: \`${group.owner_guild_id}\`). I may no longer be a member.`;
                }
                
                await interaction.editReply({ content: responseMessage });

            } else if (subcommand === 'prune_db') {
                await interaction.deferReply({ ephemeral: true });

                const currentGuildIds = Array.from(interaction.client.guilds.cache.keys());
                const groupOwners = db.prepare('SELECT DISTINCT owner_guild_id FROM relay_groups').all().map(r => r.owner_guild_id);
                const linkedGuilds = db.prepare('SELECT DISTINCT guild_id FROM linked_channels').all().map(r => r.guild_id);
                const mappedGuilds = db.prepare('SELECT DISTINCT guild_id FROM role_mappings').all().map(r => r.guild_id);
                const uniqueDbGuildIds = [...new Set([...groupOwners, ...linkedGuilds, ...mappedGuilds])];
                const guildsToPrune = uniqueDbGuildIds.filter(id => !currentGuildIds.includes(id));

                if (guildsToPrune.length === 0) {
                    return interaction.editReply({ content: 'Database is already clean. No orphaned server data found.' });
                }

                let prunedGroups = 0;
                let prunedLinks = 0;
                let prunedMappings = 0;

                for (const guildId of guildsToPrune) {
                    const groups = db.prepare('DELETE FROM relay_groups WHERE owner_guild_id = ?').run(guildId);
                    const links = db.prepare('DELETE FROM linked_channels WHERE guild_id = ?').run(guildId);
                    const mappings = db.prepare('DELETE FROM role_mappings WHERE guild_id = ?').run(guildId);
                    prunedGroups += groups.changes;
                    prunedLinks += links.changes;
                    prunedMappings += mappings.changes;
                }

                const resultsEmbed = new EmbedBuilder()
                    .setTitle('Database Pruning Complete')
                    .setColor('#ED4245')
                    .setDescription(`Successfully removed data associated with **${guildsToPrune.length}** orphaned server(s).`)
                    .addFields(
                        { name: 'Orphaned Server IDs', value: `\`\`\`${guildsToPrune.join('\n') || 'None'}\`\`\`` },
                        { name: 'Groups Deleted', value: prunedGroups.toString(), inline: true },
                        { name: 'Channel Links Deleted', value: prunedLinks.toString(), inline: true },
                        { name: 'Role Mappings Deleted', value: prunedMappings.toString(), inline: true }
                    )
                    .setTimestamp();
                
                await interaction.editReply({ embeds: [resultsEmbed] });
            }
        } catch (error) {
            console.error(`Error in /owner ${subcommand}:`, error);
            try {
                // Check if we can still edit the deferred reply.
                if (interaction.deferred || interaction.replied) {
                    await interaction.editReply({ content: 'An unknown error occurred. The developer has been notified.' });
                } else {
                    // Fallback if the interaction is completely dead.
                    await interaction.followUp({ content: 'An unknown error occurred. The developer has been notified.', ephemeral: true });
                }
            } catch (e) {
                console.error('Failed to send error response to user:', e);
            }
        }
    },
};