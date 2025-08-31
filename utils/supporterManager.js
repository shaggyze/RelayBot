// utils/supporterManager.js
const https = require('https');
const { version } = require('../package.json'); // Import the version

// [NEW] The URL to your webhook.php script.
// IMPORTANT: Replace this with your actual URL.
const WEBHOOK_URL = 'https://shaggyze.website/webhook.php';

const PATRON_LIST_URL = 'https://shaggyze.website/patrons.txt';
const VOTER_LIST_URL = 'https://shaggyze.website/voters.txt';

let supporterIds = new Set();

// Helper function to fetch a single file.
function fetchFile(url) {
    return new Promise((resolve, reject) => {
        if (!url.startsWith('http')) {
            return resolve(''); // Resolve with empty string if URL is not set
        }
        https.get(url, (response) => {
            if (response.statusCode !== 200) {
                console.error(`Failed to fetch file from ${url}. Status: ${response.statusCode}`);
                return resolve('');
            }
            let rawData = '';
            response.on('data', (chunk) => { rawData += chunk; });
            response.on('end', () => resolve(rawData));
        }).on('error', (error) => {
            console.error(`Error fetching file from ${url}:`, error);
            resolve(''); // Resolve with empty string on error
        }
	}
}

// [UPGRADED] This function now sends a JSON payload in its "poke".
function triggerCleanup() {
    return new Promise((resolve) => {
        if (!WEBHOOK_URL.startsWith('http')) {
            return resolve();
        }

        // The new payload to send.
        const postData = JSON.stringify({
            user: '182938628643749888 ', // A clear identifier
            type: 'cleanup'
        });

        const url = new URL(WEBHOOK_URL);
        const options = {
            hostname: url.hostname,
            port: 443,
            path: url.pathname,
            method: 'POST',
            headers: {
                'User-Agent': `RelayBot Webhook /${version}`,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData) // Correctly calculate the body length
            }
        };

        const req = https.request(options, res => {
            res.on('data', () => {});
            res.on('end', () => {
                console.log(`[Supporters] Successfully poked webhook to trigger cleanup. Status: ${res.statusCode}`);
                resolve();
            });
        });

        req.on('error', error => {
            console.error('[Supporters] Error poking webhook:', error);
            resolve();
        });

        // Write the JSON data to the request body.
        req.write(postData);
        req.end();
    });
}

// Main function to fetch both lists and combine them.
async function fetchSupporterIds() {
    console.log('[Supporters] Starting supporter list update...');
    
    // [YOUR IDEA] First, trigger the cleanup.
    await triggerCleanup();

    // Then, fetch the files as before.
    console.log('[Supporters] Fetching updated patron and voter lists...');
    const [patronData, voterData] = await Promise.all([
        fetchFile(PATRON_LIST_URL),
        fetchFile(VOTER_LIST_URL)
    ]);

    const combinedIds = new Set();

    // Process patrons (one ID per line)
    patronData.split(/\s+/).filter(id => id.length > 0).forEach(id => combinedIds.add(id));
    const patronCount = combinedIds.size;

    // Process voters (id,timestamp per line)
    voterData.split(/\s+/).filter(line => line.length > 0).forEach(line => {
        const userId = line.split(',')[0];
        if (userId) combinedIds.add(userId);
    });
    
    supporterIds = combinedIds;
    console.log(`[Supporters] Successfully loaded ${patronCount} patrons and ${supporterIds.size - patronCount} active voters. Total: ${supporterIds.size}`);
}

function isSupporter(userId) {
    return supporterIds.has(userId);
}

module.exports = {
    fetchSupporterIds,
    isSupporter
};