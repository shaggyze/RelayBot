// utils/supporterManager.js
const https = require('https');
const { version } = require('../package.json');

const WEBHOOK_URL = 'https://shaggyze.website/RelayBot/webhook.php';
const PATRON_LIST_URL = 'https://shaggyze.website/RelayBot/patrons.txt';
const VOTER_LIST_URL = 'https://shaggyze.website/RelayBot/voters.txt';

// We keep two sets: one for text files, one for discord API subs
let textFileSupporters = new Set();
let apiSubscriberIds = new Set();

// ... (fetchFile and triggerCleanup functions remain the same) ...
function fetchFile(url) {
    return new Promise((resolve, reject) => {
        if (!url.startsWith('http')) return resolve('');
        https.get(url, (res) => {
            if (res.statusCode !== 200) return reject(new Error(`Status ${res.statusCode}`));
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(data));
        }).on('error', reject);
    });
}

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
    console.log('[Supporters] Fetching patron/voter text lists...');
    triggerCleanup();

    try {
        const [patronData, voterData] = await Promise.all([
            fetchFile(PATRON_LIST_URL),
            fetchFile(VOTER_LIST_URL)
        ]);

        const newSet = new Set();
        
        // Process Patrons
        patronData.split(/\s+/).forEach(id => { if(id) newSet.add(id); });
        
        // Process Voters
        voterData.split(/\s+/).forEach(line => {
            const userId = line.split(',')[0];
            if (userId) newSet.add(userId);
        });

        textFileSupporters = newSet;
        console.log(`[Supporters] Loaded ${textFileSupporters.size} from text files.`);
    } catch (error) {
        console.error(`[Supporters] Failed to fetch text lists: ${error.message}`);
    }
}

// [THE FIX] Allow injecting IDs from Discord Subscriptions
function setApiSubscribers(idArray) {
    apiSubscriberIds = new Set(idArray);
    console.log(`[Supporters] Updated API Subscribers list. Count: ${apiSubscriberIds.size}`);
}

// [THE FIX] Check both lists
function isSupporter(userId) {
    return textFileSupporters.has(userId) || apiSubscriberIds.has(userId);
}

// [THE FIX] Return combined list
function getSupporterSet() {
    return new Set([...textFileSupporters, ...apiSubscriberIds]);
}

module.exports = {
    fetchSupporterIds,
    setApiSubscribers, // Export this new function
    isSupporter,
    getSupporterSet
};