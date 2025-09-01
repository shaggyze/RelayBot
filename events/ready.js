// events/ready.js
const { Events, ActivityType, WebhookClient, ChannelType } = require('discord.js');
const db = require('../db/database.js');
const { version } = require('../package.json');
const { createVoteMessage } = require('../utils/voteEmbed.js');
const { fetchSupporterIds, isSupporter } = require('../utils/supporterManager.js');

async function runDailyVoteReminder(client) {
    console.log('[Tasks] It is noon in Las Vegas! Starting daily vote reminder task...');
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
            // We need the guild object to get a reliable member list.
            if (!channel || !channel.guild) continue;

            // [THE CRITICAL FIX] Use the guild's member cache, not the channel's.
            // This is the same logic we used to fix the /relay list_servers command.
            const guild = channel.guild;
            const hasSupporter = guild.members.cache.some(member => !member.user.bot && isSupporter(member.id));

            // Diagnostic logging now uses the guild name for clarity.
            console.log(`[Tasks] [DIAGNOSTIC] Checking Server "${guild.name}": Found ${guild.memberCount} members. Does it contain a supporter? -> ${hasSupporter}`);

            if (hasSupporter) {
                console.log(`[Tasks] [SKIP] Skipping channels in "${guild.name}" because at least one member is a supporter.`);
                // Note: This now skips all channels in a server if one supporter is found.
                // This is a simplification but is more reliable and less spammy.
                continue;
            }

            console.log(`[Tasks] [SEND] Sending reminder to channel #${channel.name}.`);

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

// This is the simple, self-correcting scheduler function.
function scheduleNextNoonTask(client) {
    const now = new Date();
    const nextRun = new Date();
    
    // Set the target time in UTC. 12:00 PM in Las Vegas (PDT, UTC-7) is 19:00 UTC.
    // We set it to 12:12 PM PDT, which is 19:12 UTC.
    const targetUtcHour = 19;
    const targetUtcMinute = 0;
    nextRun.setUTCHours(targetUtcHour, targetUtcMinute, 0, 0);

    if (now > nextRun) {
        // If it's already past the target time today in UTC, schedule for the next day.
        nextRun.setUTCDate(nextRun.getUTCDate() + 1);
    }

    const delay = nextRun.getTime() - now.getTime();
    
    console.log(`[Scheduler] Next daily vote reminder scheduled for: ${nextRun.toUTCString()}`);
    console.log(`[Scheduler] Will run in ${(delay / 1000 / 60 / 60).toFixed(2)} hours.`);

    setTimeout(() => {
        runDailyVoteReminder(client);
        scheduleNextNoonTask(client); // Reschedule for the next day after running.
    }, delay);
}


module.exports = {
    name: Events.ClientReady,
    once: true,
    async execute(client) {
        console.log(`Ready! Logged in as ${client.user.tag}`);
        client.user.setActivity(`/relay help | v${version}`, { type: ActivityType.Playing });
        
        await fetchSupporterIds();
        const oneHourInMs = 60 * 60 * 1000;
        setInterval(fetchSupporterIds, oneHourInMs);
        
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
        
        scheduleNextNoonTask(client);
    },
};