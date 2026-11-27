# Reactive Portraits

A self-hosted controller and OBS browser overlay for tabletop campaigns. Mark a speaker manually, or use the optional Discord desktop RPC bridge or bot bridge to highlight whoever is speaking. Manage campaigns and participants in the controller instead of editing source code.

## What it does

- Add, edit, and remove campaigns in the web interface.
- Add participants, assign Discord user IDs, and point each portrait to an image in `assets/`.
- Use one controller to switch campaigns; the bridge follows the selected campaign's Discord voice channel.
- Choose local Discord RPC speaker detection without adding a bot to your voice channel, or use the bot bridge as an alternative.
- Load current voice channel members into a participant dropdown and map them to portraits.
- Mark a speaker manually, dim absent players, and adjust each portrait's zoom and crop.
- Open a separate, transparent OBS overlay for the selected campaign.
- Store campaign setup and portrait adjustments locally on the streaming computer.

The server binds to `127.0.0.1` and is intended for use on the same computer as OBS. It has no cloud service or account.

## Requirements

- Node.js 20 or newer.
- OBS Studio, if you want to use the overlay.
- A Discord application configured for RPC, only if you want local RPC voice activity.
- A Discord bot application, only if you choose the bot voice bridge.

## Start the controller

1. Download or clone this repository.
2. In the project directory, run `npm install`.
3. Run `npm start`.
4. Open [http://127.0.0.1:8766](http://127.0.0.1:8766) in a browser.
5. Click **Manage campaigns** to edit the example campaign or create your own.

To use a portrait, copy its image into the project's `assets/` folder and enter a relative path such as `assets/aragorn.png`. PNG, JPG, WebP, GIF, AVIF, and SVG images are supported. The repository includes a generic placeholder image.

The controller creates `campaigns.json` and `reactive-state.json` on first run. Both files are local runtime data and are excluded from Git. Back them up if you want to preserve your campaign list and crop settings.

## Add the overlay to OBS

1. Start the controller.
2. Select a campaign and click **Open OBS overlay**.
3. Copy the address from the new tab into an OBS **Browser** source.
4. Set the source dimensions to match your scene. The overlay arranges participants in one row and adjusts to the campaign roster.

Keep the controller and overlay on the same machine. Both connect to the local server at port `8766`.

## Enable automatic Discord speaker detection

### Local Discord RPC (recommended for a single stream computer)

This connects to the Discord desktop app running on the same computer. It does not join voice or send audio as a bot. Discord's RPC interface can emit speaking start/stop events for a subscribed voice channel. RPC access for an unapproved application is limited to application testers, so each person using this app must be on the app's tester list unless Discord approves the application. See [Discord's RPC documentation](https://discord.com/developers/docs/topics/rpc).

1. In the [Discord Developer Portal](https://discord.com/developers/applications), create an application. Copy its Application ID and client secret.
2. In the application's RPC settings, register the RPC origin `http://127.0.0.1:8766` and redirect URI `http://127.0.0.1/callback`.
3. Copy `discord-rpc.config.example.json` to `discord-rpc.config.json`, then enter the Application ID and client secret. Keep the listed scopes, including `rpc.voice.read`.
4. In the controller, set the campaign voice channel ID. Start Discord desktop, join the channel, and start the local controller.
5. Run `npm run rpc` in a second terminal and approve the authorization prompt from Discord.
6. In **Manage campaigns**, click **Load Discord users**, then choose the matching Discord user from each participant's **Discord speaker** dropdown. Save the campaign.

The RPC bridge only maps accounts that are presently visible in the selected voice channel's member list. Load users again when you need to assign a person who is not currently in the channel. When switching campaigns, RPC follows the selected campaign's channel.

Never share or commit `discord-rpc.config.json`. It contains your application client secret and is excluded from Git. Discord may require you to add yourself as an application tester before the authorization flow works.

### Discord bot bridge

The optional bridge uses a bot that joins the configured voice channel and listens for Discord's voice activity events. The bot does not transmit audio. Each participant is matched using their Discord user ID.

1. Create a bot in the [Discord Developer Portal](https://discord.com/developers/applications), copy its token, and invite it to your server with permission to view and connect to the campaign voice channels.
2. Copy `discord-bridge.config.example.json` to `discord-bridge.config.json`. Enter the bot token and Discord server ID in the new file.
3. In the controller's campaign editor, set the voice channel ID and each participant's Discord user ID.
4. With the controller running, run `npm run bridge` in a second terminal.

Do not share `discord-bridge.config.json` or commit it. It is excluded from Git. Never post a bot token publicly; reset it in the Developer Portal if it is exposed.

The bridge follows whichever campaign is selected in the controller and switches to that campaign's channel. If the bridge is stopped, manual speaker selection still works.

## Optional Foundry combat indicators

Requires Greene Gaming Stream Director v0.4.9 and Chrome on the same computer as this local server. The integration is opt-in per campaign and does not modify Discord speaker detection. Health and active-turn indicators appear only for mapped characters participating in active combat, and clear when combat ends or data expires.

1. Start the local controller at its default port 8766. Select the campaign, open Manage campaigns and enable Foundry integration, with health bars and active-turn indicators as desired. Save.
2. In Foundry GM settings, enable **GM portrait integration API**, select the approved PCs, and optionally enable health. The observer API and observer roster-mode switch are not required; the observer can remain entirely in OBS.
3. In Chrome, open chrome://extensions, enable Developer mode, choose Load unpacked and select this project's extension folder.
4. On the local controller click Pair Foundry. Copy the campaign ID and pairing key. On the Foundry GM tab open the extension popup, paste both values and click Connect this GM tab.
5. In the campaign editor click Load Foundry actors. In each participant's Foundry actor UUID field select the matching UUID (or paste manually). Save the campaign. Leave the GM unmapped.

The extension accesses only the explicitly selected GM browser tab, uses Stream Director's event subscription and sends a short heartbeat to the loopback server. Data expires after 12 seconds without updates; no HP is saved to disk. The extension pairing is session-local; reconnect after Chrome or server restarts, navigation/refresh if the permission is lost, or switching campaigns. Rotate the key in the pairing dialog to revoke previous bridges. No external service, remote server or Foundry account credential is used. The extension is unpacked development software, not a Chrome Web Store release. Live testing on Forge and OBS is required.

## Configuration and files

| File | Purpose | Tracked in Git? |
| --- | --- | --- |
| `campaigns.example.json` | Safe starter data | Yes |
| `campaigns.json` | Your campaign and participant setup | No |
| `reactive-state.json` | Current campaign, absent flags, and crop adjustments | No |
| `discord-bridge.config.example.json` | Bot configuration template | Yes |
| `discord-bridge.config.json` | Your bot token and server ID | No |
| `discord-rpc.config.example.json` | Discord RPC configuration template | Yes |
| `discord-rpc.config.json` | Your Discord application credentials | No |
| `assets/` | Portrait images | Yes, if you choose to add and share them |

Use one automatic speaker source at a time. The RPC bridge requires the Discord desktop client; the bot bridge joins voice as a bot. Manual speaker selection remains available with either bridge stopped.

## Troubleshooting

- **Page does not open:** make sure `npm start` is still running and that port `8766` is free.
- **Image is missing:** verify the relative path in the campaign editor and that the image exists under `assets/`.
- **Bridge does not connect:** verify the token, server ID, voice channel ID, and bot permissions. Start the local controller before starting the bridge.
- **RPC bridge cannot connect:** make sure Discord desktop is running, the RPC origin and redirect URI exactly match the application settings, and the application is approved or your account is listed as a tester.
- **RPC authorization fails:** check the application ID, client secret, configured redirect URI, and required RPC scopes.
- **Discord user dropdown is empty:** start either automatic speaker bridge, wait a few seconds, and click **Load Discord users** again. The RPC bridge lists the members Discord currently shows in the selected voice channel.
- **A participant never lights up:** verify that the correct Discord account is selected in that participant's **Discord speaker** dropdown.

## License

The application source is released under the MIT License. Portrait images you add remain subject to their own licenses and permissions.
