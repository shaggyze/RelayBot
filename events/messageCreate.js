// events/messageCreate.js
const { Events, WebhookClient, Collection, PermissionFlagsBits, EmbedBuilder, blockQuote, quote } = require('discord.js');
const db = require('../db/database.js');
const { createVoteMessage } = require('../utils/voteEmbed.js');
const { isSupporter, getSupporterSet } = require('../utils/supporterManager.js');
const { getRateLimitDayString, RESET_HOUR_UTC } = require('../utils/time.js');

const webhookCache = new Collection();
const MAX_FILE_SIZE = 8 * 1024 * 1024;
const MAX_USERNAME_LENGTH = 80;
const RATE_LIMIT_CHARS = 200000;

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
        // [THE DEFINITIVE FIX - PART 1] Wrap the entire function in a try/catch block.
        // This will prevent ANY unhandled error from crashing the bot.
        try {
            if (message.author.bot || !message.guild) return;
            if (!message.content && message.attachments.size === 0 && message.embeds.length === 0 && message.stickers.size === 0) return;

            const sourceChannelInfo = db.prepare("SELECT * FROM linked_channels WHERE channel_id = ? AND direction IN ('BOTH', 'SEND_ONLY')").get(message.channel.id);
            if (!sourceChannelInfo) return;

            const groupInfo = db.prepare('SELECT group_name FROM relay_groups WHERE group_id = ?').get(sourceChannelInfo.group_id);
            if (!groupInfo) {
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
                    // ... (rate limit warning logic)
                }
                return;
            }

            const targetChannels = db.prepare(`SELECT * FROM linked_channels WHERE group_id = ? AND channel_id != ? AND direction IN ('BOTH', 'RECEIVE_ONLY')`).all(sourceChannelInfo.group_id, message.channel.id);
            if (targetChannels.length === 0) return;

            const senderName = message.member?.displayName ?? message.author.username;
            let username = `${senderName} (${message.guild.name})`;
            if (username.length > MAX_USERNAME_LENGTH) {
                username = username.substring(0, MAX_USERNAME_LENGTH - 3) + '...';
            }
            
            const avatarURL = message.author.displayAvatarURL();
            
            let replyEmbed = null;
            if (message.reference && message.reference.messageId) {
                try {
                    const repliedMessage = await message.channel.messages.fetch(message.reference.messageId);
                    const repliedAuthorName = repliedMessage.member?.displayName ?? repliedMessage.author.username;
                    const repliedContent = repliedMessage.content ? repliedMessage.content.substring(0, 1000) : '*(Message had no text content)*';
                    replyEmbed = new EmbedBuilder().setColor('#B0B8C6').setAuthor({ name: `Replying to ${repliedAuthorName}` }).setDescription(repliedContent);
                } catch {
                    replyEmbed = new EmbedBuilder().setColor('#B0B8C6').setDescription('*Replying to a deleted or inaccessible message.*');
                }
            }
            
            const safeFiles = [];
            const largeFiles = [];
            message.attachments.forEach(att => {
                if (att.size > MAX_FILE_SIZE) largeFiles.push(att.name);
                else safeFiles.push(att.url);
            });

            for (const target of targetChannels) {
                let targetContent = message.content;
                const roleMentions = targetContent.match(/<@&(\d+)>/g);
                if (roleMentions) {
                    // Role mapping logic...
                }
                
                let finalContent = targetContent;
                if (largeFiles.length > 0) {
                    finalContent += `\n*(Note: ${largeFiles.length} file(s) were too large to be relayed: ${largeFiles.join(', ')})*`;
                }

                const payload = {
                    content: finalContent,
                    username: username,
                    avatarURL: avatarURL,
                    files: safeFiles,
                    embeds: [],
                    allowedMentions: { parse: ['roles'], repliedUser: false }
                };

                if (replyEmbed) {
                    payload.embeds.push(replyEmbed);
                }
                payload.embeds.push(...message.embeds);

                // [THE DEFINITIVE FIX - PART 2] Wrap the dangerous sticker logic in its own specific try/catch.
                try {
                    if (message.stickers.size > 0) {
                        const sticker = message.stickers.first();
                        if (sticker && sticker.id) {
                            payload.stickers = [sticker.id];
                        }
                    }
                } catch (stickerError) {
                    console.error(`[STICKER-ERROR] A non-fatal error occurred while accessing sticker data for message ${message.id}. The sticker will not be relayed.`, stickerError);
                }
                
                try {
                    const webhookClient = new WebhookClient({ url: target.webhook_url });
                    await webhookClient.send(payload);
                    console.log(`[RELAY] SUCCESS: Relayed message ${message.id} to new message ${relayedMessage.id} in group "${groupInfo.group_name}"`);
                
                    db.prepare('INSERT INTO relayed_messages (original_message_id, original_channel_id, relayed_message_id, relayed_channel_id, webhook_url) VALUES (?, ?, ?, ?, ?)')
                      .run(message.id, message.channel.id, relayedMessage.id, relayedMessage.channel_id, target.webhook_url);

                } catch (error) {
                    if (error.code === 50006 && payload.stickers && payload.stickers.length > 0) {
                        // Sticker fallback logic...
                    } else if (error.code === 10015) {
                        db.prepare('DELETE FROM linked_channels WHERE channel_id = ?').run(target.channel_id);
                    } else {
                        console.error(`[RELAY] FAILED to relay message to channel ${target.channel_id}:`, error);
                    }
                }
            }
        } catch (error) {
            console.error(`[FATAL-ERROR] A critical unhandled error occurred in the messageCreate event for message ${message.id}. The bot will not crash. Please report this!`, error);
        }
    },
};