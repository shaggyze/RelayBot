// db/database.js
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { migrate } = require('better-sqlite3-migrations');

// [NEW] Flexible database path logic
const volumePath = '/data';
let dbPath;

if (fs.existsSync(volumePath)) {
    // A persistent volume is attached (like on a paid Railway plan).
    // Use the database file inside the volume.
    dbPath = path.join(volumePath, 'database.db');
    console.log(`Persistent volume at '${volumePath}' detected. Using database at: ${dbPath}`);
} else {
    // No volume detected (running locally or on a free/ephemeral plan).
    // Use a local database file in the project root.
    dbPath = 'database.db';
    console.log(`No persistent volume detected. Using local database at: ${dbPath}`);
}

const db = new Database(dbPath);

console.log('Running database migrations...');

try {
  // The migration runner works perfectly with either path.
  migrate(db, {
    migrationsPath: path.join(__dirname, '../migrations'),
  });
  console.log('Database is up to date.');
} catch (err) {
  console.error('Migration failed:', err);
  process.exit(1);
}

module.exports = db;