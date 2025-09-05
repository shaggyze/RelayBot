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
    
    // To avoid checking the same server multiple times, let's get a unique list of guilds.
    const allLinkedGuilds = db.prepare('SELECT DISTINCT guild_id FROM linked_channels').all();
    if (allLinkedGuilds.length === 0) {
        console.log('[Tasks] No linked guilds found. Vote reminder task finished.');
        return;
    }

    console.log(`[Tasks] Checking ${allLinkedGuilds.length} unique server(s) for supporters...`);
    
    const guildsWithoutSupporters = new Set();

    for (const guildInfo of allLinkedGuilds) {
        try {
            const guild = await client.guilds.fetch(guildInfo.guild_id);
            if (!guild) continue;

            // [THE CRITICAL FIX] Actively fetch all members from the server.
            // This is required for large servers where the member cache is incomplete.
            const members = await guild.members.fetch();
            
            const hasSupporter = members.some(member => !member.user.bot && isSupporter(member.id));

            console.log(`[Tasks] [DIAGNOSTIC] Checking Server "${guild.name}": Fetched ${members.size} members. Does it contain a supporter? -> ${hasSupporter}`);

            if (!hasSupporter) {
                guildsWithoutSupporters.add(guild.id);
            } else {
                console.log(`[Tasks] [SKIP] Server "${guild.name}" will be skipped because a supporter was found.`);
            }
        } catch (error) {
            console.error(`[Tasks] FAILED to process guild ${guildInfo.guild_id}. It may be unavailable. Error: ${error.message}`);
        }
    }
    
    if (guildsWithoutSupporters.size === 0) {
        console.log('[Tasks] All servers have supporters. No reminders to send. Task finished.');
        return;
    }
    
    // Now, get all channels that belong to the guilds that need a reminder.
    const channelsToSendTo = db.prepare(`
        SELECT channel_id, webhook_url FROM linked_channels 
        WHERE guild_id IN (${Array.from(guildsWithoutSupporters).map(id => `'${id}'`).join(',')})
    `).all();

    console.log(`[Tasks] Sending reminders to ${channelsToSendTo.length} channel(s) across ${guildsWithoutSupporters.size} server(s).`);

    for (const channelInfo of channelsToSendTo) {
        try {
            const webhookClient = new WebhookClient({ url: channelInfo.webhook_url });
            await webhookClient.send(votePayload);
        } catch (error) {
            const channelName = client.channels.cache.get(channelInfo.channel_id)?.name ?? channelInfo.channel_id;
            // Self-healing logic for dead webhooks/channels
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
    // We set it to 12:00 PM PDT, which is 19:00 UTC.
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

        // --- [NEW] Prime the Member Cache at Startup ---
        console.log('[Cache] Priming member cache for all guilds...');
        try {
            const guilds = Array.from(client.guilds.cache.values());
            for (const guild of guilds) {
                console.log(`[Cache] Fetching members for "${guild.name}" (${guild.id})...`);
                await guild.members.fetch();
                console.log(`[Cache] Successfully cached ${guild.memberCount} members for "${guild.name}".`);
            }
            console.log('[Cache] Member cache priming complete.');
        } catch (error) {
            console.error('[Cache] An error occurred during member cache priming:', error);
        }

        // --- Supporter Cache Initialization and Refresh Timer ---
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