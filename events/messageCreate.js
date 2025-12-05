// events/messageCreate.js
const { Events, WebhookClient, Collection, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const db = require('../db/database.js');
const crypto = require('crypto');
const relayQueue = require('../utils/relayQueue.js'); // [REQUIRED] The new queue system

const MAX_PAYLOAD_SIZE = 6.0 * 1024 * 1024;
const MAX_USERNAME_LENGTH = 80;
const RATE_LIMIT_CHARS = 100000;
const DISCORD_MESSAGE_LIMIT = 2000;

// State Variables
const groupsBeingWarned = new Set();
const dailySupporterCache = new Map(); // Caches supporter status for 24h to reduce DB/API hits

// Helper stubs (Assuming these are defined in your project structure)
const createVoteMessage = () => ({ content: "Please vote/subscribe to increase limits!", embeds: [] }); 
const isSupporter = (id) => false; // Your supporterManager handles this
const getSupporterSet = () => new Set(); // Your supporterManager handles this
const getRateLimitDayString = () => new Date().toISOString().slice(0, 10);
const RESET_HOUR_UTC = 19;

// [OPTIMIZED] Supporter Check: Database -> Memory Cache -> API Batch
async function checkGroupForSupporters(client, groupId) {
    const currentDay = getRateLimitDayString();

    // 1. Memory Cache Check (Fastest)
    if (dailySupporterCache.get(groupId) === currentDay) {
        return true;
    }

    const supporterIdList = getSupporterSet();
    
    // 2. Database Check: Subscriptions (Fast)
    const guildsInGroup = db.prepare('SELECT DISTINCT guild_id FROM linked_channels WHERE group_id = ?').all(groupId);
    
    for (const row of guildsInGroup) {
        const subscription = db.prepare('SELECT 1 FROM guild_subscriptions WHERE guild_id = ? AND is_active = 1').get(row.guild_id);
        if (subscription) {
            dailySupporterCache.set(groupId, currentDay);
            return true; 
        }
    }

    // 3. User/Patron Check (Slower)
    if (supporterIdList.size > 0) {
        for (const row of guildsInGroup) {
            try {
                const guild = client.guilds.cache.get(row.guild_id);
                if (!guild) continue;

                // A. Check Guild Cache
                const hasSupporterInCache = guild.members.cache.some(member => supporterIdList.has(member.id));
                if (hasSupporterInCache) {
                    dailySupporterCache.set(groupId, currentDay);
                    return true;
                }

                // B. Bulk Fetch (Only if list is small enough to avoid rate limits)
                const supporterArray = Array.from(supporterIdList);
                if (supporterArray.length <= 50) { // Strict limit to prevent API spam
                    try {
                        const fetchedMembers = await guild.members.fetch({ user: supporterArray });
                        if (fetchedMembers.size > 0) {
                            dailySupporterCache.set(groupId, currentDay);
                            return true;
                        }
                    } catch (e) { /* Ignore fetch errors */ }
                }
            } catch (error) {
                // On error, default to true to avoid punishing users during API outages
                return true;
            }
        }
    }

    return false;
}

module.exports = {
    name: Events.MessageCreate,
    async execute(message) {
        const executionId = crypto.randomBytes(4).toString('hex');

        try {
            // --- 1. MASTER GUARD: Ignore DMs ---
            if (!message.guild) return;

            // --- 2. MASTER GUARD: Self-Ignore ---
            // Prevents loops. Must be the very first logic check.
            if (message.author.id === message.client.user.id) return;

            // --- 3. Database Context ---
            const sourceChannelInfo = db.prepare("SELECT * FROM linked_channels WHERE channel_id = ? AND direction IN ('BOTH', 'SEND_ONLY')").get(message.channel.id);
            if (!sourceChannelInfo) return;

            // --- 4. Conditional Bot/Webhook Logic ---
            const processBots = sourceChannelInfo.process_bot_messages; 
            // If setting is OFF (or null), ignore other bots/webhooks
            if (!processBots && (message.author.bot || message.webhookId)) {
                return; 
            }

            // --- 5. Blacklist Check ---
			const isBlocked = db.prepare('SELECT 1 FROM group_blacklist WHERE group_id = ? AND (blocked_id = ? OR blocked_id = ?)').get(sourceChannelInfo.group_id, message.author.id, message.guild.id);
			if (isBlocked) {
				console.warn(`[BLOCK] Message stopped from ${message.author.username} (ID: ${message.author.id}) in server ${message.guild.name} for group ${sourceChannelInfo.group_id}.`);
				return; 
			}

            const groupInfo = db.prepare('SELECT group_name FROM relay_groups WHERE group_id = ?').get(sourceChannelInfo.group_id);
            if (!groupInfo) {
                console.error(`[ERROR] Linked channel exists for deleted group ${sourceChannelInfo.group_id}. Cleanup required.`);
                return;
            }
            
            // --- 6. Rate Limit Logic ---
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
                // Check specific guild subscription just in case
                const subscription = db.prepare('SELECT 1 FROM guild_subscriptions WHERE guild_id = ? AND is_active = 1').get(message.guild.id);
                
                if (!subscription) {
                    if (groupsBeingWarned.has(sourceChannelInfo.group_id)) return; // Race condition lock

                    if (!stats.warning_sent_at) {
                        try {
                            groupsBeingWarned.add(sourceChannelInfo.group_id);
                            console.log(`[RATE LIMIT] Group "${groupInfo.group_name}" exceeded limit. Sending warning.`);
                            
                            const allTargetChannels = db.prepare('SELECT webhook_url FROM linked_channels WHERE group_id = ?').all(sourceChannelInfo.group_id);
                            const warningPayload = createVoteMessage();
                            
                            // Use the Queue to send warnings too, to respect rate limits
                            for (const target of allTargetChannels) {
                                relayQueue.add(target.webhook_url, warningPayload, db, {
                                    targetChannelId: 'WARNING_SYSTEM' // Dummy ID for logs
                                });
                            }
                            db.prepare('UPDATE group_stats SET warning_sent_at = ? WHERE group_id = ? AND day = ?').run(Date.now(), sourceChannelInfo.group_id, rateLimitDayString);
                        } finally {
                            groupsBeingWarned.delete(sourceChannelInfo.group_id);
                        }
                    }
                    return; // Stop relaying
                }
            }

            // --- 7. Prepare Targets ---
            const targetChannels = db.prepare(`SELECT * FROM linked_channels WHERE group_id = ? AND channel_id != ? AND direction IN ('BOTH', 'RECEIVE_ONLY')`).all(sourceChannelInfo.group_id, message.channel.id);
            console.log(`[DEBUG][${executionId}] No valid receiving channels found in group "${groupInfo.group_name}". Nothing to relay.`);
            if (targetChannels.length === 0) return;

            console.log(`[DEBUG][${executionId}] Found ${targetChannels.length} target channel(s) to relay to for group "${groupInfo.group_name}".`);

            // --- 8. Construct Payload Data ---
            const senderName = message.member?.displayName ?? message.author.username;
			const serverBrand = sourceChannelInfo.brand_name || message.guild.name;
			let username = `${senderName} (${serverBrand})`;
			if (username.length > MAX_USERNAME_LENGTH) {
				username = username.substring(0, MAX_USERNAME_LENGTH - 3) + '...';
			}
            const avatarURL = message.author.displayAvatarURL();

            // Prepare variables for the loop
            let isFirstTarget = true; 
            
            // --- 9. Main Relay Loop ---
            for (const target of targetChannels) {
                
                let replyEmbed = null;
                let replyLinkText = '';
                let finalContent = message.content;
                let hasUnmappedRoles = false;
                let safeFiles = [];
                let largeFiles = [];
                let currentFileSize = 0;
                let initialJsonSize = 0;
                
                try {
                    // A. Reply Logic
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

                            // Database lookup for cross-server link
                            const repliedToId = repliedMessage.id;
                            const parentInfo = db.prepare('SELECT original_message_id FROM relayed_messages WHERE relayed_message_id = ?').get(repliedToId);
                            const rootOriginalId = parentInfo ? parentInfo.original_message_id : repliedToId;

                            const relayedReplyInfo = db.prepare('SELECT relayed_message_id FROM relayed_messages WHERE original_message_id = ? AND relayed_channel_id = ?').get(rootOriginalId, target.channel_id);

                            let messageLink = null;
                            if (relayedReplyInfo && relayedReplyInfo.relayed_message_id) {
                                messageLink = `https://discord.com/channels/${target.guild_id}/${target.channel_id}/${relayedReplyInfo.relayed_message_id}`;
                            } else {
                                // Fallback link to source
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
                            } else if (messageLink) {
                                replyLinkText = `<@${repliedMessage.author.id}> [ Replying to ${repliedAuthorName} ](${messageLink}) `;
                            }
                        }
                    }

                    // B. Role Logic
                    const roleMentions = finalContent.match(/<@&(\d+)>/g);
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
                                finalContent = finalContent.replace(mention, `<@&${targetRole.role_id}>`);
                            } 
                            else if (allowAutoRole) {
                                try {
                                    const newRole = await targetGuild.roles.create({
                                        name: roleMap.role_name,
                                        mentionable: false, 
                                        reason: `Auto-creating for RelayBot: ${roleMap.role_name}`
                                    });
                                    db.prepare('INSERT INTO role_mappings (group_id, guild_id, role_name, role_id) VALUES (?, ?, ?, ?)').run(target.group_id, target.guild_id, roleMap.role_name, newRole.id);
                                    finalContent = finalContent.replace(mention, `<@&${newRole.id}>`);
                                } catch (e) { hasUnmappedRoles = true; }
                            } 
                            else {
                                hasUnmappedRoles = true;
                            }
                        }
                    }
                
                    const contentWithoutMentions = finalContent.replace(/<@!?&?#?(\d+)>/g, '').trim();
                    if (contentWithoutMentions.length === 0 && hasUnmappedRoles) {
                        finalContent = `*(Unmapped role in original message. Admin can map it or enable auto-sync.)*`;
                    }

                    // C. Content Prep & Truncation
                    let finalPayloadContent = replyLinkText + finalContent;
                    
                    // D. Payload Construction (For Size Check)
                    const basePayloadForSizeCalc = {
                        content: finalPayloadContent,
                        username: username,
                        avatarURL: avatarURL,
                        embeds: [],
                        allowedMentions: { parse: ['roles'], repliedUser: false }
                    };
                    if (replyEmbed) basePayloadForSizeCalc.embeds.push(replyEmbed);
                    basePayloadForSizeCalc.embeds.push(...message.embeds);
                    
                    const sticker = message.stickers.first();
                    const stickerId = sticker?.id;
                    // We store name and URL to pass to the queue for fallbacks
                    const stickerData = sticker ? { name: sticker.name, url: sticker.url } : null;
                    if (stickerId) basePayloadForSizeCalc.sticker_ids = [stickerId];

                    initialJsonSize = Buffer.byteLength(JSON.stringify(basePayloadForSizeCalc));
                    
                    // E. Attachment Selection
                    const sortedAttachments = Array.from(message.attachments.values()).sort((a, b) => a.size - b.size);
                    
                    for (const att of sortedAttachments) {
                        if (initialJsonSize + currentFileSize + att.size <= MAX_PAYLOAD_SIZE) {
                            let attachmentName = att.name;
                            if (att.spoiler && !attachmentName.startsWith('SPOILER_')) {
                                attachmentName = `SPOILER_${att.name}`;
                            }

                            safeFiles.push({
                                attachment: att.url,
                                name: attachmentName
                            });
                            currentFileSize += att.size;
                        } else {
                            largeFiles.push({ name: att.name, size: att.size });
                        }
                    }
                    // Handle Snapshot Attachments (Forwarded messages)
                    if (message.messageSnapshots && message.messageSnapshots.size > 0) {
                        const snapshot = message.messageSnapshots.first();
                         if (snapshot && snapshot.attachments) {
                            snapshot.attachments.forEach(att => {
                                if (initialJsonSize + currentFileSize + att.size <= MAX_PAYLOAD_SIZE) {
                                    safeFiles.push(att.url);
                                    currentFileSize += att.size;
                                }
                            });
                         }
                    }

                    if (largeFiles.length > 0) {
                        finalPayloadContent += `\n*(Note: ${largeFiles.length} file(s) too large: ${largeFiles.map(f => f.name).join(', ')})*`;
                    }

                    // Forwarded Text Logic
                    if (message.messageSnapshots && message.messageSnapshots.size > 0) {
                        const snapshot = message.messageSnapshots.first();
                        if (snapshot && snapshot.content) {
                            finalPayloadContent += `\n> *Forwarded:*\n${snapshot.content}`;
                        }
                    }

                    if (message.poll) {
                        const pollEmbed = new EmbedBuilder()
                            .setColor('#5865F2')
                            .setAuthor({ name: '📊 Poll', iconURL: 'https://cdn.discordapp.com/emojis/123456789.png' }) // Optional icon
                            .setTitle(message.poll.question.text.substring(0, 256));
                        
                        let description = '';
                        message.poll.answers.forEach((answer, index) => {
                            // Get emoji if it exists, otherwise use number
                            const prefix = answer.emoji ? (answer.emoji.id ? `<:${answer.emoji.name}:${answer.emoji.id}>` : answer.emoji.name) : `${index + 1}.`;
                            description += `${prefix} **${answer.text}**\n`;
                        });
                        
                        pollEmbed.setDescription(description.substring(0, 4096));
                        payloadEmbeds.push(pollEmbed);
                    }

                    if (message.flags.has(MessageFlags.IsVoiceMessage)) {
                        finalPayloadContent += `\n🎤 **[Voice Message]**\n`
                    }

                    if (finalPayloadContent.length > DISCORD_MESSAGE_LIMIT) {
                        finalPayloadContent = finalPayloadContent.substring(0, DISCORD_MESSAGE_LIMIT - 50) + "...(truncated)";
                    }

                    const payloadEmbeds = [];
                    if (replyEmbed) payloadEmbeds.push(replyEmbed);
                    payloadEmbeds.push(...message.embeds);
                    // Forwarded Embeds
                    if (message.messageSnapshots && message.messageSnapshots.size > 0) {
                        const snapshot = message.messageSnapshots.first();
                        if (snapshot && snapshot.embeds) payloadEmbeds.push(...snapshot.embeds);
                    }

                    // F. Final Object Construction
                    const finalPayloadForSend = {
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

                    // --- G. SEND VIA QUEUE (The Fix) ---
                    const meta = {
                        originalMsgId: message.id,
                        originalChannelId: message.channel.id,
                        repliedToId: message.reference ? message.reference.messageId : null,
                        targetChannelId: target.channel_id,
                        executionId: executionId
                        stickerData: stickerData
                    };

                    // [CRITICAL] Do not await this. Push to queue and move on.
                    relayQueue.add(target.webhook_url, finalPayloadForSend, db, meta);

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