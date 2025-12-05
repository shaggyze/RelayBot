// events/messageCreate.js
const { Events, WebhookClient, Collection, PermissionFlagsBits, EmbedBuilder, MessageFlags } = require('discord.js');
const db = require('../db/database.js');
const crypto = require('crypto');
const relayQueue = require('../utils/relayQueue.js');

const webhookCache = new Collection();
const MAX_PAYLOAD_SIZE = 6.0 * 1024 * 1024; 
const MAX_USERNAME_LENGTH = 80;
const RATE_LIMIT_CHARS = 100000;
const DISCORD_MESSAGE_LIMIT = 2000;

const groupsBeingWarned = new Set();
const dailySupporterCache = new Map();

const createVoteMessage = () => ({ content: "Please vote/subscribe to increase limits!", embeds: [] });
const isSupporter = (id) => false;
const getSupporterSet = () => new Set();
const getRateLimitDayString = () => new Date().toISOString().slice(0, 10);
const RESET_HOUR_UTC = 19;

async function checkGroupForSupporters(client, groupId) {
    const currentDay = getRateLimitDayString();
    if (dailySupporterCache.get(groupId) === currentDay) return true;
    
    const supporterIdList = getSupporterSet();
    const guildsInGroup = db.prepare('SELECT DISTINCT guild_id FROM linked_channels WHERE group_id = ?').all(groupId);
    
    // 1. Check DB Subscriptions
    for (const row of guildsInGroup) {
        const subscription = db.prepare('SELECT 1 FROM guild_subscriptions WHERE guild_id = ? AND is_active = 1').get(row.guild_id);
        if (subscription) { 
            dailySupporterCache.set(groupId, currentDay); 
            return true; 
        }
    }

    // 2. Check User Patrons
    if (supporterIdList.size > 0) {
        for (const row of guildsInGroup) {
            try {
                const guild = client.guilds.cache.get(row.guild_id);
                if (!guild) continue;

                if (guild.members.cache.some(member => supporterIdList.has(member.id))) { 
                    dailySupporterCache.set(groupId, currentDay); 
                    return true; 
                }

                const supporterArray = Array.from(supporterIdList);
                if (supporterArray.length <= 50) {
                    try {
                        const fetchedMembers = await guild.members.fetch({ user: supporterArray });
                        if (fetchedMembers.size > 0) { 
                            dailySupporterCache.set(groupId, currentDay); 
                            return true; 
                        }
                    } catch (e) {}
                }
            } catch (error) { return true; } // Fail open on error
        }
    }
    return false;
}

