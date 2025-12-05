// utils/supporterManager.js
const https = require('https');
const db = require('../db/database.js');

const WEBHOOK_URL = 'https://shaggyze.website/RelayBot/webhook.php';
const PATRON_LIST_URL = 'https://shaggyze.website/RelayBot/patrons.txt';
const VOTER_LIST_URL = 'https://shaggyze.website/RelayBot/voters.txt';

// Master list of User IDs (Patrons + Voters + Personal Subs)
let allSupporterIds = new Set();

// Cache of Guild IDs that contain at least one supporter
let supportedGuildsCache = new Set();

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
// 1. Fetch IDs from Text Files
async function fetchSupporterIds() {
    // Trigger PHP webhook cleanup if needed (fire and forget)
    console.log('[Supporters] Fetching patron/voter text lists...');
    triggerCleanup();

    try {
        const [patronData, voterData] = await Promise.all([
            fetchFile(PATRON_LIST_URL),
            fetchFile(VOTER_LIST_URL)
        ]);

        const newSet = new Set();
        patronData.split(/\s+/).forEach(id => { if(id) newSet.add(id); });
        voterData.split(/\s+/).forEach(line => {
            const userId = line.split(',')[0];
            if (userId) newSet.add(userId);
        });

        // Merge with existing API subscribers (handled by setApiSubscribers)
        // We do this by keeping a separate set for API subs internally if needed, 
        // or just trusting the flow. For now, let's just update the main set.
        // Note: To keep API subs from being wiped by text file updates, 
        // we should ideally store them separately.
        // For simplicity here, we assume setApiSubscribers merges INTO this.
        
        // Actually, let's keep the previous logic of two sets to be safe.
        textFileSupporters = newSet; 
        rebuildCombinedSet();
        
        console.log(`[Supporters] Loaded ${newSet.size} IDs from text files.`);
    } catch (error) {
        console.error(`[Supporters] Failed to fetch text lists: ${error.message}`);
    }
}

let textFileSupporters = new Set();
let apiSubscriberIds = new Set();

function setApiSubscribers(idArray) {
    apiSubscriberIds = new Set(idArray);
    rebuildCombinedSet();
}

function rebuildCombinedSet() {
    allSupporterIds = new Set([...textFileSupporters, ...apiSubscriberIds]);
}

function isSupporter(userId) {
    return textFileSupporters.has(userId) || apiSubscriberIds.has(userId);
}

// 2. [THE NEW FEATURE] Refresh Guild Cache
// This checks every guild the bot is in to see if any supporters are present.
async function refreshSupportedGuilds(client) {
    if (allSupporterIds.size === 0) return;
    
    console.log('[Supporters] Updating Supported Guilds Cache (Targeted Fetch)...');
    const newSupportedGuilds = new Set();
    const supporterArray = Array.from(allSupporterIds);

    // We chunk the supporters into batches of 100 (Discord API limit for fetch)
    // But since you only have ~5-10, we can send them all at once.
    
    for (const guild of client.guilds.cache.values()) {
        try {
            // THE MAGIC: Targeted Fetch.
            // "Discord, are any of THESE 5 people in THIS server?"
            // This is 1 API call per server, infinitely faster than fetching all members.
            const foundMembers = await guild.members.fetch({ user: supporterArray });
            
            if (foundMembers.size > 0) {
                newSupportedGuilds.add(guild.id);
            }
        } catch (error) {
            // If fetch fails, fall back to cache check just in case
            if (guild.members.cache.some(m => allSupporterIds.has(m.id))) {
                newSupportedGuilds.add(guild.id);
            }
        }
    }

    supportedGuildsCache = newSupportedGuilds;
    console.log(`[Supporters] Cache updated. ${supportedGuildsCache.size} guilds contain supporters.`);
}

// 3. The Check Function (Instant Access)
// Returns TRUE if the group is supported (via User Presence OR Guild Subscription)
function isGroupSupported(groupId) {
    // A. Check Guild Subscriptions (Database - Fast)
    const linkedGuilds = db.prepare('SELECT guild_id FROM linked_channels WHERE group_id = ?').all(groupId);
    
    // Check DB Subs
    for (const row of linkedGuilds) {
        const sub = db.prepare('SELECT 1 FROM guild_subscriptions WHERE guild_id = ? AND is_active = 1').get(row.guild_id);
        if (sub) return true;
    }

    // B. Check User Presence (Memory Cache - Instant)
    for (const row of linkedGuilds) {
        if (supportedGuildsCache.has(row.guild_id)) {
            return true;
        }
    }

    return false;
}

module.exports = {
    fetchSupporterIds,
    isSupporter,
    setApiSubscribers,
    refreshSupportedGuilds, // New export
    isGroupSupported,       // New export
    getSupporterSet: () => allSupporterIds
};