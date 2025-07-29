-- Migration: 001-initial-schema.sql
-- Description: The complete initial schema for the RelayBot database.
-- This file defines all tables and their relationships for the first version of the bot.

-- Enforce foreign key constraints to ensure data integrity.
PRAGMA foreign_keys = ON;

-- Table for storing global relay groups.
-- Each group has a unique name and an owner server.
CREATE TABLE IF NOT EXISTS relay_groups (
    group_id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_name TEXT NOT NULL UNIQUE,
    owner_guild_id TEXT NOT NULL
);

-- Table for storing channels that are linked to a relay group.
CREATE TABLE IF NOT EXISTS linked_channels (
    channel_id TEXT PRIMARY KEY,
    guild_id TEXT NOT NULL,
    group_id INTEGER NOT NULL,
    webhook_url TEXT NOT NULL,
    delete_delay_hours INTEGER DEFAULT 0 NOT NULL,
    reverse_delete_enabled BOOLEAN DEFAULT 0 NOT NULL,
    FOREIGN KEY (group_id) REFERENCES relay_groups(group_id) ON DELETE CASCADE
);

-- Table for mapping common role names to server-specific role IDs within a group.
CREATE TABLE IF NOT EXISTS role_mappings (
    mapping_id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER NOT NULL,
    guild_id TEXT NOT NULL,
    role_name TEXT NOT NULL,
    role_id TEXT NOT NULL,
    FOREIGN KEY (group_id) REFERENCES relay_groups(group_id) ON DELETE CASCADE,
    UNIQUE(group_id, guild_id, role_name)
);

-- Table for tracking relayed messages to enable editing and deleting.
CREATE TABLE IF NOT EXISTS relayed_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    original_message_id TEXT NOT NULL,
    original_channel_id TEXT NOT NULL,
    relayed_message_id TEXT NOT NULL,
    relayed_channel_id TEXT NOT NULL,
    webhook_url TEXT NOT NULL
);

-- IMPORTANT: This sets the database version to 1 after applying this migration.
-- The migration runner in db/database.js reads this to know that this script has been run.
PRAGMA user_version = 1;