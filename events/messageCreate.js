// events/messageCreate.js
const { Events, WebhookClient, Collection, PermissionFlagsBits, blockQuote, quote, StickerType } = require('discord.js');
const db = require('../db/database.js');

const webhookCache = new Collection();

module.exports = {
    name: Events.MessageCreate,
    async execute(message) {
        if (message.author.bot || !message.guild) return;

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

        const targetChannels = db.prepare(`SELECT * FROM linked_channels WHERE group_id = ? AND channel_id != ? AND direction IN ('BOTH', 'RECEIVE_ONLY')`).all(sourceChannelInfo.group_id, message.channel.id);
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
            }
            let finalContent = replyContent + targetContent;

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

            try {
                // --- OPTIMISTIC FIRST ATTEMPT ---
                const webhookClient = new WebhookClient({ url: target.webhook_url });
                const relayedMessage = await webhookClient.send(payload);

                console.log(`[RELAY] SUCCESS: Relayed message ${message.id} to new message ${relayedMessage.id} in group "${groupInfo.group_name}"`);
                
                db.prepare('INSERT INTO relayed_messages (original_message_id, original_channel_id, relayed_message_id, relayed_channel_id, webhook_url) VALUES (?, ?, ?, ?, ?)')
                  .run(message.id, message.channel.id, relayedMessage.id, relayedMessage.channel_id, target.webhook_url);

            } catch (error) {
                // --- INTELLIGENT CATCH BLOCK ---
                if (error.code === 50006 && message.stickers.size > 0) {
                    // This error means the sticker was likely invalid for the webhook.
                    console.warn(`[RELAY] Sticker relay failed for message ${message.id}. Retrying with text fallback.`);
                    
                    // --- GUARANTEED FALLBACK ATTEMPT ---
                    try {
                        const sticker = message.stickers.first();
                        const fallbackPayload = payload;
                        // Remove the sticker and add text instead.
                        delete fallbackPayload.stickers;
                        fallbackPayload.content += `\n*(sent sticker: ${sticker.name})*`;

                        const webhookClient = new WebhookClient({ url: target.webhook_url });
                        const relayedMessage = await webhookClient.send(fallbackPayload);
                        
                        console.log(`[RELAY] SUCCESS (Fallback): Relayed message ${message.id} to new message ${relayedMessage.id} in group "${groupInfo.group_name}"`);
                
                        db.prepare('INSERT INTO relayed_messages (original_message_id, original_channel_id, relayed_message_id, relayed_channel_id, webhook_url) VALUES (?, ?, ?, ?, ?)')
                          .run(message.id, message.channel.id, relayedMessage.id, relayedMessage.channel_id, target.webhook_url);

                    } catch (fallbackError) {
                        console.error(`[RELAY] FAILED on fallback attempt for message ${message.id} to channel ${target.channel_id}:`, fallbackError);
                    }

                } else if (error.code === 10015) {
                    console.error(`[AUTO-CLEANUP] Webhook for channel #${targetChannelName} is invalid. Removing from relay.`);
                    db.prepare('DELETE FROM linked_channels WHERE channel_id = ?').run(target.channel_id);
                } else {
                    console.error(`[RELAY] FAILED to relay message to channel ${target.channel_id}:`, error);
                }
            }
        }
    },
};