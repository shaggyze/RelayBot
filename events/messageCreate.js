// events/messageCreate.js
const { Events, WebhookClient, Collection, PermissionFlagsBits } = require('discord.js');
const db = require('../db/database.js');

const webhookCache = new Collection();

module.exports = {
    name: Events.MessageCreate,
    async execute(message) {
        if (message.author.bot || message.webhookId || !message.guild) return;

        const sourceChannelInfo = db.prepare('SELECT * FROM linked_channels WHERE channel_id = ?').get(message.channel.id);
        if (!sourceChannelInfo) return;

        const targetChannels = db.prepare('SELECT * FROM linked_channels WHERE group_id = ? AND channel_id != ?').all(sourceChannelInfo.group_id, message.channel.id);
        if (targetChannels.length === 0) return;

        const username = message.member.displayName;
        const avatarURL = message.author.displayAvatarURL();

        for (const target of targetChannels) {
            try {
                let content = message.content;
                const roleMentions = content.match(/<@&(\d+)>/g);

                if (roleMentions) {
                    for (const mention of roleMentions) {
                        const sourceRoleId = mention.match(/\d+/)[0];
                        const roleMap = db.prepare(`SELECT role_name FROM role_mappings WHERE group_id = ? AND guild_id = ? AND role_id = ?`).get(sourceChannelInfo.group_id, message.guild.id, sourceRoleId);
                        if (!roleMap) continue;

                        let targetRole = db.prepare(`SELECT role_id FROM role_mappings WHERE group_id = ? AND guild_id = ? AND role_name = ?`).get(target.group_id, target.guild_id, roleMap.role_name);

                        if (!targetRole) {
                            try {
                                const targetGuild = await message.client.guilds.fetch(target.guild_id);
                                if (!targetGuild.members.me.permissions.has(PermissionFlagsBits.ManageRoles)) {
                                    console.warn(`[Relay] Cannot create role in guild ${target.guild_id}: Missing 'Manage Roles' permission.`);
                                    continue;
                                }
                                const newRole = await targetGuild.roles.create({ name: roleMap.role_name, mentionable: true, reason: `Auto-created for message relay.` });
                                db.prepare('INSERT INTO role_mappings (group_id, guild_id, role_name, role_id) VALUES (?, ?, ?, ?)').run(target.group_id, target.guild_id, roleMap.role_name, newRole.id);
                                targetRole = { role_id: newRole.id };
                                console.log(`[Relay] Auto-created role "${newRole.name}" in guild ${target.guild_id}.`);
                            } catch (creationError) {
                                console.error(`[Relay] Failed to auto-create role "${roleMap.role_name}" in guild ${target.guild_id}:`, creationError);
                                continue;
                            }
                        }
                        content = content.replace(mention, `<@&${targetRole.role_id}>`);
                    }
                }

                let webhookClient = webhookCache.get(target.webhook_url);
                if (!webhookClient) {
                    webhookClient = new WebhookClient({ url: target.webhook_url });
                    webhookCache.set(target.webhook_url, webhookClient);
                }

                await webhookClient.send({
                    content: content,
                    username: username,
                    avatarURL: avatarURL,
                    files: message.attachments.map(att => att.url),
                    embeds: message.embeds,
                    allowedMentions: { parse: ['roles'] }
                });

            } catch (error) {
                console.error(`[Relay] Failed to relay message to channel ${target.channel_id}:`, error);
                if (error.code === 10015) { // Unknown Webhook
                    console.error(`[Relay] Webhook for channel ${target.channel_id} is invalid. Removing from DB.`);
                    db.prepare('DELETE FROM linked_channels WHERE channel_id = ?').run(target.channel_id);
                }
            }
        }
    },
};