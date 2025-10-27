// utils/supporterManager.js
const https = require('https');
const { version } = require('../package.json');

const WEBHOOK_URL = 'https://shaggyze.website/webhook.php';
const PATRON_LIST_URL = 'https://shaggyze.website/patrons.txt';
const VOTER_LIST_URL = 'https://shaggyze.website/voters.txt';

let supporterIds = new Set();

// Helper function to fetch a single file.
function fetchFile(url) {
    return new Promise((resolve) => {
        if (!url.startsWith('http')) {
            return resolve('');
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
            resolve('');
        });
    });
}

// This function sends the "poke" to the webhook to trigger cleanup.
function triggerCleanup() {
    return new Promise((resolve) => {
        if (!WEBHOOK_URL.startsWith('http')) {
            return resolve();
        }

        const postData = JSON.stringify({
            user: '182938628643749888',
            type: 'cleanup'
        });

        const url = new URL(WEBHOOK_URL);
        const options = {
            hostname: url.hostname,
            port: 443,
            path: url.pathname,
            method: 'POST',
            headers: {
                'User-Agent': `RelayBot Webhook/${version}`,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData)
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

        req.write(postData);
        req.end();
    });
}

// Main function to fetch both lists and combine them.
async function fetchSupporterIds() {
    console.log('[Supporters] Starting supporter list update...');
    
    triggerCleanup();

    try {
        console.log('[Supporters] Fetching updated patron and voter lists...');
        const [patronData, voterData] = await Promise.all([
            fetchFile(PATRON_LIST_URL),
            fetchFile(VOTER_LIST_URL)
        ]);

        const combinedIds = new Set();
		const patronList = patronData.split(/\s+/).filter(id => id.length > 0);
		const voterList = voterData.split(/\s+/).filter(line => line.length > 0);
		const patronCount = patronList.length;
		const voterCount = voterList.length;

		patronList.forEach(id => combinedIds.add(id));
		voterList.forEach(line => {
			const userId = line.split(',')[0];
			if (userId) combinedIds.add(userId);
		});
    
        // Only replace the list on a successful fetch.
        supporterIds = combinedIds;
        console.log(`[Supporters] SUCCESS: Loaded ${patronCount} patrons and ${voterCount} active voters. Total unique supporters: ${supporterIds.size}`);
    } catch (error) {
        // If any fetch fails, keep the old list and log the error.
        console.error(`[Supporters] FAILED to fetch lists: ${error.message}. Using cached list of ${supporterIds.size} supporters.`);
    }
}


function isSupporter(userId) {
    return supporterIds.has(userId);
}

// [THE DEFINITIVE FIX IS HERE]
// We are exporting the new function so that other files can access the supporter list.
module.exports = {
    fetchSupporterIds,
    isSupporter,
    getSupporterSet: () => supporterIds
};