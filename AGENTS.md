# Agent Notes (AGENTS.md)

This file is guidance for LLM coding agents working in this repository. It is meant to make you productive quickly, avoid common pitfalls, and keep changes aligned with how WA2DC is built and shipped.

## What this project is

WhatsAppToDiscord (WA2DC) is a self-hosted bridge that mirrors WhatsApp chats into Discord:

- **WhatsApp side**: WhatsApp Web protocol via **Baileys** (`@whiskeysockets/baileys`).
- **Discord side**: a **Discord bot** via **discord.js**.
- **State**: persisted locally in `./storage/` (JSON files, plus Baileys auth state).
- **Runtime**: started through a watchdog runner that can restart on crash and on-demand.

Docs for end-users live in `docs/` and are published via docsify.

## Fast start (dev)

Prereqs:

- Node.js **>= 20** (repo uses ESM)

Common commands:

- Install deps: `npm ci`
- Run bot (watchdog runner): `npm start` (runs `node src/runner.js`)
- Run docs site locally: `npm run docs`
- Lint: `npm run lint`

Quick “does it boot?” check without external connections:

- Smoke boot: `WA2DC_SMOKE_TEST=1 node src/index.js`
  - CI verifies this via `tests/smokeBoot.test.js`.
  - It skips Discord + WhatsApp client startup and exits successfully once initialization completes.

## Repository map (where to look first)

Top-level:

- `README.md`: high-level overview
- `docs/README.md`, `docs/setup.md`, `docs/commands.md`: user docs (setup, commands, troubleshooting)
- `out.js`, `build/`: build artifacts for packaged releases (don’t hand-edit)

Core runtime (`src/`):

- `src/index.js`: main app bootstrap (loads state, storage, starts clients, updater, crash handling)
- `src/runner.js`: watchdog runner (cluster worker + restart/backoff); honors `restart.flag`
- `src/state.js`: global in-memory state + **default settings**
- `src/storage.js`: persistence layer (`./storage/`), first-run Discord channel bootstrap, file permissions
- `src/discordHandler.js`: Discord client, slash commands, Discord↔WhatsApp bridge events
- `src/whatsappHandler.js`: Baileys client, WhatsApp↔Discord bridge events, reconnect logic, poll updates
- `src/utils.js`: large shared utility module (formatting, link previews, downloads server, updater, migrations)
- `src/clientFactories.js`: injectable factories used by tests to stub Discord/WhatsApp clients
- `src/groupMetadataCache.js`, `src/groupMetadataRefresh.js`: group metadata caching/refresh scheduling
- `src/messageStore.js`: in-memory TTL message cache used for edits/polls/pins
- `src/pollUtils.js`: WhatsApp poll helpers

Tests (`tests/`):

- Primary suite is Node’s built-in runner (`node --test`) via `npm test`.
- CI workflow: `.github/workflows/ci-tests.yml`

## Runtime files & side effects (don’t break these)

Created/used at runtime in the working directory:

- `storage/` (directory): persisted bot state (settings, chats, contacts, last messages, timestamps, auth)
- `downloads/` (directory): optional local downloads directory (configurable)
- `logs.txt`: structured logs (pino)
- `terminal.log`: tee of stdout/stderr from the runner worker
- `crash-report.txt`: queued crash report when Discord control channel isn’t available
- `restart.flag`: a “restart now” signal consumed by `src/runner.js`

Guidelines:

- Don’t change on-disk formats lightly; users depend on stable upgrades.
- `src/storage.js` intentionally applies restrictive permissions (`0700` dirs, `0600` files). Don’t loosen.
- Never commit secrets (`storage/`, `.env`, tokens, auth blobs).

## Key behavioral constraints (easy to regress)

### Prevent echo loops

There are explicit state trackers to prevent “message bounce” between platforms:

- `state.sentMessages` (WhatsApp msg IDs originating from Discord)
- `state.sentReactions`
- `state.sentPins`

If you add new bridge behaviors (new event types, new message flows), extend these protections as needed.

### JID / LID migration hygiene

WhatsApp identifiers may be PN-based JIDs or LID-based JIDs. Code paths commonly use:

- `utils.whatsapp.formatJid(...)`
- `utils.whatsapp.hydrateJidPair(...)` (PN↔LID pairing)
- `utils.whatsapp.migrateLegacyJid(...)` (persist mapping so existing links keep working)

Avoid hardcoding assumptions about `@s.whatsapp.net` vs `@lid`.

### Discord limits

Discord message constraints are real:

- 2000 char message limit: use `utils.discord.partitionText()` when emitting long output.
- Upload limits vary: settings like `DiscordFileSizeLimit` influence whether to upload vs download locally.

### One-way mode / whitelist

The bridge can be bidirectional or restricted; gating is enforced in multiple places. When changing message routing, ensure you respect:

- `state.settings.oneWay`
- whitelist checks (see `state.settings.Whitelist` and `utils.whatsapp.inWhitelist(...)`)

## Adding or changing a slash command

Slash commands are implemented in `src/discordHandler.js`:

- Add a new entry to `commandHandlers` with:
  - `description`
  - `options` (for Discord command registration)
  - `execute(ctx)` implementation
- Commands are registered via `registerSlashCommands()` on startup.
- Replies are **ephemeral** outside the control channel (see `CommandResponder`).

When you add/remove/change user-visible commands:

- Update `docs/commands.md` to match behavior and options.
- Keep responses partitioned when needed (`ctx.replyPartitioned(...)`).

## Settings changes (backwards compatibility rules)

Defaults live in `src/state.js`. Persistence logic merges stored JSON onto defaults in `src/storage.js`.

When adding a new setting:

- Add it to `src/state.js` defaults.
- Ensure `storage.parseSettings()` continues to load older settings files cleanly (missing key should just fall back to default).
- Document it in `docs/` if it’s user-facing.

If you must rename/remove a setting, add a migration path (don’t silently break old `storage/settings`).

## Tests & validation

Preferred quick checks before handing off a change:

- JS lint: `npm run lint`
- JS unit/behavior tests: `npm test` (Node’s built-in `node --test`)
- Smoke boot (manual): `WA2DC_SMOKE_TEST=1 node src/index.js`

CI runs `npm test` (which includes the smoke boot test).

## Build / release notes (so you don’t accidentally break packaging)

Packaged release pipeline (GitHub Actions) bundles and ships binaries:

- Bundling: esbuild bundles `src/runner.js` → `out.js` (see `.github/workflows/new-release-v2.yml`)
- Packaging: `pkg` builds platform binaries from `out.js`
- `process.pkg` is used to detect packaged runtime vs source runtime

If you introduce dependencies that rely on dynamic filesystem access, native addons, or non-standard resolution, validate that:

- esbuild bundling still works
- `pkg` can find the required assets (or they’re explicitly treated as externals)

## Security & privacy expectations

This bot handles sensitive data (WhatsApp session, Discord token, message content).

- Do not log secrets (tokens, QR codes, auth state blobs).
- Be careful when expanding crash reports: they’re sent to Discord or written to disk.
- Link previews intentionally block loopback/private/link-local targets (see `src/utils.js`). Don’t weaken those safeguards.
