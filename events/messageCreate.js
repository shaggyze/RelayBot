// events/messageCreate.js
const { Events, WebhookClient, Collection, PermissionFlagsBits, EmbedBuilder, blockQuote, quote } = require('discord.js');
const db = require('../db/database.js');
const { createVoteMessage } = require('../utils/voteEmbed.js');
const { isSupporter, getSupporterSet } = require('../utils/supporterManager.js');
const { getRateLimitDayString, RESET_HOUR_UTC } = require('../utils/time.js');

const webhookCache = new Collection();
const MAX_PAYLOAD_SIZE = 7.5 * 1024 * 1024;
const MAX_USERNAME_LENGTH = 80;
const RATE_LIMIT_CHARS = 100000;
const DISCORD_MESSAGE_LIMIT = 2000;

async function checkGroupForSupporters(client, groupId) {
    const supporterIdList = getSupporterSet();
    if (supporterIdList.size === 0) return false;
    const guildsInGroup = db.prepare('SELECT DISTINCT guild_id FROM linked_channels WHERE group_id = ?').all(groupId);
    for (const row of guildsInGroup) {
        try {
            const guild = await client.guilds.fetch(row.guild_id);
            for (const supporterId of supporterIdList) {
                if (await guild.members.fetch(supporterId).catch(() => null)) return true;
            }
        } catch {}
    }
    return false;
}

