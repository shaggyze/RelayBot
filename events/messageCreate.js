// events/messageCreate.js
const { Events, WebhookClient, Collection, PermissionFlagsBits, EmbedBuilder, blockQuote, quote } = require('discord.js');
const db = require('../db/database.js');
const crypto = require('crypto');
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
		const executionId = crypto.randomBytes(4).toString('hex');
        let shouldLogVerbose = false; // Flag to control extensive logging for problematic payloads

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
            console.log(`[EVENT][${executionId}] Message received from ${message.author.tag} in linked channel #${message.channel.name}`);
            const targetChannels = db.prepare(`SELECT * FROM linked_channels WHERE group_id = ? AND channel_id != ? AND direction IN ('BOTH', 'RECEIVE_ONLY')`).all(sourceChannelInfo.group_id, message.channel.id);
            if (targetChannels.length === 0) {
                console.log(`[DEBUG][${executionId}] No valid receiving channels found. Nothing to relay.`);
                return;
			}

            console.log(`[DEBUG][${executionId}] Found ${targetChannels.length} target channel(s) to relay to for group "${groupInfo.group_name}".`);
        
            const senderName = message.member?.displayName ?? message.author.username;
            let username = `${senderName} (${message.guild.name})`;
            if (username.length > MAX_USERNAME_LENGTH) {
                username = username.substring(0, MAX_USERNAME_LENGTH - 3) + '...';
            }
            
            const avatarURL = message.author.displayAvatarURL();
            
        let isFirstTarget = true;

        for (const target of targetChannels) {
            try {
                const targetChannelName = message.client.channels.cache.get(target.channel_id)?.name ?? target.channel_id;
                console.log(`[RELAY] Attempting to relay message ${message.id} to channel #${targetChannelName}`);
                
                let replyEmbed = null;
                
                // [THE FIX] This entire block now only runs for the FIRST target channel.
                if (isFirstTarget && message.reference && message.reference.messageId) {
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
                        if (repliedMessage.editedTimestamp) {
                            repliedContent += ' *(edited)*';
                        }

                        // --- Two-Step Database Lookup to find the root original message ID ---
                        // This logic is kept to ensure the first link is as accurate as possible.
                        let rootOriginalId;
                        const repliedToId = repliedMessage.id;
                        const parentInfo = db.prepare('SELECT original_message_id FROM relayed_messages WHERE relayed_message_id = ?').get(repliedToId);
                        if (parentInfo) {
                            rootOriginalId = parentInfo.original_message_id;
                        } else {
                            rootOriginalId = repliedToId;
                        }

                        // --- Find the corresponding relayed message for THIS specific target channel ---
                        const relayedReplyInfo = db.prepare('SELECT relayed_message_id FROM relayed_messages WHERE original_message_id = ? AND relayed_channel_id = ?').get(rootOriginalId, target.channel_id);

                        let messageLink = null;
                        if (relayedReplyInfo && relayedReplyInfo.relayed_message_id) {
                            messageLink = `https://discord.com/channels/${target.guild_id}/${target.channel_id}/${relayedReplyInfo.relayed_message_id}`;
                        } else {
                            // Fallback link to the root original message
                            const originalMessageInfo = db.prepare('SELECT original_channel_id FROM relayed_messages WHERE original_message_id = ? LIMIT 1').get(rootOriginalId);
                            if(originalMessageInfo) {
                                const originalGuildId = message.client.channels.cache.get(originalMessageInfo.original_channel_id)?.guild.id;
                                if(originalGuildId) {
                                    messageLink = `https://discord.com/channels/${originalGuildId}/${originalMessageInfo.original_channel_id}/${rootOriginalId}`;
                                }
                            }
                        }
                        
                        // Create the author embed, which will only happen once.
                        replyEmbed = new EmbedBuilder()
                            .setColor('#B0B8C6')
                            .setAuthor({ name: `Replying to ${repliedAuthorName}`, url: messageLink, iconURL: repliedAuthorAvatar })
                            .setDescription(repliedContent);
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
                
                    let initialMessageContent = targetContent; // Content *before* potential file notice
                    if (initialMessageContent.length > DISCORD_MESSAGE_LIMIT) {
                        const truncationNotice = `\n*(Message was truncated...)*`;
                        initialMessageContent = initialMessageContent.substring(0, DISCORD_MESSAGE_LIMIT - truncationNotice.length) + truncationNotice;
                    }
                    
                    const basePayloadForSizeCalc = {
                        content: initialMessageContent, // Use content BEFORE fileNotice for initial calculation
                        username: username,
                        avatarURL: avatarURL,
                        embeds: message.embeds, // Include embeds for accurate JSON size
                        allowedMentions: { parse: ['roles'], repliedUser: false }
                    };
                    if (replyEmbed) {
                        basePayloadForSizeCalc.embeds.push(replyEmbed);
                    }

                    let stickerId = null;
                    if (message.stickers.size > 0) {
                        const sticker = message.stickers.first();
                        if (sticker && sticker.id) {
                            stickerId = sticker.id;
                        }
                    }
                    if (stickerId) {
                         basePayloadForSizeCalc.sticker_ids = [stickerId];
                    }

                    const initialJsonSize = Buffer.byteLength(JSON.stringify(basePayloadForSizeCalc));
                    
                    let currentFileSize = 0;
                    const safeFiles = [];
                    const largeFiles = []; 
                    const sortedAttachments = Array.from(message.attachments.values()).sort((a, b) => a.size - b.size);

                    // --- Assemble parts for potential verbose logging ---
                    const logVerbosePayloadInfo = () => { // Define this helper within execute to access outer scope variables cleanly
                        console.error(`--- PAYLOAD DEBUG START (Message ID: ${message.id}, Triggered by Skip/Error) ---`);
                        console.error(`[DEBUG] Target Channel: #${targetChannelName}`);
                        console.error(`[DEBUG] Original Message Content Length: ${message.content ? message.content.length : 0}`); 
                        console.error(`[DEBUG] Attachments: ${messageAttachments.size}`); // `messageAttachments` is not in scope here, need `message.attachments`
                        console.error(`[DEBUG] Embeds: ${messageEmbeds.length}`); // `messageEmbeds` not in scope
                        console.error(`[DEBUG] Stickers: ${messageStickers.size} (ID: ${stickerId || 'None'})`); // `messageStickers` not in scope
                        console.error(`[DEBUG] Initial JSON Size (before file notice, includes embeds, metadata): ${initialJsonSize} bytes`);
                        
                        console.error(`[DEBUG] Processing Attachments (Total: ${sortedAttachments.length}):`); // sortedAttachments needs to be in scope
                        sortedAttachments.forEach((att, index) => { // sortedAttachments needs to be in scope
                            console.error(`  - Attachment ${index+1}: ${att.name} | Size: ${att.size} bytes`);
                            // File selection logic within here is part of log setup.
                            // No need to re-select. Use the already populated safeFiles/largeFiles from the loop below.
                        });
                        console.error(`[DEBUG] Files selected for upload (${safeFiles.length}):`);
                        safeFiles.forEach(url => console.error(`  - ${url.substring(url.lastIndexOf('/') + 1)}`));
                        console.error(`[DEBUG] Files skipped due to size (${largeFiles.length}):`);
                        largeFiles.forEach(f => console.error(`  - ${f.name} (Size: ${f.size} bytes)`));
                        console.error(`[DEBUG] Total size of selected files: ${currentFileSize} bytes`);

                        let actualFileNoticeString = "";
                        if (largeFiles.length > 0) {
                            actualFileNoticeString = `\n*(Note: ${largeFiles.length} file(s) were too large or exceeded the total upload limit and were not relayed: ${largeFiles.map(f => f.name).join(', ')})`;
                            console.error(`[DEBUG] File Notice String Size: ${Buffer.byteLength(actualFileNoticeString, 'utf8')} bytes`);
                        } else {
                            console.error(`[DEBUG] No file notice needed.`);
                        }
                        
                        let actualFinalPayloadContent = initialMessageContent + actualFileNoticeString;
                        if (actualFinalPayloadContent.length > DISCORD_MESSAGE_LIMIT) {
                            const truncationNotice = `\n*(Message was truncated...)*`;
                            actualFinalPayloadContent = actualFinalPayloadContent.substring(0, DISCORD_MESSAGE_LIMIT - truncationNotice.length) + truncationNotice;
                        }
                        const actualFinalContentSize = Buffer.byteLength(actualFinalPayloadContent, 'utf8');
                        console.error(`[DEBUG] Final Content Size (after file notice & possible truncation): ${actualFinalContentSize} bytes`);

                        const finalPayloadForLog = {
                            content: actualFinalPayloadContent,
                            files: safeFiles,
                            embeds: basePayloadForSizeCalc.embeds, 
                            username: username,
                            avatarURL: avatarURL,
                            allowedMentions: basePayloadForSizeCalc.allowedMentions,
                            sticker_ids: stickerId ? [stickerId] : undefined
                        };

                        const actualFinalJsonSize = Buffer.byteLength(JSON.stringify(finalPayloadForLog));
                        console.error(`[DEBUG] Final JSON payload size (with final content, embeds, sticker_ids): ${actualFinalJsonSize} bytes`);
                        
                        const actualTotalEstimatedDataSize = actualFinalJsonSize + currentFileSize; 
                        console.error(`[DEBUG] ESTIMATED TOTAL DATA SIZE (Final JSON + Safe File Data): ${actualTotalEstimatedDataSize} bytes`);
                        console.error(`[DEBUG] Discord Limit: ~10MB (${10 * 1024 * 1024} bytes)`);
                        console.error(`[DEBUG] Internal MAX_PAYLOAD_SIZE used for file selection: ${MAX_PAYLOAD_SIZE} bytes`);
                        
                        const finalContentTrimmedForLog = finalPayloadForLog.content?.trim() || "";
                        const isContentEmptyForLog = !finalContentTrimmedForLog;
                        const areFilesEmptyForLog = !finalPayloadForLog.files || finalPayloadForLog.files.length === 0;
                        const areEmbedsEmptyForLog = !finalPayloadForLog.embeds || finalPayloadForLog.embeds.length === 0;
                        const haveStickerIdsForLog = finalPayloadForLog.sticker_ids && finalPayloadForLog.sticker_ids.length > 0;

                        console.error(`[EXACT_CHECK_STATE] finalPayload.content.trim(): "${finalContentTrimmedForLog}" (isEmpty: ${isContentEmptyForLog})`);
                        console.error(`[EXACT_CHECK_STATE] finalPayload.files.length: ${finalPayloadForLog.files?.length}`);
                        console.error(`[EXACT_CHECK_STATE] finalPayload.embeds.length: ${finalPayloadForLog.embeds?.length}`);
                        console.error(`[EXACT_CHECK_STATE] finalPayload.sticker_ids present: ${haveStickerIdsForLog}`);
                        console.error(`--- PAYLOAD DEBUG END ---`);
                    };

                    // --- Process attachments and determine safeFiles/largeFiles ---
                    for (const att of sortedAttachments) {
                        // The core file selection check against MAX_PAYLOAD_SIZE
                        if (initialJsonSize + currentFileSize + att.size <= MAX_PAYLOAD_SIZE) {
                            safeFiles.push(att.url);
                            currentFileSize += att.size;
                        } else {
                            largeFiles.push({ name: att.name, size: att.size });
                        }
                    }
                    
                    // Prepare the final content string by adding the file notice if any files were skipped.
                    let finalPayloadContent = initialMessageContent;
                    let fileNoticeStringForPayload = ""; // This specific string is only for the payload's content
                    if (largeFiles.length > 0) {
                        fileNoticeStringForPayload = `\n*(Note: ${largeFiles.length} file(s) were too large or exceeded the total upload limit and were not relayed: ${largeFiles.map(f => f.name).join(', ')})`;
                    }
                    finalPayloadContent += fileNoticeStringForPayload;

                    // Truncate the final content if it exceeds Discord's message limit AFTER adding the file notice.
                    if (finalPayloadContent.length > DISCORD_MESSAGE_LIMIT) {
                        const truncationNotice = `\n*(Message was truncated...)*`;
                        finalPayloadContent = finalPayloadContent.substring(0, DISCORD_MESSAGE_LIMIT - truncationNotice.length) + truncationNotice;
                    }
                    
                    // --- Construct the final payload object used for checking and sending ---
                    const finalPayload = {
                        content: finalPayloadContent,
                        files: safeFiles,
                        embeds: basePayloadForSizeCalc.embeds, 
                        username: username,
                        avatarURL: avatarURL,
                        allowedMentions: basePayloadForSizeCalc.allowedMentions,
                        sticker_ids: stickerId ? [stickerId] : undefined
                    };
                    
                    // --- Evaluate the condition and set the flag if it triggers ---
                    const logFinalContentTrimmed = finalPayload.content?.trim() || "";
                    const isContentEmpty = !logFinalContentTrimmed;
                    const areFilesEmpty = !finalPayload.files || finalPayload.files.length === 0;
                    const areEmbedsEmpty = !finalPayload.embeds || finalPayload.embeds.length === 0;
                    const haveStickerIds = finalPayload.sticker_ids && finalPayload.sticker_ids.length > 0;

                    if (isContentEmpty && areFilesEmpty && areEmbedsEmpty && !haveStickerIds) {
                         shouldLogVerbose = true; // Trigger verbose logging if payload is determined to be empty
                         console.log(`[DEBUG][${executionId}] Payload determined to be empty. Skipping send.`);
                    }
                    
                    // --- Conditional Verbose Logging Execution ---
                    // This block executes ONLY IF shouldLogVerbose is true.
                    if (shouldLogVerbose) {
                        // Call the helper to print all detailed logs using context from THIS iteration.
                        logVerbosePayloadInfo(
                            message.id, targetChannelName, initialMessageContent, message.attachments, message.embeds, message.stickers,
                            initialJsonSize, currentFileSize, safeFiles, largeFiles, fileNoticeStringForPayload, finalPayloadContent,
                            actualFinalContentSize, Buffer.byteLength(JSON.stringify({ ...finalPayload, content: finalPayloadContent })), currentFileSize, // Pass finalPayloadForLog elements directly or reconstruct
                            MAX_PAYLOAD_SIZE, targetChannelName, username, avatarURL, basePayloadForSizeCalc.allowedMentions, stickerId
                        );
                        // The `logVerbosePayloadInfo` helper would need all these context variables.
                        // For clarity in this direct paste, I'll repeat the core logging logic here
                        // to avoid passing too many arguments or issues with scoping for `message`.

                        console.error(`--- PAYLOAD DEBUG START (Message ID: ${message.id}, Triggered by Skip/Error) ---`);
                        console.error(`[DEBUG] Target Channel: #${targetChannelName}`);
                        console.error(`[DEBUG] Initial JSON Size (before file notice, includes embeds, metadata): ${initialJsonSize} bytes`);
                        console.error(`[DEBUG] Files selected for upload (${safeFiles.length}):`);
                        safeFiles.forEach(url => console.error(`  - ${url.substring(url.lastIndexOf('/') + 1)}`));
                        console.error(`[DEBUG] Files skipped due to size (${largeFiles.length}):`);
                        largeFiles.forEach(f => console.error(`  - ${f.name} (Size: ${f.size} bytes)`));
                        console.error(`[DEBUG] Total size of selected files: ${currentFileSize} bytes`);

                        console.error(`[DEBUG] File Notice String Size: ${Buffer.byteLength(fileNoticeStringForPayload, 'utf8')} bytes`);
                        
                        const finalContentSize_log = Buffer.byteLength(finalPayloadContent, 'utf8');
                        console.error(`[DEBUG] Final Content Size (after file notice & possible truncation): ${finalContentSize_log} bytes`);

                        const finalPayloadForLog = {
                            content: finalPayloadContent,
                            files: safeFiles,
                            embeds: basePayloadForSizeCalc.embeds, 
                            username: username,
                            avatarURL: avatarURL,
                            allowedMentions: basePayloadForSizeCalc.allowedMentions,
                            sticker_ids: stickerId ? [stickerId] : undefined
                        };

                        const actualFinalJsonSize = Buffer.byteLength(JSON.stringify(finalPayloadForLog));
                        console.error(`[DEBUG] Final JSON payload size (with final content, embeds, sticker_ids): ${actualFinalJsonSize} bytes`);
                        
                        const actualTotalEstimatedDataSize = actualFinalJsonSize + currentFileSize; 
                        console.error(`[DEBUG] ESTIMATED TOTAL DATA SIZE (Final JSON + Safe File Data): ${totalEstimatedDataSize} bytes`);
                        console.error(`[DEBUG] Discord Limit: ~10MB (${10 * 1024 * 1024} bytes)`);
                        console.error(`[DEBUG] Internal MAX_PAYLOAD_SIZE used for file selection: ${MAX_PAYLOAD_SIZE} bytes`);
                        
                        console.error(`[EXACT_CHECK_STATE] finalPayload.content.trim(): "${finalPayload.content?.trim()}" (isEmpty: ${isContentEmpty})`);
                        console.error(`[EXACT_CHECK_STATE] finalPayload.files.length: ${finalPayload.files?.length}`);
                        console.error(`[EXACT_CHECK_STATE] finalPayload.embeds.length: ${finalPayload.embeds?.length}`);
                        console.error(`[EXACT_CHECK_STATE] finalPayload.sticker_ids present: ${haveStickerIds}`);
                        console.error(`--- PAYLOAD DEBUG END ---`);
                    }

                    // --- Attempt to send the payload ---
                    let relayedMessage = null;
                    const webhookClient = new WebhookClient({ url: target.webhook_url });
                    
                    try {
                         relayedMessage = await webhookClient.send(finalPayload);
                    } catch (sendError) {
                        if (sendError.code === 40005) { // Request entity too large
                            shouldLogVerbose = true; // Flag for verbose logging due to this specific error
                            console.error(`[ERROR 40005] Caught Request entity too large for message ${message.id} to #${targetChannelName}. Re-throwing to ensure verbose logs are triggered.`);
                            throw sendError; // Re-throw to be caught by the outer catch, ensuring verbose logs if needed
                        } else if (sendError.code === 50006 && finalPayload.sticker_ids) { // Sticker fallback
                            console.log(`[RELAY] Sticker relay failed for message ${message.id}. Retrying with text fallback.`);
                            try {
                                // Access sticker info from the original message context
                                const sticker = message.stickers.first(); 
                                if (sticker && sticker.name) {
                                    const fallbackPayload = { ...finalPayload };
                                    delete fallbackPayload.sticker_ids; // Remove sticker_ids from payload
                                    // Append sticker name to content and re-truncate if necessary
                                    fallbackPayload.content += `\n*(sent sticker: ${sticker.name})*`;
                                    if (fallbackPayload.content.length > DISCORD_MESSAGE_LIMIT) {
                                        const truncationNotice = `\n*(Message was truncated...)*`;
                                        fallbackPayload.content = fallbackPayload.content.substring(0, DISCORD_MESSAGE_LIMIT - truncationNotice.length) + truncationNotice;
                                    }
                                    relayedMessage = await webhookClient.send(fallbackPayload);
                                }
                            } catch (fallbackError) {
                                console.error(`[RELAY] FAILED on fallback attempt for message ${message.id}:`, fallbackError);
                                if (fallbackError.code === 40005) { // If fallback also fails with 40005
                                    shouldLogVerbose = true; 
                                    console.error(`[ERROR 40005 AFTER FALLBACK] Caught Request entity too large for message ${message.id} to #${targetChannelName} after fallback. Re-throwing.`);
                                    throw fallbackError;
                                }
                            }
                        } else {
                            throw sendError; // Re-throw other errors
                        }
                    }
                    
                    // --- Database insertion and any subsequent actions ---
                    // No separate `webhookClient.send` for large files needed here anymore.

                    if (relayedMessage) {
                        db.prepare('INSERT INTO relayed_messages (original_message_id, original_channel_id, relayed_message_id, relayed_channel_id, webhook_url, replied_to_id) VALUES (?, ?, ?, ?, ?, ?)')
                          .run(message.id, message.channel.id, relayedMessage.id, relayedMessage.channel_id, target.webhook_url, message.reference?.messageId ?? null);
                    }
                } catch (error) {
                    // Catch any error from the try block associated with this target channel processing
                    if (error.code === 40005) { 
                        // If a 40005 error occurs and wasn't re-thrown and caught higher up to set the flag
                        shouldLogVerbose = true; 
                    } 
                    
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
            // This catches fatal errors not specific to a target channel's send attempt
            if (error.code === 40005) { // If a fatal 40005 occurred
                 shouldLogVerbose = true; 
            }
            console.error(`[ERROR] Code:`, error.code);
            console.error(`[FATAL-ERROR][${executionId}] A critical unhandled error occurred in messageCreate for message ${message.id}.`, error);
        }
    },
};