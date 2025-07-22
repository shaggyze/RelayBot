// events/messageUpdate.js
const { Events, WebhookClient } = require('discord.js');
const db = require('../db/database.js');

module.exports = {
    name: Events.MessageUpdate,
    async execute(oldMessage, newMessage) {
        // Ignore edits from bots, in DMs, or if the text content hasn't actually changed.
        if (!newMessage.guild || newMessage.author.bot || oldMessage.content === newMessage.content) return;
        // Find all relayed messages that correspond to the edited original message
        const relayedMessages = db.prepare('SELECT * FROM relayed_messages WHERE original_message_id = ?').all(newMessage.id);
        if (relayedMessages.length === 0) return;

        console.log(`[EDIT] Detected edit on relayed message ${newMessage.id}. Attempting to update ${relayedMessages.length} copies.`);
        // Get the new, raw content for the message
        const newContent = newMessage.content;

        for (const relayed of relayedMessages) {
            try {
                const webhookClient = new WebhookClient({ url: relayed.webhook_url });
                // Note: The username and avatar CANNOT be changed in a webhook message edit, only the content/embeds.
                // This is a Discord API limitation, but the original username will remain.
                await webhookClient.editMessage(relayed.relayed_message_id, {
                    content: newContent || ' ', // Send a space if the new content is empty.
                    embeds: newMessage.embeds, // Pass through any embeds from the edited message.
                    allowedMentions: { parse: ['roles'] } // Continue to allow role mentions.
                });
                console.log(`[EDIT] SUCCESS: Updated relayed message ${relayed.relayed_message_id}`);
            } catch (error) {
                console.error(`[EDIT] FAILED to edit message ${relayed.relayed_message_id}:`, error);
            }
        }
    },
};