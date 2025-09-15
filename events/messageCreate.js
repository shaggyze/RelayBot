// events/messageCreate.js
const { Events, WebhookClient, Collection, PermissionFlagsBits, blockQuote, quote } = require('discord.js');
const db = require('../db/database.js');
const { createVoteMessage } = require('../utils/voteEmbed.js');
const { isSupporter } = require('../utils/supporterManager.js');

const webhookCache = new Collection();
const MAX_FILE_SIZE = 8 * 1024 * 1024;
const MAX_USERNAME_LENGTH = 80;
const RATE_LIMIT_CHARS = 200000;
const RESET_HOUR_UTC = 19; // 19:00 UTC is Noon Las Vegas time

module.exports = {
    name: Events.MessageCreate,
    async execute(message) {
        if (message.author.bot || !message.guild) return;
        if (!message.content && message.attachments.size === 0 && message.embeds.length === 0 && message.stickers.size === 0) return;

        const sourceChannelInfo = db.prepare("SELECT * FROM linked_channels WHERE channel_id = ? AND direction IN ('BOTH', 'SEND_ONLY')").get(message.channel.id);
        if (!sourceChannelInfo) return;

        const groupInfo = db.prepare('SELECT group_name FROM relay_groups WHERE group_id = ?').get(sourceChannelInfo.group_id);
        if (!groupInfo) {
            console.error(`[ERROR] A linked channel (${message.channel.id}) exists for a group_id (${sourceChannelInfo.group_id}) that has been deleted. Cleaning up...`);
            db.prepare('DELETE FROM linked_channels WHERE group_id = ?').run(sourceChannelInfo.group_id);
            return;
        }
        
        // --- [THE DEFINITIVE FIX] RATE LIMITING GATEKEEPER ---
        // This function calculates the "day" based on our 19:00 UTC reset time.
        const now = new Date();
        const adjustedDate = new Date(now.getTime() - (RESET_HOUR_UTC * 60 * 60 * 1000));
        const rateLimitDayString = adjustedDate.toISOString().slice(0, 10);

        let stats = db.prepare('SELECT * FROM group_stats WHERE group_id = ? AND day = ?').get(sourceChannelInfo.group_id, rateLimitDayString);
        if (!stats) {
            db.prepare('INSERT INTO group_stats (group_id, day) VALUES (?, ?)').run(sourceChannelInfo.group_id, rateLimitDayString);
            stats = { character_count: 0, warning_sent_at: null };
        }
        
        const messageLength = (message.content || '').length;

        const allChannelsInGroup = db.prepare('SELECT DISTINCT guild_id FROM linked_channels WHERE group_id = ?').all(sourceChannelInfo.group_id);
        let isSupporterGroup = false;
        for (const channel of allChannelsInGroup) {
            const guild = message.client.guilds.cache.get(channel.guild_id);
            if (guild && guild.members.cache.some(member => !member.user.bot && isSupporter(member.id))) {
                isSupporterGroup = true;
                break;
            }
        }
        
        if (!isSupporterGroup && stats.character_count + messageLength > RATE_LIMIT_CHARS) {
            if (!stats.warning_sent_at) {
                console.log(`[RATE LIMIT] Group "${groupInfo.group_name}" (ID: ${sourceChannelInfo.group_id}) has exceeded the daily character limit.`);
                const allTargetChannels = db.prepare('SELECT webhook_url FROM linked_channels WHERE group_id = ?').all(sourceChannelInfo.group_id);
                
                const nextResetTime = new Date();
                nextResetTime.setUTCHours(RESET_HOUR_UTC, 0, 0, 0);
                if (now > nextResetTime) {
                    nextResetTime.setUTCDate(nextResetTime.getUTCDate() + 1);
                }
                const resetTimestamp = Math.floor(nextResetTime.getTime() / 1000);
                const timerString = `<t:${resetTimestamp}:R>`;

                const warningPayload = createVoteMessage();
                warningPayload.username = 'RelayBot Rate Limit';
                warningPayload.avatarURL = message.client.user.displayAvatarURL();
                warningPayload.content = `**Daily character limit of ${RATE_LIMIT_CHARS.toLocaleString()} reached!**\n\nRelaying is paused for this group. It will automatically resume ${timerString} or when a supporter joins.`;
                
                for (const target of allTargetChannels) {
                    try {
                        const webhookClient = new WebhookClient({ url: target.webhook_url });
                        await webhookClient.send(warningPayload);
                    } catch { /* Ignore failures */ }
                }
                db.prepare('UPDATE group_stats SET warning_sent_at = ? WHERE group_id = ? AND day = ?').run(Date.now(), sourceChannelInfo.group_id, rateLimitDayString);
            }
            return;
        }
        // --- END OF RATE LIMITING ---

        // This is the start of the normal relay logic
        console.log(`[EVENT] Message received from ${message.author.tag} in linked channel #${message.channel.name}`);
        const targetChannels = db.prepare(`SELECT * FROM linked_channels WHERE group_id = ? AND channel_id != ? AND direction IN ('BOTH', 'RECEIVE_ONLY')`).all(sourceChannelInfo.group_id, message.channel.id);
        if (targetChannels.length === 0) {
            console.log(`[DEBUG] No valid receiving channels found in group "${groupInfo.group_name}". Nothing to relay.`);
            return;
        }

        console.log(`[DEBUG] Found ${targetChannels.length} target channel(s) to relay to for group "${groupInfo.group_name}".`);
        
        const senderName = message.member?.displayName ?? message.author.username;
        let username = `${senderName} (${message.guild.name})`;
        if (username.length > MAX_USERNAME_LENGTH) {
            username = username.substring(0, MAX_USERNAME_LENGTH - 3) + '...';
        }
        
        const avatarURL = message.author.displayAvatarURL();
        
        let replyContent = '';
        if (message.reference && message.reference.messageId) {
            try {
                const repliedMessage = await message.channel.messages.fetch(message.reference.messageId);
                const repliedAuthorName = repliedMessage.member?.displayName ?? repliedMessage.author.username;
                replyContent = blockQuote(quote(`${repliedAuthorName}: ${repliedMessage.content.substring(0, 200)}`)) + '\n';
            } catch {
                replyContent = blockQuote(quote(`Replying to a deleted or inaccessible message.`)) + '\n';
            }
        }
        
        const safeFiles = [];
        const largeFiles = [];
        message.attachments.forEach(att => {
            if (att.size > MAX_FILE_SIZE) largeFiles.push(att.name);
            else safeFiles.push(att.url);
        });

        for (const target of targetChannels) {
            const targetChannelName = message.client.channels.cache.get(target.channel_id)?.name ?? target.channel_id;
            console.log(`[RELAY] Attempting to relay message ${message.id} to channel #${targetChannelName}`);

            let targetContent = message.content;

            const roleMentions = targetContent.match(/<@&(\d+)>/g);
            if (roleMentions) {
                console.log(`[ROLES] Found ${roleMentions.length} role mention(s). Processing for target guild ${target.guild_id}.`);
                for (const mention of roleMentions) {
                    const sourceRoleId = mention.match(/\d+/)[0];
                    const roleMap = db.prepare(`SELECT role_name FROM role_mappings WHERE group_id = ? AND guild_id = ? AND role_id = ?`).get(sourceChannelInfo.group_id, message.guild.id, sourceRoleId);
                    
                    if (!roleMap) {
                        console.log(`[ROLES] Role ID ${sourceRoleId} has no mapping in this group. Skipping.`);
                        continue;
                    }

                    let targetRole = db.prepare(`SELECT role_id FROM role_mappings WHERE group_id = ? AND guild_id = ? AND role_name = ?`).get(target.group_id, target.guild_id, roleMap.role_name);
                    
                    if (!targetRole) {
                        try {
                            const targetGuild = await message.client.guilds.fetch(target.guild_id);
                            if (targetGuild.members.me.permissions.has(PermissionFlagsBits.ManageRoles)) {
                                const newRole = await targetGuild.roles.create({ name: roleMap.role_name, mentionable: true, reason: `Auto-created for message relay.` });
                                db.prepare('INSERT INTO role_mappings (group_id, guild_id, role_name, role_id) VALUES (?, ?, ?, ?)').run(target.group_id, target.guild_id, roleMap.role_name, newRole.id);
                                targetRole = { role_id: newRole.id };
                            }
                        } catch (creationError) {
                            console.error(`[ROLES] FAILED to auto-create role "${roleMap.role_name}":`, creationError);
                        }
                    }
                    
                    if (targetRole) {
                        console.log(`[ROLES] Mapping "${roleMap.role_name}" from ${sourceRoleId} to ${targetRole.role_id}.`);
                        targetContent = targetContent.replace(mention, `<@&${targetRole.role_id}>`);
                    }
                }
            }
            
            let finalContent = replyContent + targetContent;
            if (largeFiles.length > 0) {
                finalContent += `\n*(Note: ${largeFiles.length} file(s) were too large to be relayed: ${largeFiles.join(', ')})*`;
            }

            const payload = {
                content: finalContent,
                username: username,
                avatarURL: avatarURL,
                files: safeFiles,
                embeds: message.embeds,
                allowedMentions: { parse: ['roles'], repliedUser: false }
            };

            if (message.stickers.size > 0) {
                payload.stickers = [message.stickers.first().id];
            }

            try {
                const webhookClient = new WebhookClient({ url: target.webhook_url });
                const relayedMessage = await webhookClient.send(payload);

                console.log(`[RELAY] SUCCESS: Relayed message ${message.id} to new message ${relayedMessage.id} in group "${groupInfo.group_name}"`);
                
                db.prepare('INSERT INTO relayed_messages (original_message_id, original_channel_id, relayed_message_id, relayed_channel_id, webhook_url) VALUES (?, ?, ?, ?, ?)')
                  .run(message.id, message.channel.id, relayedMessage.id, relayedMessage.channel_id, target.webhook_url);

                if (messageLength > 0) {
                    db.prepare(`
                        UPDATE group_stats SET character_count = character_count + ?
                        WHERE group_id = ? AND day = ?
                    `).run(messageLength, sourceChannelInfo.group_id, today);
                }

            } catch (error) {
                if (error.code === 50006 && message.stickers.size > 0) {
                    console.warn(`[RELAY] Sticker relay failed for message ${message.id}. Retrying with text fallback.`);
                    try {
                        const sticker = message.stickers.first();
                        const fallbackPayload = payload;
                        delete fallbackPayload.stickers;
                        fallbackPayload.content += `\n*(sent sticker: ${sticker.name})*`;
                        const webhookClient = new WebhookClient({ url: target.webhook_url });
                        const relayedMessage = await webhookClient.send(fallbackPayload);
                        
                        console.log(`[RELAY] SUCCESS (Fallback): Relayed message ${message.id} to new message ${relayedMessage.id} in group "${groupInfo.group_name}"`);

                        db.prepare('INSERT INTO relayed_messages (original_message_id, original_channel_id, relayed_message_id, relayed_channel_id, webhook_url) VALUES (?, ?, ?, ?, ?)')
                          .run(message.id, message.channel.id, relayedMessage.id, relayedMessage.channel_id, target.webhook_url);
                    } catch (fallbackError) {
                        console.error(`[RELAY] FAILED on fallback attempt for message ${message.id} to channel ${target.channel_id}:`, fallbackError);
                    }
                } else if (error.code === 10015) {
                    console.error(`[AUTO-CLEANUP] Webhook for channel #${targetChannelName} is invalid. Removing from relay.`);
                    db.prepare('DELETE FROM linked_channels WHERE channel_id = ?').run(target.channel_id);
                } else {
                    console.error(`[RELAY] FAILED to relay message to channel ${target.channel_id}:`, error);
                }
            }
        }
    },
};