import readline from 'readline';
import fs from 'fs/promises';
import path from 'path';
import discordJs from 'discord.js';

import state from './state.js';

const isSmokeTest = process.env.WA2DC_SMOKE_TEST === '1';
const STORAGE_DIR_MODE = 0o700;
const STORAGE_FILE_MODE = 0o600;

const { Client, Intents } = discordJs;

const sanitizeStorageKey = (name = '') => {
  const raw = String(name)
    .replace(/[\\/]+/g, '-')
    .replace(/\0/g, '')
    .trim();
  const base = path.basename(raw);
  if (!base || base === '.' || base === '..') {
    throw new Error(`Invalid storage key: ${name}`);
  }
  return base;
};

const bidirectionalMap = (capacity, data = {}) => {
  const keys = Object.keys(data);
  return new Proxy(
    data,
    {
      set(target, prop, newVal) {
        keys.push(prop, newVal);
        if (keys.length > capacity) {
          delete target[keys.shift()];
          delete target[keys.shift()];
        }
        target[prop] = newVal;
        target[newVal] = prop;
        return true;
      },
    },
  );
};

const storage = {
  _storageDir: './storage/',
  async ensureStorageDir() {
    await fs.mkdir(this._storageDir, { recursive: true, mode: STORAGE_DIR_MODE });
  },
  async upsert(name, data) {
    const key = sanitizeStorageKey(name);
    await this.ensureStorageDir();
    const targetPath = path.join(this._storageDir, key);
    await fs.writeFile(targetPath, data, { mode: STORAGE_FILE_MODE });
    if (process.platform !== 'win32') {
      await fs.chmod(targetPath, STORAGE_FILE_MODE).catch(() => {});
    }
  },

  async get(name) {
    const key = sanitizeStorageKey(name);
    return fs.readFile(path.join(this._storageDir, key)).catch(() => null)
  },

  _settingsName: 'settings',
  async parseSettings() {
    if (isSmokeTest) {
      const smokeDefaults = {
        Token: 'SMOKE_TOKEN',
        GuildID: 'SMOKE_GUILD',
        Categories: [],
        ControlChannelID: 'SMOKE_CONTROL',
        Publish: false,
        LocalDownloadServer: false,
      };
      return Object.assign(state.settings, smokeDefaults);
    }

    const result = await this.get(this._settingsName);
    if (result == null) {
      return setup.firstRun();
    }

    try {
      const settings = Object.assign(state.settings, JSON.parse(result));
      if (settings.Token === '') return setup.firstRun();
      return settings;
    } catch (err) {
      return setup.firstRun();
    }
  },

  _chatsName: 'chats',
  async parseChats() {
    const result = await this.get(this._chatsName);
    return result ? JSON.parse(result) : {};
  },

  _contactsName: 'contacts',
  async parseContacts() {
    const result = await this.get(this._contactsName);
    return result ? JSON.parse(result) : {};
  },

  _lastMessagesName: 'lastMessages',
  async parseLastMessages() {
    const result = await this.get(this._lastMessagesName);
    return result ?
      bidirectionalMap(state.settings.lastMessageStorage * 2, JSON.parse(result)) :
      bidirectionalMap(state.settings.lastMessageStorage * 2);
  },

  _startTimeName: 'lastTimestamp',
  async parseStartTime() {
    const result = await this.get(this._startTimeName);
    return result ? parseInt(result, 10) : Math.round(Date.now() / 1000);
  },

  async save() {
    await this.upsert(this._settingsName, JSON.stringify(state.settings));
    await this.upsert(this._chatsName, JSON.stringify(state.chats));
    await this.upsert(this._contactsName, JSON.stringify(state.contacts));
    await this.upsert(this._lastMessagesName, JSON.stringify(state.lastMessages));
    await this.upsert(this._startTimeName, state.startTime.toString());
  },
};

const setup = {
  async setupDiscordChannels(token) {
    return new Promise((resolve) => {
      const client = new Client({ intents: [Intents.FLAGS.GUILDS] });
      client.once('ready', () => {
        state.logger?.info(
          `Invite the bot using the following link: https://discordapp.com/oauth2/authorize?client_id=${client.user.id}&scope=bot%20application.commands&permissions=536879120`,
        );
      });
      client.once('guildCreate', async (guild) => {
        const category = await guild.channels.create('whatsapp', {
          type: 'GUILD_CATEGORY',
        });
        const controlChannel = await guild.channels.create('control-room', {
          type: 'GUILD_TEXT',
          parent: category,
        });
        client.destroy();
        resolve({
          GuildID: guild.id,
          Categories: [category.id],
          ControlChannelID: controlChannel.id,
        });
      });
      client.login(token);
    });
  },

  async firstRun() {
    const settings = state.settings;
    state.logger?.info('It seems like this is your first run.');
    if (process.env.WA2DC_TOKEN === "CHANGE_THIS_TOKEN") {
      state.logger?.info("Please set WA2DC_TOKEN environment variable.");
      process.exit();
    }
    const input = async (query) => {
      return new Promise((resolve) => {
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
        });
        rl.question(query, (answer) => {
          resolve(answer);
          rl.close();
        });
      });
    };
    settings.Token = process.env.WA2DC_TOKEN || await input('Please enter your bot token: ');
    Object.assign(settings, await this.setupDiscordChannels(settings.Token));
    return settings;
  },
};

export default storage;
