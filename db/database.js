// db/database.js
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

// --- Define Paths and Detect Environment ---
const volumePath = '/data';
const dbName = 'database.db';
let dbPath;

if (fs.existsSync(volumePath)) {
    console.log('[DB] Persistent volume detected.');
    dbPath = path.join(volumePath, dbName);
} else {
    console.log('[DB] No persistent volume detected. Using ephemeral local storage.');
    dbPath = path.join(process.cwd(), dbName);
}

console.log(`[DB] Using database at path: ${dbPath}`);
const db = new Database(dbPath);

// --- MIGRATIONS ---
const migrations = [
    // Version 1: The initial setup (for brand new databases)
    {
        version: 1,
        up: `
            PRAGMA foreign_keys = ON;
            CREATE TABLE IF NOT EXISTS relay_groups ( /* ... */ );
            CREATE TABLE IF NOT EXISTS linked_channels ( /* ... */ );
            CREATE TABLE IF NOT EXISTS role_mappings ( /* ... */ );
            CREATE TABLE IF NOT EXISTS relayed_messages ( /* ... */ );
        `
        // Note: The full text for version 1 isn't strictly needed for the migration to run,
        // but it's kept for setting up a brand new database from scratch.
    },
    // Version 2: Added 'direction' column and changed 'delete_delay_hours' default.
    {
        version: 2,
        up: `
            ALTER TABLE linked_channels ADD COLUMN direction TEXT DEFAULT 'BOTH' NOT NULL;
            CREATE TABLE linked_channels_v2 (
                channel_id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, group_id INTEGER NOT NULL,
                webhook_url TEXT NOT NULL, delete_delay_hours INTEGER DEFAULT 0 NOT NULL,
                reverse_delete_enabled BOOLEAN DEFAULT 0 NOT NULL, direction TEXT DEFAULT 'BOTH' NOT NULL,
                FOREIGN KEY (group_id) REFERENCES relay_groups(group_id) ON DELETE CASCADE
            );
            INSERT INTO linked_channels_v2 (channel_id, guild_id, group_id, webhook_url, delete_delay_hours, reverse_delete_enabled, direction)
            SELECT channel_id, guild_id, group_id, webhook_url, delete_delay_hours, reverse_delete_enabled, direction
            FROM linked_channels;
            DROP TABLE linked_channels;
            ALTER TABLE linked_channels_v2 RENAME TO linked_channels;
        `
    },
    // [NEW] Version 3: Replaces delete settings with clearer forward/reverse toggles.
    {
        version: 3,
        up: `
            CREATE TABLE linked_channels_v3 (
                channel_id TEXT PRIMARY KEY,
                guild_id TEXT NOT NULL,
                group_id INTEGER NOT NULL,
                webhook_url TEXT NOT NULL,
                direction TEXT DEFAULT 'BOTH' NOT NULL,
                allow_forward_delete BOOLEAN DEFAULT 1 NOT NULL, -- On by default
                allow_reverse_delete BOOLEAN DEFAULT 0 NOT NULL, -- Off by default
                FOREIGN KEY (group_id) REFERENCES relay_groups(group_id) ON DELETE CASCADE
            );
            
            -- Copy the data, preserving existing settings. The new columns get their defaults.
            INSERT INTO linked_channels_v3 (channel_id, guild_id, group_id, webhook_url, direction)
            SELECT channel_id, guild_id, group_id, webhook_url, direction
            FROM linked_channels;

            DROP TABLE linked_channels;
            ALTER TABLE linked_channels_v3 RENAME TO linked_channels;
        `
    }
];

// --- MIGRATION LOGIC (This part remains the same) ---
const currentVersion = db.pragma('user_version', { simple: true });
const latestVersion = migrations[migrations.length - 1].version;

console.log(`[DB] Current database schema version: ${currentVersion}`);

if (currentVersion < latestVersion) {
    console.log(`[DB] Database schema is out of date. Applying migrations...`);
    for (const migration of migrations) {
        if (currentVersion < migration.version) {
            // For brand new databases, we just run the latest schema directly.
            if (currentVersion === 0 && migration.version === latestVersion) {
                console.log(`[DB] New database detected. Applying latest schema (v${latestVersion})...`);
                const latestSchema = `
                    PRAGMA foreign_keys = ON;
                    CREATE TABLE relay_groups (group_id INTEGER PRIMARY KEY AUTOINCREMENT, group_name TEXT NOT NULL UNIQUE, owner_guild_id TEXT NOT NULL);
                    CREATE TABLE linked_channels (channel_id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, group_id INTEGER NOT NULL, webhook_url TEXT NOT NULL, direction TEXT DEFAULT 'BOTH' NOT NULL, allow_forward_delete BOOLEAN DEFAULT 1 NOT NULL, allow_reverse_delete BOOLEAN DEFAULT 0 NOT NULL, FOREIGN KEY (group_id) REFERENCES relay_groups(group_id) ON DELETE CASCADE);
                    CREATE TABLE role_mappings (mapping_id INTEGER PRIMARY KEY AUTOINCREMENT, group_id INTEGER NOT NULL, guild_id TEXT NOT NULL, role_name TEXT NOT NULL, role_id TEXT NOT NULL, FOREIGN KEY (group_id) REFERENCES relay_groups(group_id) ON DELETE CASCADE, UNIQUE(group_id, guild_id, role_name));
                    CREATE TABLE relayed_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, original_message_id TEXT NOT NULL, original_channel_id TEXT NOT NULL, relayed_message_id TEXT NOT NULL, relayed_channel_id TEXT NOT NULL, webhook_url TEXT NOT NULL);
                `;
                db.exec(latestSchema);
                db.pragma(`user_version = ${latestVersion}`);
                console.log(`[DB] Successfully set up new database at version ${latestVersion}.`);
                break; // Exit the loop after setting up the new DB
            }

            console.log(`[DB] Migrating to version ${migration.version}...`);
            db.exec('BEGIN TRANSACTION;');
            try {
                db.exec(migration.up);
                db.pragma(`user_version = ${migration.version}`);
                db.exec('COMMIT;');
                console.log(`[DB] Successfully migrated to version ${migration.version}.`);
            } catch (error) {
                db.exec('ROLLBACK;');
                console.error(`[DB] FAILED to migrate to version ${migration.version}. Changes were rolled back.`, error);
                process.exit(1);
            }
        }
    }
} else {
    console.log('[DB] Database schema is up to date.');
}

module.exports = db;