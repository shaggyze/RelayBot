// index.js
const fs = require('fs');
const path = require('path');
const { Client, Collection, GatewayIntentBits, Options } = require('discord.js');
require('dotenv').config();

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildWebhooks,
        GatewayIntentBits.GuildMembers
    ],
    makeCache: Options.cacheWithLimits({
        MessageManager: 50,
        GuildMemberManager: {
            maxSize: 200,
            keepOverLimit: member => member.id === client.user.id,
        },
    }),
});

// --- [THE FIX] Enhanced Rate Limit Monitoring ---
client.rest.on('rateLimited', (info) => {
    // Try to extract context from the URL
    const url = info.url;
    let context = 'Unknown Context';
    let contextId = 'N/A';

    if (url.includes('/webhooks/')) {
        const match = url.match(/\/webhooks\/(\d+)/);
        context = 'Webhook';
        contextId = match ? match[1] : 'Unknown';
    } else if (url.includes('/channels/')) {
        const match = url.match(/\/channels\/(\d+)/);
        context = 'Channel';
        contextId = match ? match[1] : 'Unknown';
    } else if (url.includes('/guilds/')) {
        const match = url.match(/\/guilds\/(\d+)/);
        context = 'Guild';
        contextId = match ? match[1] : 'Unknown';
    }

    console.warn(`
[RATE-LIMIT] ⚠️ Hit a limit!
    • Type:     ${info.global ? 'GLOBAL (Danger!)' : 'Local Route'}
    • Target:   ${context} (ID: ${contextId})
    • Method:   ${info.method} (Action)
    • Path:     ${info.route}
    • Timeout:  ${info.timeToReset}ms
    • Limit:    ${info.limit}
`);
});

// --- Anti-Crash ---
process.on('unhandledRejection', (reason, promise) => {
    console.error('[ANTI-CRASH] Unhandled Rejection:', reason);
});

process.on('uncaughtException', (error) => {
    console.error('[ANTI-CRASH] Uncaught Exception:', error);
});

// Log every debug message from discord.js
//client.on('debug', console.log);
// Log any warnings
client.on('warn', console.log);
// Log any general errors
client.on('error', console.error);
// --- END DIAGNOSTIC STEP ---

console.log('[DEBUG] index.js starting...');
console.log('[DEBUG] Requiring database...');
require('./db/database.js'); 
console.log('[DEBUG] Database require() successful.');

client.commands = new Collection();
const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));

try {
    console.log('[DEBUG] Loading commands...');
for (const file of commandFiles) {
    const filePath = path.join(commandsPath, file);
    const command = require(filePath);
    if ('data' in command && 'execute' in command) {
        client.commands.set(command.data.name, command);
    }
}
console.log(`[DEBUG] Successfully loaded ${client.commands.size} commands.`);
} catch (error) {
    console.error('[FATAL-CRASH] The application crashed while loading commands.', error);
    process.exit(1);
}

const eventsPath = path.join(__dirname, 'events');
const eventFiles = fs.readdirSync(eventsPath).filter(file => file.endsWith('.js'));

try {
    console.log('[DEBUG] Loading events...');
for (const file of eventFiles) {
    const filePath = path.join(eventsPath, file);
    const event = require(filePath);
    if (event.once) {
        client.once(event.name, (...args) => event.execute(...args));
    } else {
        client.on(event.name, (...args) => event.execute(...args));
    }
}
console.log(`[DEBUG] Successfully loaded ${eventFiles.length} events.`);
} catch (error) {
    console.error('[FATAL-CRASH] The application crashed while loading events or logging in.', error);
    process.exit(1);
}

// [THE FIX] Robust Login with Retry System & Ban Detection
const loginWithRetry = async () => {
    try {
        console.log('[DEBUG] Attempting to log in...');
        await client.login(process.env.DISCORD_TOKEN);
        console.log('[DEBUG] Login call completed. Waiting for "Ready" event...');
    } catch (error) {
        console.error('[LOGIN-FATAL] Login failed:', error.message);

        // --- [NEW] Ban/Rate Limit Detection ---
        // Check for common signs of a Discord 429 ban
        const isRateLimit = 
            error.message.includes('429') || 
            error.message.includes('Too Many Requests') || 
            (error.rawError && error.rawError.code === 429) ||
            error.status === 429;

        if (isRateLimit) {
            console.error('\n!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
            console.error('[BAN CONFIRMED] 🚨 A 429 RATE LIMIT WAS DETECTED DURING LOGIN.');
            console.error('This usually means the IP is temporarily banned by Cloudflare.');
            console.error('Initiating 15-minute cooldown to allow the ban to expire.');
            console.error('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n');
        } else {
            console.warn('[LOGIN-WARNING] Login failed for a reason other than explicit 429.');
            console.warn('Waiting 15 minutes regardless, to be safe and prevent restart loops.');
        }
        
        // 15 Minutes = 15 * 60 * 1000 = 900,000 ms
        const retryDelay = 15 * 60 * 1000; 
        
        console.warn(`[LOGIN-RETRY] Bot will sleep for 15 minutes.`);
        console.warn(`[LOGIN-RETRY] Next login attempt: ${new Date(Date.now() + retryDelay).toLocaleTimeString()}`);

        // Use setTimeout to retry recursively without crashing the process
        setTimeout(() => {
            console.log('[LOGIN-RETRY] Waking up! Trying to log in again...');
            loginWithRetry();
        }, retryDelay);
    }
};

// Start the login process
loginWithRetry();