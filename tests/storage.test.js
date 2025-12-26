import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resetClientFactoryOverrides, setClientFactoryOverrides } from '../src/clientFactories.js';
import state from '../src/state.js';
import storage from '../src/storage.js';

const snapshotObject = (value) => ({ ...value });
const restoreObject = (target, snapshot) => {
  Object.keys(target).forEach((key) => { delete target[key]; });
  Object.assign(target, snapshot);
};

test('Storage upsert sanitizes keys and enforces restrictive permissions', async () => {
  const originalDir = storage._storageDir;
  const settingsSnapshot = snapshotObject(state.settings);
  const tempBase = await fs.mkdtemp(path.join(os.tmpdir(), 'wa2dc-storage-'));
  const sandboxDir = path.join(tempBase, 'storage');

  storage._storageDir = sandboxDir;
  try {
    await storage.upsert('../evil', 'ok');

    const entries = await fs.readdir(sandboxDir);
    assert.deepEqual(entries, ['..-evil']);

    if (process.platform !== 'win32') {
      const dirMode = (await fs.stat(sandboxDir)).mode & 0o777;
      const fileMode = (await fs.stat(path.join(sandboxDir, '..-evil'))).mode & 0o777;
      assert.equal(dirMode, 0o700);
      assert.equal(fileMode, 0o600);
    }

    await assert.rejects(() => storage.upsert('..', 'x'), /Invalid storage key/);
    await assert.rejects(() => storage.upsert('\0\0', 'x'), /Invalid storage key/);
  } finally {
    storage._storageDir = originalDir;
    restoreObject(state.settings, settingsSnapshot);
    await fs.rm(tempBase, { recursive: true, force: true });
  }
});

test('parseSettings merges defaults when older settings are missing keys', async () => {
  const originalDir = storage._storageDir;
  const settingsSnapshot = snapshotObject(state.settings);
  const tempBase = await fs.mkdtemp(path.join(os.tmpdir(), 'wa2dc-settings-'));
  const sandboxDir = path.join(tempBase, 'storage');

  storage._storageDir = sandboxDir;
  try {
    await fs.mkdir(sandboxDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(
      path.join(sandboxDir, 'settings'),
      JSON.stringify({ Token: 'TOK', GuildID: 'G', ControlChannelID: 'C' }),
      { mode: 0o600 },
    );

    const settings = await storage.parseSettings();
    assert.equal(settings.Token, 'TOK');
    assert.equal(settings.DownloadDir, './downloads');
    assert.equal(settings.LocalDownloads, false);
    assert.equal(settings.PinDurationSeconds, 7 * 24 * 60 * 60);
  } finally {
    storage._storageDir = originalDir;
    restoreObject(state.settings, settingsSnapshot);
    await fs.rm(tempBase, { recursive: true, force: true });
  }
});

test('parseSettings recovers via firstRun on corrupted JSON (mocked Discord bootstrap)', async () => {
  const originalDir = storage._storageDir;
  const settingsSnapshot = snapshotObject(state.settings);
  const originalLogger = state.logger;
  const originalEnvToken = process.env.WA2DC_TOKEN;
  const tempBase = await fs.mkdtemp(path.join(os.tmpdir(), 'wa2dc-settings-corrupt-'));
  const sandboxDir = path.join(tempBase, 'storage');

  storage._storageDir = sandboxDir;
  process.env.WA2DC_TOKEN = 'TOK';
  state.logger = { info() {}, warn() {}, error() {}, debug() {} };

  let capturedToken = null;
  let clientDestroyed = false;
  const createdChannels = [];

  const fakeGuild = {
    id: 'guild-1',
    channels: {
      async create(name) {
        const id = name === 'whatsapp' ? 'cat-1' : 'ctrl-1';
        createdChannels.push({ name, id });
        return { id };
      },
    },
  };

  class FakeDiscordClient extends EventEmitter {
    constructor() {
      super();
      this.user = { id: 'bot-1' };
    }

    async login(token) {
      capturedToken = token;
      queueMicrotask(() => this.emit('ready'));
      queueMicrotask(() => this.emit('guildCreate', fakeGuild));
      return this;
    }

    destroy() {
      clientDestroyed = true;
    }
  }

  setClientFactoryOverrides({ createDiscordClient: () => new FakeDiscordClient() });

  try {
    await fs.mkdir(sandboxDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(sandboxDir, 'settings'), '{not-json', { mode: 0o600 });

    const settings = await storage.parseSettings();

    assert.equal(capturedToken, 'TOK');
    assert.ok(clientDestroyed);
    assert.deepEqual(createdChannels.map((entry) => entry.name), ['whatsapp', 'control-room']);

    assert.equal(settings.Token, 'TOK');
    assert.equal(settings.GuildID, 'guild-1');
    assert.deepEqual(settings.Categories, ['cat-1']);
    assert.equal(settings.ControlChannelID, 'ctrl-1');
  } finally {
    resetClientFactoryOverrides();
    storage._storageDir = originalDir;
    restoreObject(state.settings, settingsSnapshot);
    state.logger = originalLogger;
    if (originalEnvToken === undefined) {
      delete process.env.WA2DC_TOKEN;
    } else {
      process.env.WA2DC_TOKEN = originalEnvToken;
    }
    await fs.rm(tempBase, { recursive: true, force: true });
  }
});

