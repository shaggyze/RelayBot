// events/ready.js
const { Events, ActivityType, WebhookClient, ChannelType } = require('discord.js');
const db = require('../db/database.js');
const { version } = require('../package.json');
const { createVoteMessage } = require('../utils/voteEmbed.js');
// [FIX] Ensure setApiSubscribers and getSupporterSet are imported
const { fetchSupporterIds, isSupporter, setApiSubscribers, getSupporterSet } = require('../utils/supporterManager.js');
const { uploadDatabase } = require('../utils/backupManager.js');

const PREMIUM_SKU_ID = '1436488229455925299';

async function primeMemberCache(client) {
    console.log('[Cache] Starting background member cache priming for all guilds...');
    const guilds = Array.from(client.guilds.cache.values());
    for (const guild of guilds) {
        try {
            if (guild.memberCount === guild.members.cache.size) continue;
            await guild.members.fetch({ time: 10000 });
        } catch (error) {
            if (error.code === 'GuildMembersTimeout') {
                try {
                    await guild.members.fetch({ time: 30000 });
                } catch (retryError) {
                    console.warn(`[Cache] FAILED retry for "${guild.name}" (${guild.id}): ${retryError.message}`);
                }
            } else {
                console.warn(`[Cache] Could not fetch members for guild "${guild.name}" (${guild.id}). Error: ${error.message}`);
            }
        }
    }
    console.log('[Cache] Background member cache priming complete.');
}

// --- [NEW] Dev Server Role Manager ---
async function manageDevServerRole(client) {
    const devGuildId = process.env.DEV_GUILD_ID; 
    if (!devGuildId) return;

    try {
        const guild = await client.guilds.fetch(devGuildId).catch(() => null);
        if (!guild) return;

        let role = guild.roles.cache.find(r => r.name === 'Supporter');
        if (!role) {
            console.log('[Role-Sync] "Supporter" role not found in Dev server. Creating it...');
            try {
                role = await guild.roles.create({
                    name: 'Supporter',
                    color: '#FFD700',
                    hoist: true,
                    mentionable: true,
                    reason: 'Auto-created for RelayBot Premium Subscribers'
                });
            } catch (e) {
                console.error('[Role-Sync] Failed to create role:', e.message);
                return;
            }
        }

        const allSupporters = getSupporterSet();
        const members = await guild.members.fetch({ time: 10000 });

        for (const [memberId, member] of members) {
            if (member.user.bot) continue;

            const hasRole = member.roles.cache.has(role.id);
            const shouldHaveRole = allSupporters.has(memberId);

            if (shouldHaveRole && !hasRole) {
                await member.roles.add(role).catch(e => console.error(`Failed to add role to ${member.user.tag}:`, e.message));
                console.log(`[Role-Sync] Granted Role to ${member.user.tag}`);
            } 
            else if (!shouldHaveRole && hasRole) {
                await member.roles.remove(role).catch(e => console.error(`Failed to remove role from ${member.user.tag}:`, e.message));
                console.log(`[Role-Sync] Revoked Role from ${member.user.tag}`);
            }
        }
    } catch (error) {
        console.error(`[Role-Sync] Error managing Dev Guild roles: ${error.message}`);
    }
}

// --- [FIXED] Combined Subscription Logic ---
async function syncGlobalSubscriptions(client) {
    console.log('[Subscriptions] Starting global sync...');
    
    try {
        // 1. Fetch ALL entitlements
        const entitlements = await client.application.entitlements.fetch();
        
        // 2. Filter for Active + Your SKU. IMPORTANT: Use .isActive()
        const activeSubs = entitlements.filter(e => e.skuId === PREMIUM_SKU_ID && e.isActive());
        
        const subscriberUserIds = [];
        
        // 3. Transaction to update Guild DB safely
        const updateSubscriptionDb = db.transaction((subs) => {
            db.prepare('DELETE FROM guild_subscriptions').run();
            const insertStmt = db.prepare('INSERT OR REPLACE INTO guild_subscriptions (guild_id, is_active, expires_at, updated_at) VALUES (?, 1, ?, ?)');
            
            let guildCount = 0;
            for (const sub of subs.values()) {
                if (sub.guildId) {
                    insertStmt.run(sub.guildId, sub.endsTimestamp, Date.now());
                    guildCount++;
                }
                if (sub.userId) {
                    subscriberUserIds.push(sub.userId);
                }
            }
            return guildCount;
        });

        const processedGuilds = updateSubscriptionDb(activeSubs);
        
        // 4. Update Supporter Manager with User IDs
        setApiSubscribers(subscriberUserIds);

        console.log(`[Subscriptions] Synced. Active Guilds: ${processedGuilds}, Active Users: ${subscriberUserIds.length}`);

        // 5. Handle Dev Server Role Logic
        await manageDevServerRole(client);

    } catch (error) {
        console.error(`[Subscriptions] Critical Error: ${error.message}`);
    }
}

