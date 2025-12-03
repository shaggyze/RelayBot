// utils/relayQueue.js
const { WebhookClient } = require('discord.js');

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
    add(webhookUrl, payload, db, meta) {
        this.queue.push({ webhookUrl, payload, db, meta, attempt: 1 });
        this.process();
    }

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
        const { webhookUrl, payload, db, meta, attempt } = item;

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
                } catch (dbError) {
                    console.error(`[QUEUE-DB-ERR] Failed to save record: ${dbError.message}`);
                }
            }

        } catch (error) {
            // [RETRY SYSTEM]
            if (error.code === 429) {
                // We hit a rate limit. Put it back at the FRONT of the queue.
                // Wait longer (5 seconds) to let the bucket cool down.
                console.warn(`[QUEUE-429] Rate Limit hit for ${meta.targetChannelId}. Backing off for 5s.`);
                this.queue.unshift(item); 
                await new Promise(resolve => setTimeout(resolve, 5000));
            } 
            else if (error.code === 10015) {
                // Invalid Webhook - Cleanup immediately
                console.error(`[QUEUE-CLEANUP] Webhook invalid for target ${meta.targetChannelId}. Removing link.`);
                db.prepare('DELETE FROM linked_channels WHERE channel_id = ?').run(meta.targetChannelId);
            } 
            else if (error.code === 50006 && payload.sticker_ids) {
                 // Empty message error due to Sticker. Retry without sticker.
                 // We modify the payload directly and re-queue it.
                 console.log(`[QUEUE-RETRY] Sticker failed. Retrying as text.`);
                 delete payload.sticker_ids;
                 payload.content = (payload.content || "") + "\n*(Sticker was not compatible)*";
                 
                 // Safety check for length
                 if (payload.content.length > 2000) {
                     payload.content = payload.content.substring(0, 1997) + "...";
                 }
                 
                 // Add back to front of queue
                 this.queue.unshift(item);
            }
            else {
                console.error(`[QUEUE-FAIL] Failed to send to ${meta.targetChannelId}: ${error.message}`);
                // If it's a network error (ECONNRESET), we could retry up to 3 times.
                if ((error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT') && attempt < 3) {
                    console.log(`[QUEUE-RETRY] Network error. Attempt ${attempt + 1}/3.`);
                    item.attempt++;
                    this.queue.push(item); // Push to back to retry later
                }
            }
        }
    }
}

module.exports = new RelayQueue();