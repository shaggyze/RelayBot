// utils/supporterManager.js
const https = require('https');

// [NEW] Add URLs for both files.
const PATRON_LIST_URL = 'https://your-domain.com/path/to/patrons.txt'; // Replace with your URL
const VOTER_LIST_URL = 'https://your-domain.com/path/to/voters.txt';   // Replace with your URL

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
        });
    });
}

// Main function to fetch both lists and combine them.
async function fetchSupporterIds() {
    console.log('[Supporters] Fetching updated patron and voter lists...');
    
    // Fetch both files in parallel for speed.
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