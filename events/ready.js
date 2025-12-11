// events/ready.js
const { Events, ActivityType, WebhookClient } = require('discord.js');
const db = require('../db/database.js');
const { version } = require('../package.json');
const { createVoteMessage } = require('../utils/voteEmbed.js');
const { fetchSupporterIds, isSupporter, setApiSubscribers, getSupporterSet, refreshSupportedGuilds, isGroupSupported } = require('../utils/supporterManager.js');
const { uploadDatabase } = require('../utils/backupManager.js');

const PREMIUM_SKU_ID = '1436488229455925299';

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
        
        if (guild.memberCount !== guild.members.cache.size) {
            try {
                await guild.members.fetch({ time: 10000 });
            } catch (err) {
                console.warn(`[Role-Sync] Initial fetch dropped for Dev Guild. Retrying...`);
                try {
                    await guild.members.fetch({ time: 30000 });
                } catch (retryErr) {
                    console.error(`[Role-Sync] Failed to fetch members after retry: ${retryErr.message}`);
                }
            }
        }

        const members = guild.members.cache;

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

async function syncGlobalSubscriptions(client) {
    console.log('[Subscriptions] Starting global sync...');
    
    try {
        const entitlements = await client.application.entitlements.fetch();
        const activeSubs = entitlements.filter(e => e.skuId === PREMIUM_SKU_ID && e.isActive());
        const subscriberUserIds = [];
        
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
        setApiSubscribers(subscriberUserIds);

        console.log(`[Subscriptions] Synced. Active Guilds: ${processedGuilds}, Active Users: ${subscriberUserIds.length}`);
        await manageDevServerRole(client);

    } catch (error) {
        console.error(`[Subscriptions] Critical Error: ${error.message}`);
    }
}

async function runDailyVoteReminder(client) {
    console.log('[Tasks] It is noon in Las Vegas! Starting daily vote reminder task...');
    
    // Refresh lists and find where supporters are located
    await fetchSupporterIds();
    await refreshSupportedGuilds(client);

    const votePayload = createVoteMessage();
    votePayload.username = 'RelayBot';
    votePayload.avatarURL = client.user.displayAvatarURL();
    
    const allLinkedGroups = db.prepare('SELECT DISTINCT group_id FROM linked_channels').all();

    for (const groupRow of allLinkedGroups) {
        // [OPTIMIZATION] Use the instant check. If group has supporter, skip reminder.
        if (isGroupSupported(groupRow.group_id)) {
            continue;
        }

        // Group is NOT supported, send reminder to all channels in group
        const channelsToSendTo = db.prepare('SELECT channel_id, webhook_url FROM linked_channels WHERE group_id = ?').all(groupRow.group_id);

        for (const channelInfo of channelsToSendTo) {
            try {
                const webhookClient = new WebhookClient({ url: channelInfo.webhook_url });
                await webhookClient.send(votePayload);
            } catch (error) {
                // Handle Invalid Webhook (10015) with Repair -> Notify -> Delete
                if (error.code === 10015) {
                    console.warn(`[Tasks] Webhook invalid for channel ${channelInfo.channel_id}. Attempting repair...`);
                    try {
                        // 1. Attempt Repair
                        const channel = await client.channels.fetch(channelInfo.channel_id);
                        const newWebhook = await channel.createWebhook({ name: 'RelayBot', reason: 'Auto-repair during vote reminder' });
                        
                        db.prepare('UPDATE linked_channels SET webhook_url = ? WHERE channel_id = ?').run(newWebhook.url, channelInfo.channel_id);
                        
                        // Retry sending the vote reminder
                        const retryClient = new WebhookClient({ url: newWebhook.url });
                        await retryClient.send(votePayload);
                        console.log(`[Tasks] Successfully repaired webhook for channel ${channelInfo.channel_id}`);

                    } catch (repairError) {
                        console.error(`[Tasks] Repair failed for channel ${channelInfo.channel_id}: ${repairError.message}`);

                        // 2. Notify Channel
                        try {
                            const brokenChannel = await client.channels.fetch(channelInfo.channel_id);
                            if (brokenChannel) {
                                await brokenChannel.send("⚠️ **Relay Connection Lost:** The webhook for this channel is invalid and could not be auto-repaired.\n\n**Action Required:** An admin must run `/relay link_channel` to reconnect.");
                            }
                        } catch (e) { /* Ignore notification errors */ }

                        // 3. Delete Link
                        db.prepare('DELETE FROM linked_channels WHERE channel_id = ?').run(channelInfo.channel_id);
                    }
                } 
                // Handle other fatal errors (Unknown Channel/Missing Access) immediately
                else if (error.code === 10003 || error.code === 50001) {
                    console.warn(`[Tasks] Channel inaccessible (${error.code}). Removing link for ${channelInfo.channel_id}.`);
                    db.prepare('DELETE FROM linked_channels WHERE channel_id = ?').run(channelInfo.channel_id);
                }
            }
        }
        console.log(`[Tasks] Daily vote reminder task finished.  ${channelsToSendTo.length}/${allLinkedGroups.length}`);
    }
}

function scheduleNextNoonTask(client) {
    const now = new Date();
    const nextRun = new Date();
    const targetUtcHour = 20;
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

        // 1. Fetch Data
        await fetchSupporterIds();
        await syncGlobalSubscriptions(client);

        // 2. [OPTIMIZATION] Build the guild cache once on startup
        await refreshSupportedGuilds(client);

        const thirtyMs = 30 * 60 * 1000;
        const oneHourInMs = 60 * 60 * 1000;
        const twentyFourHoursInMs = 24 * 60 * 60 * 1000;

        // 3. Refresh data periodically
        setInterval(async () => {
            await fetchSupporterIds();
            await syncGlobalSubscriptions(client);
            await refreshSupportedGuilds(client);
        }, thirtyMs);

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