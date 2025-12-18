// utils/relayQueue.js
const { WebhookClient } = require('discord.js');
const webhookManager = require('./webhookManager.js');
const Logger = require('./logManager.js');

class RelayQueue {
    constructor() {
        this.queue = [];
        this.processing = false;
        this.rateLimitDelay = 600; 
    }

    add(webhookUrl, payload, db, meta, client) {
        if (!client) Logger.warn('QUEUE', `Item added to queue without Client object for target ${meta.targetChannelId}`);
        this.queue.push({ webhookUrl, payload, db, meta, client, attempt: 1 });
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
                Logger.error('QUEUE-FATAL', `Critical error in sendItem`, null, error);
            }
            await new Promise(resolve => setTimeout(resolve, this.rateLimitDelay));
        }

        this.processing = false;
    }

    async sendItem(item) {
        const { webhookUrl, payload, db, meta, client, attempt } = item;

        //Logger.info('QUEUE-SEND', `Sending to target ${meta.targetChannelId}...`, meta.executionId);

        try {
            const webhookClient = new WebhookClient({ url: webhookUrl });
            const relayedMessage = await webhookClient.send(payload);

            Logger.info('QUEUE-SEND', `Attempting to relay message ${meta.originalMsgId} to target channel #${meta.targetChannelId}`, meta.executionId);

            // [THE FIX] Isolate the database operation. A failure here should NOT re-send the message.
            if (relayedMessage) {
                try {
                    const repliedToOriginalId = meta.repliedToId || null;
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
                    Logger.error('QUEUE-DB-ERR', `Failed to save record for ${meta.originalMsgId}`, meta.executionId, dbError);
                }
            }

        } catch (error) {
            // Error handling for SENDING the message
            if (error.code === 429) {
                Logger.warn('QUEUE-429', `Rate Limit hit for ${meta.targetChannelId}. Backing off.`, meta.executionId);
                this.queue.unshift(item); 
                await new Promise(resolve => setTimeout(resolve, 5000));
            } 
            else if (error.code === 10015) {
                Logger.error('QUEUE-CLEANUP', `Webhook invalid. Attempting repair via Manager.`, meta.executionId);
                const newClient = await webhookManager.handleInvalidWebhook(client, meta.targetChannelId, meta.groupName || 'RelayQueue');
                if (newClient) {
                    item.webhookUrl = newClient.url;
                    this.queue.unshift(item); // Re-queue with fixed URL
                }
            } 
            else if (error.code === 50006) {
                 Logger.warn('QUEUE-RETRY', `Sticker/Empty message failed. Retrying with fallback.`, meta.executionId);
                 if (payload.sticker_ids && meta.stickerData) {
                    delete payload.sticker_ids;
                    payload.content = (payload.content || "") + (meta.stickerData.url ? `\n[Sticker: ${meta.stickerData.name}](${meta.stickerData.url})` : `\n*(sent sticker: ${meta.stickerData.name})*`);
                 } else {
                    payload.content = (payload.content || "") + "\n*(Message content was empty or could not be sent)*";
                 }
                 if (payload.content.length > 2000) payload.content = payload.content.substring(0, 1997) + "...";
                 this.queue.unshift(item);
            }
            else {
                Logger.error('QUEUE-FAIL', `Failed to send to ${meta.targetChannelId}`, meta.executionId, error);
                if ((error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT') && attempt < 3) {
                    Logger.warn('QUEUE-RETRY', `Network error. Attempt ${attempt + 1}/3.`, meta.executionId);
                    item.attempt++;
                    this.queue.push(item);
                }
            }
        }
    }
}

module.exports = new RelayQueue();