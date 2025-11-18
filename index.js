// index.js
const fs = require('fs');
const path = require('path');
const { Client, Collection, GatewayIntentBits } = require('discord.js');
require('dotenv').config();

console.log('[DEBUG] index.js starting...');

// --- [DIAGNOSTIC STEP 1] Add detailed debug listeners ---
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildWebhooks,
        GatewayIntentBits.GuildMembers
    ],
});

// Log every debug message from discord.js
client.on('debug', console.log);
// Log any warnings
client.on('warn', console.log);
// Log any general errors
client.on('error', console.error);
// --- END DIAGNOSTIC STEP ---


console.log('[DEBUG] Requiring database...');
require('./db/database.js'); 
console.log('[DEBUG] Database require() successful.');


client.commands = new Collection();
const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));

console.log('[DEBUG] Loading commands...');
for (const file of commandFiles) {
    const filePath = path.join(commandsPath, file);
    const command = require(filePath);
    if ('data' in command && 'execute' in command) {
        client.commands.set(command.data.name, command);
    }
}
console.log(`[DEBUG] Successfully loaded ${client.commands.size} commands.`);

const eventsPath = path.join(__dirname, 'events');
const eventFiles = fs.readdirSync(eventsPath).filter(file => file.endsWith('.js'));

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

console.log('[DEBUG] Attempting to log in...');
client.login(process.env.DISCORD_TOKEN);

console.log('[DEBUG] index.js has finished executing. Awaiting login confirmation from the "ready" event...');