// utils/webhookManager.js
const { WebhookClient } = require('discord.js');
const db = require('../db/database.js');

class WebhookManager {
    async handleInvalidWebhook(client, channelId, groupName = 'Unknown Group') {
        // [SAFETY CHECK] Ensure client exists
        if (!client) {
            console.error(`[WebhookManager] Fatal: Client object is undefined for channel ${channelId}. Cannot repair.`);
            // Perform DB cleanup anyway since we can't repair
            db.prepare('DELETE FROM linked_channels WHERE channel_id = ?').run(channelId);
            return null;
        }

        console.warn(`[WebhookManager] Webhook invalid for channel ${channelId}. Attempting repair...`);

        try {
            // 1. Fetch channel
            const channel = await client.channels.fetch(channelId).catch(() => null);
            
            if (!channel) {
                throw new Error("Channel inaccessible (Bot kicked or channel deleted).");
            }

            // 2. Create new webhook
            const newWebhook = await channel.createWebhook({
                name: 'RelayBot',
                reason: `Auto-repair for group: ${groupName}`
            });

            // 3. Update DB
            db.prepare('UPDATE linked_channels SET webhook_url = ? WHERE channel_id = ?').run(newWebhook.url, channelId);
            console.log(`[WebhookManager] Success! Repaired webhook for channel ${channel.name} (${channelId}).`);

            return new WebhookClient({ url: newWebhook.url });

        } catch (repairError) {
            console.error(`[WebhookManager] Repair failed for ${channelId}: ${repairError.message}`);

            // 4. Notify Channel (Wrapped in extra safety)
            try {
                // Try fetching again only if we didn't get it above, or verify we have it
                const channel = await client.channels.fetch(channelId).catch(() => null);
                if (channel) {
                    await channel.send("⚠️ **Relay Connection Lost:** The webhook for this channel is invalid and could not be auto-repaired (Check 'Manage Webhooks' permission).\n\n**Action Required:** An admin must run `/relay link_channel` to reconnect.").catch(e => console.warn(`[WebhookManager] Failed to send warning msg: ${e.message}`));
                }
            } catch (notifyError) {
                // Prevent crash if client.channels is somehow invalid here
                console.warn(`[WebhookManager] Notify failed completely: ${notifyError.message}`);
            }

            // 5. Cleanup Database
            console.warn(`[WebhookManager] Removing broken link for ${channelId}.`);
            try {
                db.prepare('DELETE FROM linked_channels WHERE channel_id = ?').run(channelId);
            } catch (dbError) {
                console.error(`[WebhookManager] DB Cleanup failed: ${dbError.message}`);
            }
            
            return null;
        }
    }
}

module.exports = new WebhookManager();