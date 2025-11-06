# RelayBot

<p align="center">
  <strong>A powerful and easy-to-use Discord bot for relaying messages, edits, deletes, and role pings between channels on one or more servers.</strong>
  <br />
  <br />
  <span>
  <a href="https://discord.gg/tbDeymDm2B"><img src="https://img.shields.io/badge/Discord-7289DA?style=for-the-badge&logo=discord&logoColor=white" alt="Join our Discord"/></a>
  </span>
</p>

RelayBot is designed for communities that span multiple Discord servers, like gaming alliances or project collaborations. It creates a seamless bridge, allowing members to communicate as if they were in the same channel.

## ✨ Key Features

- **Multi-Server Relaying:** Link channels from any number of servers into a single, shared communication group.
- **Directional Relays:** Configure channels to be Send-Only, Receive-Only, or Both Ways, perfect for announcements or log channels.
- **Full Message Syncing:** Messages, edits, deletes, replies, and attachments are all synced across relayed channels.
- **Dynamic Role Mapping:** Mention a role in one server, and RelayBot will intelligently ping the correctly mapped role in all other linked servers.
- **Automatic Role Syncing:** When linking a channel, the bot can automatically create any missing mapped roles and link existing ones by name, ensuring role pings always work (feature is opt-in).
- **Granular Deletion Toggles:** Separately control if deleting original messages deletes copies, and if deleting copies deletes the original.
- **Group Moderation:** Group owners can block abusive users or entire servers from being relayed, giving you full control over your shared space.
- **Customizable Branding:** Set a custom brand/tag for your server's relayed messages (e.g., `ShaggyZE [S1]`).
- **Public Statistics:** View activity and engagement stats for your relay group.
- **Easy Setup & Management:** All configuration is done through user-friendly `/` slash commands.
- **Scalable & Secure:** Built with a robust database backend to ensure every server's configuration is separate and secure.

## 🚀 Getting Started

There are two ways to use RelayBot: inviting an official public bot (if available) or self-hosting your own private instance for full control.

### Public-Hosting

- [top.gg](https://top.gg/bot/1397069734469435446) (public bot on railway.app)

### Self-Hosting (Recommended)

The easiest way to host your own bot is with Railway. The button below will guide you through setting up your own private instance.

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.com/deploy/HbhYGF?referralCode=hmJrvY)

For manual installation instructions and troubleshooting, please see the sections at the bottom of this guide.

## 🤖 Bot Usage Guide

Configuration is done via the `/relay` command. You must have the `Manage Server` permission.

### The Setup Workflow

The bot uses **global groups**. One server creates the group, and others link to it.

1.  **On ONE Server Only - Create a Global Group:**
    An admin on your "main" server creates the group. The name must be unique across all servers using this bot.
    - `/relay create_group name: my-super-unique-alliance`

2.  **On ALL Servers - Link Your Channels:**
    Admins on all participating servers can now link their channels to the *same* global group by name. You can specify a message direction, which is great for announcement or log channels!
    - `/relay link_channel group_name: my-super-unique-alliance direction: One Way (Send messages FROM this channel only)`

3.  **Map Roles: (Optional)**
    To sync role pings, map your server's roles to a shared "common name" within that group. This should be done on all servers that want to participate in role pings.
    - On Server A: `/relay map_role group_name: my-super-unique-alliance common_name: K30-31 role: @Kingdom-30-31`
    - On Server B: `/relay map_role group_name: my-super-unique-alliance common_name: K30-31 role: @K30-31`

4.  **Enable Auto-Role Syncing (Optional, Recommended):**
    For the easiest role management, you can have the bot automatically create and link roles for you.
    - First, enable the feature on your channel: `/relay toggle_auto_role`
    - Then, run the link command. The bot will now sync all mapped roles from the group to your server, creating new ones if they don't exist and linking existing ones by name.
    - **Already in a group?** No problem. Just run `/relay toggle_auto_role` to enable the feature, then run `/relay link_channel` again on your already-linked channel to trigger the sync.

### All Commands

- `/relay help`: Shows the setup guide.

**Group Management:**
- `/relay create_group`: Creates a new, unique global group.
- `/relay delete_group`: Deletes a global group (can only be run by the creating server).
- `/relay kick_server`: Forcibly remove a server from a group you own.
- `/relay list_servers`: See all servers currently in a group.
- `/relay block`: Blocks a user or server from being relayed in a group you own.
- `/relay unblock`: Unblocks a user or server from a group you own.

**Channel Management:**
- `/relay link_channel`: Links the current channel to a global group. If auto-role is enabled, this also syncs roles.
- `/relay unlink_channel`: Unlinks the current channel from its group.

**Role Mapping:**
- `/relay map_role`: Maps a server role to a common name.
- `/relay list_mappings`: Lists all configured role mappings for a group on this server.
- `/relay unmap_role`: Removes a specific role mapping.

**Settings:**
- `/relay set_direction`: Sets the direction of a channel from a group you own.
- `/relay set_brand`: Sets a custom server name/tag for messages from this channel.
- `/relay set_delete_delay`: Sets how long until relayed messages are auto-deleted (OFF by default).
- `/relay toggle_forward_delete`: Toggles if deleting an original message also deletes its copies (ON by default).
- `/relay toggle_reverse_delete`: Toggles if deleting a relayed copy also deletes the original message (OFF by default).
- `/relay toggle_auto_role`: Enables/disables automatic role creation and linking for this channel.

**Utility:**
- `/stats`: Shows public activity statistics for your group.
- `/invite`: Get a link to invite the bot to another server.
- `/version`: Check the bot's current version.
- `/vote`: Get links to vote for and support the bot.

---

