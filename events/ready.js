// events/ready.js
const { Events, ActivityType, WebhookClient, ChannelType } = require('discord.js');
const db = require('../db/database.js');
const { version } = require('../package.json');
const { createVoteMessage } = require('../utils/voteEmbed.js');
const { fetchSupporterIds, isSupporter } = require('../utils/supporterManager.js');

// This function contains the logic for the task we want to run.
async function runDailyVoteReminder(client) {
    console.log('[Tasks] It is noon! Starting daily vote reminder task...');
    await fetchSupporterIds(); // Always get the freshest data

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
            if (!channel || !channel.members) continue;

            const hasSupporter = channel.members.some(member => !member.user.bot && isSupporter(member.id));
            if (hasSupporter) {
                console.log(`[Tasks] [SKIP] Skipping channel #${channel.name} because a supporter is present.`);
                continue;
            }

            const webhookClient = new WebhookClient({ url: channelInfo.webhook_url });
            await webhookClient.send(votePayload);
        } catch (error) {
            const channelName = client.channels.cache.get(channelInfo.channel_id)?.name ?? channelInfo.channel_id;
            if (error.code === 10015 || error.code === 10003 || error.code === 50001) {
                console.warn(`[Tasks] [AUTO-CLEANUP] Removing invalid channel/webhook for #${channelName}.`);
                db.prepare('DELETE FROM linked_channels WHERE channel_id = ?').run(channelInfo.channel_id);
            } else {
                console.error(`[Tasks] [FAIL] An unhandled error occurred while processing channel #${channelName}:`, error);
            }
        }
    }
    console.log('[Tasks] Daily vote reminder task finished.');
}

// This is the self-correcting scheduler function.
function scheduleNextNoonTask(client) {
    const now = new Date();
    const nextNoon = new Date();
    nextNoon.setHours(12, 0, 0, 0);

    if (now > nextNoon) {
        nextNoon.setDate(now.getDate() + 1);
    }

    const delay = nextNoon.getTime() - now.getTime();
    
    console.log(`[Scheduler] Next daily vote reminder scheduled for: ${nextNoon.toLocaleString()}`);
    console.log(`[Scheduler] Will run in ${(delay / 1000 / 60 / 60).toFixed(2)} hours.`);

    setTimeout(() => {
        runVoteReminder(client);
        // After running, immediately schedule the *next* noon's task.
        scheduleNextNoonTask(client);
    }, delay);
}


module.exports = {
    name: Events.ClientReady,
    once: true,
    async execute(client) {
        console.log(`Ready! Logged in as ${client.user.tag}`);
        client.user.setActivity(`/relay help | v${version}`, { type: ActivityType.Playing });

        // --- Supporter Cache Initialization and Refresh Timer ---
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

        // --- Task 2: Daily Noon Vote Reminder ---
        // Start the scheduling loop.
        scheduleNextNoonTask(client);
    },
};