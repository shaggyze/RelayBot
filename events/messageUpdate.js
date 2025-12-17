// events/messageUpdate.js
const { Events, WebhookClient, EmbedBuilder } = require('discord.js');
const db = require('../db/database.js');
const webhookManager = require('../utils/webhookManager.js');

const MAX_USERNAME_LENGTH = 80;
const DISCORD_MESSAGE_LIMIT = 2000;
const BOT_OWNER_ID = '182938628643749888';

// Helper to escape regex characters for the filter system
function escapeRegex(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Definitive helper function to rebuild and edit a message.
async function rebuildAndEdit(client, originalMessageId) {
    try {
        // 1. Get info about the original message location
        const originalInfo = db.prepare('SELECT original_channel_id FROM relayed_messages WHERE original_message_id = ? LIMIT 1').get(originalMessageId);
        if (!originalInfo) return;
        
        // 2. Fetch the current state of the original message
        const originalChannel = await client.channels.fetch(originalInfo.original_channel_id).catch(() => null);
        if (!originalChannel) return;
        const originalMessage = await originalChannel.messages.fetch(originalMessageId).catch(() => null);
        if (!originalMessage) return;

        // 3. Get source channel settings (Branding, Filters, Bot Processing)
        const sourceChannelInfo = db.prepare('SELECT * FROM linked_channels WHERE channel_id = ?').get(originalMessage.channel.id);
        if (!sourceChannelInfo) return;

        // --- [NEW] Bot Processing Check ---
        // If the author is a bot/webhook, only proceed if the setting is ON.
        const processBots = sourceChannelInfo.process_bot_messages;
        // Exception: Always process edits if it's OUR bot (though loop protection prevents us from getting here usually)
        if (originalMessage.author.id !== client.user.id) {
            if ((originalMessage.author.bot || originalMessage.webhookId) && !processBots) {
                return;
            }
        }

        // --- [NEW] Branding Logic ---
        const senderName = originalMessage.member?.displayName ?? originalMessage.author.username;
        const serverBrand = sourceChannelInfo.brand_name || originalMessage.guild.name;
        let username = `${senderName} (${serverBrand})`;
        if (username.length > MAX_USERNAME_LENGTH) {
            username = username.substring(0, MAX_USERNAME_LENGTH - 3) + '...';
        }
        const avatarURL = originalMessage.author.displayAvatarURL();

        // --- [NEW] Filter System (Censorship) ---
        let finalContent = originalMessage.content;
        
        // Check immunity (Bot Owner / Group Owner)
        const groupInfo = db.prepare('SELECT owner_user_id FROM relay_groups WHERE group_id = ?').get(sourceChannelInfo.group_id);
        const isBotOwner = originalMessage.author.id === BOT_OWNER_ID;
        const isGroupOwner = groupInfo && originalMessage.author.id === groupInfo.owner_user_id;

        if (finalContent) {
            const filters = db.prepare('SELECT phrase FROM group_filters WHERE group_id = ?').all(sourceChannelInfo.group_id);
            for (const f of filters) {
                const regex = new RegExp(`\\b${escapeRegex(f.phrase)}\\b`, 'gi');
                if (regex.test(finalContent)) {
                    finalContent = finalContent.replace(regex, '***');
                }
            }
        }

        // Add attachment links if present (since we can't re-upload files easily on edit)
        if (originalMessage.attachments.size > 0) {
            const attachmentLinks = originalMessage.attachments.map(a => a.url).join('\n');
            if (!finalContent.includes(attachmentLinks)) {
                finalContent += `\n${attachmentLinks}`;
            }
        }

        // Truncate if needed
        if (finalContent.length > DISCORD_MESSAGE_LIMIT) {
            const truncationNotice = `\n*(Message was truncated...)*`;
            finalContent = finalContent.substring(0, DISCORD_MESSAGE_LIMIT - truncationNotice.length) + truncationNotice;
        }

        // --- [NEW] Embed Reconstruction (Fixes small images) ---
        const payloadEmbeds = [];
        if (originalMessage.embeds.length > 0) {
            for (const originalEmbed of originalMessage.embeds) {
                const cleanEmbed = new EmbedBuilder();
                if (originalEmbed.title) cleanEmbed.setTitle(originalEmbed.title);
                if (originalEmbed.description) cleanEmbed.setDescription(originalEmbed.description);
                if (originalEmbed.url) cleanEmbed.setURL(originalEmbed.url);
                if (originalEmbed.color) cleanEmbed.setColor(originalEmbed.color);
                if (originalEmbed.timestamp) cleanEmbed.setTimestamp(new Date(originalEmbed.timestamp));
                if (originalEmbed.author) cleanEmbed.setAuthor({ name: originalEmbed.author.name, url: originalEmbed.author.url, iconURL: originalEmbed.author.iconURL });
                if (originalEmbed.footer) cleanEmbed.setFooter({ text: originalEmbed.footer.text, iconURL: originalEmbed.footer.iconURL });
                if (originalEmbed.fields && originalEmbed.fields.length > 0) cleanEmbed.addFields(originalEmbed.fields);

                // Image Logic
                if (originalEmbed.image) {
                    cleanEmbed.setImage(originalEmbed.image.url);
                } else if (originalEmbed.thumbnail && originalEmbed.type === 'image') {
                    cleanEmbed.setImage(originalEmbed.thumbnail.url);
                } else if (originalEmbed.thumbnail) {
                    cleanEmbed.setThumbnail(originalEmbed.thumbnail.url);
                }

                if (cleanEmbed.data.title || cleanEmbed.data.description || cleanEmbed.data.image || cleanEmbed.data.author) {
                    payloadEmbeds.push(cleanEmbed);
                } else if (originalEmbed.url && originalEmbed.type === 'image') {
                    cleanEmbed.setImage(originalEmbed.url);
                    payloadEmbeds.push(cleanEmbed);
                }
            }
        }

        // --- Execute Updates ---
        const copiesToUpdate = db.prepare('SELECT * FROM relayed_messages WHERE original_message_id = ?').all(originalMessageId);

        for (const relayed of copiesToUpdate) {
            try {
                // Reply Embed Logic (Unique per target)
                let replyEmbed = null;
                let replyPing = '';

                if (originalMessage.reference && originalMessage.reference.messageId) {
                    // Try to fetch replied-to message info
                    let repliedMessage; 
                    try {
                        const repliedToChannel = await client.channels.fetch(originalMessage.reference.channelId);
                        repliedMessage = await repliedToChannel.messages.fetch(originalMessage.reference.messageId);
                    } catch { /* Msg deleted */ }

                    if (repliedMessage) {
                        const repliedAuthorName = repliedMessage.member?.displayName ?? repliedMessage.author.username;
                        const repliedAuthorAvatar = repliedMessage.author.displayAvatarURL();
                        let repliedContent = repliedMessage.content ? repliedMessage.content.substring(0, 1000) : '*(Message had no text content)*';
                        if (repliedMessage.editedTimestamp) repliedContent += ' *(edited)*';

                        // DB Lookup for Link
                        const repliedToId = repliedMessage.id;
                        const parentInfo = db.prepare('SELECT original_message_id FROM relayed_messages WHERE relayed_message_id = ?').get(repliedToId);
                        const rootOriginalId = parentInfo ? parentInfo.original_message_id : repliedToId;
                        const relayedReplyInfo = db.prepare('SELECT relayed_message_id FROM relayed_messages WHERE original_message_id = ? AND relayed_channel_id = ?').get(rootOriginalId, relayed.relayed_channel_id);
                        
                        let messageLink = null;
                        if (relayedReplyInfo && relayedReplyInfo.relayed_message_id) {
                            messageLink = `https://discord.com/channels/${relayed.relayed_channel_id}/${relayedReplyInfo.relayed_message_id}`; // Note: Guild ID missing in DB record here, using simplified link format
                            // Better link if we had guild ID: `https://discord.com/channels/${targetGuildId}/${relayed.relayed_channel_id}/${relayedReplyInfo.relayed_message_id}`
                        } else {
                            // Fallback to original URL
                             messageLink = repliedMessage.url;
                        }

                        // Consistent Style
                        replyEmbed = new EmbedBuilder()
                            .setColor('#B0B8C6')
                            .setAuthor({ name: `Replying to ${repliedAuthorName}`, url: messageLink, iconURL: repliedAuthorAvatar })
                            .setDescription(repliedContent);
                        
                        replyPing = `<@${repliedMessage.author.id}> `;
                    } else {
                        replyEmbed = new EmbedBuilder().setColor('#B0B8C6').setDescription('*Replying to a deleted or inaccessible message.*');
                    }
                }

                // Combine Content
                const targetContent = replyPing + finalContent;

                const payload = {
                    content: targetContent,
                    username: username,
                    avatarURL: avatarURL,
                    embeds: [],
                    allowedMentions: { parse: ['roles', 'users'], repliedUser: false }
                };
                
                if (replyEmbed) payload.embeds.push(replyEmbed);
                if (payloadEmbeds.length > 0) payload.embeds.push(...payloadEmbeds);

                // Get Webhook
                const channelLink = db.prepare('SELECT webhook_url FROM linked_channels WHERE channel_id = ?').get(relayed.relayed_channel_id);
                if (!channelLink || !channelLink.webhook_url) {
                    console.log(`[EDIT] SKIPPING: No valid webhook URL found for channel ${relayed.relayed_channel_id}.`);
                    continue;
                }

                const webhookClient = new WebhookClient({ url: channelLink.webhook_url });
                await webhookClient.editMessage(relayed.relayed_message_id, payload);
                // console.log(`[EDIT] SUCCESS: Updated relayed message ${relayed.relayed_message_id}`);

            } catch (loopError) {
				console.error(`[EDIT-LOOP-ERROR] A failure occurred while processing an update for relayed message ${relayed.relayed_message_id}:`, loopError);
                if (loopError.code === 10015) { 
                    // [THE FIX] Use the Manager
                    // We can attempt to repair and then retry the edit immediately
                    const newClient = await webhookManager.handleInvalidWebhook(client, relayed.relayed_channel_id, 'Message Update');
                    if (newClient) {
                         try {
                             await newClient.editMessage(relayed.relayed_message_id, payload);
                             // console.log(`[EDIT] Success after repair.`);
                         } catch (e) { /* ignore retry fail */ }
                    }
                } else if (loopError.code !== 10008) { // Ignore Unknown Message
                     console.error(`[EDIT-LOOP-ERROR] Failed update for ${relayed.relayed_message_id}:`, loopError.message);
                } else {
                    const errorCode = error.code || 'N/A';
                    const errorMsg = error.message || 'Unknown error occurred';
                    console.error(`[EDIT-LOOP-ERROR] FAILED to update relay for target #${targetChannelNameForError}. Code: ${errorCode} | Error: ${errorMsg}`);
                }
            }
        }
    } catch (error) {
        console.error(`[EDIT-FATAL] Error in rebuildAndEdit for message ${originalMessageId}:`, error);
    }
}

module.exports = {
    name: Events.MessageUpdate,
    async execute(oldMessage, newMessage) {
        try {
            if (!newMessage.guild) return; 
            
            // Allow bots if enabled, but check setting in rebuildAndEdit
            // This basic check ignores basic bot updates unless we know they need processing
            // For now, let everything through to rebuildAndEdit which has the robust check.
            
            if (newMessage.partial) { try { await newMessage.fetch(); } catch { return; } }
            
            // Ignore if content/embeds didn't change (prevents loops on reaction updates or ephemeral changes)
            if (oldMessage.content === newMessage.content && 
                oldMessage.attachments.size === newMessage.attachments.size && 
                oldMessage.embeds.length === newMessage.embeds.length) return;

            // CASE 1: The edited message IS an original message.
            await rebuildAndEdit(newMessage.client, newMessage.id);

            // CASE 2: The edited message was REPLIED TO by a relayed message.
            // (Updates the "Replying to..." embed content on the children)
            const originalIdsToUpdate = db.prepare('SELECT DISTINCT original_message_id FROM relayed_messages WHERE replied_to_id = ?').all(newMessage.id);
            if (originalIdsToUpdate.length > 0) {
                for (const original of originalIdsToUpdate) {
                    await rebuildAndEdit(newMessage.client, original.original_message_id);
                }
            }
        } catch (error) {
            console.error(`[EDIT-HANDLER-FATAL] Error in MessageUpdate:`, error);
        }
    },
};