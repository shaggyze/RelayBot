# RelayBot

<p align="center">
  <strong>A powerful and easy-to-use Discord bot for relaying messages, embeds, and role pings between channels on different servers.</strong>
  <br />
  <br />
  <a href="https://railway.app/new/template?template=https%3A%2F%2Fgithub.com%2Fshaggyze%2FRelayBot&envs=DISCORD_TOKEN,CLIENT_ID&DISCORD_TOKENDesc=Your+Discord+bot+token.&CLIENT_IDDesc=Your+bot's+application+ID."><img src="https://railway.app/button.svg" alt="Deploy on Railway"/></a>
</p>

is designed for communities that span multiple Discord servers, like gaming alliances or project collaborations. It creates a seamless bridge, allowing members to communicate as if they were in the same channel, complete with role-mention syncing.

## ✨ Key Features

- **Multi-Server Relaying:** Link channels from any number of servers into a single, shared communication group.
- **Dynamic Role Mapping:** Mention a role in one server, and will intelligently ping the correctly mapped role in all other linked servers.
- **Auto-Role Creation:** If a mapped role doesn't exist on a target server, the bot will automatically create it for you.
- **Full Message Support:** Relays text, embeds, attachments, and replies.
- **Configurable Message Deletion:** Automatically clean up relayed messages after a set number of hours to keep channels tidy.
- **Easy Setup:** All configuration is done through user-friendly \`/\` slash commands. No coding required.
- **Scalable & Secure:** Built with a robust database backend to ensure every server's configuration is separate and secure.

## 🚀 Getting Started

There are two ways to use RelayBot: inviting the official public bot (if available) or self-hosting your own private instance for full control.

### Self-Hosting (Recommended)

The easiest way to host your own bot is with Railway. Click the button below to deploy your own instance in just a few minutes.

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/new/template?template=https%3A%2F%2Fgithub.com%2Fshaggyze%2FRelayBot&envs=DISCORD_TOKEN,CLIENT_ID&DISCORD_TOKENDesc=Your+Discord+bot+token.&CLIENT_IDDesc=Your+bots+application+ID.)

#### Manual Installation & Configuration

If you prefer to host the bot yourself on a VPS or other service, follow these steps.

**Prerequisites:**
- [Node.js](https://nodejs.org/en/) (v16.9.0 or higher)
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
- Click "New Application" and give it a name (e.g., "My RelayBot").
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

After deploying your bot (either on Railway or manually), it is running online, but it hasn't joined any servers yet. You need to invite it using a special link.

There are two ways to get this link:

#### Method 1: The First Invite (Manual Link Generation)

You need to do this once to get the bot into your first server.

1.  Go to the [Discord Developer Portal](https://discord.com/developers/applications) and select your application.
2.  Go to the **OAuth2 -> URL Generator** page from the left-hand menu.
3.  In the "Scopes" box, check both **\`bot\`** and **\`applications.commands\`**. A new "Bot Permissions" box will appear below.
    
4.  In the "Bot Permissions" box, check the following permissions:
    - \`Manage Roles\`
    - \`Manage Webhooks\`
    - \`View Channels\`
    - \`Send Messages\`
    - \`Manage Messages\`
    - \`Read Message History\`
    
5.  Scroll down to the "Generated URL" box. Copy this URL.
6.  Paste the URL into your browser, choose a server you manage, and complete the authorization process.

Your bot will now be in your server!

#### Method 2: The Easy Way (Using the \`/invite\` Command)

Once your bot is in at least one server, you can easily get its invite link at any time.

-   Simply type \`/invite\` in any channel where the bot is present.
-   The bot will reply with a clean, pre-configured invite link that you can share with others.


## 🤖 Bot Usage Guide

Once the bot is in your servers, all configuration is done with the \`/relay\` command. You must have the \`Manage Server\` permission to use these commands.

### The Setup Workflow

1.  **Create a Group:** An admin on **Server A** and **Server B** must both create a relay group with the *exact same name*.
    - \`/relay create_group name: my-cool-alliance\`

2.  **Link Channels:** In the channels you want to connect, use the link command.
    - On Server A: \`/relay link_channel group_name: my-cool-alliance\`
    - On Server B: \`/relay link_channel group_name: my-cool-alliance\`

3.  **Map Roles (Optional):** To sync role pings, map your server's roles to a shared "common name".
    - On Server A: \`/relay map_role group_name: my-cool-alliance common_name: Team Leaders role: @Leaders\`
    - On Server B: \`/relay map_role group_name: my-cool-alliance common_name: Team Leaders role: @Squad-Leads\`

Now, when a user pings \`@Leaders\` in Server A, the bot will ping \`@Squad-Leads\` in Server B!

### All Commands

- \`/relay help\`: Shows the setup guide.
- \`/relay create_group\`: Creates a new relay group.
- \`/relay link_channel\`: Links the current channel to a group.
- \`/relay unlink_channel\`: Unlinks the current channel.
- \`/relay map_role\`: Maps a server role to a common name for a group.
- \`/relay unmap_role\`: Removes a role mapping.
- \`/relay set_delete_delay\`: Sets how many hours until relayed messages are auto-deleted (0 to disable).
- \`/invite\`: Get a link to invite the bot to another server.
- \`/version\`: Check the bot's current version.

---
*This bot was originally conceived by YuRaNnNzZZ and ShaggyZE and has been refactored for public use.*