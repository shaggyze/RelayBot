// db/database.js
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

// --- Define Paths ---
const volumePath = '/data';
const rootPath = process.cwd(); // This is /app on Railway
const dbName = 'database.db';
let primaryDbPath;
let isUsingVolume = false;

// --- Determine the Primary Database Path ---
if (fs.existsSync(volumePath)) {
    isUsingVolume = true;
    primaryDbPath = path.join(volumePath, dbName);
    console.log(`[DB] Persistent volume detected. Using primary database at: ${primaryDbPath}`);
} else {
    primaryDbPath = path.join(rootPath, dbName);
    console.log(`[DB] No persistent volume detected. Using ephemeral database at: ${primaryDbPath}`);
}

const db = new Database(primaryDbPath);

// --- [REVERTED] Use the original, reliable setup script ---
console.log('[DB] Initializing database schema...');
const setupScript = `
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
        delete_delay_hours INTEGER DEFAULT 0 NOT NULL,
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
`;
db.exec(setupScript);
console.log('[DB] Database schema initialized.');

// --- "Hot Spare" Backup Logic ---
if (isUsingVolume) {
    const spareDbPath = path.join(rootPath, dbName);
    console.log(`[DB] Syncing persistent data from volume to ephemeral spare at: ${spareDbPath}`);
    try {
        db.backup(spareDbPath)
            .then(() => console.log('[DB] Hot spare sync successful.'))
            .catch((backupErr) => console.error('[DB] Hot spare sync failed:', backupErr));
    } catch (backupErr) {
        console.error('[DB] An immediate error occurred during hot spare sync initiation:', backupErr);
    }
}

module.exports = db;