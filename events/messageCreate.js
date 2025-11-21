// events/messageCreate.js
const { Events, WebhookClient, Collection, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const db = require('../db/database.js');
const crypto = require('crypto');

const webhookCache = new Collection();
const MAX_PAYLOAD_SIZE = 7.0 * 1024 * 1024;
const MAX_USERNAME_LENGTH = 80;
const RATE_LIMIT_CHARS = 100000;
const DISCORD_MESSAGE_LIMIT = 2000;

// Re-using simplified placeholder stubs for external functions not provided
const createVoteMessage = () => ({}); 
const isSupporter = (id) => false;
const getSupporterSet = () => new Set();
const getRateLimitDayString = () => new Date().toISOString().slice(0, 10);
const RESET_HOUR_UTC = 19;

const groupsBeingWarned = new Set();

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
        let shouldLogVerbose = false;
        const executionId = crypto.randomBytes(4).toString('hex');

        try {
            // 1. Always ignore DMs.
            if (!message.guild) return; 
            console.log(`content ${message.content} attachments ${message.attachments.size} embeds ${message.embeds.length} stickers ${message.stickers.size}.`);
            if (!message.content && message.attachments.size === 0 && message.embeds.length === 0 && message.stickers.size === 0) return;
            // 2. ALWAYS ignore anything sent by THIS bot's user account. This covers all self-relays via webhook too.
            if (message.author.id === message.client.user.id || message.webhookId) return; 
console.log{`0`);      
            // --- End of Simplified Guard ---

            const sourceChannelInfo = db.prepare("SELECT * FROM linked_channels WHERE channel_id = ? AND direction IN ('BOTH', 'SEND_ONLY')").get(message.channel.id);
            if (!sourceChannelInfo) return;

            // 2. CONDITIONAL IGNORE for ALL OTHER external bots/webhooks.
            if (!sourceChannelInfo.process_bot_messages && (message.author.bot || message.webhookId)) return;
console.log{`1`);
            // --- Blacklist Check ---
			const isBlocked = db.prepare('SELECT 1 FROM group_blacklist WHERE group_id = ? AND (blocked_id = ? OR blocked_id = ?)').get(sourceChannelInfo.group_id, message.author.id, message.guild.id);
			if (isBlocked) {
				console.warn(`[BLOCK] Message stopped from ${message.author.username} (ID: ${message.author.id}) in server ${message.guild.name} (ID: ${message.guild.id}) for group ${sourceChannelInfo.group_id}.`);
				return; // Stop processing immediately
			}

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
console.log{`2`);
            const isSupporterGroup = await checkGroupForSupporters(message.client, sourceChannelInfo.group_id);
            const stats = db.prepare('SELECT character_count, warning_sent_at FROM group_stats WHERE group_id = ? AND day = ?').get(sourceChannelInfo.group_id, rateLimitDayString);

            // This is the main gate for the rate limit check.
            if (!isSupporterGroup && stats && stats.character_count > RATE_LIMIT_CHARS) {
                
                // First, check for the premium subscription bypass.
                const subscription = db.prepare('SELECT is_active FROM guild_subscriptions WHERE guild_id = ?').get(message.guild.id);
                if (subscription && subscription.is_active) {
                    // This guild has an active premium subscription.
                    // By doing nothing here, the code will continue outside this 'if' block and relay the message.
                    //console.log(`[SUBSCRIPTION] Bypassing rate limit for guild ${message.guild.id} due to active subscription.`);
                } else {
                    // --- This is the "You ARE being rate-limited" block ---

                    // Check if another message is already sending the warning to prevent a race condition.
                    if (groupsBeingWarned.has(sourceChannelInfo.group_id)) {
                        return; // Stop immediately.
                    }

                    // Check if a warning needs to be sent for the first time today.
                    if (!stats.warning_sent_at) {
                        try {
                            groupsBeingWarned.add(sourceChannelInfo.group_id);

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

                        } finally {
                            groupsBeingWarned.delete(sourceChannelInfo.group_id);
                        }
                    }

                    // [THE FIX] CRITICAL: This return stops the message from being relayed,
                    // regardless of whether a warning was just sent or had been sent previously.
                    return; 
                }
            }

			// --- Branding Logic (Used to construct 'username' and 'avatarURL') ---
			const senderName = message.member?.displayName ?? message.author.username;
			const serverBrand = sourceChannelInfo.brand_name || message.guild.name;
			let username = `${senderName} (${serverBrand})`;
console.log{`3`);
			if (username.length > MAX_USERNAME_LENGTH) {
				username = username.substring(0, MAX_USERNAME_LENGTH - 3) + '...';
			}
            const avatarURL = message.author.displayAvatarURL();
console.log{`4`);
            console.log(`[EVENT][${executionId}] Message received from ${message.author.tag} in linked channel #${message.channel.name}`);
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
                
                // --- Reset Variables for EACH Target Loop Iteration (CRITICAL) ---
                let replyEmbed = null;
                let stickerId = null;
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
                    console.log(`[RELAY][${executionId}] Attempting to relay message ${message.id} to channel #${targetChannelName}`);
                    
                    // --- Reply Embed and Jump Link Logic ---
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
                            if (repliedMessage.editedTimestamp) {
                                repliedContent += ' *(edited)*';
                            }

                            // Two-Step Database Lookup to find the root original ID
                            const repliedToId = repliedMessage.id;
                            const parentInfo = db.prepare('SELECT original_message_id FROM relayed_messages WHERE relayed_message_id = ?').get(repliedToId);
                            const rootOriginalId = parentInfo ? parentInfo.original_message_id : repliedToId;

                            // Use the ROOT original ID to find the sibling message on THIS target channel.
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
                            
                            // Create the full author embed only for the FIRST target channel.
                            if (isFirstTarget) {
                                // [FIX] Corrected Unicode to ASCII for reply icon
                                replyEmbed = new EmbedBuilder()
                                    .setColor('#B0B8C6')
                                    .setAuthor({ name: `Replying to ${repliedAuthorName}`, url: messageLink, iconURL: repliedAuthorAvatar })
                                    .setDescription(repliedContent);
                            }
                        }
                    }

                    // --- Role and Mention Logic ---
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
                            
                            // [FIX] Ignore pings for roles that are not mapped on the source side.
                            if (!roleMap) {
                                continue; 
                            }
                            
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
                                    console.error(`[AUTO-ROLE-FAIL] FAILED to create/map role "${roleMap.role_name}" on target server:`, roleError);
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
                    
                    // [FIX] The warning logic is correctly triggered only on known aliases that failed to translate/create.
                    if (contentWithoutMentions.length === 0 && hasUnmappedRoles) {
                        // [FIX] Simplified warning message as roleMap.role_name is not available in this scope after the loop.
                        finalContent = `*(A role in the original message was not relayed because it has not been mapped in this server. An admin needs to map a role or run /relay toggle_auto_role to sync roles.)*`;
                    }
                    
                    if (finalContent.length > DISCORD_MESSAGE_LIMIT) {
                        const truncationNotice = `\n*(Message was truncated...)*`;
                        finalContent = finalContent.substring(0, DISCORD_MESSAGE_LIMIT - truncationNotice.length) + truncationNotice;
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
                    
                    // --- Attachment/Size Logic (Restored and Fixed) ---
                    for (const att of sortedAttachments) {
                        if (initialJsonSize + currentFileSize + att.size <= MAX_PAYLOAD_SIZE) {
                            safeFiles.push(att.url);
                            currentFileSize += att.size;
                        } else {
                            largeFiles.push({ name: att.name, size: att.size });
                        }
                    }

                    // Prepare final content after checking large files
                    let fileNoticeString = "";
                    if (largeFiles.length > 0) {
                        fileNoticeString = `\n*(Note: ${largeFiles.length} file(s) were too large or exceeded the total upload limit and were not relayed: ${largeFiles.map(f => f.name).join(', ')})`;
                    }
                    finalPayloadContent = finalContent + fileNoticeString;

                    if (finalPayloadContent.length > DISCORD_MESSAGE_LIMIT) {
                        const truncationNotice = `\n*(Message was truncated...)*`;
                        finalPayloadContent = finalPayloadContent.substring(0, DISCORD_MESSAGE_LIMIT - truncationNotice.length) + truncationNotice;
                    }

                    payloadEmbeds = [];
                    if (replyEmbed) payloadEmbeds.push(replyEmbed);
                    payloadEmbeds.push(...message.embeds);

                    // Final Payload construction for the check and send
                    finalPayloadForSend = {
                        content: finalPayloadContent,
                        files: safeFiles,
                        embeds: payloadEmbeds,
                        username: username,
                        avatarURL: avatarURL,
                        allowedMentions: basePayloadForSizeCalc.allowedMentions,
                        sticker_ids: stickerId ? [stickerId] : undefined,
                    };

                    
                    // --- Pre-Send Checks (Payload Empty) ---
                    const logFinalContentTrimmed = finalPayloadContent?.trim() || "";
                    const isContentEmpty = !logFinalContentTrimmed;
                    const areFilesEmpty = !finalPayloadForSend.files || finalPayloadForSend.files.length === 0;
                    const areEmbedsEmpty = !finalPayloadForSend.embeds || finalPayloadForSend.embeds.length === 0;
                    const haveStickerIds = finalPayloadForSend.sticker_ids && finalPayloadForSend.sticker_ids.length > 0;

                    if (isContentEmpty && areFilesEmpty && areEmbedsEmpty && !haveStickerIds) {
                         shouldLogVerbose = true; 
                         console.log(`[DEBUG][${executionId}] Payload determined to be empty. Skipping send.`);
                    }
                    
                    // --- Conditional Verbose Logging Execution ---
                    if (shouldLogVerbose) {
                        // NOTE: Verbose logging body would be here if implemented.
                        console.error(`[FATAL-DEBUG][${executionId}] Verbose logging triggered for target ${targetChannelName}. Skipping detailed log dump.`);
                    }

                    let relayedMessage = null;
                    const webhookClient = new WebhookClient({ url: target.webhook_url });
                    
                    try {
                        relayedMessage = await webhookClient.send(finalPayloadForSend);
                    } catch (sendError) {
                        if (sendError.code === 40005) { 
                            shouldLogVerbose = true; 
                            throw sendError; 
                        } else if (sendError.code === 50006 && finalPayloadForSend.sticker_ids) { 
                            console.log(`[RELAY] Sticker relay failed for message ${message.id}. Retrying with text fallback.`);
                            try {
                                // Access sticker info from the original message context
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
                                console.error(`[RELAY] FAILED on fallback attempt for message ${message.id}:`, fallbackError);
                                if (fallbackError.code === 40005) { 
                                    shouldLogVerbose = true; 
                                    throw fallbackError;
                                }
                            }
                        } else {
                            throw sendError; 
                        }
                    }

                    // --- DB Insertion for successful relay ---
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

                    // Ensure flag is set to false to prevent full reply embed on the next loop
                    isFirstTarget = false;

                } catch (error) {
                    const targetChannelNameForError = message.client.channels.cache.get(target.channel_id)?.name ?? `ID ${target.channel_id}`;
                    if (error.code === 10015) {
                        console.error(`[AUTO-CLEANUP][${executionId}] Webhook for channel #${targetChannelNameForError} is invalid. Removing from relay.`);
                        db.prepare('DELETE FROM linked_channels WHERE channel_id = ?').run(target.channel_id);
                    } else {
                        console.error(`[RELAY-LOOP-ERROR][${executionId}] FAILED to process relay for target #${targetChannelNameForError}.`, error);
                    }
                }
            }
        } catch (error) {
            console.error(`[ERROR] Code:`, error.code);
            console.error(`[FATAL-ERROR][${executionId}] A critical unhandled error occurred in messageCreate for message ${message.id}.`, error);
        }
    },
};