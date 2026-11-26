# Reactive Portraits

A self-hosted controller and OBS browser overlay for tabletop campaigns. Mark a speaker manually, or run the optional Discord bot bridge to highlight whoever is speaking. Manage campaigns and participants in the controller instead of editing source code.

## What it does

- Add, edit, and remove campaigns in the web interface.
- Add participants, assign Discord user IDs, and point each portrait to an image in `assets/`.
- Use one controller to switch campaigns; the bridge follows the selected campaign's Discord voice channel.
- Mark a speaker manually, dim absent players, and adjust each portrait's zoom and crop.
- Open a separate, transparent OBS overlay for the selected campaign.
- Store campaign setup and portrait adjustments locally on the streaming computer.

The server binds to `127.0.0.1` and is intended for use on the same computer as OBS. It has no cloud service or account.

## Requirements

- Node.js 20 or newer.
- OBS Studio, if you want to use the overlay.
- A Discord bot application, only if you want automatic voice activity.

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

The optional bridge uses a bot that joins the configured voice channel and listens for Discord's voice activity events. The bot does not transmit audio. Each participant is matched using their Discord user ID.

1. Create a bot in the [Discord Developer Portal](https://discord.com/developers/applications), copy its token, and invite it to your server with permission to view and connect to the campaign voice channels.
2. Copy `discord-bridge.config.example.json` to `discord-bridge.config.json`. Enter the bot token and Discord server ID in the new file.
3. In the controller's campaign editor, set the voice channel ID and each participant's Discord user ID.
4. With the controller running, run `npm run bridge` in a second terminal.

Do not share `discord-bridge.config.json` or commit it. It is excluded from Git. Never post a bot token publicly; reset it in the Developer Portal if it is exposed.

The bridge follows whichever campaign is selected in the controller and switches to that campaign's channel. If the bridge is stopped, manual speaker selection still works.

## Configuration and files

| File | Purpose | Tracked in Git? |
| --- | --- | --- |
| `campaigns.example.json` | Safe starter data | Yes |
| `campaigns.json` | Your campaign and participant setup | No |
| `reactive-state.json` | Current campaign, absent flags, and crop adjustments | No |
| `discord-bridge.config.example.json` | Bot configuration template | Yes |
| `discord-bridge.config.json` | Your bot token and server ID | No |
| `assets/` | Portrait images | Yes, if you choose to add and share them |

The project uses Discord's bot voice connection for automatic speaker detection. Discord also documents a local RPC interface that can emit voice speaker events, but RPC access for an unapproved app is restricted to a tester list; this package does not depend on it.

## Troubleshooting

- **Page does not open:** make sure `npm start` is still running and that port `8766` is free.
- **Image is missing:** verify the relative path in the campaign editor and that the image exists under `assets/`.
- **Bridge does not connect:** verify the token, server ID, voice channel ID, and bot permissions. Start the local controller before starting the bridge.
- **A participant never lights up:** verify that their Discord user ID is correct and that it is entered on that participant's campaign row.

## License

The application source is released under the MIT License. Portrait images you add remain subject to their own licenses and permissions.
