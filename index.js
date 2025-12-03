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

try {
console.log('[DEBUG] Attempting to log in...');
client.login(process.env.DISCORD_TOKEN);
console.log('[DEBUG] index.js has finished executing. Awaiting login confirmation from the "ready" event...');
} catch (error) {
    console.error('[FATAL-CRASH] The application crashed during the client.login() call.', error);
    process.exit(1);
}