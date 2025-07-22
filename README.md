# RelayBot

<p align="center">
  <strong>A powerful and easy-to-use Discord bot for relaying messages, edits, deletes, and role pings between channels on different servers.</strong>
  <br />
  <br />
  <a href="https://discord.gg/tbDeymDm2B"><img src="https://img.shields.io/badge/Discord-7289DA?style=for-the-badge&logo=discord&logoColor=white" alt="Join our Discord"/></a>
</p>

RelayBot is designed for communities that span multiple Discord servers, like gaming alliances or project collaborations. It creates a seamless bridge, allowing members to communicate as if they were in the same channel.

## ✨ Key Features

- **Multi-Server Relaying:** Link channels from any number of servers into a single, shared communication group.
- **Full Message Syncing:** Messages, edits, deletes, replies, and attachments are all synced across relayed channels.
- **Dynamic Role Mapping:** Mention a role in one server, and RelayBot will intelligently ping the correctly mapped role in all other linked servers.
- **Auto-Role Creation:** If a mapped role doesn't exist on a target server, the bot will automatically create it for you.
- **Reverse Deletion (Opt-in):** Configure the bot to delete the original message if a relayed copy is deleted.
- **Server Context:** Relayed messages clearly show the sender's name and their original server (e.g., `ShaggyZE (Server A)`).
- **Easy Setup:** All configuration is done through user-friendly \`/\` slash commands. No coding required.
- **Scalable & Secure:** Built with a robust database backend to ensure every server's configuration is separate and secure.

## 🚀 Getting Started

There are two ways to use RelayBot: inviting an official public bot (if available) or self-hosting your own private instance for full control.

### Self-Hosting (Recommended)

The easiest way to host your own bot is with Railway. The button below will guide you through setting up your own private instance.

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/new/template?template=https%3A%2F%2Fgithub.com%2Fshaggyze%2FRelayBot&envs=DISCORD_TOKEN,CLIENT_ID&DISCORD_TOKENDesc=Your+Discord+bot+token.&CLIENT_IDDesc=Your+bot's+application+ID)

#### Manual Installation & Configuration

If you prefer to host the bot yourself on a VPS or other service, follow these steps.

**Prerequisites:**
- [Node.js](https://nodejs.org/en/) (v20.x LTS is highly recommended)
- A code editor like [VS Code](https://code.visualstudio.com/)

**1. Clone the Repository:**
\`\`\`bash
git clone https://github.com/shaggyze/RelayBot.git
cd RelayBot
\`\`\`

**2. Install Dependencies:**
\`\`\`bash
npm install
\`\`\`

**3. Create a Discord Bot Application:**
- Go to the [Discord Developer Portal](https://discord.com/developers/applications).
- Click "New Application" and give it a name.
- Go to the "Bot" tab and click "Add Bot".
- Under the bot's username, enable all three **Privileged Gateway Intents** (Presence, Server Members, and Message Content).
- Click "Reset Token" to reveal your bot's token. **Keep this secret!**
- On the "General Information" page, copy the **Application ID**.

**4. Configure Environment Variables:**
- Create a new file named \`.env\` in the project root.
- Open the \`.env\` file and fill in the required values:
  \`\`\`
  # Your Discord Bot Token from the Developer Portal
  DISCORD_TOKEN=YourBotTokenGoesHere

  # Your Bot's Application/Client ID from the "General Information" page
  CLIENT_ID=YourBotClientIDGoesHere
  \`\`\`

**5. Deploy Slash Commands:**
Run this command once to register the bot's slash commands with Discord.
\`\`\`bash
npm run deploy
\`\`\`

**6. Start the Bot:**
\`\`\`bash
npm start
\`\`\`

For 24/7 hosting on a VPS, it is highly recommended to use a process manager like \`pm2\`.

**7. Inviting Your Bot to a Server:**
After deploying your bot, it is running but hasn't joined any servers yet. Use the manual link generation method to get it into your first server.

1.  Go to the **Discord Developer Portal -> [Your App] -> OAuth2 -> URL Generator**.
2.  In "Scopes", check **\`bot\`** and **\`applications.commands\`**.
3.  In "Bot Permissions", check: \`Manage Roles\`, \`Manage Webhooks\`, \`Manage Messages\`, \`Read Message History\`, \`Send Messages\`, and \`View Channel\`.
4.  Copy the generated URL and use it to invite the bot.

Once the bot is in one server, you can simply use the \`/invite\` command to get a clean invite link for other servers.


## 🤖 Bot Usage Guide

Configuration is done via the \`/relay\` command. You must have the \`Manage Server\` permission.

### The Setup Workflow

The bot now uses **global groups**. One server creates the group, and others link to it.

1.  **On ONE Server Only - Create a Global Group:**
    An admin on your "main" server creates the group. The name must be unique across all servers using this bot.
    - \`/relay create_group name: my-super-unique-alliance\`

2.  **On ALL Servers - Link Your Channels:**
    Admins on Server A, Server B, etc., can now link their channels to the *same* global group by name.
    - \`/relay link_channel group_name: my-super-unique-alliance\`

3.  **Map Roles (Optional):**
    To sync role pings, map your server's roles to a shared "common name" within that group.
    - On Server A: \`/relay map_role group_name: my-super-unique-alliance common_name: Team Leaders role: @Leaders\`
    - On Server B: \`/relay map_role group_name: my-super-unique-alliance common_name: Team Leaders role: @Squad-Leads\`

### All Commands

- \`/relay help\`: Shows the setup guide.

**Group Management:**
- \`/relay create_group\`: Creates a new, unique global group.
- \`/relay delete_group\`: Deletes a global group (can only be run by the creating server).

**Channel Management:**
- \`/relay link_channel\`: Links the current channel to a global group.
- \`/relay unlink_channel\`: Unlinks the current channel from its group.

**Role Mapping:**
- \`/relay map_role\`: Maps a server role to a common name.
- \`/relay list_mappings\`: Lists all configured role mappings for a group on this server.
- \`/relay unmap_role\`: Removes a specific role mapping.

**Settings:**
- \`/relay set_delete_delay\`: Sets how long until relayed messages are auto-deleted.
- \`/relay toggle_reverse_delete\`: Toggles if deleting a relayed message also deletes the original message (off by default).

**Utility:**
- \`/invite\`: Get a link to invite the bot to another server.
- \`/version\`: Check the bot's current version.

---
*This bot was originally conceived by YuRaNnNzZZ and ShaggyZE and has been refactored for public use.*