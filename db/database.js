// db/database.js
const path = require('path');
const Database = require('better-sqlite3');
const migrate = require('better-sqlite3-migrate');

// [CHANGED] Point to the persistent volume path
const db = new Database('/data/database.db');

console.log('Running database migrations...');

const migrations = [
  {
    file: path.join(__dirname, '../migrations/001-initial-schema.sql'),
    version: 1,
  },
  // Add future migrations here
];

try {
  for (const migration of migrations) {
    migrate(db, migration);
  }
  console.log('Database is up to date.');
} catch (err) {
  console.error('Migration failed:', err);
  process.exit(1);
}

module.exports = db;