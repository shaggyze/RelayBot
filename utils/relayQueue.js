// utils/relayQueue.js
const { WebhookClient } = require('discord.js');
const webhookManager = require('./webhookManager.js');

class RelayQueue {
    constructor() {
        this.queue = [];
        this.processing = false;
        // 600ms delay between webhooks is safe. Discord allows ~50/sec globally, 
        // but 1-2/sec per channel. 600ms buffers you against the Global Rate Limit.
        this.rateLimitDelay = 600; 
    }

    /**
     * Add a message to the relay queue
     * @param {string} webhookUrl - The destination webhook URL
     * @param {object} payload - The message payload (content, files, embeds)
     * @param {object} db - Database reference
     * @param {object} meta - Metadata (original ID, channel IDs for DB insert)
     */
    add(webhookUrl, payload, db, meta, client) {
        this.queue.push({ webhookUrl, payload, db, meta, client, attempt: 1 });
        this.process();
    }
        // Optional: Log when it enters the queue
        // console.log(`[QUEUE-ADD][${meta.executionId}] Queued message for target ${meta.targetChannelId}`);

    async process() {
        if (this.processing) return;
        this.processing = true;

        while (this.queue.length > 0) {
            const item = this.queue.shift();
            
            try {
                await this.sendItem(item);
            } catch (error) {
                console.error(`[QUEUE] Critical error processing item: ${error.message}`);
            }
            
            // [SMART SLOW MODE]
            // Wait before processing the next item to prevent hitting the 
            // Global Rate Limit (Cloudflare Ban).
            await new Promise(resolve => setTimeout(resolve, this.rateLimitDelay));
        }

        this.processing = false;
    }

    async sendItem(item) {
        const { webhookUrl, payload, db, meta, attempt, client } = item;
		console.log(`[QUEUE-SEND][${meta.executionId}] Attempting to relay message ${meta.originalMsgId} to target channel #${meta.targetChannelId}`);
        try {
            const webhookClient = new WebhookClient({ url: webhookUrl });
            const relayedMessage = await webhookClient.send(payload);

            // [DB OPTIMIZATION] Perform the Insert here, after success.
            // This moves write operations out of the main event loop.
            if (relayedMessage) {
                const repliedToOriginalId = meta.repliedToId || null;
                
                try {
                    db.prepare(
                        'INSERT INTO relayed_messages (original_message_id, original_channel_id, relayed_message_id, relayed_channel_id, replied_to_id) VALUES (?, ?, ?, ?, ?)'
                    ).run(
                        meta.originalMsgId,
                        meta.originalChannelId,
                        relayedMessage.id,
                        relayedMessage.channel_id,
                        repliedToOriginalId
					);
                    console.log(`[QUEUE-SUCCESS][${meta.executionId}] Sent to ${meta.targetChannelId}`);
                } catch (dbError) {
                    console.error(`[QUEUE-DB-ERR][${meta.executionId}] Failed to save record: ${dbError.message}`);
                }
            }

        } catch (error) {
            // ... (Error handling logic) ...
            if (error.code === 429) {
                console.warn(`[QUEUE-429][${meta.executionId}] Rate Limit hit for ${meta.targetChannelId}. Backing off.`);
                this.queue.unshift(item); 
                await new Promise(resolve => setTimeout(resolve, 5000));
            else if (error.code === 10015) {
                // [THE FIX] Use the Manager
                const newClient = await webhookManager.handleInvalidWebhook(client, meta.targetChannelId, 'RelayQueue');
                if (newClient) {
                    // Update item with new URL and retry immediately (put at front)
                    item.webhookUrl = newClient.url;
                    this.queue.unshift(item);
                }
                // If null, it was deleted/cleaned up automatically by the manager.
            } 
			} else if (error.code === 50006 && payload.sticker_ids) {
                 console.log(`[QUEUE-RETRY][${meta.executionId}] Sticker relay failed. Retrying with link fallback.`);
                 
                 // Remove the thing that caused the error
                 delete payload.sticker_ids;
                 
                 // [THE FIX] improved fallback text
                 let fallbackText = "";
                 
                 if (meta.stickerData) {
                     if (meta.stickerData.url) {
                         // Option 1: Clickable link (often renders a preview image!)
                         fallbackText = `\n[Sticker: ${meta.stickerData.name}](${meta.stickerData.url})`;
                     } else {
                         // Option 2: Just the name if URL is somehow missing
                         fallbackText = `\n*(sent sticker: ${meta.stickerData.name})*`;
                     }
                 } else {
                     fallbackText = `\n*(sent a sticker)*`;
                 }

                 // Append to content
                 payload.content = (payload.content || "") + fallbackText;
                 
                 // Content length safety check
                 if (payload.content.length > 2000) {
                     payload.content = payload.content.substring(0, 1997) + "...";
                 }
                 
                 this.queue.unshift(item); // Retry immediately
            } else if (error.code === 50006) {
                // [THE FIX] Log specific details about the empty payload
                console.error(`[QUEUE-FAIL][${meta.executionId}] Empty Message Error (50006). Debugging Payload:`);
                console.error(`- Content Length: ${payload.content ? payload.content.length : 0}`);
                console.error(`- Files: ${payload.files ? payload.files.length : 0}`);
                console.error(`- Embeds: ${payload.embeds ? payload.embeds.length : 0}`);
                console.error(`- Stickers: ${payload.sticker_ids ? payload.sticker_ids.length : 0}`);
                
                // If it was a sticker fail, we already handle that.
                // If it wasn't a sticker, it's likely a stripped attachment (Voice Msg).
                if (!payload.sticker_ids) {
                     // Optional: Add a fallback so it retries successfully?
                     payload.content = "*[Error: Content was empty (likely a large file that was removed)]*";
                     this.queue.unshift(item);
                }
            } else {
                console.error(`[QUEUE-FAIL][${meta.executionId}] Failed to send to ${meta.targetChannelId}: ${error.message}`);
                if ((error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT') && attempt < 3) {
                    console.log(`[QUEUE-RETRY][${meta.executionId}] Network error. Attempt ${attempt + 1}/3.`);
                    item.attempt++;
                    this.queue.push(item);
                }
            }
        }
    }
}

module.exports = new RelayQueue();