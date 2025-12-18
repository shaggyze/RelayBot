// events/messageCreate.js
const { Events, WebhookClient, Collection, PermissionFlagsBits, EmbedBuilder, MessageFlags } = require('discord.js');
const db = require('../db/database.js');
const crypto = require('crypto');
const relayQueue = require('../utils/relayQueue.js');
const { isGroupSupported } = require('../utils/supporterManager.js');
const webhookManager = require('../utils/webhookManager.js');
const Logger = require('../utils/logManager.js');

const BOT_OWNER_ID = '182938628643749888';

const webhookCache = new Collection();
const MAX_PAYLOAD_SIZE = 6.0 * 1024 * 1024; 
const MAX_USERNAME_LENGTH = 80;
const RATE_LIMIT_CHARS = 100000;
const DISCORD_MESSAGE_LIMIT = 2000;

const groupsBeingWarned = new Set();

const createVoteMessage = () => ({ content: "Please vote/subscribe to increase limits!", embeds: [] });
const getRateLimitDayString = () => new Date().toISOString().slice(0, 10);
const RESET_HOUR_UTC = 20;

function escapeRegex(string) { return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

async function sendWarning(message, userId, text) {
    try {
        // Try DM first
        const user = await message.client.users.fetch(userId);
        await user.send(`⚠️ **RelayBot Warning**\nServer: ${message.guild.name}\n${text}`);
    } catch (dmError) {
        // Fallback to Channel with Ping
        try {
            const reply = await message.channel.send(`<@${userId}> ${text}`);
            // Optional: delete warning after a while
            setTimeout(() => reply.delete().catch(() => {}), 15000);
        } catch (chError) { /* Cannot warn */ }
    }
}

async function notifyGroupOwner(client, groupInfo, report) {
    if (!groupInfo.owner_user_id) return; // Can't notify if unknown
    try {
        const owner = await client.users.fetch(groupInfo.owner_user_id);
        await owner.send(`🛡️ **RelayBot Auto-Mod Report**\n**Group:** ${groupInfo.group_name}\n\n${report}`);
    } catch (e) {
        Logger.error(`Failed to DM Group Owner ${groupInfo.owner_user_id}: ${e.message}`);
    }
}

module.exports = {
    name: Events.MessageCreate,
    async execute(message) {
        const executionId = crypto.randomBytes(4).toString('hex');
        let shouldLogVerbose = false;

        try {
            // 1. Always ignore DMs.
            if (!message.guild) return;

            // 2. MASTER SELF-IGNORE (LOOP PROTECTION)
            // Ignore messages from the bot's user account
            if (message.author.id === message.client.user.id) return;
            // Ignore messages from webhooks OWNED by this bot (Shared Application ID)
            // This stops the bot from replying to itself, while allowing OTHER webhooks.
            if (message.webhookId && message.applicationId === message.client.user.id) return;
            
            const sourceChannelInfo = db.prepare("SELECT * FROM linked_channels WHERE channel_id = ? AND direction IN ('BOTH', 'SEND_ONLY')").get(message.channel.id);
            if (!sourceChannelInfo) return;

            // 3. CONDITIONAL IGNORE (Process Bots)
            const processBots = sourceChannelInfo.process_bot_messages; 
            if (!processBots && (message.author.bot || message.webhookId)) {
                return; 
            }

            // 4. Blacklist Check
			const isBlocked = db.prepare('SELECT 1 FROM group_blacklist WHERE group_id = ? AND (blocked_id = ? OR blocked_id = ?)').get(sourceChannelInfo.group_id, message.author.id, message.guild.id);
			if (isBlocked) {
				Logger.warn('BLOCK', `Message stopped from ${message.author.username} (${message.author.id}) in ${message.guild.name}`, executionId);
				return;
			}

            const groupInfo = db.prepare('SELECT group_name FROM relay_groups WHERE group_id = ?').get(sourceChannelInfo.group_id);
            if (!groupInfo) {
                Logger.error('DB-ERROR', `Linked channel exists for deleted group ${sourceChannelInfo.group_id}. Cleanup required.`, executionId);
                db.prepare('DELETE FROM linked_channels WHERE group_id = ?').run(sourceChannelInfo.group_id);
                return;
            }
            
            // --- IMMUNITY CHECK ---
            const isBotOwner = message.author.id === BOT_OWNER_ID
            const isGroupOwner = message.author.id === groupInfo.owner_user_id;

            // --- NEW FILTER SYSTEM ---
            let filterContent = message.content;

            if (filterContent) {
                const filters = db.prepare('SELECT * FROM group_filters WHERE group_id = ?').all(sourceChannelInfo.group_id);
                
                for (const f of filters) {
                    const regex = new RegExp(`\\b${escapeRegex(f.phrase)}\\b`, 'gi');
                    if (regex.test(filterContent)) {
                        let shouldBlock = false;
                        let trippedFilter = null;
                        filterContent = filterContent.replace(regex, '***');
                        if (!isBotOwner && !isGroupOwner) trippedFilter = f;

                        if (trippedFilter) {
                            // Update Warnings
                            db.prepare(`
                                INSERT INTO user_warnings (group_id, user_id, filter_id, warning_count, last_violation_at) 
                                VALUES (?, ?, ?, 1, ?)
                                ON CONFLICT(group_id, user_id, filter_id) 
                                DO UPDATE SET warning_count = warning_count + 1, last_violation_at = excluded.last_violation_at
                            `).run(sourceChannelInfo.group_id, message.author.id, trippedFilter.filter_id, Date.now());

                            const userStats = db.prepare('SELECT warning_count FROM user_warnings WHERE group_id = ? AND user_id = ? AND filter_id = ?').get(sourceChannelInfo.group_id, message.author.id, trippedFilter.filter_id);
                            
                            // Logic based on Individual Filter Threshold
                            if (trippedFilter.threshold === 0) {
                                break;
                            } else if (trippedFilter.threshold === 1) {
                                // Instant Silent Block
                                shouldBlock = true;
                                // Do NOT warn user.
                            } else if (userStats.warning_count >= trippedFilter.threshold) {
                                // Strike out
                                shouldBlock = true;
                                // Notify User they are blocked
                                await sendWarning(message, message.author.id, `🚫 **You have been blocked from the relay group.**\nReason: Repeated use of prohibited phrase: "||${trippedFilter.phrase}||"`);
                            } else {
                                // Warn User
                                const remaining = trippedFilter.threshold - userStats.warning_count;
                                await sendWarning(message, message.author.id, `⚠️ **Warning:** ${trippedFilter.warning_msg}\nPhrase: "||${trippedFilter.phrase}||"\nStrikes: ${userStats.warning_count}/${trippedFilter.threshold}. (${remaining} left).`);
                            }

                            if (shouldBlock) {
                                try {
                                    db.prepare('INSERT INTO group_blacklist (group_id, blocked_id, type) VALUES (?, ?, ?)').run(sourceChannelInfo.group_id, message.author.id, 'USER');
                                    
                                    const report = `**User Blocked:** ${message.author.tag} (\`${message.author.id}\`)\n` +
                                                   `**Trigger Phrase:** ${trippedFilter.phrase}\n` +
                                                   `**Strikes:** ${userStats.warning_count}\n` +
                                                   `**Original Message:**\n> ${message.content}\n` +
                                                   `**Link:** ${message.url}`;
                                    await notifyGroupOwner(message.client, groupInfo, report);
                                    Logger.warn('BLOCK', `User ${message.author.id} auto-blocked in group ${sourceChannelInfo.group_id}`, executionId);
                                } catch (e) {} // Ignore if already blocked
                                
                                return; // DO NOT RELAY
                            }
                        }
                    }
                }
            }
            const rateLimitDayString = getRateLimitDayString();
            const messageLength = (filterContent || '').length;
            
            if (messageLength > 0) {
                db.prepare(`INSERT INTO group_stats (group_id, day, character_count) VALUES (?, ?, ?) ON CONFLICT(group_id, day) DO UPDATE SET character_count = character_count + excluded.character_count`).run(sourceChannelInfo.group_id, rateLimitDayString, messageLength);
            }

            // --- Rate Limit Logic (Optimized) ---
            // [THE FIX] Use the cached check. No API calls.
            const isSupporterGroup = isGroupSupported(sourceChannelInfo.group_id);
            
            const stats = db.prepare('SELECT character_count, warning_sent_at FROM group_stats WHERE group_id = ? AND day = ?').get(sourceChannelInfo.group_id, rateLimitDayString);
            
            if (!isSupporterGroup && stats && stats.character_count > RATE_LIMIT_CHARS) {
                if (groupsBeingWarned.has(sourceChannelInfo.group_id)) return;

                if (!stats.warning_sent_at) {
                    try {
                        groupsBeingWarned.add(sourceChannelInfo.group_id);
                        Logger.warn('RATELIMIT', `Group "${groupInfo.group_name}" exceeded limit.`, executionId);
                        const allTargetChannels = db.prepare('SELECT webhook_url FROM linked_channels WHERE group_id = ?').all(sourceChannelInfo.group_id);
                        const now = new Date();
                        const nextResetTime = new Date();
                        nextResetTime.setUTCHours(RESET_HOUR_UTC, 0, 0, 0);
                        if (now > nextResetTime) { nextResetTime.setUTCDate(nextResetTime.getUTCDate() + 1); }
                        const timerString = `<t:${Math.floor(nextResetTime.getTime() / 1000)}:R>`;
                        const warningPayload = createVoteMessage(); 
                        warningPayload.username = 'RelayBot';
                        warningPayload.avatarURL = message.client.user.displayAvatarURL();
                        warningPayload.content = `**Daily character limit of ${RATE_LIMIT_CHARS.toLocaleString()} reached!**\n\nRelaying is paused. It will resume next reset or when a supporter joins.`;
                        for (const target of allTargetChannels) {
                            relayQueue.add(target.webhook_url, warningPayload, db, { targetChannelId: 'WARNING_SYSTEM', executionId: executionId }, message.client);
                        }
                        db.prepare('UPDATE group_stats SET warning_sent_at = ? WHERE group_id = ? AND day = ?').run(Date.now(), sourceChannelInfo.group_id, rateLimitDayString);
                    } finally {
                        groupsBeingWarned.delete(sourceChannelInfo.group_id);
                    }
                }
                return; 
            }

			const senderName = message.member?.displayName ?? message.author.username;
			const serverBrand = sourceChannelInfo.brand_name || message.guild.name;
			let username = `${senderName} (${serverBrand})`;
			if (username.length > MAX_USERNAME_LENGTH) {
				username = username.substring(0, MAX_USERNAME_LENGTH - 3) + '...';
			}
            const avatarURL = message.author.displayAvatarURL();
            
            // [THE FIX] Added DISTINCT to the query to help, but we will also deduplicate in code
            const rawTargetChannels = db.prepare(`SELECT * FROM linked_channels WHERE group_id = ? AND channel_id != ? AND direction IN ('BOTH', 'RECEIVE_ONLY')`).all(sourceChannelInfo.group_id, message.channel.id);
            
            // [THE FIX] Manually deduplicate based on channel_id to be 100% safe against DB errors
            const targetChannelsMap = new Map();
            for (const t of rawTargetChannels) {
                targetChannelsMap.set(t.channel_id, t);
            }
            const targetChannels = Array.from(targetChannelsMap.values());

            if (targetChannels.length === 0) return;

            console.log(`[DEBUG][${executionId}] Found ${targetChannels.length} unique target channel(s) to relay to for group "${groupInfo.group_name}".`);

            for (const target of targetChannels) {
                let replyEmbed = null;
                let replyPing = ''; 
                let finalContent = filterContent;
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
                    
                    // --- Reply Logic ---
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
                                if (!messageLink) messageLink = repliedMessage.url;
                            }
                            
                            replyEmbed = new EmbedBuilder()
                                .setColor('#B0B8C6') 
                                .setAuthor({ name: `Replying to ${repliedAuthorName}`, url: messageLink, iconURL: repliedAuthorAvatar })
                                .setDescription(repliedContent);
                            
                            // [SMART PING] Check if user already mentioned the author manually
                            const isAlreadyMentioned = message.mentions.users.has(repliedMessage.author.id);
                            
                            if (!isAlreadyMentioned) {
                                replyPing = `<@${repliedMessage.author.id}> `;
                            }
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

                    // --- Attachments / Voice / Forwarded Logic ---
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

                    if (replyEmbed) payloadEmbeds.push(replyEmbed);

                    if (message.embeds.length > 0) {
                        for (const originalEmbed of message.embeds) {
                            // Skip the "Replying to..." embed if we are creating our own
                            // (Though usually message.embeds refers to the original message's content)
                            
                            // Create a new Builder to sanitize the data
                            const cleanEmbed = new EmbedBuilder();

                            // Copy standard fields
                            if (originalEmbed.title) cleanEmbed.setTitle(originalEmbed.title);
                            if (originalEmbed.description) cleanEmbed.setDescription(originalEmbed.description);
                            if (originalEmbed.url) cleanEmbed.setURL(originalEmbed.url);
                            if (originalEmbed.color) cleanEmbed.setColor(originalEmbed.color);
                            if (originalEmbed.timestamp) cleanEmbed.setTimestamp(new Date(originalEmbed.timestamp));
                            
                            // Copy Author
                            if (originalEmbed.author) {
                                cleanEmbed.setAuthor({
                                    name: originalEmbed.author.name,
                                    url: originalEmbed.author.url,
                                    iconURL: originalEmbed.author.iconURL
                                });
                            }

                            // Copy Footer
                            if (originalEmbed.footer) {
                                cleanEmbed.setFooter({
                                    text: originalEmbed.footer.text,
                                    iconURL: originalEmbed.footer.iconURL
                                });
                            }

                            // Copy Fields
                            if (originalEmbed.fields && originalEmbed.fields.length > 0) {
                                cleanEmbed.addFields(originalEmbed.fields);
                            }

                            // [CRITICAL FIX] Handle Images and Thumbnails
                            // If the original had an image (even if it was an auto-embed), set it explicitly.
                            // This forces the "Big Image" view.
                            if (originalEmbed.image) {
                                cleanEmbed.setImage(originalEmbed.image.url);
                            } else if (originalEmbed.thumbnail && originalEmbed.type === 'image') {
                                // Sometimes auto-images are stored in thumbnail field for 'image' types
                                cleanEmbed.setImage(originalEmbed.thumbnail.url);
                            } else if (originalEmbed.thumbnail) {
                                // Otherwise, keep it as a standard thumbnail (small top-right image)
                                cleanEmbed.setThumbnail(originalEmbed.thumbnail.url);
                            }

                            // Only add if it has content (Discord rejects empty embeds)
                            if (cleanEmbed.data.title || cleanEmbed.data.description || cleanEmbed.data.image || cleanEmbed.data.author) {
                                payloadEmbeds.push(cleanEmbed);
                            } else if (originalEmbed.url && originalEmbed.type === 'image') {
                                // Edge case: Just a raw image link embed without other data. 
                                // Force it into an image embed.
                                cleanEmbed.setImage(originalEmbed.url);
                                payloadEmbeds.push(cleanEmbed);
                            }
                        }
                    }

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
                        groupName: groupInfo.group_name, // Pass for webhookManager
                        stickerData: stickerData
                    };
                    relayQueue.add(target.webhook_url, finalPayloadForSend, db, meta, message.client);

                 } catch (error) {
                    if (error.code === 40005) shouldLogVerbose = true;
                   
                    const targetChannelNameForError = message.client.channels.cache.get(target.channel_id)?.name ?? `ID ${target.channel_id}`;
                    if (error.code === 10015) {
                        Logger.error('AUTO-REPAIR', `Webhook missing for channel #${targetChannelNameForError}. Attempting to repair...`, executionId, error);
                        webhookManager.handleInvalidWebhook(message.client, target.channel_id, groupInfo.group_name);
                    } else {
                        const errorCode = error.code || 'N/A';
                        const errorMsg = error.message || 'Unknown error occurred';
                   Logger.error('RELAY-LOOP-ERROR', `Failed to prep relay for ${target.channel_id}`, executionId, error);
                    }
                }
            }

            if (shouldLogVerbose) {
                Logger.warn('VERBOSE', `Verbose logging triggered for ${executionId} due to errors/empty payload.`);
            }

        } catch (error) {
            Logger.error('FATAL-ERROR', `Critical unhandled error in messageCreate for message ${message.id}`, executionId, error);
        }
    },
};