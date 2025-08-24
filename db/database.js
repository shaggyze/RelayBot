// db/database.js
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

// --- Define Paths and Detect Environment ---
const volumePath = '/data'; // This is the persistent storage volume on Railway
const dbName = 'database.db';
let dbPath; // This will be the final path to the database we use

// Check if the persistent volume exists. This is the key to differentiating
// the temporary "build" container from the permanent "run" container.
if (fs.existsSync(volumePath)) {
    console.log('[DB] Persistent volume detected.');
    dbPath = path.join(volumePath, dbName);
} else {
    console.log('[DB] No persistent volume detected. Using ephemeral local storage.');
    dbPath = path.join(process.cwd(), dbName); // Fallback to /app/database.db
}

console.log(`[DB] Using database at path: ${dbPath}`);
const db = new Database(dbPath);

// --- MIGRATIONS ---
// Each object in this array represents a schema version.
// The `up` property contains the SQL to run to upgrade to that version.
const migrations = [
    // Version 1: The initial setup
    {
        version: 1,
        up: `
            PRAGMA foreign_keys = ON;
            CREATE TABLE IF NOT EXISTS relay_groups (
                group_id INTEGER PRIMARY KEY AUTOINCREMENT,
                group_name TEXT NOT NULL UNIQUE,
                owner_guild_id TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS linked_channels (
                channel_id TEXT PRIMARY KEY,
                guild_id TEXT NOT NULL,
                group_id INTEGER NOT NULL,
                webhook_url TEXT NOT NULL,
                delete_delay_hours INTEGER DEFAULT 2, -- Old default
                reverse_delete_enabled BOOLEAN DEFAULT 0 NOT NULL,
                FOREIGN KEY (group_id) REFERENCES relay_groups(group_id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS role_mappings (
                mapping_id INTEGER PRIMARY KEY AUTOINCREMENT,
                group_id INTEGER NOT NULL,
                guild_id TEXT NOT NULL,
                role_name TEXT NOT NULL,
                role_id TEXT NOT NULL,
                FOREIGN KEY (group_id) REFERENCES relay_groups(group_id) ON DELETE CASCADE,
                UNIQUE(group_id, guild_id, role_name)
            );
            CREATE TABLE IF NOT EXISTS relayed_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                original_message_id TEXT NOT NULL,
                original_channel_id TEXT NOT NULL,
                relayed_message_id TEXT NOT NULL,
                relayed_channel_id TEXT NOT NULL,
                webhook_url TEXT NOT NULL
            );
        `
    },
    // Version 2: Add direction and change delete delay default
    {
        version: 2,
        up: `
            ALTER TABLE linked_channels ADD COLUMN direction TEXT DEFAULT 'BOTH' NOT NULL;
            CREATE TABLE linked_channels_new (
                channel_id TEXT PRIMARY KEY,
                guild_id TEXT NOT NULL,
                group_id INTEGER NOT NULL,
                webhook_url TEXT NOT NULL,
                delete_delay_hours INTEGER DEFAULT 0 NOT NULL, -- New default
                reverse_delete_enabled BOOLEAN DEFAULT 0 NOT NULL,
                direction TEXT DEFAULT 'BOTH' NOT NULL,
                FOREIGN KEY (group_id) REFERENCES relay_groups(group_id) ON DELETE CASCADE
            );
            INSERT INTO linked_channels_new (channel_id, guild_id, group_id, webhook_url, delete_delay_hours, reverse_delete_enabled, direction)
            SELECT channel_id, guild_id, group_id, webhook_url, delete_delay_hours, reverse_delete_enabled, 'BOTH'
            FROM linked_channels;
            DROP TABLE linked_channels;
            ALTER TABLE linked_channels_new RENAME TO linked_channels;
        `
    },
];

// --- MIGRATION LOGIC ---
const currentVersion = db.pragma('user_version', { simple: true });
const latestVersion = migrations[migrations.length - 1].version;

console.log(`[DB] Current database schema version: ${currentVersion}`);

if (currentVersion < latestVersion) {
    console.log(`[DB] Database schema is out of date. Applying migrations...`);
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
} else {
    console.log('[DB] Database schema is up to date.');
}

module.exports = db;