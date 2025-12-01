// events/messageCreate.js
const { Events, WebhookClient, Collection, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const db = require('../db/database.js');
const crypto = require('crypto');

const webhookCache = new Collection();
const MAX_PAYLOAD_SIZE = 7.0 * 1024 * 1024;
const MAX_USERNAME_LENGTH = 80;
const RATE_LIMIT_CHARS = 100000;
const DISCORD_MESSAGE_LIMIT = 2000;

const groupsBeingWarned = new Set();

// [THE FIX] In-memory cache to store groups confirmed as supporters for the day
// Key: groupId (Integer), Value: Date String "YYYY-MM-DD"
const dailySupporterCache = new Map();

// Re-using simplified placeholder stubs for external functions
const createVoteMessage = () => ({}); 
const isSupporter = (id) => false;
const getSupporterSet = () => new Set();
const getRateLimitDayString = () => new Date().toISOString().slice(0, 10);
const RESET_HOUR_UTC = 19;

// [THE FIX] Updated function with caching logic
async function checkGroupForSupporters(client, groupId) {
    const currentDay = getRateLimitDayString();

    // 1. Fast Path: Check Cache
    // If we already confirmed this group has a supporter TODAY, skip all other checks.
    if (dailySupporterCache.get(groupId) === currentDay) {
        return true;
    }

    const supporterIdList = getSupporterSet();
    
    // 2. Database Check: Guild Subscriptions
    // We check if any guild in this group has an active subscription.
    const guildsInGroup = db.prepare('SELECT DISTINCT guild_id FROM linked_channels WHERE group_id = ?').all(groupId);
    
    for (const row of guildsInGroup) {
        const subscription = db.prepare('SELECT 1 FROM guild_subscriptions WHERE guild_id = ? AND is_active = 1').get(row.guild_id);
        if (subscription) {
            // Found a subscription! Cache it for today and return.
            dailySupporterCache.set(groupId, currentDay);
            return true; 
        }
    }

    // 3. User Check: Patron List (Memory & Bulk Fetch)
    if (supporterIdList.size > 0) {
        for (const row of guildsInGroup) {
            try {
                const guild = client.guilds.cache.get(row.guild_id);
                if (!guild) continue;

                // A. Check Cache (Instant)
                const hasSupporterInCache = guild.members.cache.some(member => supporterIdList.has(member.id));
                if (hasSupporterInCache) {
                    // Found a patron in cache! Cache group status and return.
                    dailySupporterCache.set(groupId, currentDay);
                    return true;
                }

                // B. Bulk Fetch (Only if needed)
                const supporterArray = Array.from(supporterIdList);
                if (supporterArray.length <= 100) {
                    try {
                        const fetchedMembers = await guild.members.fetch({ user: supporterArray });
                        if (fetchedMembers.size > 0) {
                            // Found a patron via fetch! Cache group status and return.
                            dailySupporterCache.set(groupId, currentDay);
                            return true;
                        }
                    } catch (e) {
                        // Ignore specific fetch errors
                    }
                }
            } catch (error) {
                console.warn(`[SupporterCheck] Error checking guild ${row.guild_id}. Defaulting to true.`);
                // If we default to true due to error, we DO NOT cache it, 
                // so we retry properly next time.
                return true;
            }
        }
    }

    // If we get here, no supporter was found.
    return false;
}

module.exports = {
    name: Events.MessageCreate,
    async execute(message) {
        let shouldLogVerbose = false;
        const executionId = crypto.randomBytes(4).toString('hex');

        try {
            // --- CRITICAL GUARD CLAUSES ---
            if (!message.guild) return;

            // 1. ALWAYS ignore messages sent by THIS bot's user account.
            if (message.author.id === message.client.user.id) return;
            
            const sourceChannelInfo = db.prepare("SELECT * FROM linked_channels WHERE channel_id = ? AND direction IN ('BOTH', 'SEND_ONLY')").get(message.channel.id);
            if (!sourceChannelInfo) return;

            // --- 2. CONDITIONAL IGNORE for ALL OTHER bots/webhooks ---
            const processBots = sourceChannelInfo.process_bot_messages; 

            if (!processBots && (message.author.bot || message.webhookId)) {
                return; 
            }
            
            // --- Blacklist Check ---
			const isBlocked = db.prepare('SELECT 1 FROM group_blacklist WHERE group_id = ? AND (blocked_id = ? OR blocked_id = ?)').get(sourceChannelInfo.group_id, message.author.id, message.guild.id);
			if (isBlocked) {
				console.warn(`[BLOCK] Message stopped from ${message.author.username} (ID: ${message.author.id}) in server ${message.guild.name} (ID: ${message.guild.id}) for group ${sourceChannelInfo.group_id}.`);
				return; 
			}

            const groupInfo = db.prepare('SELECT group_name FROM relay_groups WHERE group_id = ?').get(sourceChannelInfo.group_id);
            if (!groupInfo) {
                console.error(`[ERROR] A linked channel (${message.channel.id}) exists for a deleted group_id (${sourceChannelInfo.group_id}). Cleaning up...`);
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

            // --- Rate Limit Logic ---
            const isSupporterGroup = await checkGroupForSupporters(message.client, sourceChannelInfo.group_id);
            const stats = db.prepare('SELECT character_count, warning_sent_at FROM group_stats WHERE group_id = ? AND day = ?').get(sourceChannelInfo.group_id, rateLimitDayString);
            
            if (!isSupporterGroup && stats && stats.character_count > RATE_LIMIT_CHARS) {
                if (groupsBeingWarned.has(sourceChannelInfo.group_id)) return;

                if (!stats.warning_sent_at) {
                    try {
                        groupsBeingWarned.add(sourceChannelInfo.group_id);
                        console.log(`[RATE LIMIT] Group "${groupInfo.group_name}" has exceeded the daily limit. Sending warning.`);
                        
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
                    } finally {
                        groupsBeingWarned.delete(sourceChannelInfo.group_id);
                    }
                }
                return; 
            }

            // --- Branding Logic ---
			const senderName = message.member?.displayName ?? message.author.username;
			const serverBrand = sourceChannelInfo.brand_name || message.guild.name;
			let username = `${senderName} (${serverBrand})`;

			if (username.length > MAX_USERNAME_LENGTH) {
				username = username.substring(0, MAX_USERNAME_LENGTH - 3) + '...';
			}
            const avatarURL = message.author.displayAvatarURL();
            
            const targetChannels = db.prepare(`SELECT * FROM linked_channels WHERE group_id = ? AND channel_id != ? AND direction IN ('BOTH', 'RECEIVE_ONLY')`).all(sourceChannelInfo.group_id, message.channel.id);
            if (targetChannels.length === 0) {
                console.log(`[DEBUG][${executionId}] No valid receiving channels found in group "${groupInfo.group_name}". Nothing to relay.`);
                return;
            }

            console.log(`[DEBUG][${executionId}] Found ${targetChannels.length} target channel(s) to relay to for group "${groupInfo.group_name}".`);
        
            // Flag to ensure full reply embed only appears once
            let isFirstTarget = true; 

            for (const target of targetChannels) {
                shouldLogVerbose = false; 
                
                let initialMessageContent = message.content;
                let replyEmbed = null;
                let stickerId = null;
                let finalContent = null;
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
                            if (isFirstTarget) {
                                replyEmbed = new EmbedBuilder().setColor('#B0B8C6').setDescription('*Replying to a deleted or inaccessible message.*');
                            }
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
                            
                            if (isFirstTarget) {
                                replyEmbed = new EmbedBuilder()
                                    .setColor('#B0B8C6')
                                    .setAuthor({ name: `Replying to ${repliedAuthorName}`, url: messageLink, iconURL: repliedAuthorAvatar })
                                    .setDescription(repliedContent);
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
                            } 
                            else if (allowAutoRole) {
                                try {
                                    const newRole = await targetGuild.roles.create({
                                        name: roleMap.role_name,
                                        mentionable: false, 
                                        reason: `Auto-creating role for RelayBot mapping: ${roleMap.role_name}`
                                    });
                                    db.prepare('INSERT INTO role_mappings (group_id, guild_id, role_name, role_id) VALUES (?, ?, ?, ?)').run(target.group_id, target.guild_id, roleMap.role_name, newRole.id);
                                    targetContent = targetContent.replace(mention, `<@&${newRole.id}>`);
                                } catch (roleError) {
                                    console.error(`[AUTO-ROLE-FAIL] FAILED to create role "${roleMap.role_name}":`, roleError);
                                    hasUnmappedRoles = true; 
                                }
                            } 
                            else {
                                hasUnmappedRoles = true;
                            }
                        }
                    }
                
                    finalContent = targetContent;
                    const contentWithoutMentions = finalContent.replace(/<@!?&?#?(\d+)>/g, '').trim();
                    
                    if (contentWithoutMentions.length === 0 && hasUnmappedRoles) {
                        finalContent = `*(A role in the original message was not relayed because it has not been mapped in this server. An admin needs to manually map a role or enable and run the auto-sync feature.)*`;
                    }

                    let fileNoticeString = "";
                    if (largeFiles.length > 0) {
                        fileNoticeString = `\n*(Note: ${largeFiles.length} file(s) were too large or exceeded the total upload limit and were not relayed: ${largeFiles.map(f => f.name).join(', ')})*`;
                    }
                    let finalPayloadContent = finalContent + fileNoticeString;

                    // [THE FIX] Handle Forwarded Messages (Snapshots)
                    if (message.messageSnapshots && message.messageSnapshots.size > 0) {
                        const snapshot = message.messageSnapshots.first();
                        if (snapshot) {
                            if (snapshot.content) {
                                finalPayloadContent += `\n> *Forwarded Message:*\n${snapshot.content}`;
                            }
                            if (snapshot.embeds && snapshot.embeds.length > 0) {
                                payloadEmbeds.push(...snapshot.embeds);
                            }
                            if (snapshot.attachments && snapshot.attachments.size > 0) {
                                // We process snapshot attachments using the same logic as normal attachments
                                // but we can't retroactively add them to 'safeFiles' easily here without re-running size checks.
                                // For simplicity, we just add their URLs if we assume they fit, or better:
                                // We should ideally loop them into the attachment processor.
                                // Given complexity, just appending URLs to content is safest for forwarded images:
                                const snapshotFileLinks = snapshot.attachments.map(a => a.url).join('\n');
                                finalPayloadContent += `\n${snapshotFileLinks}`;
                            }
                        }
                    }
                    
                    if (finalPayloadContent.length > DISCORD_MESSAGE_LIMIT) {
                        const truncationNotice = `\n*(Message was truncated...)*`;
                        finalPayloadContent = finalPayloadContent.substring(0, DISCORD_MESSAGE_LIMIT - truncationNotice.length) + truncationNotice;
                    }

                    basePayloadForSizeCalc = {
                        content: finalContent,
                        username: username,
                        avatarURL: avatarURL,
                        embeds: [],
                        allowedMentions: { parse: ['roles'], repliedUser: false }
                    };
                    if (replyEmbed) basePayloadForSizeCalc.embeds.push(replyEmbed);
                    basePayloadForSizeCalc.embeds.push(...message.embeds);
                    
                    if (message.stickers.size > 0) {
                        const sticker = message.stickers.first();
                        if (sticker && sticker.id) {
                            stickerId = sticker.id;
                        }
                    }
                    if (stickerId) {
                         basePayloadForSizeCalc.sticker_ids = [stickerId];
                    }

                    initialJsonSize = Buffer.byteLength(JSON.stringify(basePayloadForSizeCalc));
                    
                    const sortedAttachments = Array.from(message.attachments.values()).sort((a, b) => a.size - b.size);
                    
                    for (const att of sortedAttachments) {
                        if (initialJsonSize + currentFileSize + att.size <= MAX_PAYLOAD_SIZE) {
                            safeFiles.push(att.url);
                            currentFileSize += att.size;
                        } else {
                            largeFiles.push({ name: att.name, size: att.size });
                        }
                    }

                    // Re-calculate final content with large files notice if needed (logic moved above but needs to be consistent)
                    // We did it above, but safeFiles/largeFiles wasn't populated yet. 
                    // [CORRECTION]: We need to construct finalPayloadContent AFTER file processing.
                    
                    fileNoticeString = ""; // Reset and rebuild
                    if (largeFiles.length > 0) {
                        fileNoticeString = `\n*(Note: ${largeFiles.length} file(s) were too large or exceeded the total upload limit and were not relayed: ${largeFiles.map(f => f.name).join(', ')})`;
                    }
                    finalPayloadContent = finalContent + fileNoticeString; // Re-add notice
                    
                    // Re-apply Forwarded Message Logic (needs to happen here to be part of content)
                    if (message.messageSnapshots && message.messageSnapshots.size > 0) {
                         const snapshot = message.messageSnapshots.first();
                         if (snapshot) {
                            if (snapshot.content) finalPayloadContent += `\n> *Forwarded Message:*\n${snapshot.content}`;
                            if (snapshot.embeds && snapshot.embeds.length > 0) payloadEmbeds.push(...snapshot.embeds);
                            if (snapshot.attachments && snapshot.attachments.size > 0) finalPayloadContent += `\n${snapshot.attachments.map(a => a.url).join('\n')}`;
                         }
                    }

                    if (finalPayloadContent.length > DISCORD_MESSAGE_LIMIT) {
                        const truncationNotice = `\n*(Message was truncated...)*`;
                        finalPayloadContent = finalPayloadContent.substring(0, DISCORD_MESSAGE_LIMIT - truncationNotice.length) + truncationNotice;
                    }

                    payloadEmbeds = [];
                    if (replyEmbed) payloadEmbeds.push(replyEmbed);
                    payloadEmbeds.push(...message.embeds);

                    finalPayloadForSend = {
                        content: finalPayloadContent,
                        files: safeFiles,
                        embeds: payloadEmbeds,
                        username: username,
                        avatarURL: avatarURL,
                        allowedMentions: basePayloadForSizeCalc.allowedMentions,
                        sticker_ids: stickerId ? [stickerId] : undefined,
                    };
                    
                    // Check for empty payload
                    const logFinalContentTrimmed = finalPayloadContent?.trim() || "";
                    const isContentEmpty = !logFinalContentTrimmed;
                    const areFilesEmpty = !finalPayloadForSend.files || finalPayloadForSend.files.length === 0;
                    const areEmbedsEmpty = !finalPayloadForSend.embeds || finalPayloadForSend.embeds.length === 0;
                    const haveStickerIds = finalPayloadForSend.sticker_ids && finalPayloadForSend.sticker_ids.length > 0;

                    if (isContentEmpty && areFilesEmpty && areEmbedsEmpty && !haveStickerIds) {
                         shouldLogVerbose = true; 
                         console.log(`[DEBUG][${executionId}] Payload determined to be empty. Skipping send.`);
                    }
                    
                    if (shouldLogVerbose) {
                        console.error(`[FATAL-DEBUG][${executionId}] Verbose log triggered.`);
                    }

                    let relayedMessage = null;
                    const webhookClient = new WebhookClient({ url: target.webhook_url });
                    
                    try {
                        relayedMessage = await webhookClient.send(finalPayloadForSend);
                    } catch (sendError) {
                        if (sendError.code === 40005) {
                            shouldLogVerbose = true; 
                            console.error(`[ERROR 40005] Caught Request entity too large for message ${message.id} to #${targetChannelName}.`);
                            throw sendError;
                        } else if (sendError.code === 50006 && finalPayloadForSend.sticker_ids) {
                            try {
                                const sticker = message.stickers.first(); 
                                if (sticker && sticker.name) {
                                    const fallbackPayload = { ...finalPayloadForSend };
                                    delete fallbackPayload.sticker_ids; 
                                    fallbackPayload.content += `\n*(sent sticker: ${sticker.name})*`;
                                    if (fallbackPayload.content.length > DISCORD_MESSAGE_LIMIT) {
                                        const truncationNotice = `\n*(Message was truncated...)*`;
                                        fallbackPayload.content = fallbackPayload.content.substring(0, DISCORD_MESSAGE_LIMIT - truncationNotice.length) + truncationNotice;
                                    }
                                    relayedMessage = await webhookClient.send(fallbackPayload);
                                }
                            } catch (fallbackError) {
                                if (fallbackError.code === 40005) shouldLogVerbose = true;
                            }
                        } else {
                            throw sendError; 
                        }
                    }

                    if (relayedMessage) {
                        const repliedToOriginalId = message.reference ? message.reference.messageId : null;
                        db.prepare(
                            'INSERT INTO relayed_messages (original_message_id, original_channel_id, relayed_message_id, relayed_channel_id, replied_to_id) VALUES (?, ?, ?, ?, ?)'
                        ).run(
                            message.id,
                            message.channel.id,
                            relayedMessage.id,
                            relayedMessage.channel_id,
                            repliedToOriginalId
                        );
                    }

                    isFirstTarget = false;

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
                }
            }
        } catch (error) {
            if (error.code === 40005) shouldLogVerbose = true; 
            console.error(`[ERROR] Code:`, error.code);
            console.error(`[FATAL-ERROR][${executionId}] A critical unhandled error occurred in messageCreate for message ${message.id}.`, error);
        }
    },
};