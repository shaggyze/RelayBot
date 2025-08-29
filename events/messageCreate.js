// events/messageCreate.js
const { Events, WebhookClient, Collection, PermissionFlagsBits, blockQuote, quote } = require('discord.js');
const db = require('../db/database.js');

const webhookCache = new Collection();

module.exports = {
    name: Events.MessageCreate,
    async execute(message) {
        if (message.author.bot || !message.guild) return;

        // A simple check for truly empty messages (e.g., a failed embed load).
        // Note: Sticker-only messages are handled later.
        if (!message.content && message.attachments.size === 0 && message.embeds.length === 0 && message.stickers.size === 0) {
            return;
        }

        const sourceChannelInfo = db.prepare("SELECT * FROM linked_channels WHERE channel_id = ? AND direction IN ('BOTH', 'SEND_ONLY')").get(message.channel.id);
        if (!sourceChannelInfo) return;

        const groupInfo = db.prepare('SELECT group_name FROM relay_groups WHERE group_id = ?').get(sourceChannelInfo.group_id);
        if (!groupInfo) {
            console.error(`[ERROR] A linked channel (${message.channel.id}) exists for a group_id (${sourceChannelInfo.group_id}) that has been deleted. Cleaning up...`);
            db.prepare('DELETE FROM linked_channels WHERE group_id = ?').run(sourceChannelInfo.group_id);
            return;
        }

        console.log(`[EVENT] Message received from ${message.author.tag} in linked channel #${message.channel.name}`);

        const targetChannels = db.prepare(
            `SELECT * FROM linked_channels WHERE group_id = ? AND channel_id != ? AND direction IN ('BOTH', 'RECEIVE_ONLY')`
        ).all(sourceChannelInfo.group_id, message.channel.id);

        if (targetChannels.length === 0) return;
        
        console.log(`[DEBUG] Found ${targetChannels.length} target channel(s) to relay to for group "${groupInfo.group_name}".`);
        
        const senderName = message.member?.displayName ?? message.author.username;
        const username = `${senderName} (${message.guild.name})`;
        const avatarURL = message.author.displayAvatarURL();
        
        let replyContent = '';
        if (message.reference && message.reference.messageId) {
            try {
                const repliedMessage = await message.channel.messages.fetch(message.reference.messageId);
                const repliedAuthorName = repliedMessage.member?.displayName ?? repliedMessage.author.username;
                replyContent = blockQuote(quote(`${repliedAuthorName}: ${repliedMessage.content.substring(0, 200)}`)) + '\n';
            } catch {
                replyContent = blockQuote(quote(`Replying to a deleted or inaccessible message.`)) + '\n';
            }
        }

        for (const target of targetChannels) {
            const targetChannelName = message.client.channels.cache.get(target.channel_id)?.name ?? target.channel_id;
            console.log(`[RELAY] Attempting to relay message ${message.id} to channel #${targetChannelName}`);
            try {
                let targetContent = message.content;
                const roleMentions = targetContent.match(/<@&(\d+)>/g);

                if (roleMentions) {
                    // Role mapping logic does not change.
                    // It correctly replaces mapped roles and leaves unmapped roles untouched.
                    for (const mention of roleMentions) {
                        const sourceRoleId = mention.match(/\d+/)[0];
                        const roleMap = db.prepare(`SELECT role_name FROM role_mappings WHERE group_id = ? AND guild_id = ? AND role_id = ?`).get(sourceChannelInfo.group_id, message.guild.id, sourceRoleId);
                        if (!roleMap) continue;

                        let targetRole = db.prepare(`SELECT role_id FROM role_mappings WHERE group_id = ? AND guild_id = ? AND role_name = ?`).get(target.group_id, target.guild_id, roleMap.role_name);
                        if (targetRole) {
                            targetContent = targetContent.replace(mention, `<@&${targetRole.role_id}>`);
                        }
                    }
                }
                
                let finalContent = replyContent + targetContent;

                // [THE DEFINITIVE FIX FOR UNMAPPED ROLES AND EMPTY MESSAGES]
                // This logic ensures a message is NEVER dropped.
                // If the final text content is empty or just mentions, we add an invisible character
                // to force Discord's API to process and render it, showing '@unknown-role'.
                const contentWithoutMentions = finalContent.replace(/<@!?&?#?(\d+)>/g, '').trim();
                if (contentWithoutMentions.length === 0 && (finalContent.includes('<@') || finalContent.includes('<#'))) {
                    finalContent += '\u200B'; // Append a zero-width space
                }

                let webhookClient = webhookCache.get(target.webhook_url);
                if (!webhookClient) {
                    webhookClient = new WebhookClient({ url: target.webhook_url });
                    webhookCache.set(target.webhook_url, webhookClient);
                }

                const payload = {
                    content: finalContent,
                    username: username,
                    avatarURL: avatarURL,
                    files: message.attachments.map(att => att.url),
                    embeds: message.embeds,
                    allowedMentions: { parse: ['roles'], repliedUser: false }
                };

                if (message.stickers.size > 0) {
                    payload.stickers = [message.stickers.first().id];
                }

                // Final check: If after all this, the payload is still fundamentally empty, we skip.
                // This should now only catch truly blank messages, not unmapped roles.
                if (!payload.content.trim() && !payload.files.length && !payload.embeds.length && !payload.stickers) {
                    console.log(`[RELAY] SKIPPED sending to #${targetChannelName} because the final payload was truly empty.`);
                    continue;
                }

                const relayedMessage = await webhookClient.send(payload);

                console.log(`[RELAY] SUCCESS: Relayed message ${message.id} to new message ${relayedMessage.id} in group "${groupInfo.group_name}"`);
                
                db.prepare('INSERT INTO relayed_messages (original_message_id, original_channel_id, relayed_message_id, relayed_channel_id, webhook_url) VALUES (?, ?, ?, ?, ?)')
                  .run(message.id, message.channel.id, relayedMessage.id, relayedMessage.channel_id, target.webhook_url);

            } catch (error) {
                if (error.code === 10015) {
                    console.error(`[AUTO-CLEANUP] Webhook for channel #${targetChannelName} is invalid. Removing from relay.`);
                    db.prepare('DELETE FROM linked_channels WHERE channel_id = ?').run(target.channel_id);
                } else {
                    console.error(`[RELAY] FAILED to relay message to channel ${target.channel_id}:`, error);
                }
            }
        }
    },
};