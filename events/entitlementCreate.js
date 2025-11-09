// events/entitlementCreate.js
const { Events } = require('discord.js');
const db = require('../db/database.js');

const PREMIUM_SKU_ID = '1436488229455925299';

module.exports = {
    name: Events.EntitlementCreate,
    async execute(entitlement) {
        // [THE FIX] Only process entitlements for your specific SKU
        if (entitlement.skuId !== PREMIUM_SKU_ID) return;
        if (!entitlement.guildId) return; // We only care about guild subscriptions

        const expiresTimestamp = entitlement.endsTimestamp;
        
        console.log(`[SUBSCRIPTION] Premium SKU Entitlement CREATED for guild ${entitlement.guildId}.`);
        
        db.prepare('INSERT OR REPLACE INTO guild_subscriptions (guild_id, is_active, expires_at, updated_at) VALUES (?, 1, ?, ?)')
          .run(entitlement.guildId, expiresTimestamp, Date.now());
    },
};