<details>
<summary><strong>Manual Installation & Configuration</strong></summary>

If you prefer to host the bot yourself on a VPS or other service, follow these steps.

**Prerequisites:**
- A code editor like [VS Code](https://code.visualstudio.com/)

Before you begin, ensure you have the following software installed on your system.

1.  **Node.js:** This is the runtime environment for the bot.
    -   **Recommended Version:** v20.x (LTS) or higher.
    -   **We strongly recommend using a version manager** to avoid permission issues and easily switch versions:
        -   For Windows, use [nvm-windows](https://github.com/coreybutler/nvm-windows).
        -   For Mac/Linux, use [nvm](https://github.com/nvm-sh/nvm).

2.  **Build Tools for Native Modules:** The `better-sqlite3` database package requires C++ code to be compiled during installation.
    -   **On Windows:** The easiest way to get the necessary build tools is to install **Visual Studio 2022 Community**. During installation, make sure to select the **"Desktop development with C++"** workload.
    -   **On macOS:** Install the Xcode Command Line Tools by running `xcode-select --install` in your terminal.
    -   **On Debian/Ubuntu:** Install the necessary packages by running `sudo apt-get install -y build-essential python3`.

3.  **Git:** Required for cloning the repository. You can get it from [git-scm.com](https://git-scm.com/).


**1. Clone the Repository:**
```bash
git clone https://github.com/shaggyze/RelayBot.git
cd RelayBot
```

**2. Install Dependencies:**
This single command will download all the necessary Node.js packages like `discord.js`, `dotenv`, and `better-sqlite3`.
```bash
npm install
```

**3. Create a Discord Bot Application:**
- Go to the [Discord Developer Portal](https://discord.com/developers/applications).
- Click "New Application" and give it a name.
- Go to the "Bot" tab and click "Add Bot".
- **Crucially**, under the bot's username, enable **Privileged Gateway Intents** (Server Members and Message Content).
- Click "Reset Token" to reveal your bot's token. **Keep this secret!**
- On the "General Information" page, copy the **Application ID**.

**4. Configure Environment Variables:**
- Create a new file named `.env` in the project root.
- Open the `.env` file and fill in the required values:
  ```
  # Your Discord Bot Token from the Developer Portal
  DISCORD_TOKEN=YourBotTokenGoesHere

  # Your Bot's Application/Client ID from the "General Information" page
  CLIENT_ID=YourBotClientIDGoesHere
  
  # The ID of your private/developer/support server
  DEV_GUILD_ID=1397170407580237944
  ```

**5. Deploy Slash Commands:**
Run this command once to register the bot's slash commands with Discord.
```bash
npm run deploy
```

**6. Start the Bot:**
```bash
npm start
```

For 24/7 hosting on a VPS, it is highly recommended to use a process manager like `pm2`.

**7. Inviting Your Bot to a Server:**
After deploying your bot, it is running but hasn't joined any servers yet. Use the manual link generation method to get it into your first server.

1.  Go to the **Discord Developer Portal -> [Your App] -> OAuth2 -> URL Generator**.
2.  In "Scopes", check **`bot`** and **`applications.commands`**.
3.  In "Bot Permissions", check: `View Channel`, `Send Messages`, `Read Message History`, `Manage Webhooks`, `Manage Messages`, `Manage Roles`, `Embed Links` and `Attach Files`.
4.  Copy the generated URL and use it to invite the bot.

Once the bot is in one server, you can simply use the `/invite` command to get a clean invite link for other servers.
</details>

<details>
<summary><strong>Troubleshooting</strong></summary>

**_I get a big red error during `npm install` on Windows (better-sqlite3 / node-gyp)_**

If you see a long error log during `npm install` that mentions `better-sqlite3`, `node-gyp rebuild`, and C++ errors, it is almost certainly a Node.js version incompatibility.

**Cause:** This happens when you are using a brand-new or unstable version of Node.js. Many packages that rely on native C++ code, like our database driver, are only compatible with stable, Long-Term Support (LTS) versions.

**Solution:** The fix is to use a Node Version Manager to install and switch to the recommended LTS version.

1.  **Install a Node Version Manager:**
    -   Download and run the installer for **[nvm-windows](https://github.com/coreybutler/nvm-windows/releases)**.

2.  **Switch to the Stable LTS Version:**
    -   Open a **new terminal as an Administrator**.
    -   Install the latest Long-Term Support (LTS) version: `nvm install lts`
    -   Tell nvm to use it: `nvm use lts`
    -   Verify the change with `node -v`. It should now show a stable version (e.g., `v20.x.x`).

3.  **Perform a Clean Installation:**
    -   It's crucial to delete the old, broken files. In your project directory, run:
        ```bash
        rmdir /s /q node_modules
        del package-lock.json
        ```
    -   Now, run the installation again: `npm install`
</details>

---

### Legal & Licensing

Your use of RelayBot is subject to the following legal documents. By adding the bot to your server, you are agreeing to these terms.

<details>
<summary>documents</summary>

*   **[Terms & Conditions](https://shaggyze.website/RelayBot/terms-conditions.php)**: Outlines the rules for using the bot, acceptable use, and our disclaimers.
*   **[Privacy Policy](https://shaggyze.website/RelayBot/privacy-policy.php)**: Details what data the bot collects, how it is used, and your rights regarding that data.
*   **[ISC License](https://shaggyze.website/RelayBot/license.php)**: RelayBot is open-source software. This license grants you broad permissions to use, modify, and distribute the software.

The bot is provided "as is", without warranty of any kind.
</details>

---
*This bot was originally conceived by [YuRaNnNzZZ](https://github.com/YuRaNnNzZZ/discord-message-relay-bot) then ShaggyZE and has been refactored for public use.*