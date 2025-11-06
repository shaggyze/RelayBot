// events/ready.js
const { Events, ActivityType, WebhookClient, ChannelType } = require('discord.js');
const db = require('../db/database.js');
const { version } = require('../package.json');
const { createVoteMessage } = require('../utils/voteEmbed.js');
const { fetchSupporterIds, isSupporter } = require('../utils/supporterManager.js');
const { uploadDatabase } = require('../utils/backupManager.js');

async function primeMemberCache(client) {
    console.log('[Cache] Starting background member cache priming for all guilds...');
    const guilds = Array.from(client.guilds.cache.values());
    for (const guild of guilds) {
        try {
            console.log(`[Cache] Fetching members for "${guild.name}"...`);
            await guild.members.fetch();
            console.log(`[Cache] Successfully cached members for "${guild.name}".`);
        } catch (error) {
            console.warn(`[Cache] Could not fetch members for guild "${guild.name}" (${guild.id}). Error: ${error.message}`);
        }
    }
    console.log('[Cache] Background member cache priming complete.');
}

async function runDailyVoteReminder(client) {
    console.log('[Tasks] It is noon in Las Vegas! Starting daily vote reminder task...');
    await fetchSupporterIds();
    const votePayload = createVoteMessage();
    votePayload.username = 'RelayBot';
    votePayload.avatarURL = client.user.displayAvatarURL();
    
    const allLinkedGuilds = db.prepare('SELECT DISTINCT guild_id FROM linked_channels').all();
    if (allLinkedGuilds.length === 0) {
        console.log('[Tasks] No linked guilds found. Task finished.');
        return;
    }

    console.log(`[Tasks] Checking ${allLinkedGuilds.length} unique server(s) for supporters...`);
    
    const guildsWithoutSupporters = new Set();

    for (const guildInfo of allLinkedGuilds) {
        let hasSupporter = false;
        let guild;

        try {
            guild = await client.guilds.fetch(guildInfo.guild_id);
            if (!guild) {
                db.prepare('DELETE FROM relay_groups WHERE owner_guild_id = ?').run(guildInfo.guild_id);
                db.prepare('DELETE FROM linked_channels WHERE guild_id = ?').run(guildInfo.guild_id);
                db.prepare('DELETE FROM role_mappings WHERE guild_id = ?').run(guildInfo.guild_id);
                continue;
            }

            const members = await guild.members.fetch({ time: 120000 });
            hasSupporter = members.some(member => !member.user.bot && isSupporter(member.id));
            console.log(`[Tasks] [DIAGNOSTIC] Checking Server "${guild.name}": Fetched ${members.size} members. Does it contain a supporter? -> ${hasSupporter}`);

        } catch (error) {
            const guildId = guildInfo.guild_id;
            const guildName = guild ? guild.name : `Unknown Guild (${guildId})`;

            if (error.code === 10004) {
                console.warn(`[Tasks] [AUTO-CLEANUP] Guild ${guildId} is unknown. Pruning data.`);
                db.prepare('DELETE FROM relay_groups WHERE owner_guild_id = ?').run(guildId);
                db.prepare('DELETE FROM linked_channels WHERE guild_id = ?').run(guildId);
                db.prepare('DELETE FROM role_mappings WHERE guild_id = ?').run(guildId);
                continue;
            }
            
            if (error.code === 'GuildMembersTimeout') {
                console.error(`[Tasks] [TIMEOUT] FAILED to fetch members for guild "${guildName}" in time.`);
            } else {
                console.error(`[Tasks] [ERROR] FAILED to process guild "${guildName}". Error: ${error.message}`);
            }
            
            hasSupporter = true;
        }

        if (!hasSupporter) {
            guildsWithoutSupporters.add(guildInfo.guild_id);
        } else {
            const guildName = client.guilds.cache.get(guildInfo.guild_id)?.name ?? `Guild ID ${guildInfo.guild_id}`;
            console.log(`[Tasks] [SKIP] Server "${guildName}" will be skipped.`);
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

function scheduleNextNoonTask(client) {
    const now = new Date();
    const nextRun = new Date();
    const targetUtcHour = 19;
    const targetUtcMinute = 0;
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

        console.log('[Startup] Caching members for all guilds...');
        primeMemberCache(client);
        console.log('[Startup] Member cache priming complete.');

        console.log('[Startup] Performing initial fetch of supporter list...');
        fetchSupporterIds();
        console.log('[Startup] Initial supporter list loaded.');

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

        const twentyFourHoursInMs = 24 * 60 * 60 * 1000;
        const scheduleWeeklyBackup = () => {
            const now = new Date();
            // Check if today is Sunday (getDay() returns 0 for Sunday)
            if (now.getDay() === 0) {
                console.log('[SCHEDULE] Today is Sunday. Attempting automated database backup...');
                uploadDatabase().catch(error => {
                    console.error('[SCHEDULE] Automated backup failed:', error.message);
                });
            } else {
                console.log(`[SCHEDULE] Today is not Sunday (Day: ${now.getDay()}). Skipping weekly backup.`);
            }
        };

        // Run the check once a day. We'll use a timeout to schedule the first check,
        // then an interval for subsequent checks.
        const now = new Date();
        const nextCheck = new Date();
        nextCheck.setUTCHours(2, 0, 0, 0); // Set to run at 2:00 AM UTC every day
        if (now > nextCheck) {
            nextCheck.setDate(nextCheck.getDate() + 1);
        }
        const initialDelay = nextCheck.getTime() - now.getTime();

        console.log(`[SCHEDULE] Next weekly backup check scheduled in ${(initialDelay / 1000 / 60 / 60).toFixed(2)} hours.`);

        setTimeout(() => {
            scheduleWeeklyBackup(); // Run the first check
            setInterval(scheduleWeeklyBackup, twentyFourHoursInMs); // Then check again every 24 hours
        }, initialDelay);

        setTimeout(() => {
            // This function will run for the first time after 24 hours.
            const runPruning = () => {
                console.log('[DB-Prune] Starting daily database pruning task...');
                try {
					const cutoffDate = new Date();
					cutoffDate.setDate(cutoffDate.getDate() - 7); // Prune messages older than 7 days

					// For group_stats, we use the date string directly.
					const cutoffDayString = cutoffDate.toISOString().slice(0, 10); // 'YYYY-MM-DD'

					// For relayed_messages, we need to compare original_message_id (TEXT Snowflake ID)
					// with a cutoff ID derived from the same date.
					// Discord Snowflakes are 64-bit integers. JavaScript Numbers can lose precision
					// for values > Number.MAX_SAFE_INTEGER (2^53 - 1).
					// Bitwise operations in JS are performed on 32-bit integers.
					// We must use BigInt for accurate Snowflake calculations.

					const discordEpoch = 1420070400000n; // Discord's epoch in BigInt
					const cutoffTimestamp = BigInt(cutoffDate.getTime()); // Current date's timestamp in BigInt

					// Calculate the Snowflake ID equivalent for the cutoff date.
					// The formula is (timestamp - discordEpoch) << 22 (timestamp part is 42 bits, starts at bit 22)
					const timestampPart = cutoffTimestamp - discordEpoch;
					const discordEpochCutoffBigInt = (timestampPart << 22n); // Use BigInt for bit shift

					// Convert the BigInt cutoff ID to a string for the SQL query.
					const cutoffIdString = discordEpochCutoffBigInt.toString();

					console.log(`[DB-Prune] Pruning relayed_messages older than Snowflake ID: ${cutoffIdString}`);
					const resultMessages = db.prepare('DELETE FROM relayed_messages WHERE original_message_id < ?').run(cutoffIdString);

					//console.log(`[DB-Prune] Pruning group_stats for days older than: ${cutoffDayString}`);
					//const resultStats = db.prepare("DELETE FROM group_stats WHERE day < ?").run(cutoffDayString);

					console.log(`[DB-Prune] Success! Pruned ${resultMessages.changes} old message links.`);
					//console.log(`[DB-Prune] Success! Pruned ${resultStats.changes} old daily stats.`);
                } catch (error) {
                    console.error('[DB-Prune] An error occurred during the daily pruning task:', error);
                }
            };
            
            runPruning(); // Run it once now (after the initial timeout)
            setInterval(runPruning, twentyFourHoursInMs); // Then schedule it for every 24 hours after that.

        }, twentyFourHoursInMs); // The initial delay
        
        scheduleNextNoonTask(client);
    },
};