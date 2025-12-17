// utils/webhookManager.js
const { WebhookClient } = require('discord.js');
const db = require('../db/database.js');

class WebhookManager {
    /**
     * Handles 10015 errors by attempting to repair the webhook.
     * @param {Client} client - Discord Client
     * @param {string} channelId - The ID of the channel with the broken webhook
     * @param {string} groupName - (Optional) Name of the group for the audit log/reason
     * @returns {Promise<WebhookClient|null>} Returns a new WebhookClient if repaired, or null if failed/removed.
     */
    async handleInvalidWebhook(client, channelId, groupName = 'Unknown Group') {
        console.warn(`[WebhookManager] Webhook invalid for channel ${channelId}. Attempting repair...`);

        try {
            // 1. Fetch the channel to ensure we still have access and permissions
            const channel = await client.channels.fetch(channelId).catch(() => null);
            
            if (!channel) {
                throw new Error("Channel inaccessible (Bot kicked or channel deleted).");
            }

            // 2. Attempt to create a new webhook
            const newWebhook = await channel.createWebhook({
                name: 'RelayBot',
                reason: `Auto-repair for group: ${groupName}`
            });

            // 3. Update the database
            db.prepare('UPDATE linked_channels SET webhook_url = ? WHERE channel_id = ?').run(newWebhook.url, channelId);
            console.log(`[WebhookManager] Success! Repaired webhook for channel ${channel.name} (${channelId}).`);

            // Return the new client so the calling function can retry the message immediately
            return new WebhookClient({ url: newWebhook.url });

        } catch (repairError) {
            console.error(`[WebhookManager] Repair failed for ${channelId}: ${repairError.message}`);

            // 4. If repair failed (no perms), try to notify the channel
            try {
                const channel = await client.channels.fetch(channelId).catch(() => null);
                if (channel) {
                    await channel.send("⚠️ **Relay Connection Lost:** The webhook for this channel is invalid and could not be auto-repaired (Check 'Manage Webhooks' permission).\n\n**Action Required:** An admin must run `/relay link_channel` to reconnect.");
                }
            } catch (notifyError) {
                console.warn(`[WebhookManager] Could not notify channel ${channelId}: ${notifyError.message}`);
            }

            // 5. Cleanup Database
            console.warn(`[WebhookManager] removing broken link for ${channelId}.`);
            db.prepare('DELETE FROM linked_channels WHERE channel_id = ?').run(channelId);
            
            return null;
        }
    }
}

module.exports = new WebhookManager();