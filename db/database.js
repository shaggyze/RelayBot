// db/database.js
const Database = require('better-sqlite3');
const db = new Database('database.db');

console.log('Initializing database...');

// This script runs on every startup to ensure the tables exist.
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
        delete_delay_hours INTEGER DEFAULT 2,
        reverse_delete_enabled BOOLEAN DEFAULT 0 NOT NULL, -- [NEW] Off by default
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
        original_channel_id TEXT NOT NULL, -- [NEW] We need to know where the original came from
        relayed_message_id TEXT NOT NULL,
        relayed_channel_id TEXT NOT NULL,
        webhook_url TEXT NOT NULL
    );
`;

db.exec(setupScript);
console.log('Database initialized successfully.');

module.exports = db;