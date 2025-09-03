// deploy-commands.js
require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const { REST } = require('@discordjs/rest');
const { Routes } = require('discord-api-types/v10');

// --- Environment Variable Check ---
const { CLIENT_ID, DISCORD_TOKEN, DEV_GUILD_ID } = process.env;
if (!CLIENT_ID || !DISCORD_TOKEN || !DEV_GUILD_ID) {
    console.error('Error: CLIENT_ID, DISCORD_TOKEN, and DEV_GUILD_ID must be provided in the .env file.');
    process.exit(1);
}

// --- Command Separation Logic ---
const globalCommands = [];
const devCommands = [];
const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));

for (const file of commandFiles) {
    const command = require(`./commands/${file}`);
    if (file === 'owner.js') {
        // If the file is owner.js, add it to the dev/guild list.
        devCommands.push(command.data.toJSON());
    } else {
        // Otherwise, add it to the global list.
        globalCommands.push(command.data.toJSON());
    }
}

const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

// --- Deployment Logic ---
(async () => {
    try {
        // 1. Deploy Global Commands
        console.log(`Started refreshing ${globalCommands.length} global application (/) commands.`);
        const globalData = await rest.put(
            Routes.applicationCommands(CLIENT_ID),
            { body: globalCommands },
        );
        console.log(`Successfully reloaded ${globalData.length} global commands.`);

        // 2. Deploy Developer/Guild Commands
        console.log(`Started refreshing ${devCommands.length} developer commands on server ${DEV_GUILD_ID}.`);
        const devData = await rest.put(
            Routes.applicationGuildCommands(CLIENT_ID, DEV_GUILD_ID),
            { body: devCommands },
        );
        console.log(`Successfully reloaded ${devData.length} developer commands.`);

    } catch (error) {
        console.error(error);
    }
})();