// commands/groupOwner.js
const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const db = require('../db/database.js');

const BOT_OWNER_ID = '182938628643749888';

module.exports = {
    data: new SlashCommandBuilder()
        .setName('group_owner')
        .setDescription('Commands for the Group Owner to manage filters and blocks.')
        .setDefaultMemberPermissions(0) // Logic handles permissions internally
        .addSubcommand(subcommand => subcommand.setName('add_filter').setDescription('Add a phrase to the filter.')
            .addStringOption(option => option.setName('phrase').setDescription('The word/phrase to censor.').setRequired(true))
            .addIntegerOption(option => option.setName('threshold').setDescription('Strikes before block (0=Off, 1=Instant).').setRequired(false).setMinValue(0).setMaxValue(100))
            .addStringOption(option => option.setName('message').setDescription('Warning message to send to user.').setRequired(false)))
        .addSubcommand(subcommand => subcommand.setName('remove_filter').setDescription('Remove a phrase from the filter.')
            .addStringOption(option => option.setName('phrase').setDescription('The phrase to remove.').setRequired(true).setAutocomplete(true)))
        .addSubcommand(subcommand => subcommand.setName('edit_filter').setDescription('Edit settings for an existing filter.')
            .addStringOption(option => option.setName('phrase').setDescription('The phrase to edit.').setRequired(true).setAutocomplete(true))
            .addIntegerOption(option => option.setName('threshold').setDescription('New threshold.').setRequired(false))
            .addStringOption(option => option.setName('message').setDescription('New warning message.').setRequired(false)))
        .addSubcommand(subcommand => subcommand.setName('list_filters').setDescription('List all filters and their settings.'))
        .addSubcommand(subcommand => subcommand.setName('block').setDescription('Block a user or server ID.').addStringOption(option => option.setName('target_id').setDescription('ID to block.').setRequired(true)))
        .addSubcommand(subcommand => subcommand.setName('unblock').setDescription('Unblock a user or server ID.').addStringOption(option => option.setName('target_id').setDescription('ID to unblock.').setRequired(true)))
    ,

    async execute(interaction) {
        if (!interaction.inGuild()) return interaction.reply({ content: 'Server only.', ephemeral: true });
        await interaction.deferReply({ ephemeral: true });

        const subcommand = interaction.options.getSubcommand();
        const channelId = interaction.channel.id;

        // 1. Identify Group from Channel
        const linkInfo = db.prepare('SELECT group_id FROM linked_channels WHERE channel_id = ?').get(channelId);
        if (!linkInfo) return interaction.editReply('❌ This channel is not linked to a relay group.');

        const group = db.prepare('SELECT * FROM relay_groups WHERE group_id = ?').get(linkInfo.group_id);
        
        // --- [THE FIX] REFRESH OWNERSHIP & SECURITY CHECK ---
        
        const isBotOwner = interaction.user.id === BOT_OWNER_ID;
        let isGroupOwner = false;

        // Try to fetch the owner guild to verify current ownership
        const ownerGuild = await interaction.client.guilds.fetch(group.owner_guild_id).catch(() => null);

        if (ownerGuild) {
            const currentDiscordOwnerId = ownerGuild.ownerId;
            const storedOwnerId = group.owner_user_id;

            // 1. Check if ownership changed
            if (storedOwnerId !== currentDiscordOwnerId) {
                console.log(`[OWNER-SYNC] Group "${group.group_name}" ownership changed. Updating DB: ${storedOwnerId} -> ${currentDiscordOwnerId}`);
                db.prepare('UPDATE relay_groups SET owner_user_id = ? WHERE group_id = ?').run(currentDiscordOwnerId, group.group_id);
            }

            // 2. Determine if user is the REAL current owner
            isGroupOwner = interaction.user.id === currentDiscordOwnerId;

            // 3. Security Log: Did the OLD owner try to use the command?
            if (!isBotOwner && !isGroupOwner && interaction.user.id === storedOwnerId) {
                console.warn(`[SECURITY-ALERT] OLD OWNER (${interaction.user.tag} / ${interaction.user.id}) attempted to use group_owner commands on "${group.group_name}" after losing server ownership.`);
            }
        } else {
            // Edge Case: Bot is kicked from owner guild. 
            // Only Bot Owner can proceed, or we rely on the DB (risky, so we default to DB check if fetch fails)
            isGroupOwner = interaction.user.id === group.owner_user_id;
        }

        // --- Permission Gate ---
        if (!isBotOwner && !isGroupOwner) {
            return interaction.editReply('❌ **Permission Denied:** Only the **Current Group Owner** (Server Owner of the creating server) or Bot Owner can use these commands.');
        }

        try {
            if (subcommand === 'add_filter') {
                const phrase = interaction.options.getString('phrase').toLowerCase().trim();
                const threshold = interaction.options.getString('threshold') || 0;
                const msg = interaction.options.getString('message') || 'Bad word/phrase is not allowed.';

                try {
                    db.prepare('INSERT INTO group_filters (group_id, phrase, threshold, warning_msg) VALUES (?, ?, ?, ?)').run(group.group_id, phrase, threshold, msg);
                    
                    let status = `Block after ${threshold} strikes.`;
                    if (threshold === 0) status = `**Censor Only** (No strikes/blocking).`;
                    
                    await interaction.editReply({ content: `✅ Added filter: "**${phrase}**" (${status})\nMsg: "${msg}"` });
                } catch (e) {
                    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
                        await interaction.editReply({ content: `⚠️ "**${phrase}**" is already in the filter list.` });
                    } else throw e;
                }

            } else if (subcommand === 'remove_filter') {
                const phrase = interaction.options.getString('phrase');
                const res = db.prepare('DELETE FROM group_filters WHERE group_id = ? AND phrase = ?').run(group.group_id, phrase);
                await interaction.editReply({ content: res.changes ? `✅ Removed filter: "**${phrase}**"` : '❌ Phrase not found in filter list.' });

            } else if (subcommand === 'edit_filter') {
                const phrase = interaction.options.getString('phrase');
                const threshold = interaction.options.getInteger('threshold');
                const msg = interaction.options.getString('message');
                
                const current = db.prepare('SELECT * FROM group_filters WHERE group_id = ? AND phrase = ?').get(group.group_id, phrase);
                if (!current) return interaction.editReply({ content: '❌ Filter phrase not found.' });

                const newThresh = threshold ?? current.threshold;
                const newMsg = msg ?? current.warning_msg;

                db.prepare('UPDATE group_filters SET threshold = ?, warning_msg = ? WHERE group_id = ? AND phrase = ?').run(newThresh, newMsg, group.group_id, phrase);
                await interaction.editReply({ content: `✅ Updated "**${phrase}**": Threshold ${newThresh}, Msg: "${newMsg}"` });

            } else if (subcommand === 'list_filters') {
                const filters = db.prepare('SELECT phrase, threshold, warning_msg FROM group_filters WHERE group_id = ?').all(group.group_id);
                if (filters.length === 0) return interaction.editReply({ content: 'ℹ️ No active filters for this group.' });
                
                const embed = new EmbedBuilder().setTitle(`Filters for ${group.group_name}`).setColor('#ED4245');
                const desc = filters.map(f => `**"${f.phrase}"** (Block @ ${f.threshold})\n└Msg: *${f.warning_msg}*`).join('\n\n');
                
                embed.setDescription(desc.length > 4000 ? desc.substring(0, 3997) + '...' : desc);
                await interaction.editReply({ embeds: [embed] });

            } else if (subcommand === 'block') {
                const targetId = interaction.options.getString('target_id');
                // Protect Bot Owner and the CURRENT Group Owner
                // Note: We use the *refreshed* owner info from the check above
                const currentOwnerId = ownerGuild ? ownerGuild.ownerId : group.owner_user_id;

                if (targetId === BOT_OWNER_ID || targetId === currentOwnerId) {
                    return interaction.editReply({ content: '❌ You cannot block the Bot Owner or the Group Owner.' });
                }
                
                try {
                    db.prepare('INSERT INTO group_blacklist (group_id, blocked_id, type) VALUES (?, ?, ?)').run(group.group_id, targetId, 'MANUAL');
                    await interaction.editReply({ content: `✅ Blocked ID \`${targetId}\`.` });
                } catch (e) {
                    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
                        await interaction.editReply({ content: '⚠️ That ID is already blocked.' });
                    } else throw e;
                }

            } else if (subcommand === 'unblock') {
                const targetId = interaction.options.getString('target_id');
                const res = db.prepare('DELETE FROM group_blacklist WHERE group_id = ? AND blocked_id = ?').run(group.group_id, targetId);
                await interaction.editReply({ content: res.changes ? `✅ Unblocked ID \`${targetId}\`.` : '⚠️ ID not found in blocklist.' });
            }

        } catch (error) {
            console.error('Group Owner Command Error:', error);
            await interaction.editReply({ content: 'An error occurred while executing the command.' });
        }
    },

    async autocomplete(interaction) {
        const focused = interaction.options.getFocused(true);
        // Only run for phrase inputs
        if (focused.name !== 'phrase') return;

        // Context check
        const linkInfo = db.prepare('SELECT group_id FROM linked_channels WHERE channel_id = ?').get(interaction.channel.id);
        if (!linkInfo) return interaction.respond([]);

        // Permission check (Bot Owner or Group Owner)
        const group = db.prepare('SELECT owner_guild_id, owner_user_id FROM relay_groups WHERE group_id = ?').get(linkInfo.group_id);
        
        // Note: For autocomplete speed, we use the cached DB ID. 
        // The real security check happens in 'execute'.
        const isBotOwner = interaction.user.id === BOT_OWNER_ID;
        const isGroupOwner = interaction.user.id === group.owner_user_id; 

        if (!isBotOwner && !isGroupOwner) return interaction.respond([]);

        // Fetch
        const filters = db.prepare('SELECT phrase FROM group_filters WHERE group_id = ? AND phrase LIKE ? LIMIT 25')
            .all(linkInfo.group_id, `%${focused.value}%`);
        
        await interaction.respond(filters.map(f => ({ name: f.phrase, value: f.phrase })));
    }
};