// events/ready.js
const { Events, ActivityType, WebhookClient, ChannelType } = require('discord.js');
const db = require('../db/database.js');
const { version } = require('../package.json');
const { createVoteMessage } = require('../utils/voteEmbed.js');
const { fetchSupporterIds, isSupporter } = require('../utils/supporterManager.js');

module.exports = {
    name: Events.ClientReady,
    once: true,
    async execute(client) {
        console.log(`Ready! Logged in as ${client.user.tag}`);
        client.user.setActivity(`/relay help | v${version}`, { type: ActivityType.Playing });

        // --- Supporter Cache Initialization and Refresh Timer ---
        // Fetch the list on startup and then refresh it periodically.
        await fetchSupporterIds();
        const oneHourInMs = 60 * 60 * 1000;
        setInterval(fetchSupporterIds, oneHourInMs);

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

        // --- Task 2: Daily Vote Reminder (runs every 24 hours) ---
        const twentyFourHoursInMs = 24 * 60 * 60 * 1000;
        setInterval(async () => {
            console.log('[Tasks] Starting daily vote reminder task...');

            // [FIX] Always fetch the latest supporter list right before running.
            await fetchSupporterIds();

            const votePayload = createVoteMessage();
            votePayload.username = 'RelayBot';
            votePayload.avatarURL = client.user.displayAvatarURL();
            
            const allLinkedChannels = db.prepare('SELECT channel_id, webhook_url FROM linked_channels').all();
            if (allLinkedChannels.length === 0) {
                console.log('[Tasks] No linked channels found. Vote reminder task finished.');
                return;
            }

            console.log(`[Tasks] Checking ${allLinkedChannels.length} channel(s) for reminders.`);

            for (const channelInfo of allLinkedChannels) {
                try {
                    const channel = await client.channels.fetch(channelInfo.channel_id);
                    if (!channel || channel.type === ChannelType.DM || !channel.members) {
                        continue;
                    }

                    const hasSupporter = channel.members.some(member => !member.user.bot && isSupporter(member.id));
                    console.log(`[Tasks] [DIAGNOSTIC] Checking channel #${channel.name}: Found ${channel.members.size} members. Does it contain a supporter? -> ${hasSupporter}`);

                    if (hasSupporter) {
                        console.log(`[Tasks] [SKIP] Skipping channel #${channel.name} because at least one member is a supporter.`);
                        continue;
                    }

                    console.log(`[Tasks] [SEND] Sending reminder to channel #${channel.name}.`);
                    const webhookClient = new WebhookClient({ url: channelInfo.webhook_url });
                    await webhookClient.send(votePayload);
                    
                } catch (error) {
                    // [IMPROVED ERROR HANDLING & SELF-HEALING]
                    const channelName = client.channels.cache.get(channelInfo.channel_id)?.name ?? channelInfo.channel_id;
                    if (error.code === 10015) { // Unknown Webhook
                        console.error(`[Tasks] [AUTO-CLEANUP] Webhook for channel #${channelName} is invalid. Removing from relay.`);
                        db.prepare('DELETE FROM linked_channels WHERE channel_id = ?').run(channelInfo.channel_id);
                    } else if (error.code === 10003 || error.code === 50001) { // Unknown Channel or Missing Access
                        console.warn(`[Tasks] [AUTO-CLEANUP] Cannot access channel #${channelName}. It may have been deleted or I lost permissions. Removing from relay.`);
                        db.prepare('DELETE FROM linked_channels WHERE channel_id = ?').run(channelInfo.channel_id);
                    } else {
                        console.error(`[Tasks] [FAIL] An unhandled error occurred while processing channel #${channelName}:`, error);
                    }
                }
            }
            console.log('[Tasks] Vote reminder task finished.');
        }, twentyFourHoursInMs);
    },
};