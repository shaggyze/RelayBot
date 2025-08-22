// events/messageUpdate.js
const { Events, WebhookClient } = require('discord.js');
const db = require('../db/database.js');

module.exports = {
    name: Events.MessageUpdate,
    async execute(oldMessage, newMessage) {
        if (!newMessage.guild || newMessage.author.bot || oldMessage.content === newMessage.content) return;

        const relayedMessages = db.prepare('SELECT * FROM relayed_messages WHERE original_message_id = ?').all(newMessage.id);
        if (relayedMessages.length === 0) return;

        console.log(`[EDIT] Detected edit on relayed message ${newMessage.id}. Attempting to update ${relayedMessages.length} copies.`);

        const newContent = newMessage.content;

        for (const relayed of relayedMessages) {
            try {
                const webhookClient = new WebhookClient({ url: relayed.webhook_url });
                await webhookClient.editMessage(relayed.relayed_message_id, {
                    content: newContent || ' ',
                    embeds: newMessage.embeds,
                    allowedMentions: { parse: ['roles'] }
                });
                console.log(`[EDIT] SUCCESS: Updated relayed message ${relayed.relayed_message_id}`);
            } catch (error) {
                if (error.code === 10015) {
                    const channelName = newMessage.client.channels.cache.get(relayed.relayed_channel_id)?.name ?? relayed.relayed_channel_id;
                    console.error(`[AUTO-CLEANUP] Webhook for channel #${channelName} (${relayed.relayed_channel_id}) is invalid during edit. Removing from the relay group.`);
                    db.prepare('DELETE FROM linked_channels WHERE channel_id = ?').run(relayed.relayed_channel_id);
                } else {
                    console.error(`[EDIT] FAILED to edit message ${relayed.relayed_message_id}:`, error);
                }
            }
        }
    },
};