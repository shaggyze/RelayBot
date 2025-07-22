// db/database.js
const Database = require('better-sqlite3');
const db = new Database('database.db');

console.log('Initializing database...');

// This script runs on every startup to ensure the tables exist.
const setupScript = `
    PRAGMA foreign_keys = ON;

    -- Stores relay groups. A group is identified by its name *and* the guild that created it.
    -- This allows different servers to have groups with the same name without conflict.
    CREATE TABLE IF NOT EXISTS relay_groups (
        group_id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        group_name TEXT NOT NULL,
        UNIQUE(guild_id, group_name)
    );

    -- Stores the channels linked to each relay group.
    CREATE TABLE IF NOT EXISTS linked_channels (
        channel_id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL,
        group_id INTEGER NOT NULL,
        webhook_url TEXT NOT NULL,
        delete_delay_hours INTEGER DEFAULT 2,
        FOREIGN KEY (group_id) REFERENCES relay_groups(group_id) ON DELETE CASCADE
    );

    -- Maps a common role name (e.g., "K30-31") to a specific role ID for each server in a group.
    CREATE TABLE IF NOT EXISTS role_mappings (
        mapping_id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id INTEGER NOT NULL,
        guild_id TEXT NOT NULL,
        role_name TEXT NOT NULL,
        role_id TEXT NOT NULL,
        FOREIGN KEY (group_id) REFERENCES relay_groups(group_id) ON DELETE CASCADE,
        UNIQUE(group_id, guild_id, role_name)
    );
`;

db.exec(setupScript);
console.log('Database initialized successfully.');

module.exports = db;