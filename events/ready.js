// events/ready.js
const { Events, ActivityType } = require('discord.js');
const db = require('../db/database.js');
const { version } = require('../package.json');

module.exports = {
    name: Events.ClientReady,
    once: true,
    execute(client) {
        console.log(`Ready! Logged in as ${client.user.tag}`);
        client.user.setActivity(`v${version} | /relay help`, { type: ActivityType.Playing });

        // Start the message cleanup interval (runs every 15 minutes)
        setInterval(() => {
            console.log('Running scheduled message cleanup...');
            const channelsToClean = db.prepare('SELECT channel_id, delete_delay_hours FROM linked_channels WHERE delete_delay_hours > 0').all();

            for (const item of channelsToClean) {
                const delayMs = item.delete_delay_hours * 60 * 60 * 1000;
                client.channels.fetch(item.channel_id).then(channel => {
                    if (!channel) return;
                    channel.messages.fetch({ limit: 100 }).then(messages => {
                        messages.forEach(message => {
                            if (message.webhookId && (Date.now() - message.createdTimestamp > delayMs)) {
                                message.delete().catch(err => console.error(`[Cleanup] Failed to delete message ${message.id}: ${err.message}`));
                            }
                        });
                    }).catch(err => console.error(`[Cleanup] Failed to fetch messages in ${item.channel_id}: ${err.message}`));
                }).catch(err => console.error(`[Cleanup] Failed to fetch channel ${item.channel_id}: ${err.message}`));
            }
        }, 15 * 60 * 1000);
    },
};