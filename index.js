// index.js
const fs = require('fs');
const path = require('path');
const { Client, Collection, GatewayIntentBits } = require('discord.js');
require('dotenv').config();

// [DIAGNOSTIC] Add global error handlers to catch anything that slips through.
process.on('uncaughtException', (err, origin) => {
    console.error('!!!!!!!!!! UNCAUGHT EXCEPTION !!!!!!!!!');
    console.error(`Caught exception: ${err}\n` + `Exception origin: ${origin}`);
    console.error(err.stack);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('!!!!!!!!!! UNHANDLED REJECTION !!!!!!!!!');
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

console.log('[DEBUG] index.js starting...');

console.log('[DEBUG] Requiring database...');
require('./db/database.js'); 
console.log('[DEBUG] Database require() successful.');
try {
    console.log('[DEBUG] Requiring database...');
    require('./db/database.js');
    console.log('[DEBUG] Database require() successful.');
} catch (error) {
    console.error('[FATAL-CRASH] The application crashed while loading the database file.', error);
    process.exit(1); // Exit immediately if the DB fails
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildWebhooks,
        GatewayIntentBits.GuildMembers
    ],
    rest: {
        retries: 3,
    },
});

// Log every debug message from discord.js
client.on('debug', console.log);
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