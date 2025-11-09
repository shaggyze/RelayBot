// events/entitlementDelete.js
const { Events } = require('discord.js');
const db = require('../db/database.js');

const PREMIUM_SKU_ID = '1436488229455925299';

module.exports = {
    name: Events.EntitlementDelete,
    async execute(entitlement) {
        // [THE FIX] Only process entitlements for your specific SKU
        if (entitlement.skuId !== PREMIUM_SKU_ID) return;
        if (!entitlement.guildId) return;

        console.log(`[SUBSCRIPTION] Premium SKU Entitlement DELETED for guild ${entitlement.guildId}. Marking as inactive.`);
        
        // Mark as inactive in your database cache
        db.prepare('UPDATE guild_subscriptions SET is_active = 0 WHERE guild_id = ?')
          .run(entitlement.guildId);
    },
};