module.exports = {
    name: Events.MessageCreate,
    async execute(message) {
        try {
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
            
            const rateLimitDayString = getRateLimitDayString();
            const messageLength = (message.content || '').length;
            
            if (messageLength > 0) {
                db.prepare(`
                    INSERT INTO group_stats (group_id, day, character_count) VALUES (?, ?, ?)
                    ON CONFLICT(group_id, day) DO UPDATE SET character_count = character_count + excluded.character_count
                `).run(sourceChannelInfo.group_id, rateLimitDayString, messageLength);
            }

            const isSupporterGroup = await checkGroupForSupporters(message.client, sourceChannelInfo.group_id);
            const stats = db.prepare('SELECT character_count, warning_sent_at FROM group_stats WHERE group_id = ? AND day = ?').get(sourceChannelInfo.group_id, rateLimitDayString);
            
            if (!isSupporterGroup && stats && stats.character_count > RATE_LIMIT_CHARS) {
                if (!stats.warning_sent_at) {
                    console.log(`[RATE LIMIT] Group "${groupInfo.group_name}" has now exceeded the daily limit. Sending warning.`);
                    const allTargetChannels = db.prepare('SELECT webhook_url FROM linked_channels WHERE group_id = ?').all(sourceChannelInfo.group_id);
                    const now = new Date();
                    const nextResetTime = new Date();
                    nextResetTime.setUTCHours(RESET_HOUR_UTC, 0, 0, 0);
                    if (now > nextResetTime) { nextResetTime.setUTCDate(nextResetTime.getUTCDate() + 1); }
                    const timerString = `<t:${Math.floor(nextResetTime.getTime() / 1000)}:R>`;
                    const warningPayload = createVoteMessage();
                    warningPayload.username = 'RelayBot';
                    warningPayload.avatarURL = message.client.user.displayAvatarURL();
                    warningPayload.content = `**Daily character limit of ${RATE_LIMIT_CHARS.toLocaleString()} reached!**\n\nRelaying is paused. It will resume ${timerString} or when a supporter joins.`;
                    for (const target of allTargetChannels) {
                        try {
                            const webhookClient = new WebhookClient({ url: target.webhook_url });
                            await webhookClient.send(warningPayload);
                        } catch {}
                    }
                    db.prepare('UPDATE group_stats SET warning_sent_at = ? WHERE group_id = ? AND day = ?').run(Date.now(), sourceChannelInfo.group_id, rateLimitDayString);
                }
                return;
            }
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
            
            for (const target of targetChannels) {
                try {
                    const targetChannelName = message.client.channels.cache.get(target.channel_id)?.name ?? target.channel_id;
                    console.log(`[RELAY] Attempting to relay message ${message.id} to channel #${targetChannelName}`);
                    
                    let replyEmbed = null;
                    if (message.reference && message.reference.messageId) {
                        let repliedMessage;
                        try {
                            repliedMessage = await message.channel.messages.fetch(message.reference.messageId);
                        } catch {
                            replyEmbed = new EmbedBuilder().setColor('#444444').setDescription('*Replying to a deleted or inaccessible message.*');
                        }
                        if (repliedMessage) {
                            const repliedAuthorName = repliedMessage.member?.displayName ?? repliedMessage.author.username;
                            const repliedAuthorAvatar = repliedMessage.author.displayAvatarURL();
                            let repliedContent = repliedMessage.content ? repliedMessage.content.substring(0, 1000) : '*(Message had no text content)*';
                            if (repliedMessage.editedTimestamp) {
                                repliedContent += ' *(edited)*';
                            }
                            const relayedReplyInfo = db.prepare('SELECT relayed_message_id FROM relayed_messages WHERE original_message_id = ? AND relayed_channel_id = ?').get(repliedMessage.id, target.channel_id);
                            let messageLink = null;
                            if (relayedReplyInfo && target.guild_id && target.channel_id && relayedReplyInfo.relayed_message_id) {
                                messageLink = `https://discord.com/channels/${target.guild_id}/${target.channel_id}/${relayedReplyInfo.relayed_message_id}`;
                            }
                            replyEmbed = new EmbedBuilder().setColor('#444444').setAuthor({ name: `└─Replying to ${repliedAuthorName}`, url: messageLink, iconURL: repliedAuthorAvatar }).setDescription(repliedContent);
                        }
                    }

                    let targetContent = message.content;
                    let hasUnmappedRoles = false;
                    const roleMentions = targetContent.match(/<@&(\d+)>/g);
                    if (roleMentions) {
                        for (const mention of roleMentions) {
                            const sourceRoleId = mention.match(/\d+/)[0];
                            const roleMap = db.prepare(`SELECT role_name FROM role_mappings WHERE group_id = ? AND guild_id = ? AND role_id = ?`).get(sourceChannelInfo.group_id, message.guild.id, sourceRoleId);
                            if (!roleMap) {
                                hasUnmappedRoles = true;
                                continue;
                            }
                            let targetRole = db.prepare(`SELECT role_id FROM role_mappings WHERE group_id = ? AND guild_id = ? AND role_name = ?`).get(target.group_id, target.guild_id, roleMap.role_name);
                            if (targetRole) {
                                targetContent = targetContent.replace(mention, `<@&${targetRole.role_id}>`);
                            } else {
                                hasUnmappedRoles = true;
                            }
                        }
                    }
                
                    let finalContent = targetContent;
                    const contentWithoutMentions = finalContent.replace(/<@!?&?#?(\d+)>/g, '').trim();
                    if (contentWithoutMentions.length === 0 && hasUnmappedRoles) {
                          finalContent = `*(A role in the original message was not relayed because it has not been mapped in this server. An admin can use \`/relay map_role\` to fix this.)*`;
                    }
                    
                    if (finalContent.length > DISCORD_MESSAGE_LIMIT) {
                        const truncationNotice = `\n*(Message was truncated...)*`;
                        finalContent = finalContent.substring(0, DISCORD_MESSAGE_LIMIT - truncationNotice.length) + truncationNotice;
                    }

                                        // 1. Build the payload with everything EXCEPT files first.
                    const payloadWithoutFiles = {
                        content: finalContent,
                        username: username,
                        avatarURL: avatarURL,
                        embeds: [],
                        allowedMentions: { parse: ['roles'], repliedUser: false }
                    };
                    if (replyEmbed) payloadWithoutFiles.embeds.push(replyEmbed);
                    payloadWithoutFiles.embeds.push(...message.embeds);
                    if (message.stickers.size > 0) {
                        const sticker = message.stickers.first();
                        if (sticker && sticker.id) payloadWithoutFiles.stickers = [sticker.id];
                    }

                    // 2. Calculate the size of the text/embed part and determine the file budget.
                    const jsonSize = Buffer.byteLength(JSON.stringify(payloadWithoutFiles));
                    const fileBudget = MAX_PAYLOAD_SIZE - jsonSize;

                    // 3. Intelligently pack files that fit into the budget.
                    const safeFiles = [];
                    const largeFiles = [];
                    let currentTotalSize = 0;
                    const sortedAttachments = Array.from(message.attachments.values()).sort((a, b) => a.size - b.size);

                    for (const attachment of sortedAttachments) {
                        if (currentTotalSize + attachment.size <= fileBudget) {
                            safeFiles.push(attachment.url);
                            currentTotalSize += attachment.size;
                        } else {
                            largeFiles.push(attachment.name);
                        }
                    }

                    // 4. Assemble the final text content, including the large file notice, and truncate it.
                    let finalPayloadContent = payloadWithoutFiles.content;
                    if (largeFiles.length > 0) {
                        const fileNotice = `\n*(Note: ${largeFiles.length} file(s) were too large or exceeded the total upload limit and were not relayed: ${largeFiles.join(', ')})*`;
                        finalPayloadContent += fileNotice;
                    }
                    if (finalPayloadContent.length > DISCORD_MESSAGE_LIMIT) {
                        const truncationNotice = `\n*(Message was truncated...)*`;
                        finalPayloadContent = finalPayloadContent.substring(0, DISCORD_MESSAGE_LIMIT - truncationNotice.length) + truncationNotice;
                    }

                    // 5. Assemble the final payload for sending.
                    const finalPayload = { ...payloadWithoutFiles, content: finalPayloadContent, files: safeFiles };

                    if (!finalPayload.content.trim() && finalPayload.files.length === 0 && finalPayload.embeds.length === 0 && !finalPayload.stickers) {
                        continue;
                    }
                    
                    let relayedMessage = null;
                    const webhookClient = new WebhookClient({ url: target.webhook_url });
                    try {
                        relayedMessage = await webhookClient.send(finalPayload);
                    } catch (sendError) {
                        if (sendError.code === 50006 && finalPayload.stickers) {
                            console.log(`[RELAY] Sticker relay failed for message ${message.id}. Retrying with text fallback.`);
                            try {
                                const sticker = message.stickers.first();
                                if (sticker && sticker.name) {
                                    const fallbackPayload = { ...finalPayload };
                                    delete fallbackPayload.stickers;
                                    fallbackPayload.content += `\n*(sent sticker: ${sticker.name})*`;
                                    relayedMessage = await webhookClient.send(fallbackPayload);
                                }
                            } catch (fallbackError) {
                                console.error(`[RELAY] FAILED on fallback attempt for message ${message.id}:`, fallbackError);
                            }
                        } else {
                            throw sendError;
                        }
                    }

                    if (largeFiles.length > 0) {
                        const fileNotice = `*(Note: ${largeFiles.length} file(s) from the message above were too large or exceeded the total upload limit and were not relayed: ${largeFiles.join(', ')})*`;
                        await webhookClient.send({
                            content: fileNotice,
                            username: username,
                            avatarURL: avatarURL
                        });
                    }

                    if (relayedMessage) {
                        db.prepare('INSERT INTO relayed_messages (original_message_id, original_channel_id, relayed_message_id, relayed_channel_id, webhook_url, replied_to_id) VALUES (?, ?, ?, ?, ?, ?)')
                          .run(message.id, message.channel.id, relayedMessage.id, relayedMessage.channel_id, target.webhook_url, message.reference?.messageId ?? null);
                    }
                } catch (error) {
                    console.error(`[ERROR] Code:`, error.code);
                    const targetChannelName = message.client.channels.cache.get(target.channel_id)?.name ?? `ID ${target.channel_id}`;
                    if (error.code === 10015) {
                        console.error(`[AUTO-CLEANUP] Webhook for channel #${targetChannelName} is invalid. Removing from relay.`);
                        db.prepare('DELETE FROM linked_channels WHERE channel_id = ?').run(target.channel_id);
                    } else {
                        console.error(`[RELAY-LOOP-ERROR] FAILED to process relay for target #${targetChannelName}.`, error);
                    }
                }
            }
        } catch (error) {
            console.error(`[ERROR] Code:`, error.code);
            console.error(`[FATAL-ERROR] A critical unhandled error occurred in messageCreate for message ${message.id}.`, error);
        }
    },
};