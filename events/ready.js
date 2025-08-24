// events/ready.js
const { Events, ActivityType, WebhookClient, ChannelType } = require('discord.js');
const db = require('../db/database.js');
const { version } = require('../package.json');
const { createVoteMessage } = require('../utils/voteEmbed.js');
const { fetchSupporterIds, isSupporter } = require('../utils/supporterManager.js'); // [NEW] Import the supporter manager

module.exports = {
    name: Events.ClientReady,
    once: true,
    async execute(client) { // Make the function async
        console.log(`Ready! Logged in as ${client.user.tag}`);
        client.user.setActivity(`/relay help | v${version}`, { type: ActivityType.Playing });

        // --- [NEW] Supporter Cache Initialization and Refresh Timer ---
        // Fetch the list for the first time on startup.
        await fetchSupporterIds();
        
        // Set a timer to re-fetch the list every hour.
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
        setInterval(async () => { // Make this function async as well
            console.log('[Tasks] Sending daily vote reminder...');

            const votePayload = createVoteMessage();
            votePayload.username = 'RelayBot';
            votePayload.avatarURL = client.user.displayAvatarURL();
            
            const allLinkedChannels = db.prepare('SELECT channel_id, webhook_url FROM linked_channels').all();
            if (allLinkedChannels.length === 0) return;

            console.log(`[Tasks] Checking ${allLinkedChannels.length} channel(s) for reminders.`);

            for (const channelInfo of allLinkedChannels) {
                try {
                    const channel = await client.channels.fetch(channelInfo.channel_id);
                    // Ensure it's a channel where we can get members (i.e., not a DM or deleted channel)
                    if (!channel || channel.type === ChannelType.DM || !channel.members) continue;

                    // Fetch all members in the channel
                    const members = channel.members;
                    if (members.size === 0) continue; // Skip empty channels

                    // [NEW LOGIC] Check if every member in the channel is a supporter
                    const allMembersAreSupporters = members.every(member => isSupporter(member.id));

                    if (allMembersAreSupporters) {
                        console.log(`[Tasks] Skipping channel #${channel.name} because all members are supporters.`);
                        continue; // Skip this channel
                    }

                    // If we reach here, at least one person is not a supporter, so send the message.
                    const webhookClient = new WebhookClient({ url: channelInfo.webhook_url });
                    await webhookClient.send(votePayload).catch(() => {});
                    
                } catch (error) {
                    // Ignore errors for channels we can't fetch or process
                }
            }
        }, twentyFourHoursInMs);
    },
};