module.exports = {
    name: Events.MessageCreate,
    async execute(message) {
        const executionId = crypto.randomBytes(4).toString('hex');

        try {
            if (!message.guild) return;

            // --- MASTER SELF-IGNORE (THE FIX) ---
            
            // Check 1: Is the message tagged with our Application ID? 
            // (This catches ALL webhooks created by this bot).
            if (message.applicationId === message.client.user.id) return;

            // Check 2: Is the author the bot user itself?
            // (This catches standard messages sent by the bot user).
            if (message.author.id === message.client.user.id) return;
            
            const sourceChannelInfo = db.prepare("SELECT * FROM linked_channels WHERE channel_id = ? AND direction IN ('BOTH', 'SEND_ONLY')").get(message.channel.id);
            if (!sourceChannelInfo) return;

            // --- CONDITIONAL IGNORE for OTHER bots/webhooks ---
            const processBots = sourceChannelInfo.process_bot_messages; 

            // If setting is OFF (0/null), ignore other bots/webhooks.
            if (!processBots && (message.author.bot || message.webhookId)) {
                return; 
            }

			const isBlocked = db.prepare('SELECT 1 FROM group_blacklist WHERE group_id = ? AND (blocked_id = ? OR blocked_id = ?)').get(sourceChannelInfo.group_id, message.author.id, message.guild.id);
			if (isBlocked) {
				console.warn(`[BLOCK] Message stopped from ${message.author.username} (ID: ${message.author.id}) in server ${message.guild.name} (ID: ${message.guild.id}) for group ${sourceChannelInfo.group_id}.`);
				return; 
			}

            const groupInfo = db.prepare('SELECT group_name FROM relay_groups WHERE group_id = ?').get(sourceChannelInfo.group_id);
            if (!groupInfo) {
                console.error(`[ERROR] Linked channel exists for deleted group ${sourceChannelInfo.group_id}. Cleanup required.`);
                db.prepare('DELETE FROM linked_channels WHERE group_id = ?').run(sourceChannelInfo.group_id);
                return;
            }
            
            const rateLimitDayString = getRateLimitDayString();
            const messageLength = (message.content || '').length;
            
            if (messageLength > 0) {
                db.prepare(`INSERT INTO group_stats (group_id, day, character_count) VALUES (?, ?, ?) ON CONFLICT(group_id, day) DO UPDATE SET character_count = character_count + excluded.character_count`).run(sourceChannelInfo.group_id, rateLimitDayString, messageLength);
            }

            const isSupporterGroup = await checkGroupForSupporters(message.client, sourceChannelInfo.group_id);
            const stats = db.prepare('SELECT character_count, warning_sent_at FROM group_stats WHERE group_id = ? AND day = ?').get(sourceChannelInfo.group_id, rateLimitDayString);
            
            if (!isSupporterGroup && stats && stats.character_count > RATE_LIMIT_CHARS) {
                const subscription = db.prepare('SELECT 1 FROM guild_subscriptions WHERE guild_id = ? AND is_active = 1').get(message.guild.id);
                if (!subscription) {
                    if (groupsBeingWarned.has(sourceChannelInfo.group_id)) return;
                    if (!stats.warning_sent_at) {
                        try {
                            groupsBeingWarned.add(sourceChannelInfo.group_id);
                            console.log(`[RATE LIMIT] Group "${groupInfo.group_name}" exceeded limit. Sending warning.`);
                            const allTargetChannels = db.prepare('SELECT webhook_url FROM linked_channels WHERE group_id = ?').all(sourceChannelInfo.group_id);
                            const warningPayload = createVoteMessage(); 
                            warningPayload.username = 'RelayBot';
                            warningPayload.avatarURL = message.client.user.displayAvatarURL();
                            warningPayload.content = `**Daily character limit of ${RATE_LIMIT_CHARS.toLocaleString()} reached!**\n\nRelaying is paused. It will resume next reset or when a supporter joins.`;
                            for (const target of allTargetChannels) {
                                relayQueue.add(target.webhook_url, warningPayload, db, { targetChannelId: 'WARNING_SYSTEM' });
                            }
                            db.prepare('UPDATE group_stats SET warning_sent_at = ? WHERE group_id = ? AND day = ?').run(Date.now(), sourceChannelInfo.group_id, rateLimitDayString);
                        } finally {
                            groupsBeingWarned.delete(sourceChannelInfo.group_id);
                        }
                    }
                    return; 
                }
            }

			const senderName = message.member?.displayName ?? message.author.username;
			const serverBrand = sourceChannelInfo.brand_name || message.guild.name;
			let username = `${senderName} (${serverBrand})`;
			if (username.length > MAX_USERNAME_LENGTH) {
				username = username.substring(0, MAX_USERNAME_LENGTH - 3) + '...';
			}
            const avatarURL = message.author.displayAvatarURL();
            
            const targetChannels = db.prepare(`SELECT * FROM linked_channels WHERE group_id = ? AND channel_id != ? AND direction IN ('BOTH', 'RECEIVE_ONLY')`).all(sourceChannelInfo.group_id, message.channel.id);
            if (targetChannels.length === 0) return;

            console.log(`[DEBUG][${executionId}] Found ${targetChannels.length} target channel(s) to relay to for group "${groupInfo.group_name}".`);

            for (const target of targetChannels) {
                let replyEmbed = null;
                let replyPing = ''; 
                let finalContent = message.content;
                let hasUnmappedRoles = false;
                let safeFiles = [];
                let largeFiles = [];
                let currentFileSize = 0;
                let initialJsonSize = 0;
                let basePayloadForSizeCalc = {};
                let finalPayloadForSend = {};
                let payloadEmbeds = [];
                let finalPayloadContent = null;
                
                try {
                    const targetChannelName = message.client.channels.cache.get(target.channel_id)?.name ?? target.channel_id;
                    
                    // --- Reply Embed Logic ---
                    if (message.reference && message.reference.messageId) {
                        let repliedMessage;
                        try {
                            repliedMessage = await message.channel.messages.fetch(message.reference.messageId);
                        } catch {
                            replyEmbed = new EmbedBuilder().setColor('#B0B8C6').setDescription('*Replying to a deleted or inaccessible message.*');
                        }
                        
                        if (repliedMessage) {
                            const repliedAuthorName = repliedMessage.member?.displayName ?? repliedMessage.author.username;
                            const repliedAuthorAvatar = repliedMessage.author.displayAvatarURL();
                            let repliedContent = repliedMessage.content ? repliedMessage.content.substring(0, 1000) : '*(Message had no text content)*';
                            if (repliedMessage.editedTimestamp) repliedContent += ' *(edited)*';

                            const repliedToId = repliedMessage.id;
                            const parentInfo = db.prepare('SELECT original_message_id FROM relayed_messages WHERE relayed_message_id = ?').get(repliedToId);
                            const rootOriginalId = parentInfo ? parentInfo.original_message_id : repliedToId;

                            const relayedReplyInfo = db.prepare('SELECT relayed_message_id FROM relayed_messages WHERE original_message_id = ? AND relayed_channel_id = ?').get(rootOriginalId, target.channel_id);

                            let messageLink = null;
                            if (relayedReplyInfo && relayedReplyInfo.relayed_message_id) {
                                messageLink = `https://discord.com/channels/${target.guild_id}/${target.channel_id}/${relayedReplyInfo.relayed_message_id}`;
                            } else {
                                const originalMessageInfo = db.prepare('SELECT original_channel_id FROM relayed_messages WHERE original_message_id = ? LIMIT 1').get(rootOriginalId);
                                if(originalMessageInfo) {
                                    const originalGuildId = message.client.channels.cache.get(originalMessageInfo.original_channel_id)?.guild.id;
                                    if(originalGuildId) {
                                        messageLink = `https://discord.com/channels/${originalGuildId}/${originalMessageInfo.original_channel_id}/${rootOriginalId}`;
                                    }
                                }
                            }
                            
                            replyEmbed = new EmbedBuilder()
                                .setColor('#B0B8C6')
                                .setAuthor({ name: `Replying to ${repliedAuthorName}`, url: messageLink, iconURL: repliedAuthorAvatar })
                                .setDescription(repliedContent);
                            
                            // [Ping]
                            replyPing = `<@${repliedMessage.author.id}> `;
                        }
                    }

                    // --- Role Logic ---
                    let targetContent = message.content;
                    const roleMentions = targetContent.match(/<@&(\d+)>/g);

                    if (roleMentions) {
                        const targetGuild = await message.client.guilds.fetch(target.guild_id).catch(() => null);
                        const canManageRoles = targetGuild && targetGuild.members.me?.permissions.has(PermissionFlagsBits.ManageRoles);
                        let allowAutoRole = false;
                        if (canManageRoles) {
                             const channelSettings = db.prepare('SELECT allow_auto_role_creation FROM linked_channels WHERE channel_id = ?').get(target.channel_id);
                             allowAutoRole = channelSettings && channelSettings.allow_auto_role_creation;
                        }
                        for (const mention of roleMentions) {
                            const sourceRoleId = mention.match(/\d+/)[0];
                            const roleMap = db.prepare(`SELECT role_name FROM role_mappings WHERE group_id = ? AND guild_id = ? AND role_id = ?`).get(sourceChannelInfo.group_id, message.guild.id, sourceRoleId);
                            if (!roleMap) continue; 
                            let targetRole = db.prepare(`SELECT role_id FROM role_mappings WHERE group_id = ? AND guild_id = ? AND role_name = ?`).get(target.group_id, target.guild_id, roleMap.role_name);
                            if (targetRole) {
                                targetContent = targetContent.replace(mention, `<@&${targetRole.role_id}>`);
                            } else if (allowAutoRole) {
                                try {
                                    const newRole = await targetGuild.roles.create({ name: roleMap.role_name, mentionable: false, reason: `RelayBot Auto-Create` });
                                    db.prepare('INSERT INTO role_mappings (group_id, guild_id, role_name, role_id) VALUES (?, ?, ?, ?)').run(target.group_id, target.guild_id, roleMap.role_name, newRole.id);
                                    targetContent = targetContent.replace(mention, `<@&${newRole.id}>`);
                                } catch (e) { hasUnmappedRoles = true; }
                            } else {
                                hasUnmappedRoles = true;
                            }
                        }
                    }
                
                    finalContent = targetContent;
                    const contentWithoutMentions = finalContent.replace(/<@!?&?#?(\d+)>/g, '').trim();
                    if (contentWithoutMentions.length === 0 && hasUnmappedRoles) {
                        finalContent = `*(Unmapped role in original message. Admin can map it or enable auto-sync.))*`;
                    }

                    let finalPayloadContent = replyPing + finalContent;

                    // --- Attachments / Voice / Forwarded ---
                    let fileNoticeString = "";
                    const sortedAttachments = Array.from(message.attachments.values()).sort((a, b) => a.size - b.size);
                    
                    basePayloadForSizeCalc = { content: finalPayloadContent, username: username, avatarURL: avatarURL, embeds: [], allowedMentions: { parse: ['roles', 'users'], repliedUser: false } }; 
                    if (replyEmbed) basePayloadForSizeCalc.embeds.push(replyEmbed);
                    basePayloadForSizeCalc.embeds.push(...message.embeds);
                    initialJsonSize = Buffer.byteLength(JSON.stringify(basePayloadForSizeCalc));

                    for (const att of sortedAttachments) {
                        if (initialJsonSize + currentFileSize + att.size <= MAX_PAYLOAD_SIZE) {
                            let attachmentName = att.name;
                            if (att.spoiler && !attachmentName.startsWith('SPOILER_')) {
                                attachmentName = `SPOILER_${att.name}`;
                            }
                            safeFiles.push({ attachment: att.url, name: attachmentName });
                            currentFileSize += att.size;
                        } else {
                            largeFiles.push({ name: att.name, size: att.size });
                        }
                    }
                    
                    if (largeFiles.length > 0) {
                        fileNoticeString = `\n*(Note: ${largeFiles.length} file(s) too large: ${largeFiles.map(f => f.name).join(', ')})*`;
                    }
                    finalPayloadContent += fileNoticeString;

                    if (message.flags.has(MessageFlags.IsVoiceMessage)) {
                        finalPayloadContent += `\n🎤 **[Voice Message]**`; 
                    }
                    
                    if (message.messageSnapshots && message.messageSnapshots.size > 0) {
                        const snapshot = message.messageSnapshots.first();
                        if (snapshot) {
                            if (snapshot.content) finalPayloadContent += `\n> *Forwarded Message:*\n${snapshot.content}`;
                            if (snapshot.embeds && snapshot.embeds.length > 0) payloadEmbeds.push(...snapshot.embeds);
                            if (snapshot.attachments && snapshot.attachments.size > 0) {
                                snapshot.attachments.forEach(att => {
                                    if (initialJsonSize + currentFileSize + att.size <= MAX_PAYLOAD_SIZE) {
                                         let attachmentName = att.name;
                                         if (att.spoiler && !attachmentName.startsWith('SPOILER_')) attachmentName = `SPOILER_${att.name}`;
                                         safeFiles.push({ attachment: att.url, name: attachmentName });
                                         currentFileSize += att.size;
                                    }
                                });
                            }
                        }
                    }

                    if (message.poll) {
                        const pollEmbed = new EmbedBuilder().setColor('#5865F2').setAuthor({ name: '📊 Poll' }).setTitle(message.poll.question.text.substring(0, 256));
                        let description = '';
                        message.poll.answers.forEach((answer, index) => {
                            const prefix = answer.emoji ? (answer.emoji.id ? `<:${answer.emoji.name}:${answer.emoji.id}>` : answer.emoji.name) : `${index + 1}.`;
                            description += `${prefix} **${answer.text}**\n`;
                        });
                        pollEmbed.setDescription(description.substring(0, 4096));
                        payloadEmbeds.push(pollEmbed);
                    }

                    if (finalPayloadContent.length > DISCORD_MESSAGE_LIMIT) {
                        finalPayloadContent = finalPayloadContent.substring(0, DISCORD_MESSAGE_LIMIT - 50) + "...(truncated)";
                    }

                    payloadEmbeds = [];
                    if (replyEmbed) payloadEmbeds.push(replyEmbed);
                    payloadEmbeds.push(...message.embeds);

                    const sticker = message.stickers.first();
                    const stickerId = sticker?.id;
                    const stickerData = sticker ? { name: sticker.name, url: sticker.url } : null;

                    finalPayloadForSend = {
                        content: finalPayloadContent,
                        files: safeFiles,
                        embeds: payloadEmbeds,
                        username: username,
                        avatarURL: avatarURL,
                        allowedMentions: { parse: ['roles', 'users'], repliedUser: false },
                        sticker_ids: stickerId ? [stickerId] : undefined,
                        tts: message.tts,
                        flags: message.flags.bitfield & (4096 | 4)
                    };
                    
                    const meta = {
                        originalMsgId: message.id,
                        originalChannelId: message.channel.id,
                        repliedToId: message.reference ? message.reference.messageId : null,
                        targetChannelId: target.channel_id,
                        executionId: executionId,
                        stickerData: stickerData // [THE FIX] Comma added here
                    };

                    relayQueue.add(target.webhook_url, finalPayloadForSend, db, meta);

              } catch (error) {
                    if (error.code === 40005) shouldLogVerbose = true; 

                    const targetChannelNameForError = message.client.channels.cache.get(target.channel_id)?.name ?? `ID ${target.channel_id}`;
                    if (error.code === 10015) {
                        console.error(`[AUTO-CLEANUP][${executionId}] Webhook for channel #${targetChannelNameForError} is invalid. Removing from relay.`);
                        try {
                            const brokenChannel = await message.client.channels.fetch(target.channel_id);
                            if (brokenChannel) {
                                await brokenChannel.send("⚠️ **Relay Connection Lost:** The webhook used for relaying messages in this channel was deleted or is invalid.\n\n**Action Required:** This channel has been automatically unlinked. An admin must run `/relay link_channel` to reconnect it.");
                            }
                        } catch (notifyError) {
                            console.warn(`[AUTO-CLEANUP-WARN] Could not notify channel ${target.channel_id}: ${notifyError.message}`);
                        }
                        db.prepare('DELETE FROM linked_channels WHERE channel_id = ?').run(target.channel_id);
                    } else {
                        const errorCode = error.code || 'N/A';
                        const errorMsg = error.message || 'Unknown error occurred';
                        console.error(`[RELAY-LOOP-ERROR][${executionId}] FAILED to process relay for target #${targetChannelNameForError}. Code: ${errorCode} | Error: ${errorMsg}`);
                    }
                   console.error(`[RELAY-LOOP-ERROR][${executionId}] ${error.message}`);
                }
            }
        } catch (error) {
            if (error.code === 40005) shouldLogVerbose = true; 
            console.error(`[ERROR] Code:`, error.code);
            console.error(`[FATAL-ERROR][${executionId}] A critical unhandled error occurred in messageCreate for message ${message.id} ${error.message}.`, error);
        }
    },
};