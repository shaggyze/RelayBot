// events/messageUpdate.js
const { Events, WebhookClient, EmbedBuilder } = require('discord.js');
const db = require('../db/database.js');

const MAX_USERNAME_LENGTH = 80;
const DISCORD_MESSAGE_LIMIT = 2000;

// This is the definitive, robust helper function to rebuild and edit a message.
async function rebuildAndEdit(client, originalMessageId) {
    try {
        const originalInfo = db.prepare('SELECT original_channel_id, replied_to_id FROM relayed_messages WHERE original_message_id = ? LIMIT 1').get(originalMessageId);
        if (!originalInfo) return;
        
        const originalChannel = await client.channels.fetch(originalInfo.original_channel_id).catch(() => null);
        if (!originalChannel) return;
        const originalMessage = await originalChannel.messages.fetch(originalMessageId).catch(() => null);
        if (!originalMessage) return;

        const senderName = originalMessage.member?.displayName ?? originalMessage.author.username;
        let username = `${senderName} (${originalMessage.guild.name})`;
        if (username.length > MAX_USERNAME_LENGTH) {
            username = username.substring(0, MAX_USERNAME_LENGTH - 3) + '...';
        }
        const avatarURL = originalMessage.author.displayAvatarURL();

        const copiesToUpdate = db.prepare('SELECT * FROM relayed_messages WHERE original_message_id = ?').all(originalMessageId);

        for (const relayed of copiesToUpdate) {
            try {
                let replyEmbed = null;
                if (originalMessage.reference && originalMessage.reference.messageId) {
                    try {
                        const repliedToChannel = await client.channels.fetch(originalMessage.reference.channelId);
                        const repliedToMessage = await repliedToChannel.messages.fetch(originalMessage.reference.messageId);
                        const repliedAuthorName = repliedToMessage.member?.displayName ?? repliedToMessage.author.username;
                        const repliedAuthorAvatar = repliedToMessage.author.displayAvatarURL();
                        let repliedContent = repliedToMessage.content ? repliedToMessage.content.substring(0, 1000) : '*(Message had no text content)*';
                        if (repliedToMessage.editedTimestamp) {
                            repliedContent += ' *(edited)*';
                        }
                        const relayedReplyInfo = db.prepare('SELECT relayed_message_id FROM relayed_messages WHERE original_message_id = ? AND relayed_channel_id = ?').get(originalMessage.reference.messageId, relayed.relayed_channel_id);
                        let messageLink = null;
                        if (relayedReplyInfo) {
                            messageLink = `https://discord.com/channels/${relayed.guild_id}/${relayed.relayed_channel_id}/${relayedReplyInfo.relayed_message_id}`;
                        }
                        replyEmbed = new EmbedBuilder().setColor('#B0B8C6').setAuthor({ name: `Replying to ${repliedAuthorName}`, url: messageLink, iconURL: repliedAuthorAvatar }).setDescription(repliedContent);
                    } catch {
                        replyEmbed = new EmbedBuilder().setColor('#B0B8C6').setDescription('*Replying to a deleted or inaccessible message.*');
                    }
                }
                
                let finalContent = originalMessage.content;
                if (finalContent.length > DISCORD_MESSAGE_LIMIT) {
                    const truncationNotice = `\n*(Message was truncated...)*`;
                    finalContent = finalContent.substring(0, DISCORD_MESSAGE_LIMIT - truncationNotice.length) + truncationNotice;
                }

                // [THE DEFINITIVE FIX] - Rebuild the payload with all safety checks.
                const payload = {
                    content: finalContent,
                    username: username,
                    avatarURL: avatarURL,
                    embeds: [],
                    // Note: Files cannot be re-sent in an edit, so we don't include them.
                    files: [],
                    allowedMentions: { parse: ['roles'], repliedUser: false }
                };
                if (replyEmbed) payload.embeds.push(replyEmbed);
                payload.embeds.push(...originalMessage.embeds);

                if (originalMessage.stickers.size > 0) {
                    const sticker = originalMessage.stickers.first();
                    if (sticker && sticker.id) {
                        payload.stickers = [sticker.id];
                    }
                }

                try {
                    const webhookClient = new WebhookClient({ url: relayed.webhook_url });
                    await webhookClient.editMessage(relayed.relayed_message_id, payload);
                    console.log(`[EDIT] SUCCESS: Updated relayed message ${relayed.relayed_message_id}`);
                } catch (error) {
                    if (error.code === 50006 && payload.stickers) {
                        const sticker = originalMessage.stickers.first();
                        if (sticker && sticker.name) {
                            const fallbackPayload = payload;
                            delete fallbackPayload.stickers;
                            fallbackPayload.content += `\n*(sent sticker: ${sticker.name})*`;
                            const webhookClient = new WebhookClient({ url: relayed.webhook_url });
                            await webhookClient.editMessage(relayed.relayed_message_id, fallbackPayload);
                            console.log(`[EDIT] SUCCESS (Fallback): Updated relayed message ${relayed.relayed_message_id}`);
                        }
                    } else if (error.code === 10015) {
                        db.prepare('DELETE FROM linked_channels WHERE channel_id = ?').run(relayed.relayed_channel_id);
                    } else {
                        throw error;
                    }
                }
            } catch (loopError) {
                console.error(`[EDIT-LOOP-ERROR] A failure occurred while processing an update for relayed message ${relayed.relayed_message_id}:`, loopError);
            }
        }
    } catch (error) {
        console.error(`[EDIT-FATAL] A critical unhandled error occurred in rebuildAndEdit for message ${originalMessageId}.`, error);
    }
}

module.exports = {
    name: Events.MessageUpdate,
    async execute(oldMessage, newMessage) {
        try {
            if (!newMessage.guild || newMessage.author.bot) return;
            if (newMessage.partial) { try { await newMessage.fetch(); } catch { return; } }
            if (oldMessage.content === newMessage.content && oldMessage.attachments.size === newMessage.attachments.size && oldMessage.embeds.length === newMessage.embeds.length) return;

            // CASE 1: The edited message IS an original message.
            await rebuildAndEdit(newMessage.client, newMessage.id);

            // CASE 2: The edited message was REPLIED TO by a relayed message.
            const originalIdsToUpdate = db.prepare('SELECT DISTINCT original_message_id FROM relayed_messages WHERE replied_to_id = ?').all(newMessage.id);
            if (originalIdsToUpdate.length > 0) {
                 console.log(`[EDIT] Detected edit on a replied-to message ${newMessage.id}. Found ${originalIdsToUpdate.length} relay(s) that need updating.`);
                for (const original of originalIdsToUpdate) {
                    await rebuildAndEdit(newMessage.client, original.original_message_id);
                }
            }
        } catch (error) {
            console.error(`[EDIT-HANDLER-FATAL] A critical unhandled error occurred in the main MessageUpdate handler.`, error);
        }
    },
};