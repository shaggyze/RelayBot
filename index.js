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
    // [PRO FEATURE] Increase internal cache limits to reduce API fetching
    makeCache: Options.cacheWithLimits({
        MessageManager: 50, // Keep message cache low to save RAM
        GuildMemberManager: {
            maxSize: 200,
            keepOverLimit: member => member.id === client.user.id,
        },
    }),
});

// --- [NEW] Rate Limit Monitoring ---
client.rest.on('rateLimited', (info) => {
    console.warn(`[RATE-LIMIT] Hit a rate limit! 
    Global: ${info.global} 
    Method: ${info.method} 
    Path: ${info.route} 
    Timeout: ${info.timeToReset}ms 
    Limit: ${info.limit}`);
});

// --- [NEW] Anti-Crash (Prevents Login Loops) ---
process.on('unhandledRejection', (reason, promise) => {
    console.error('[ANTI-CRASH] Unhandled Rejection:', reason);
    // Do NOT exit the process. Keeping it alive prevents login-loop bans.
});

process.on('uncaughtException', (error) => {
    console.error('[ANTI-CRASH] Uncaught Exception:', error);
    // Do NOT exit the process.
});

// Log every debug message from discord.js
//client.on('debug', console.log);
// Log any warnings
client.on('warn', console.log);
// Log any general errors
client.on('error', console.error);
// --- END DIAGNOSTIC STEP ---

try {
    console.log('[DEBUG] Loading commands...');
    client.commands = new Collection();
    const commandsPath = path.join(__dirname, 'commands');
    const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));
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

try {
    console.log('[DEBUG] Loading events...');
    const eventsPath = path.join(__dirname, 'events');
    const eventFiles = fs.readdirSync(eventsPath).filter(file => file.endsWith('.js'));
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
    console.error('[FATAL-CRASH] The application crashed while loading events.', error);
    process.exit(1);
}

try {
    console.log('[DEBUG] Attempting to log in...');
    client.login(process.env.DISCORD_TOKEN);
} catch (error) {
    console.error('[FATAL-CRASH] The application crashed during the client.login() call.', error);
    process.exit(1);
}

console.log('[DEBUG] index.js has finished executing. Awaiting login confirmation from the "ready" event...');