// events/ready.js
const { Events, ActivityType, WebhookClient } = require('discord.js');
const db = require('../db/database.js');
const { version } = require('../package.json');
const { createVoteMessage } = require('../utils/voteEmbed.js');
const { fetchSupporterIds, isSupporter, getSupporterSet } = require('../utils/supporterManager.js'); // Import getSupporterSet

async function runDailyVoteReminder(client) {
    console.log('[Tasks] It is noon in Las Vegas! Starting daily vote reminder task...');
    await fetchSupporterIds();
    const votePayload = createVoteMessage();
    votePayload.username = 'RelayBot';
    votePayload.avatarURL = client.user.displayAvatarURL();
    
    const supporterIdList = getSupporterSet();
    const allLinkedGuilds = db.prepare('SELECT DISTINCT guild_id FROM linked_channels').all();
    if (allLinkedGuilds.length === 0) return;

    console.log(`[Tasks] Checking ${allLinkedGuilds.length} unique server(s) for supporters...`);
    const guildsWithoutSupporters = new Set();

    for (const guildInfo of allLinkedGuilds) {
        let supporterFound = false;
        const guild = await client.guilds.fetch(guildInfo.guild_id).catch(() => null);
        if (!guild) continue;

        // [THE DEFINITIVE FIX] Use the memory-efficient "Supporter-First" check.
        // This makes a few small, fast requests instead of one huge, memory-intensive request.
        for (const supporterId of supporterIdList) {
            if (await guild.members.fetch(supporterId).catch(() => null)) {
                supporterFound = true;
                break; // Found one, no need to check other supporters for this guild.
            }
        }
        
        console.log(`[Tasks] [DIAGNOSTIC] Checking Server "${guild.name}": Does it contain a supporter? -> ${supporterFound}`);
        
        if (!supporterFound) {
            guildsWithoutSupporters.add(guild.id);
        } else {
            console.log(`[Tasks] [SKIP] Server "${guild.name}" will be skipped.`);
        }
    }
    
    if (guildsWithoutSupporters.size === 0) {
        console.log('[Tasks] All servers have supporters. No reminders to send. Task finished.');
        return;
    }
    
    const channelsToSendTo = db.prepare(`SELECT channel_id, webhook_url FROM linked_channels WHERE guild_id IN (${Array.from(guildsWithoutSupporters).map(id => `'${id}'`).join(',')})`).all();
    console.log(`[Tasks] Sending reminders to ${channelsToSendTo.length} channel(s) across ${guildsWithoutSupporters.size} server(s).`);

    for (const channelInfo of channelsToSendTo) {
        try {
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
    const targetUtcHour = 19;
    const targetUtcMinute = 0; // Set to 0 for exactly noon
    nextRun.setUTCHours(targetUtcHour, targetUtcMinute, 0, 0);

    if (now > nextRun) {
        nextRun.setUTCDate(nextRun.getUTCDate() + 1);
    }

    const delay = nextRun.getTime() - now.getTime();
    
    console.log(`[Scheduler] Next daily vote reminder scheduled for: ${nextRun.toUTCString()}`);
    console.log(`[Scheduler] Will run in ${(delay / 1000 / 60 / 60).toFixed(2)} hours.`);

    setTimeout(() => {
        runDailyVoteReminder(client);
        scheduleNextNoonTask(client);
    }, delay);
}


module.exports = {
    name: Events.ClientReady,
    once: true,
    async execute(client) {
        console.log(`Ready! Logged in as ${client.user.tag}`);
        client.user.setActivity(`/relay help | v${version}`, { type: ActivityType.Playing });
        
        // [THE DEFINITIVE FIX]
        // Start the cache priming process, but DO NOT await it.
        // This lets the bot become responsive to commands immediately.
        primeMemberCache(client);

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