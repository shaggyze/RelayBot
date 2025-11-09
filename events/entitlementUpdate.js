// events/entitlementUpdate.js
const { Events } = require('discord.js');
const db = require('../db/database.js');

const PREMIUM_SKU_ID = '1436488229455925299';

module.exports = {
    name: Events.EntitlementUpdate,
    async execute(entitlement) {
        // [THE FIX] Only process entitlements for your specific SKU
        if (entitlement.skuId !== PREMIUM_SKU_ID) return;
        if (!entitlement.guildId) return;

        const isActive = entitlement.isActive;
        const expiresTimestamp = entitlement.endsTimestamp;

        console.log(`[SUBSCRIPTION] Premium SKU Entitlement UPDATED for guild ${entitlement.guildId}. Active: ${isActive}`);
        
        db.prepare('INSERT OR REPLACE INTO guild_subscriptions (guild_id, is_active, expires_at, updated_at) VALUES (?, ?, ?, ?)')
          .run(entitlement.guildId, isActive ? 1 : 0, expiresTimestamp, Date.now());
    },
};