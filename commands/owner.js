// commands/owner.js
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const db = require('../db/database.js');

// This is your unique Discord User ID.
const BOT_OWNER_ID = '182938628643749888';

module.exports = {
    data: new SlashCommandBuilder()
        .setName('owner')
        .setDescription('Owner-only commands for managing the bot.')
        .addSubcommand(subcommand =>
            subcommand
                .setName('list_groups')
                .setDescription('Lists all global relay groups in the database.')),
    
    async execute(interaction) {
        // --- CRITICAL SECURITY CHECK ---
        // Immediately stop if the user is not the designated bot owner.
        if (interaction.user.id !== BOT_OWNER_ID) {
            return interaction.reply({ content: 'You do not have permission to use this command.', ephemeral: true });
        }

        const subcommand = interaction.options.getSubcommand();

        if (subcommand === 'list_groups') {
            // Acknowledge the command immediately, as fetching and formatting may take a moment.
            await interaction.deferReply({ ephemeral: true });

            const allGroups = db.prepare('SELECT group_name, owner_guild_id FROM relay_groups ORDER BY group_name ASC').all();

            if (allGroups.length === 0) {
                return interaction.editReply({ content: 'There are currently no relay groups in the database.' });
            }

            // Paginate the output in case the list is very long to avoid exceeding Discord's character limit.
            const descriptions = [];
            let currentDescription = '';

            for (const group of allGroups) {
                const ownerGuild = interaction.client.guilds.cache.get(group.owner_guild_id);
                const ownerInfo = ownerGuild ? `${ownerGuild.name} (\`${group.owner_guild_id}\`)` : `Unknown Server (\`${group.owner_guild_id}\`)`;
                const line = `• **${group.group_name}** (Owner: ${ownerInfo})\n`;
                
                // Check if adding the next line would exceed Discord's embed description limit (4096 chars).
                // We use a safe buffer of 4000.
                if (currentDescription.length + line.length > 4000) {
                    descriptions.push(currentDescription);
                    currentDescription = '';
                }
                currentDescription += line;
            }
            // Add the last or only page to the array.
            descriptions.push(currentDescription);

            const embeds = descriptions.map((desc, index) => {
                return new EmbedBuilder()
                    .setTitle(`Global Relay Groups (Page ${index + 1}/${descriptions.length})`)
                    .setColor('#FFD700') // Gold color for owner commands
                    .setDescription(desc)
                    .setTimestamp()
                    .setFooter({ text: `Total Groups: ${allGroups.length}` });
            });

            // Since we deferred the reply, we must use followUp for all subsequent messages.
            // First, we edit the original deferred reply with the first page.
            await interaction.editReply({ embeds: [embeds[0]] });

            // If there are more pages, send them as separate follow-up messages.
            for (let i = 1; i < embeds.length; i++) {
                await interaction.followUp({ embeds: [embeds[i]], ephemeral: true });
            }
        }
    },
};