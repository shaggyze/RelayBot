// events/messageDelete.js
const { Events, WebhookClient } = require('discord.js');
const db = require('../db/database.js');

module.exports = {
    name: Events.MessageDelete,
    async execute(message) {
        if (!message.guild) return; // Ignore DMs

        // CASE 1: The deleted message was a webhook message (a bot relay)
        if (message.webhookId) {
            const link = db.prepare('SELECT original_message_id, original_channel_id FROM relayed_messages WHERE relayed_message_id = ?').get(message.id);
            if (!link) return;

            const sourceChannelSettings = db.prepare('SELECT reverse_delete_enabled FROM linked_channels WHERE channel_id = ?').get(link.original_channel_id);
            if (!sourceChannelSettings || !sourceChannelSettings.reverse_delete_enabled) return;

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
        const relayedMessages = db.prepare('SELECT * FROM relayed_messages WHERE original_message_id = ?').all(message.id);
        if (relayedMessages.length === 0) return;

        console.log(`[DELETE] Original message ${message.id} deleted. Attempting to delete ${relayedMessages.length} relayed copies.`);
        for (const relayed of relayedMessages) {
            try {
                const webhookClient = new WebhookClient({ url: relayed.webhook_url });
                await webhookClient.deleteMessage(relayed.relayed_message_id);
            } catch { /* Ignore errors, message may already be gone */ }
        }
        
        db.prepare('DELETE FROM relayed_messages WHERE original_message_id = ?').run(message.id);
        console.log(`[DELETE] SUCCESS: Cleaned up DB entries for original message ${message.id}.`);
    },
};