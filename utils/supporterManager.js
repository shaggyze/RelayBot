// utils/supporterManager.js
const https = require('https'); // Use the built-in Node.js module for HTTPS requests

// The raw URL to your supporters.txt file on GitHub Gist or your webserver.
// IMPORTANT: Replace this with your actual URL.
const SUPPORTER_LIST_URL = 'https://shaggyze.website/supporters.txt';

// We will store the supporter IDs in a Set for very fast lookups.
let supporterIds = new Set();

// Function to fetch the list and update our cache using the native https module.
function fetchSupporterIds() {
    // We wrap the logic in a Promise to handle the asynchronous nature cleanly.
    return new Promise((resolve) => {
        if (!SUPPORTER_LIST_URL.startsWith('http')) {
            console.log('[Supporters] Supporter list URL is not configured. Skipping fetch.');
            return resolve();
        }

        console.log('[Supporters] Fetching updated supporter list using native https...');
        
        https.get(SUPPORTER_LIST_URL, (response) => {
            // Check if the request was successful
            if (response.statusCode !== 200) {
                console.error(`[Supporters] Failed to fetch supporter list. Status: ${response.statusCode}`);
                return resolve();
            }

            let rawData = '';
            // A chunk of data has been received.
            response.on('data', (chunk) => {
                rawData += chunk;
            });

            // The whole response has been received. Process the result.
            response.on('end', () => {
                try {
                    const ids = rawData.split(/\s+/).filter(id => id.length > 0);
                    supporterIds = new Set(ids);
                    console.log(`[Supporters] Successfully loaded ${supporterIds.size} supporter IDs into the cache.`);
                } catch (e) {
                    console.error('[Supporters] An error occurred while parsing the supporter list:', e);
                } finally {
                    resolve();
                }
            });

        }).on('error', (error) => {
            console.error('[Supporters] An error occurred while fetching the supporter list:', error);
            resolve();
        });
    });
}

// Function to check if a user is a supporter (this function remains the same).
function isSupporter(userId) {
    return supporterIds.has(userId);
}

module.exports = {
    fetchSupporterIds,
    isSupporter
};