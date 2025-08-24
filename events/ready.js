// events/ready.js
const { Events, ActivityType, WebhookClient } = require('discord.js');
const db = require('../db/database.js');
const { version } = require('../package.json');
const { createVoteMessage } = require('../utils/voteEmbed.js'); // Import our new utility

module.exports = {
    name: Events.ClientReady,
    once: true,
    execute(client) {
        console.log(`Ready! Logged in as ${client.user.tag}`);
        client.user.setActivity(`/relay help | v${version}`, { type: ActivityType.Playing });

        // --- Task 1: Message Cleanup (runs every 15 minutes) ---
        setInterval(() => {
            console.log('[Tasks] Running scheduled message cleanup...');
            const channelsToClean = db.prepare('SELECT channel_id, delete_delay_hours FROM linked_channels WHERE delete_delay_hours > 0').all();
            for (const item of channelsToClean) {
                const delayMs = item.delete_delay_hours * 60 * 60 * 1000;
                client.channels.fetch(item.channel_id).then(channel => {
                    if (channel) channel.messages.fetch({ limit: 100 }).then(messages => {
                        messages.forEach(message => {
                            if (message.webhookId && (Date.now() - message.createdTimestamp > delayMs)) {
                                message.delete().catch(() => {});
                            }
                        });
                    });
                }).catch(() => {});
            }
        }, 15 * 60 * 1000);

        // --- [NEW] Task 2: Daily Vote Reminder (runs every 24 hours) ---
        const twentyFourHoursInMs = 24 * 60 * 60 * 1000;
        setInterval(() => {
            console.log('[Tasks] Sending daily vote reminder to all linked channels.');

            // Get the message payload from our utility file.
            const votePayload = createVoteMessage();
            
            // Add the bot's own branding for the webhook message.
            votePayload.username = 'RelayBot';
            votePayload.avatarURL = client.user.displayAvatarURL();
            
            // Get all unique webhook URLs from the database.
            const allLinkedChannels = db.prepare('SELECT webhook_url FROM linked_channels').all();
            
            if (allLinkedChannels.length > 0) {
                console.log(`[Tasks] Found ${allLinkedChannels.length} channel(s) to send reminder to.`);
                
                allLinkedChannels.forEach(channel => {
                    try {
                        const webhookClient = new WebhookClient({ url: channel.webhook_url });
                        webhookClient.send(votePayload).catch(() => {}); // Send and forget, ignore errors
                    } catch {
                        // Ignore errors from invalid webhook URLs
                    }
                });
            }
        }, twentyFourHoursInMs);
    },
};