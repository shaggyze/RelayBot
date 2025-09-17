// events/messageUpdate.js
const { Events, WebhookClient, EmbedBuilder, blockQuote, quote } = require('discord.js');
const db = require('../db/database.js');

// This is a powerful helper function to rebuild a complete message payload from scratch.
async function rebuildRelayPayload(client, originalMessageId) {
    // We need to find the original channel to fetch the message.
    const originalChannelId = db.prepare('SELECT original_channel_id FROM relayed_messages WHERE original_message_id = ? LIMIT 1').get(originalMessageId)?.original_channel_id;
    if (!originalChannelId) return null; // Safety check if the original message isn't in the DB.

    const originalChannel = await client.channels.fetch(originalChannelId).catch(() => null);
    if (!originalChannel) return null;

    const originalMessage = await originalChannel.messages.fetch(originalMessageId).catch(() => null);
    if (!originalMessage) return null;

    const senderName = originalMessage.member?.displayName ?? originalMessage.author.username;
    let username = `${senderName} (${originalMessage.guild.name})`;
    if (username.length > 80) username = username.substring(0, 77) + '...';
    const avatarURL = originalMessage.author.displayAvatarURL();

    let replyEmbed = null;
    if (originalMessage.reference && originalMessage.reference.messageId) {
        try {
            const repliedToMessage = await originalMessage.channel.messages.fetch(originalMessage.reference.messageId);
            const repliedAuthorName = repliedToMessage.member?.displayName ?? repliedToMessage.author.username;
            const repliedContent = repliedToMessage.content ? repliedToMessage.content.substring(0, 1000) : '*(Message had no text content)*';
            replyEmbed = new EmbedBuilder().setColor('#B0B8C6').setAuthor({ name: `Replying to ${repliedAuthorName}` }).setDescription(repliedContent);
        } catch {
            replyEmbed = new EmbedBuilder().setColor('#B0B8C6').setDescription('*Replying to a deleted or inaccessible message.*');
        }
    }

    const payload = {
        content: originalMessage.content,
        username: username,
        avatarURL: avatarURL,
        embeds: [],
        // Note: Files, stickers, and attachments cannot be re-sent in an edit.
        allowedMentions: { parse: ['roles'], repliedUser: false }
    };
    if (replyEmbed) payload.embeds.push(replyEmbed);
    payload.embeds.push(...originalMessage.embeds);
    return payload;
}

module.exports = {
    name: Events.MessageUpdate,
    async execute(oldMessage, newMessage) {
        if (!newMessage.guild || newMessage.author.bot) return;
        if (newMessage.partial) { try { await newMessage.fetch(); } catch { return; } }
        // Ignore edits that are just embed loads
        if (oldMessage.content === newMessage.content && oldMessage.attachments.size === newMessage.attachments.size) return;

        // --- CASE 1: The edited message IS an original message that was relayed. ---
        const case1Copies = db.prepare('SELECT * FROM relayed_messages WHERE original_message_id = ?').all(newMessage.id);
        if (case1Copies.length > 0) {
            console.log(`[EDIT] Detected edit on original message ${newMessage.id}. Rebuilding and updating ${case1Copies.length} copies.`);
            const newPayload = await rebuildRelayPayload(newMessage.client, newMessage.id);
            if (!newPayload) return;

            for (const relayed of case1Copies) {
                try {
                    const webhookClient = new WebhookClient({ url: relayed.webhook_url });
                    await webhookClient.editMessage(relayed.relayed_message_id, newPayload);
					console.log(`[EDIT] SUCCESS: Updated relayed message ${relayed.relayed_message_id}`);
                } catch (error) {
                    // [THE FIX] Restore the self-healing logic here.
                    if (error.code === 10015) { // Unknown Webhook
                        console.error(`[AUTO-CLEANUP] Webhook for channel ${relayed.relayed_channel_id} is invalid. Removing from relay.`);
                        db.prepare('DELETE FROM linked_channels WHERE channel_id = ?').run(relayed.relayed_channel_id);
                    } else {
                        console.error(`[EDIT-CASE1] FAILED to edit message ${relayed.relayed_message_id}:`, error.message);
                    }
                }
            }
        }

        // --- CASE 2: The edited message was REPLIED TO by a relayed message. ---
        const case2Originals = db.prepare('SELECT DISTINCT original_message_id FROM relayed_messages WHERE replied_to_id = ?').all(newMessage.id);
        if (case2Originals.length > 0) {
             console.log(`[EDIT] Detected edit on a replied-to message ${newMessage.id}. Found ${case2Originals.length} relay(s) that need updating.`);
            for (const original of case2Originals) {
                const newPayload = await rebuildRelayPayload(newMessage.client, original.original_message_id);
                if (!newPayload) continue;

                const copiesToUpdate = db.prepare('SELECT * FROM relayed_messages WHERE original_message_id = ?').all(original.original_message_id);
                for (const relayed of copiesToUpdate) {
                    try {
                        const webhookClient = new WebhookClient({ url: relayed.webhook_url });
                        await webhookClient.editMessage(relayed.relayed_message_id, newPayload);
						console.log(`[EDIT] SUCCESS: Updated relayed message ${relayed.relayed_message_id}`);
                    } catch (error) {
                         // [THE FIX] Restore the self-healing logic here as well.
                        if (error.code === 10015) { // Unknown Webhook
                            console.error(`[AUTO-CLEANUP] Webhook for channel ${relayed.relayed_channel_id} is invalid. Removing from relay.`);
                            db.prepare('DELETE FROM linked_channels WHERE channel_id = ?').run(relayed.relayed_channel_id);
                        } else {
                            console.error(`[EDIT-CASE2] FAILED to edit message ${relayed.relayed_message_id}:`, error.message);
                        }
                    }
                }
            }
        }
    },
};