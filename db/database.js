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
    // Version 1: The initial setup.
    {
        version: 1,
        up: `
            PRAGMA foreign_keys = ON;
            CREATE TABLE relay_groups (group_id INTEGER PRIMARY KEY AUTOINCREMENT, group_name TEXT NOT NULL UNIQUE, owner_guild_id TEXT NOT NULL);
            CREATE TABLE linked_channels (channel_id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, group_id INTEGER NOT NULL, webhook_url TEXT NOT NULL, delete_delay_hours INTEGER DEFAULT 2, reverse_delete_enabled BOOLEAN DEFAULT 0 NOT NULL, FOREIGN KEY (group_id) REFERENCES relay_groups(group_id) ON DELETE CASCADE);
            CREATE TABLE role_mappings (mapping_id INTEGER PRIMARY KEY AUTOINCREMENT, group_id INTEGER NOT NULL, guild_id TEXT NOT NULL, role_name TEXT NOT NULL, role_id TEXT NOT NULL, FOREIGN KEY (group_id) REFERENCES relay_groups(group_id) ON DELETE CASCADE, UNIQUE(group_id, guild_id, role_name));
            CREATE TABLE relayed_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, original_message_id TEXT NOT NULL, original_channel_id TEXT NOT NULL, relayed_message_id TEXT NOT NULL, relayed_channel_id TEXT NOT NULL, webhook_url TEXT NOT NULL);
        `
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
            SELECT channel_id, guild_id, group_id, webhook_url, delete_delay_hours, reverse_delete_enabled, 'BOTH'
            FROM linked_channels;
            DROP TABLE linked_channels;
            ALTER TABLE linked_channels_v2 RENAME TO linked_channels;
        `
    },
    // Version 3: Replaced delete settings with clearer forward/reverse toggles.
    {
        version: 3,
        up: `
            CREATE TABLE linked_channels_v3 (
                channel_id TEXT PRIMARY KEY,
                guild_id TEXT NOT NULL,
                group_id INTEGER NOT NULL,
                webhook_url TEXT NOT NULL,
                direction TEXT DEFAULT 'BOTH' NOT NULL,
                allow_forward_delete BOOLEAN DEFAULT 1 NOT NULL,
                allow_reverse_delete BOOLEAN DEFAULT 0 NOT NULL,
                FOREIGN KEY (group_id) REFERENCES relay_groups(group_id) ON DELETE CASCADE
            );
            INSERT INTO linked_channels_v3 (channel_id, guild_id, group_id, webhook_url, direction)
            SELECT channel_id, guild_id, group_id, webhook_url, direction
            FROM linked_channels;
            DROP TABLE linked_channels;
            ALTER TABLE linked_channels_v3 RENAME TO linked_channels;
        `
    },
    // Version 4: Re-adds the delete_delay_hours column that was mistakenly removed.
    {
        version: 4,
        up: `
            ALTER TABLE linked_channels ADD COLUMN delete_delay_hours INTEGER DEFAULT 0 NOT NULL;
        `
    },
    // Version 5: Adds a table for tracking character usage statistics per group.
    {
        version: 5,
        up: `
            CREATE TABLE group_stats (
                stat_id INTEGER PRIMARY KEY AUTOINCREMENT,
                group_id INTEGER NOT NULL,
                day TEXT NOT NULL, -- Stored as 'YYYY-MM-DD'
                character_count INTEGER NOT NULL DEFAULT 0,
                FOREIGN KEY (group_id) REFERENCES relay_groups(group_id) ON DELETE CASCADE,
                UNIQUE(group_id, day)
            );
        `
    },
    // Version 6: Upgrades group_stats for rate limiting.
    {
        version: 6,
        up: `
            CREATE TABLE group_stats_new (
                stat_id INTEGER PRIMARY KEY AUTOINCREMENT,
                group_id INTEGER NOT NULL,
                day TEXT NOT NULL,
                character_count INTEGER NOT NULL DEFAULT 0,
                warning_sent_at INTEGER, -- Timestamp of when the warning was sent, NULL by default
                FOREIGN KEY (group_id) REFERENCES relay_groups(group_id) ON DELETE CASCADE,
                UNIQUE(group_id, day)
            );
            INSERT INTO group_stats_new (group_id, day, character_count)
            SELECT group_id, day, character_count
            FROM group_stats;
            DROP TABLE group_stats;
            ALTER TABLE group_stats_new RENAME TO group_stats;
        `
    },
	// Version 7: Adds a column to track replies for edit syncing.
    {
        version: 7,
        up: `
            ALTER TABLE relayed_messages ADD COLUMN replied_to_id TEXT;
        `
    },
    // [NEW] Version 8: Adds indexes for efficient pruning of old data.
    {
        version: 8,
        up: `
            CREATE INDEX IF NOT EXISTS idx_relayed_messages_original_id ON relayed_messages(original_message_id);
            CREATE INDEX IF NOT EXISTS idx_group_stats_day ON group_stats(day);
        `
    }
];

// --- MIGRATION LOGIC ---
const currentVersion = db.pragma('user_version', { simple: true });
const latestVersion = migrations[migrations.length - 1].version;

console.log(`[DB] Current database schema version: ${currentVersion}`);

if (currentVersion < latestVersion) {
    console.log(`[DB] Database schema is out of date. Applying migrations...`);
    // For brand new databases (version 0), we apply the latest schema directly.
    if (currentVersion === 0) {
        console.log(`[DB] New database detected. Applying latest schema (v${latestVersion})...`);
        const latestSchema = `
            PRAGMA foreign_keys = ON;
            CREATE TABLE relay_groups (group_id INTEGER PRIMARY KEY AUTOINCREMENT, group_name TEXT NOT NULL UNIQUE, owner_guild_id TEXT NOT NULL);
            CREATE TABLE linked_channels (channel_id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, group_id INTEGER NOT NULL, webhook_url TEXT NOT NULL, direction TEXT DEFAULT 'BOTH' NOT NULL, allow_forward_delete BOOLEAN DEFAULT 1 NOT NULL, allow_reverse_delete BOOLEAN DEFAULT 0 NOT NULL, delete_delay_hours INTEGER DEFAULT 0 NOT NULL, FOREIGN KEY (group_id) REFERENCES relay_groups(group_id) ON DELETE CASCADE);
            CREATE TABLE role_mappings (mapping_id INTEGER PRIMARY KEY AUTOINCREMENT, group_id INTEGER NOT NULL, guild_id TEXT NOT NULL, role_name TEXT NOT NULL, role_id TEXT NOT NULL, FOREIGN KEY (group_id) REFERENCES relay_groups(group_id) ON DELETE CASCADE, UNIQUE(group_id, guild_id, role_name));
            CREATE TABLE relayed_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, original_message_id TEXT NOT NULL, original_channel_id TEXT NOT NULL, relayed_message_id TEXT NOT NULL, relayed_channel_id TEXT NOT NULL, webhook_url TEXT NOT NULL, replied_to_id TEXT);
            CREATE TABLE group_stats (stat_id INTEGER PRIMARY KEY AUTOINCREMENT, group_id INTEGER NOT NULL, day TEXT NOT NULL, character_count INTEGER NOT NULL DEFAULT 0, warning_sent_at INTEGER, FOREIGN KEY (group_id) REFERENCES relay_groups(group_id) ON DELETE CASCADE, UNIQUE(group_id, day));
            CREATE INDEX idx_relayed_messages_original_id ON relayed_messages(original_message_id);
            CREATE INDEX idx_group_stats_day ON group_stats(day);
        `;
        try {
            db.exec(latestSchema);
            db.pragma(`user_version = ${latestVersion}`);
            console.log(`[DB] Successfully set up new database at version ${latestVersion}.`);
        } catch (error) {
            console.error(`[DB] FAILED to set up new database.`, error);
            process.exit(1);
        }
    } else {
        // For existing databases, apply migrations one by one.
        for (const migration of migrations) {
            if (currentVersion < migration.version) {
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
    }
} else {
    console.log('[DB] Database schema is up to date.');
}

module.exports = db;