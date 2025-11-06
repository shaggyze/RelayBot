// utils/backupManager.js
const { exec } = require('child_process');
const { EmbedBuilder } = require('discord.js');

async function uploadDatabase() {
    return new Promise((resolve, reject) => {
        const uploadSecret = process.env.UPLOAD_SECRET_KEY;
        const clientId = process.env.CLIENT_ID;

        if (!uploadSecret || !clientId) {
            const errorMsg = 'UPLOAD_SECRET_KEY and CLIENT_ID must be set for automated backups.';
            console.error(`[DB-BACKUP] ${errorMsg}`);
            return reject(new Error(errorMsg));
        }

        const timestamp = new Date().toISOString().replace(/:/g, '-').slice(0, 19);
        const dynamicFilename = `database_${clientId}_${timestamp}.db`;

        // This path must match your production environment
        const dbPath = '/data/database.db';
        const uploadUrl = 'https://shaggyze.website/railway-upload.php';

        const command = `curl -s -X POST -H "X-Upload-Secret: ${uploadSecret}" -F "file=@${dbPath}" -F "filename=${dynamicFilename}" ${uploadUrl}`;

        console.log('[DB-BACKUP] Starting automated database backup upload...');

        exec(command, (error, stdout, stderr) => {
            if (error) {
                console.error('[DB-BACKUP] Exec error:', error);
                return reject(new Error(stderr.toString()));
            }

            try {
                const response = JSON.parse(stdout.toString());
                if (response.success && response.url) {
                    console.log(`[DB-BACKUP] Success! Database uploaded as ${response.filename}.`);
                    resolve(response); // Resolve with the successful response
                } else {
                    const errorMsg = `Upload script returned an error: ${response.message || stdout.toString()}`;
                    console.error(`[DB-BACKUP] ${errorMsg}`);
                    reject(new Error(errorMsg));
                }
            } catch (parseError) {
                const errorMsg = `Failed to parse server response. Raw output: ${stdout.toString()}`;
                console.error(`[DB-BACKUP] ${errorMsg}`);
                reject(new Error(errorMsg));
            }
        });
    });
}

module.exports = { uploadDatabase };