# Commands

All bot controls now run exclusively through Discord slash commands. Type `/` in any channel to see the available commands (the bot must share the server) or narrow the list by typing `/wa` and selecting the desired action. Commands can be invoked anywhere, but responses are ephemeral outside the control channel. The legacy `#control-room` text commands have been removed—use slash commands or the persistent buttons in the control channel.

---

## Conversation Management

### `/pairwithcode`
Request a pairing code for a specific phone number.  
Usage: `/pairwithcode number:<E.164 phone number>`

### `/start`
Create a brand-new WhatsApp conversation and channel link.  
Usage: `/start contact:<phone number or saved contact name>`

### `/link`
Link an existing Discord text/news channel to an existing WhatsApp chat without creating anything new.  
Usage: `/link contact:<name or number> channel:<#channel> force:<true|false>`  
Enable `force` to override a channel that is already linked to another chat.

### `/move`
Move an existing WhatsApp link (and webhook) from one channel to another.  
Usage: `/move from:<#current-channel> to:<#new-channel> force:<true|false>`

### `/list`
List all known contacts and groups, optionally filtered.  
Usage: `/list query:<optional text>`

### `/poll`
Create a WhatsApp poll from Discord.  
Usage: `/poll question:"text" options:"opt1,opt2,..." select:<count> announcement:<true|false>`  
Notes: Poll messages and live vote updates are mirrored to Discord, voting can only be done directly in WhatsApp.

### `/setpinduration`
Set the default expiration time (24h, 7d, or 30d) for WhatsApp pins created from Discord.  
Usage: `/setpinduration duration:<24h|7d|30d>`

---

## Whitelist Controls

### `/listwhitelist`
Show the conversations currently allowed to bridge when the whitelist is enabled.

### `/addtowhitelist`
Add a linked channel to the whitelist.  
Usage: `/addtowhitelist channel:<#channel>`

### `/removefromwhitelist`
Remove a linked channel from the whitelist.  
Usage: `/removefromwhitelist channel:<#channel>`

---

## Formatting & Prefixes

### `/setdcprefix`
Override the prefix prepended to Discord → WhatsApp messages.  
Usage: `/setdcprefix prefix:<optional text>` (omit to reset to usernames)

### `/enabledcprefix` / `/disabledcprefix`
Toggle whether the configured prefix is used.

### `/enablewaprefix` / `/disablewaprefix`
Toggle whether WhatsApp sender names are prepended inside Discord messages.

---

## Attachments & Downloads

### `/enablewaupload` / `/disablewaupload`
Toggle whether Discord attachments are uploaded to WhatsApp (vs sending as links).

### `/enablelocaldownloads` / `/disablelocaldownloads`
Control whether large WhatsApp attachments are downloaded locally when they exceed Discord’s upload limit.

### `/getdownloadmessage`
Show the current local-download notification template.

### `/setdownloadmessage`
Update the notification template.  
Usage: `/setdownloadmessage message:"text with {url}/{fileName}/..."`.

### `/getdownloaddir`
Show the folder used for downloaded files.

### `/setdownloaddir`
Change the download directory.  
Usage: `/setdownloaddir path:<folder>`

### `/setdownloadlimit`
Limit the download directory size (GB).  
Usage: `/setdownloadlimit size:<number>`

### `/setfilesizelimit`
Override the Discord upload size limit used to decide when to download instead of re-uploading.  
Usage: `/setfilesizelimit bytes:<integer>`

### `/enablelocaldownloadserver` / `/disablelocaldownloadserver`
Start/stop the built-in HTTP(S) server that serves downloaded files.

### `/setlocaldownloadserverhost`
Configure the hostname used in generated download URLs.  
Usage: `/setlocaldownloadserverhost host:<value>`

### `/setlocaldownloadserverport`
Configure which port the download server listens on.  
Usage: `/setlocaldownloadserverport port:<1-65535>`

### `/enablehttpsdownloadserver` / `/disablehttpsdownloadserver`
Toggle HTTPS for the download server (requires certificates).

### `/sethttpscert`
Set TLS certificate paths for the download server.  
Usage: `/sethttpscert key_path:<file> cert_path:<file>`

---

## Messaging Behavior

### `/enabledeletes` / `/disabledeletes`
Toggle mirrored message deletions between Discord and WhatsApp.

### `/enablereadreceipts` / `/disablereadreceipts`
Turn read receipts on or off entirely.

### `/dmreadreceipts`, `/publicreadreceipts`, `/reactionreadreceipts`
Pick the delivery style when read receipts are enabled (DM, short channel reply, or ☑️ reaction).

### `/enablechangenotifications` / `/disablechangenotifications`
Toggle profile-picture / status-change alerts and WhatsApp Status (stories) mirroring (posted into the `status@broadcast` / `#status` channel).

### `/oneway`
Restrict the bridge to one direction or keep it bidirectional.  
Usage: `/oneway direction:<discord|whatsapp|disabled>`

### `/redirectbots`
Allow or block Discord bot messages from being forwarded to WhatsApp.  
Usage: `/redirectbots enabled:<true|false>`

### `/redirectwebhooks`
Allow or block Discord webhook messages from being forwarded to WhatsApp.  
Usage: `/redirectwebhooks enabled:<true|false>`

### `/ping`
Return the current bot latency.

---

## Maintenance & Settings

### `/resync`
Re-sync WhatsApp contacts/groups. Set `rename:true` to rename Discord channels to match WhatsApp subjects.

### `/autosaveinterval`
Change how often the bot persists state (seconds).  
Usage: `/autosaveinterval seconds:<integer>`

### `/lastmessagestorage`
Limit how many WhatsApp messages remain editable/deletable from Discord.  
Usage: `/lastmessagestorage size:<integer>`

### `/enablelocaldownloadserver`, `/disablelocaldownloadserver`, `/enablehttpsdownloadserver`, `/disablehttpsdownloadserver`
See “Attachments & Downloads” above (listed again here for visibility).

---

## Update Management

The control channel now shows a persistent update card with “Update”, “Skip update”, and “Roll back” buttons that survive restarts. These buttons trigger the same slash commands listed below.

### `/updatechannel`
Switch between the stable and unstable release channels.  
Usage: `/updatechannel channel:<stable|unstable>`

### `/checkupdate`
Manually check for updates on the active channel.

### `/skipupdate`
Dismiss the current update notification without installing.

### `/update`
Download and install the available release (packaged installs only). Docker/source deployments will be reminded to pull and restart manually.

### `/rollback`
Restore the previous packaged binary when one is available. The dedicated “Roll back” button only appears if a backup exists.

---

Need help remembering the command names? Type `/wa` inside Discord and let the client autocomplete each slash command along with its required options. All commands are self-documented via Discord’s UI, so you no longer have to memorize legacy text formats.