async function runDailyVoteReminder(client) {
    console.log('[Tasks] It is noon in Las Vegas! Starting daily vote reminder task...');
    await fetchSupporterIds();
    
    const votePayload = createVoteMessage();
    votePayload.username = 'RelayBot';
    votePayload.avatarURL = client.user.displayAvatarURL();
    
    const allLinkedGuilds = db.prepare('SELECT DISTINCT guild_id FROM linked_channels').all();
    if (allLinkedGuilds.length === 0) return;

    console.log(`[Tasks] Checking ${allLinkedGuilds.length} unique server(s) for supporters...`);
    
    const guildsWithoutSupporters = new Set();

    for (const guildInfo of allLinkedGuilds) {
        let hasSupporter = false;
        
        // Check DB Subscription first
        const subscription = db.prepare('SELECT 1 FROM guild_subscriptions WHERE guild_id = ? AND is_active = 1').get(guildInfo.guild_id);
        if (subscription) {
            hasSupporter = true;
        } else {
            try {
                const guild = await client.guilds.fetch(guildInfo.guild_id);
                if (!guild) {
                    // Cleanup deleted guilds
                    db.prepare('DELETE FROM relay_groups WHERE owner_guild_id = ?').run(guildInfo.guild_id);
                    db.prepare('DELETE FROM linked_channels WHERE guild_id = ?').run(guildInfo.guild_id);
                    db.prepare('DELETE FROM role_mappings WHERE guild_id = ?').run(guildInfo.guild_id);
                    continue;
                }
                // Check cache first for supporters
                const supporterSet = getSupporterSet();
                if (guild.members.cache.some(m => supporterSet.has(m.id))) {
                    hasSupporter = true;
                } else {
                     // Only fetch if cache check fails
                    const members = await guild.members.fetch({ time: 120000 });
                    hasSupporter = members.some(member => !member.user.bot && isSupporter(member.id));
                }
            } catch (error) {
                // If error (timeout/network), assume supporter to be safe and avoid spamming
                hasSupporter = true; 
            }
        }

        if (!hasSupporter) {
            guildsWithoutSupporters.add(guildInfo.guild_id);
        }
    }
    
    if (guildsWithoutSupporters.size === 0) return;
    
    const channelsToSendTo = db.prepare(`SELECT channel_id, webhook_url FROM linked_channels WHERE guild_id IN (${Array.from(guildsWithoutSupporters).map(id => `'${id}'`).join(',')})`).all();

    for (const channelInfo of channelsToSendTo) {
        try {
            const webhookClient = new WebhookClient({ url: channelInfo.webhook_url });
            await webhookClient.send(votePayload);
        } catch (error) {
            if (error.code === 10015 || error.code === 10003 || error.code === 50001) {
                db.prepare('DELETE FROM linked_channels WHERE channel_id = ?').run(channelInfo.channel_id);
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
    
    setTimeout(() => {
        runDailyVoteReminder(client);
        scheduleNextNoonTask(client);
    }, delay);
}

function runDbPruning() {
    console.log('[DB-Prune] Starting daily database pruning task...');
    try {
        const pruneDays = parseInt(process.env.DB_PRUNE_DAYS, 10) || 7;
        if (pruneDays <= 0) return;

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

        // 1. Await Member Cache (Fixes startup race condition)
        await primeMemberCache(client);

        // 2. Await Initial Supporter Fetch (Fixes rate limit bugs)
        await fetchSupporterIds();

        // 3. Await Initial Subscription/Dev Role Sync (Fixes premium features)
        // [THE FIX] This defines the function call that was missing/undefined in your error
        await syncGlobalSubscriptions(client);

        const oneHourInMs = 60 * 60 * 1000;
        const twentyFourHoursInMs = 24 * 60 * 60 * 1000;

        // Scheduled Tasks
        setInterval(fetchSupporterIds, oneHourInMs);
        
        // Run sync periodically
        setInterval(() => syncGlobalSubscriptions(client), oneHourInMs);

        setInterval(() => {
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

        const scheduleDailyTasks = () => {
            const now = new Date();
            const nextRun = new Date();
            nextRun.setUTCHours(2, 0, 0, 0); 
            if (now > nextRun) {
                nextRun.setDate(nextRun.getDate() + 1);
            }
            const initialDelay = nextRun.getTime() - now.getTime();

            console.log(`[Scheduler] Next daily backup & pruning check scheduled in ${(initialDelay / 1000 / 60 / 60).toFixed(2)} hours.`);

            setTimeout(() => {
                runDbPruning();
                if (new Date().getDay() === 0) { 
                    console.log('[SCHEDULE] Today is Sunday. Attempting automated database backup...');
                    uploadDatabase().catch(error => console.error('[SCHEDULE] Automated backup failed:', error.message));
                }

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