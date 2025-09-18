// events/messageUpdate.js
const { Events, WebhookClient, EmbedBuilder } = require('discord.js');
const db = require('../db/database.js');

// This is a new, powerful helper function to rebuild a complete message payload from scratch.
async function rebuildAndEdit(client, originalMessageId) {
    // Find the original message's details from the database
    const originalInfo = db.prepare('SELECT original_channel_id, replied_to_id FROM relayed_messages WHERE original_message_id = ? LIMIT 1').get(originalMessageId);
    if (!originalInfo) return; // This message wasn't one we relayed.
    
    // Fetch the original message object from Discord
    const originalChannel = await client.channels.fetch(originalInfo.original_channel_id).catch(() => null);
    if (!originalChannel) return;
    const originalMessage = await originalChannel.messages.fetch(originalMessageId).catch(() => null);
    if (!originalMessage) return;

    // Rebuild the sender's identity
    const senderName = originalMessage.member?.displayName ?? originalMessage.author.username;
    let username = `${senderName} (${originalMessage.guild.name})`;
    if (username.length > 80) username = username.substring(0, 77) + '...';
    const avatarURL = originalMessage.author.displayAvatarURL();

    // Find all the copies of this message that need to be updated
    const copiesToUpdate = db.prepare('SELECT * FROM relayed_messages WHERE original_message_id = ?').all(originalMessageId);

    for (const relayed of copiesToUpdate) {
        let replyEmbed = null;
        if (originalInfo.replied_to_id) {
            try {
				// 1. Get the correct channel ID from the message reference.
                const repliedToChannel = await client.channels.fetch(originalMessage.reference.channelId);
                // 2. Fetch the message from that correct channel.
                const repliedToMessage = await repliedToChannel.messages.fetch(originalMessage.reference.messageId);
                
                const repliedAuthorName = repliedToMessage.member?.displayName ?? repliedToMessage.author.username;
				const repliedAuthorAvatar = repliedMessage.author.displayAvatarURL();
                const repliedContent = repliedToMessage.content ? repliedToMessage.content.substring(0, 1000) : '*(Message had no text content)*';
                if (repliedToMessage.editedTimestamp) {
                    repliedContent += ' *(edited)*';
                }
                let messageLink = null;
                if (relayedReplyInfo) {
                    messageLink = `https://discord.com/channels/${relayed.guild_id}/${relayed.relayed_channel_id}/${relayedReplyInfo.relayed_message_id}`;
                }
                
                replyEmbed = new EmbedBuilder().setColor('#B0B8C6').setAuthor({ name: `└─Replying to ${repliedAuthorName}`, url: messageLink, iconURL: repliedAuthorAvatar }).setDescription(repliedContent);
            } catch {
                replyEmbed = new EmbedBuilder().setColor('#B0B8C6').setDescription('*Replying to a deleted or inaccessible message.*');
            }
        }

        // Rebuild the payload for this specific copy
        const payload = {
            content: originalMessage.content,
            username: username,
            avatarURL: avatarURL,
            embeds: [],
            allowedMentions: { parse: ['roles'], repliedUser: false }
            // Note: Files and stickers cannot be re-sent in an edit.
        };
        if (replyEmbed) payload.embeds.push(replyEmbed);
        payload.embeds.push(...originalMessage.embeds);

        try {
            const webhookClient = new WebhookClient({ url: relayed.webhook_url });
            await webhookClient.editMessage(relayed.relayed_message_id, payload);
			console.log(`[EDIT] SUCCESS: Updated relayed message ${relayed.relayed_message_id}`);
        } catch (error) {
            if (error.code === 10015) { db.prepare('DELETE FROM linked_channels WHERE channel_id = ?').run(relayed.relayed_channel_id); } 
            else { console.error(`[EDIT] FAILED to edit message ${relayed.relayed_message_id}:`, error.message); }
        }
    }
}

module.exports = {
    name: Events.MessageUpdate,
    async execute(oldMessage, newMessage) {
        if (!newMessage.guild || newMessage.author.bot) return;
        if (newMessage.partial) { try { await newMessage.fetch(); } catch { return; } }
        if (oldMessage.content === newMessage.content && oldMessage.attachments.size === newMessage.attachments.size) return;

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
    },
};