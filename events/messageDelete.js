// events/messageDelete.js
const { Events, WebhookClient } = require('discord.js');
const db = require('../db/database.js');

module.exports = {
    name: Events.MessageDelete,
    async execute(message) {
        if (!message.guild) return; // Ignore DMs

        // CASE 1: The deleted message was a webhook message (a bot relay)
        // This case is UNAFFECTED by our change because it doesn't use the webhook URL.
        if (message.webhookId) {
            const link = db.prepare('SELECT original_message_id, original_channel_id FROM relayed_messages WHERE relayed_message_id = ?').get(message.id);
            if (!link) return;

            const sourceChannelSettings = db.prepare('SELECT allow_reverse_delete FROM linked_channels WHERE channel_id = ?').get(link.original_channel_id);
            if (!sourceChannelSettings || !sourceChannelSettings.allow_reverse_delete) {
                return;
            }

            console.log(`[REVERSE-DELETE] Relayed message ${message.id} deleted. Attempting to delete original message ${link.original_message_id}.`);
            try {
                const originalChannel = await message.client.channels.fetch(link.original_channel_id);
                const originalMessage = await originalChannel.messages.fetch(link.original_message_id);
                await originalMessage.delete();
                console.log(`[REVERSE-DELETE] SUCCESS: Deleted original message ${link.original_message_id}.`);
            } catch (error) {
                console.warn(`[REVERSE-DELETE] FAILED to delete original message ${link.original_message_id} (it was likely already gone).`);
            }
            return;
        }

        // CASE 2: The deleted message was a user's original message
        const sourceChannelSettings = db.prepare('SELECT allow_forward_delete FROM linked_channels WHERE channel_id = ?').get(message.channel.id);
        if (!sourceChannelSettings || !sourceChannelSettings.allow_forward_delete) {
            return;
        }

        const relayedMessages = db.prepare('SELECT relayed_message_id, relayed_channel_id FROM relayed_messages WHERE original_message_id = ?').all(message.id);
        if (relayedMessages.length === 0) return;

        console.log(`[DELETE] Original message ${message.id} deleted. Attempting to delete ${relayedMessages.length} relayed copies.`);
        for (const relayed of relayedMessages) {
            try {
                // [THE FIX] Look up the webhook URL from the linked_channels table using the relayed_channel_id.
                const linkInfo = db.prepare('SELECT webhook_url FROM linked_channels WHERE channel_id = ?').get(relayed.relayed_channel_id);

                // If the channel was unlinked, its info will be gone. Skip it.
                if (!linkInfo || !linkInfo.webhook_url) {
                    console.warn(`[DELETE] Could not find webhook URL for channel ${relayed.relayed_channel_id}. It may have been unlinked. Skipping.`);
                    continue; // Go to the next message in the loop
                }

                // Now use the URL we just found.
                const webhookClient = new WebhookClient({ url: linkInfo.webhook_url });
                await webhookClient.deleteMessage(relayed.relayed_message_id);

            } catch (error) {
                if (error.code === 10015) { // Invalid Webhook
                    const channelName = message.client.channels.cache.get(relayed.relayed_channel_id)?.name ?? relayed.relayed_channel_id;
                    console.error(`[AUTO-CLEANUP] Webhook for channel #${channelName} (${relayed.relayed_channel_id}) is invalid during delete. Removing from the relay group.`);
                    db.prepare('DELETE FROM linked_channels WHERE channel_id = ?').run(relayed.relayed_channel_id);
                } else {
                    // Log other errors but don't stop the loop
                    console.warn(`[DELETE] Failed to delete relayed message ${relayed.relayed_message_id} in channel ${relayed.relayed_channel_id}. It may have been deleted already. Error: ${error.message}`);
                }
            }
        }
        
        db.prepare('DELETE FROM relayed_messages WHERE original_message_id = ?').run(message.id);
        console.log(`[DELETE] SUCCESS: Cleaned up DB entries for original message ${message.id}.`);
    },
};