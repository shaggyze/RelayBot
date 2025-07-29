// db/database.js
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { migrate } = require('@blackglory/better-sqlite3-migrations');

// --- Define Paths ---
const volumePath = '/data';
const rootPath = process.cwd(); // This is /app on Railway
const dbName = 'database.db';
let primaryDbPath;
let isUsingVolume = false;

// --- Step 1: Determine the Primary Database Path ---
if (fs.existsSync(volumePath)) {
    // A persistent volume is attached. This is our primary source of truth.
    isUsingVolume = true;
    primaryDbPath = path.join(volumePath, dbName);
    console.log(`[DB] Persistent volume detected. Using primary database at: ${primaryDbPath}`);
} else {
    // No volume detected. Fallback to the ephemeral root directory.
    // This will be used when running locally, on a free plan, or after a volume is detached.
    primaryDbPath = path.join(rootPath, dbName);
    console.log(`[DB] No persistent volume detected. Using ephemeral database at: ${primaryDbPath}`);
}

// --- Step 2: Connect to the Primary Database ---
const db = new Database(primaryDbPath);

// --- Step 3: Run Migrations on the Primary Database ---
console.log('[DB] Running migrations on primary database...');
try {
  migrate(db, {
    migrationsPath: path.join(__dirname, '../migrations'),
  });
  console.log('[DB] Primary database is up to date.');
} catch (err) {
  console.error('[DB] Migration failed:', err);
  process.exit(1);
}

// --- Step 4: [YOUR FEATURE] Create the "Hot Spare" Backup in the Root Directory ---
if (isUsingVolume) {
    // This block only runs if our primary database is on the permanent volume.
    const spareDbPath = path.join(rootPath, dbName);
    console.log(`[DB] Syncing persistent data from volume to ephemeral spare at: ${spareDbPath}`);
    try {
        // Use the built-in backup feature for a safe and efficient copy.
        // This overwrites the ephemeral DB with the latest data from the permanent one.
        db.backup(spareDbPath)
            .then(() => {
                console.log('[DB] Hot spare sync successful.');
            })
            .catch((backupErr) => {
                console.error('[DB] Hot spare sync failed:', backupErr);
            });
    } catch (backupErr) {
        console.error('[DB] An immediate error occurred during hot spare sync initiation:', backupErr);
    }
}

// --- Step 5: Export the connection to the primary database ---
module.exports = db;