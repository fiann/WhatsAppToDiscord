# WhatsApp To Discord

WhatsAppToDiscord is a Discord bot that uses WhatsApp Web as a bridge between Discord and WhatsApp. It is built on top of [discord.js](https://github.com/discordjs/discord.js) and [Baileys](https://github.com/WhiskeySockets/Baileys) libraries.

Originally created by [Fatih Kilic](https://github.com/FKLC), the project is now maintained by [arespawn](https://github.com/arespawn) with the blessing of the previous author.

> ⚠️ **Alpha release notice:** Version `v2.0.0-alpha.4` ships the Baileys 7 migration and is considered **unstable**. Expect rapid changes and breaking issues until a stable tag is published.

## Requirements

- Node.js 20 or higher

## Features

- Supports media (Image, Video, Audio, Document, Stickers) and reactions!
- Allows whitelisting, so you can choose what to see on Discord
- Translates mentions between WhatsApp and Discord
- Allows usage of WhatsApp through the Discord overlay
- Syncs message edits between WhatsApp and Discord
- Uses minimal resources because it doesn't simulate a browser
- Open Source, you can see, modify and run your own version of the bot!
- Self Hosted, so your data never leaves your computer
- Automatically restarts itself if it crashes
- Checks for updates every couple of days and can apply signed updates on command (packaged builds only)

**Note:** Due to limitations of the WhatsApp Web protocol, the bot can only notify you of incoming or missed calls. It cannot forward the audio or video streams of a WhatsApp call to Discord.

## Running

Run the bot with `npm start` or use the executable downloaded from the releases
page. Both methods use a small helper script that watches the process and
restarts it automatically if it exits unexpectedly. Directly running `node
src/index.js` skips this helper and the bot won't restart on crashes.

Runtime logs are written to `logs.txt`. Everything printed to the terminal is
also saved to `terminal.log`, which can help diagnose issues when running on a
headless server.

Alternatively, you can run the bot using Docker. Copy `.env.example` to `.env`,
put your Discord bot token in it and execute:

```bash
docker compose up -d
```

The compose file mounts the `storage` directory so data is kept between
container restarts. It uses the `stable` tag by default; switch to `unstable`
if you explicitly want prerelease builds.

To update a running container, pull the new image and recreate the service:

```bash
docker compose pull wa2dc && docker compose up -d wa2dc
```

This keeps you in control of when updates are applied instead of auto-updating.

## Troubleshooting

- **Duplicate Discord channels after the LID migration** – If a chat suddenly starts posting to a brand-new Discord channel, re-link it back to the original room from the control channel instead of editing `storage/chats.json` by hand. Run `link --force <contact> #old-channel` (or `start <jid> #old-channel` for a brand-new contact) and the bot will recreate its webhook inside the existing Discord channel, delete the stray webhook, and update the saved chat metadata. If you just want to repoint the webhook that already lives inside the duplicate channel, run `move #duplicate-channel #old-channel --force` to move the WhatsApp conversation (and clean up the redundant webhook) in one step.

### Automatic updates

Images are published to the GitHub Container Registry on every release, with
immutable version tags (for example, `v2.0.0-alpha.4`) and moving channels:

- `stable` (also published as `latest`) tracks the newest stable release.
- `unstable` tracks the newest prerelease.

The bot checks for updates on the chosen channel every couple of days. Set
`WA2DC_UPDATE_CHANNEL=unstable` if you want to be notified about prereleases;
otherwise `stable` is used.

- Packaged binaries can download and apply updates after you confirm with the
  `update` command. Set `WA2DC_KEEP_OLD_BINARY=1` if you want the previous
  binary to be left on disk for easy rollback.
- Switch channels from the control channel with `updateChannel stable|unstable`.
- Packaged installs keep the previous binary so you can run `rollback` from the
  control channel if a release breaks.
- Docker and source installs never self-update. When the bot posts an update
  notice in the control channel, review the changelog and pull the new image
  yourself (for example, `docker compose pull wa2dc && docker compose up -d
  wa2dc`). Pinning a specific tag lets you roll back quickly if something breaks.

## Release workflow

- Use the **Build and Release Binaries** workflow to publish a new release. Pick
  `stable` or `unstable` for the channel; unstable runs are marked as
  prereleases and do not become the latest release.
- Docker images are published automatically on release events with
  channel-appropriate tags (`stable`/`latest` or `unstable` plus the version).
  You can also trigger the **Build and Push Docker Image** workflow manually to
  republish a specific tag.

---

For setup and commands, check out the [documentation](https://arespawn.github.io/WhatsAppToDiscord/)!
