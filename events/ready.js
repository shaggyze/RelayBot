// events/ready.js
const { Events, ActivityType, WebhookClient, ChannelType } = require('discord.js');
const db = require('../db/database.js');
const { version } = require('../package.json');
const { createVoteMessage } = require('../utils/voteEmbed.js');
const { fetchSupporterIds, isSupporter } = require('../utils/supporterManager.js');
const { uploadDatabase } = require('../utils/backupManager.js');
const PREMIUM_SKU_ID = '1436488229455925299';

async function primeMemberCache(client) {
    const guilds = Array.from(client.guilds.cache.values());
    console.log(`[Cache] Starting background member cache priming for all ${guilds} guilds...`);
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
            // [THE FIX] Check Subscription Status FIRST (Faster than fetching members)
            const subscription = db.prepare('SELECT is_active FROM guild_subscriptions WHERE guild_id = ? AND is_active = 1').get(guildInfo.guild_id);
            if (subscription) {
                hasSupporter = true; // Server is subscribed, treat as supporter
            } else {
                // No subscription, proceed to check members
                guild = await client.guilds.fetch(guildInfo.guild_id);
                if (!guild) {
                    // Cleanup logic if guild is missing
                    db.prepare('DELETE FROM relay_groups WHERE owner_guild_id = ?').run(guildInfo.guild_id);
                    db.prepare('DELETE FROM linked_channels WHERE guild_id = ?').run(guildInfo.guild_id);
                    db.prepare('DELETE FROM role_mappings WHERE guild_id = ?').run(guildInfo.guild_id);
                    continue;
                }

                const members = await guild.members.fetch({ time: 120000 });
                hasSupporter = members.some(member => !member.user.bot && isSupporter(member.id));
                console.log(`[Tasks] [DIAGNOSTIC] Checking Server "${guild.name}": Fetched ${members.size} members. Does it contain a supporter? -> ${hasSupporter}`);
            }

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

// --- [NEW] Sync Subscriptions & Manage Role ---
async function syncGlobalSubscriptions(client) {
    console.log('[Subscriptions] Starting global sync...');
    
    try {
        // 1. Fetch ALL entitlements
        const entitlements = await client.application.entitlements.fetch();
        
        // 2. Filter for Active + Your SKU
        const activeSubs = entitlements.filter(e => e.skuId === PREMIUM_SKU_ID && e.isActive());
        
        const subscriberUserIds = [];
        const subscriberGuildIds = []; // For direct guild subs (rare but possible)

        activeSubs.forEach(sub => {
            if (sub.userId) subscriberUserIds.push(sub.userId);
            if (sub.guildId) subscriberGuildIds.push(sub.guildId);
        });

        // 3. Send User IDs to SupporterManager
        // This makes isSupporter(id) return true for them, which enables rate-limit bypass
        // in ANY guild they are currently in (handled by messageCreate.js logic).
        setApiSubscribers(subscriberUserIds);

        // 4. Update Database for Direct Guild Subs (if any)
        db.prepare('UPDATE guild_subscriptions SET is_active = 0').run(); // Reset
        
        for (const gId of subscriberGuildIds) {
            // We use a dummy timestamp for now or extract from entitlement if needed
            db.prepare('INSERT OR REPLACE INTO guild_subscriptions (guild_id, is_active, updated_at) VALUES (?, 1, ?)')
              .run(gId, Date.now());
        }

        console.log(`[Subscriptions] Synced. Users: ${subscriberUserIds.length}, Guilds: ${subscriberGuildIds.length}`);

        // 5. Handle Dev Server Role Logic
        await manageDevServerRole(client);

    } catch (error) {
        console.error(`[Subscriptions] Critical Error: ${error.message}`);
    }
}

// --- [NEW] Dev Server Role Manager ---
async function manageDevServerRole(client) {
    const devGuildId = process.env.DEV_GUILD_ID; // Ensure this is in your .env
    if (!devGuildId) return;

    try {
        const guild = await client.guilds.fetch(devGuildId);
        if (!guild) return;

        // A. Ensure Role Exists
        let role = guild.roles.cache.find(r => r.name === 'Supporter');
        if (!role) {
            console.log('[Role-Sync] "Supporter" role not found. Creating it...');
            role = await guild.roles.create({
                name: 'Supporter',
                color: '#FFD700', // Gold
                hoist: true,      // Display separately
                mentionable: true,
                reason: 'Auto-created for RelayBot Premium Subscribers'
            });
        }

        // B. Get all Supporters (Text File + API Subs)
        const allSupporters = getSupporterSet();

        // C. Fetch all members of Dev Guild to ensure cache is fresh
        const members = await guild.members.fetch();

        // D. Loop Members: Grant or Revoke
        for (const [memberId, member] of members) {
            if (member.user.bot) continue;

            const hasRole = member.roles.cache.has(role.id);
            const shouldHaveRole = allSupporters.has(memberId);

            if (shouldHaveRole && !hasRole) {
                await member.roles.add(role);
                console.log(`[Role-Sync] Granted Role to ${member.user.tag}`);
            } 
            else if (!shouldHaveRole && hasRole) {
                await member.roles.remove(role);
                console.log(`[Role-Sync] Revoked Role from ${member.user.tag} (No longer a supporter)`);
            }
        }

    } catch (error) {
        console.error(`[Role-Sync] Error managing Dev Guild roles: ${error.message}`);
    }
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

function runDbPruning() {
    console.log('[DB-Prune] Starting daily database pruning task...');
    try {
        const pruneDays = parseInt(process.env.DB_PRUNE_DAYS, 10) || 7;
        if (pruneDays <= 0) {
            console.log('[DB-Prune] Pruning is disabled (DB_PRUNE_DAYS <= 0).');
            return;
        }

        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - pruneDays);
        const discordEpoch = 1420070400000n;
        const cutoffTimestamp = BigInt(cutoffDate.getTime());
        const timestampPart = cutoffTimestamp - discordEpoch;
        const discordEpochCutoffBigInt = (timestampPart << 22n);
        const cutoffIdString = discordEpochCutoffBigInt.toString();

        console.log(`[DB-Prune] Pruning relayed_messages older than Snowflake ID: ${cutoffIdString}`);
        const resultMessages = db.prepare('DELETE FROM relayed_messages WHERE original_message_id < ?').run(cutoffIdString);
        console.log(`[DB-Prune] Success! Pruned ${resultMessages.changes} old message links.`);
    } catch (error) {
        console.error('[DB-Prune] An error occurred during the daily pruning task:', error);
    }
}

module.exports = {
    name: Events.ClientReady,
    once: true,
    async execute(client) {
        console.log(`Ready! Logged in as ${client.user.tag}`);
        client.user.setActivity(`/relay help | v${version}`, { type: ActivityType.Watching });

        // --- Non-blocking startup tasks (run in the background without await) ---
        primeMemberCache(client);
        fetchSupporterIds();
        
        syncGlobalSubscriptions(client);

        // --- Scheduled Tasks ---
        const thirtyInMs = 30 * 60 * 1000;
        const oneHourInMs = 60 * 60 * 1000;
        const twentyFourHoursInMs = 24 * 60 * 60 * 1000;

        // Hourly supporter fetch
        setInterval(fetchSupporterIds, thirtyInMs);
        
        // Message cleanup (every 15 minutes)
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

        // Daily Subscription Sync
        setInterval(() => syncGlobalSubscriptions(client), thirtyInMs);

        // Daily Vote Reminder
        scheduleNextNoonTask(client);

        // --- Precisely Timed Daily Tasks (Pruning & Backups) ---
        const scheduleDailyTasks = () => {
            const now = new Date();
            const nextRun = new Date();
            nextRun.setUTCHours(2, 0, 0, 0); // Set a specific time, e.g., 2:00 AM UTC
            if (now > nextRun) {
                nextRun.setDate(nextRun.getDate() + 1);
            }
            const initialDelay = nextRun.getTime() - now.getTime();

            console.log(`[Scheduler] Next daily backup & pruning check scheduled in ${(initialDelay / 1000 / 60 / 60).toFixed(2)} hours.`);

            setTimeout(() => {
                // Run tasks for the first time
                runDbPruning();
                if (new Date().getDay() === 0) { // Check if it's Sunday
                    console.log('[SCHEDULE] Today is Sunday. Attempting automated database backup...');
                    uploadDatabase().catch(error => console.error('[SCHEDULE] Automated backup failed:', error.message));
                }

                // Schedule them to run every 24 hours thereafter
                setInterval(runDbPruning, twentyFourHoursInMs);
                setInterval(() => {
                    if (new Date().getDay() === 0) {
                        console.log('[SCHEDULE] Today is Sunday. Attempting automated database backup...');
                        uploadDatabase().catch(error => console.error('[SCHEDULE] Automated backup failed:', error.message));
                    }
                }, twentyFourHoursInMs);
            }, initialDelay);
        };

        scheduleDailyTasks();
    },
};