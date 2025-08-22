// events/messageCreate.js
const { Events, WebhookClient, Collection, PermissionFlagsBits } = require('discord.js');
const db = require('../db/database.js');

const webhookCache = new Collection();

module.exports = {
    name: Events.MessageCreate,
    async execute(message) {
        if (message.author.bot || !message.guild) return;

        // [NEW] Add a guard to ignore truly empty messages (e.g., sticker-only messages)
        if (!message.content && message.attachments.size === 0 && message.embeds.length === 0 && message.stickers.size === 0) {
            console.log(`[DEBUG] Message ${message.id} from ${message.author.tag} was ignored because it is effectively empty.`);
            return;
        }

        const sourceChannelInfo = db.prepare('SELECT * FROM linked_channels WHERE channel_id = ?').get(message.channel.id);
        if (!sourceChannelInfo) return; // Not a relay channel, ignore silently.

        const groupInfo = db.prepare('SELECT group_name FROM relay_groups WHERE group_id = ?').get(sourceChannelInfo.group_id);
        if (!groupInfo) {
            console.error(`[ERROR] A linked channel (${message.channel.id}) exists for a group_id (${sourceChannelInfo.group_id}) that has been deleted. Cleaning up...`);
            db.prepare('DELETE FROM linked_channels WHERE group_id = ?').run(sourceChannelInfo.group_id);
            return;
        }

        console.log(`[EVENT] Message received from ${message.author.tag} in linked channel #${message.channel.name}`);

        const targetChannels = db.prepare('SELECT * FROM linked_channels WHERE group_id = ? AND channel_id != ?').all(sourceChannelInfo.group_id, message.channel.id);
        if (targetChannels.length === 0) {
            console.log(`[DEBUG] No other target channels found in group "${groupInfo.group_name}" (ID: ${sourceChannelInfo.group_id}). Nothing to relay.`);
            return;
        }
        
        console.log(`[DEBUG] Found ${targetChannels.length} target channel(s) to relay to for group "${groupInfo.group_name}".`);
        
        const senderName = message.member?.displayName ?? message.author.username;
        const username = `${senderName} (${message.guild.name})`;
        const avatarURL = message.author.displayAvatarURL();
        
        for (const target of targetChannels) {
            const targetChannelName = message.client.channels.cache.get(target.channel_id)?.name ?? target.channel_id;
            console.log(`[RELAY] Attempting to relay message ${message.id} to channel #${targetChannelName}`);
            try {
                let targetContent = message.content;
                const roleMentions = targetContent.match(/<@&(\d+)>/g);

                if (roleMentions) {
                    console.log(`[ROLES] Found ${roleMentions.length} role mention(s). Processing for target guild ${target.guild_id}.`);
                    for (const mention of roleMentions) {
                        const sourceRoleId = mention.match(/\d+/)[0];
                        const roleMap = db.prepare(`SELECT role_name FROM role_mappings WHERE group_id = ? AND guild_id = ? AND role_id = ?`).get(sourceChannelInfo.group_id, message.guild.id, sourceRoleId);
                        if (!roleMap) {
                            console.log(`[ROLES] Role ID ${sourceRoleId} has no mapping in this group. Skipping.`);
                            continue;
                        }

                        let targetRole = db.prepare(`SELECT role_id FROM role_mappings WHERE group_id = ? AND guild_id = ? AND role_name = ?`).get(target.group_id, target.guild_id, roleMap.role_name);
                        
                        if (!targetRole) {
                            try {
                                const targetGuild = await message.client.guilds.fetch(target.guild_id);
                                if (targetGuild.members.me.permissions.has(PermissionFlagsBits.ManageRoles)) {
                                    console.log(`[ROLES] Auto-creating role "${roleMap.role_name}" in guild ${target.guild_id}.`);
                                    const newRole = await targetGuild.roles.create({ name: roleMap.role_name, mentionable: true, reason: `Auto-created for message relay.` });
                                    db.prepare('INSERT INTO role_mappings (group_id, guild_id, role_name, role_id) VALUES (?, ?, ?, ?)').run(target.group_id, target.guild_id, roleMap.role_name, newRole.id);
                                    targetRole = { role_id: newRole.id };
                                }
                            } catch (creationError) {
                                console.error(`[ROLES] FAILED to auto-create role "${roleMap.role_name}":`, creationError);
                            }
                        }
                        
                        if (targetRole) {
                            console.log(`[ROLES] Mapping "${roleMap.role_name}" from ${sourceRoleId} to ${targetRole.role_id}.`);
                            targetContent = targetContent.replace(mention, `<@&${targetRole.role_id}>`);
                        }
                    }
                }
                
                let webhookClient = webhookCache.get(target.webhook_url);
                if (!webhookClient) {
                    webhookClient = new WebhookClient({ url: target.webhook_url });
                    webhookCache.set(target.webhook_url, webhookClient);
                }

                const relayedMessage = await webhookClient.send({
                    content: targetContent, // No longer need the `|| ' '` fallback because of our new guard clause.
                    username: username,
                    avatarURL: avatarURL,
                    files: message.attachments.map(att => att.url),
                    embeds: message.embeds,
                    allowedMentions: { parse: ['roles'] }
                });

                console.log(`[RELAY] SUCCESS: Relayed message ${message.id} to new message ${relayedMessage.id} in group "${groupInfo.group_name}"`);
                
                db.prepare('INSERT INTO relayed_messages (original_message_id, original_channel_id, relayed_message_id, relayed_channel_id, webhook_url) VALUES (?, ?, ?, ?, ?)')
                  .run(message.id, message.channel.id, relayedMessage.id, relayedMessage.channel_id, target.webhook_url);

            } catch (error) {
                if (error.code === 10015) { // Unknown Webhook
                    console.error(`[AUTO-CLEANUP] Webhook for channel #${targetChannelName} (${target.channel_id}) is invalid or was deleted. Removing from the relay group.`);
                    db.prepare('DELETE FROM linked_channels WHERE channel_id = ?').run(target.channel_id);
                } else {
                    console.error(`[RELAY] FAILED to relay message to channel ${target.channel_id}:`, error);
                }
            }
        }
    },
};