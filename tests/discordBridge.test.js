import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

import { resetClientFactoryOverrides, setClientFactoryOverrides } from '../src/clientFactories.js';
import state from '../src/state.js';
import utils from '../src/utils.js';

test('Discord typing updates WhatsApp presence', async () => {
  const originalSetTimeout = global.setTimeout;
  const originalDiscordUtils = {
    getGuild: utils.discord.getGuild,
    getControlChannel: utils.discord.getControlChannel,
    channelIdToJid: utils.discord.channelIdToJid,
  };
  const originalSettings = {
    Token: state.settings.Token,
    GuildID: state.settings.GuildID,
  };
  const originalDcClient = state.dcClient;
  const originalWaClient = state.waClient;
  const originalChat = state.chats['123@jid'];

  try {
    global.setTimeout = (fn, ms, ...args) => {
      if (typeof ms === 'number' && ms >= 1000) {
        return originalSetTimeout(fn, 0, ...args);
      }
      return originalSetTimeout(fn, ms, ...args);
    };

    const presenceUpdates = [];
    state.waClient = {
      async sendPresenceUpdate(status, jid) {
        presenceUpdates.push({ status, jid });
      },
    };

    state.settings.Token = 'TEST_TOKEN';
    state.settings.GuildID = 'guild';
    state.chats['123@jid'] = { channelId: 'chan-1' };

    utils.discord.getGuild = async () => ({ commands: { set: async () => {} } });
    utils.discord.getControlChannel = async () => ({ send: async () => {} });
    utils.discord.channelIdToJid = () => '123@jid';

    class FakeDiscordClient extends EventEmitter {
      constructor() {
        super();
        this.loginCalls = [];
      }

      async login(token) {
        this.loginCalls.push(token);
        queueMicrotask(() => this.emit('ready'));
        return this;
      }
    }

    const fakeClient = new FakeDiscordClient();
    setClientFactoryOverrides({ createDiscordClient: () => fakeClient });

    const discordHandler = (await import('../src/discordHandler.js')).default;
    state.dcClient = await discordHandler.start();

    fakeClient.emit('typingStart', { channel: { id: 'chan-1' } });
    // Allow the async typing handler to schedule its paused timer.
    await Promise.resolve();
    await delay(0);

    assert.deepEqual(fakeClient.loginCalls, ['TEST_TOKEN']);
    assert.deepEqual(presenceUpdates, [
      { status: 'composing', jid: '123@jid' },
      { status: 'paused', jid: '123@jid' },
    ]);
  } finally {
    global.setTimeout = originalSetTimeout;

    utils.discord.getGuild = originalDiscordUtils.getGuild;
    utils.discord.getControlChannel = originalDiscordUtils.getControlChannel;
    utils.discord.channelIdToJid = originalDiscordUtils.channelIdToJid;

    state.settings.Token = originalSettings.Token;
    state.settings.GuildID = originalSettings.GuildID;

    if (originalChat === undefined) {
      delete state.chats['123@jid'];
    } else {
      state.chats['123@jid'] = originalChat;
    }

    state.dcClient = originalDcClient;
    state.waClient = originalWaClient;
    resetClientFactoryOverrides();
  }
});
