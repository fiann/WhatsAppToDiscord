import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

import discordJs from 'discord.js';

import { resetClientFactoryOverrides, setClientFactoryOverrides } from '../src/clientFactories.js';
import state from '../src/state.js';
import utils from '../src/utils.js';

const restoreObject = (target, snapshot) => {
  Object.keys(target).forEach((key) => { delete target[key]; });
  Object.assign(target, snapshot);
};

const importDiscordHandler = async (tag) => (
  (await import(`../src/discordHandler.js?test=${encodeURIComponent(tag)}`)).default
);

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
    oneWay: state.settings.oneWay,
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

    const discordHandler = await importDiscordHandler('typing');
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
    state.settings.oneWay = originalSettings.oneWay;

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

test('oneWay gating blocks WhatsApp -> Discord forwards in discordHandler', async () => {
  const originalDiscordUtils = {
    getGuild: utils.discord.getGuild,
    getControlChannel: utils.discord.getControlChannel,
    getOrCreateChannel: utils.discord.getOrCreateChannel,
  };
  const originalSettings = {
    Token: state.settings.Token,
    GuildID: state.settings.GuildID,
    oneWay: state.settings.oneWay,
  };
  const originalDcClient = state.dcClient;

  try {
    state.settings.Token = 'TEST_TOKEN';
    state.settings.GuildID = 'guild';
    state.settings.oneWay = 0b10; // Discord -> WhatsApp only

    utils.discord.getGuild = async () => ({ commands: { set: async () => {} } });
    utils.discord.getControlChannel = async () => ({ send: async () => {} });

    const getOrCreateCalls = [];
    utils.discord.getOrCreateChannel = async (jid) => {
      getOrCreateCalls.push(jid);
      return { send: async () => {} };
    };

    class FakeDiscordClient extends EventEmitter {
      constructor() {
        super();
        this.user = { id: 'bot-1' };
      }

      async login() {
        queueMicrotask(() => this.emit('ready'));
        return this;
      }
    }

    const fakeClient = new FakeDiscordClient();
    setClientFactoryOverrides({ createDiscordClient: () => fakeClient });
    const discordHandler = await importDiscordHandler('oneway-wa-block');
    state.dcClient = await discordHandler.start();

    fakeClient.emit('whatsappMessage', {
      id: 'wa-1',
      name: 'Tester',
      content: 'hello',
      channelJid: 'jid@s.whatsapp.net',
      file: null,
      quote: null,
      profilePic: null,
      isGroup: false,
      isForwarded: false,
      isEdit: false,
    });
    await delay(0);
    assert.equal(getOrCreateCalls.length, 0);

    state.settings.oneWay = 0b11;
    fakeClient.emit('whatsappMessage', {
      id: 'wa-2',
      name: 'Tester',
      content: 'hello',
      channelJid: 'jid@s.whatsapp.net',
      file: null,
      quote: null,
      profilePic: null,
      isGroup: false,
      isForwarded: false,
      isEdit: false,
    });
    await delay(0);
    assert.equal(getOrCreateCalls.length, 1);
  } finally {
    utils.discord.getGuild = originalDiscordUtils.getGuild;
    utils.discord.getControlChannel = originalDiscordUtils.getControlChannel;
    utils.discord.getOrCreateChannel = originalDiscordUtils.getOrCreateChannel;

    state.settings.Token = originalSettings.Token;
    state.settings.GuildID = originalSettings.GuildID;
    state.settings.oneWay = originalSettings.oneWay;

    state.dcClient = originalDcClient;
    resetClientFactoryOverrides();
  }
});

test('Discord messageDelete emits discordDelete for bridged messages', async () => {
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
  const originalLastMessages = state.lastMessages;
  const originalReactions = state.reactions;

  try {
    state.settings.Token = 'TEST_TOKEN';
    state.settings.GuildID = 'guild';
    state.lastMessages = { 'wa-1': 'dc-1', 'dc-1': 'wa-1' };
    state.reactions = {};

    utils.discord.getGuild = async () => ({ commands: { set: async () => {} } });
    utils.discord.getControlChannel = async () => ({ send: async () => {} });
    utils.discord.channelIdToJid = () => 'jid@s.whatsapp.net';

    const waEvents = [];
    const waEv = new EventEmitter();
    waEv.on('discordDelete', (payload) => waEvents.push(payload));
    state.waClient = { ev: waEv };

    class FakeDiscordClient extends EventEmitter {
      constructor() {
        super();
        this.user = { id: 'bot-1' };
      }

      async login() {
        queueMicrotask(() => this.emit('ready'));
        return this;
      }
    }

    const fakeClient = new FakeDiscordClient();
    setClientFactoryOverrides({ createDiscordClient: () => fakeClient });
    const discordHandler = await importDiscordHandler('delete');
    state.dcClient = await discordHandler.start();

    fakeClient.emit('messageDelete', {
      id: 'dc-1',
      channelId: 'chan-1',
      webhookId: null,
      author: { id: 'user-1' },
      channel: { send: async () => {} },
    });
    await delay(0);

    assert.deepEqual(waEvents, [{ jid: 'jid@s.whatsapp.net', id: 'wa-1' }]);
    assert.equal(state.lastMessages['wa-1'], undefined);
    assert.equal(state.lastMessages['dc-1'], undefined);
  } finally {
    utils.discord.getGuild = originalDiscordUtils.getGuild;
    utils.discord.getControlChannel = originalDiscordUtils.getControlChannel;
    utils.discord.channelIdToJid = originalDiscordUtils.channelIdToJid;

    state.settings.Token = originalSettings.Token;
    state.settings.GuildID = originalSettings.GuildID;

    state.dcClient = originalDcClient;
    state.waClient = originalWaClient;
    state.lastMessages = originalLastMessages;
    state.reactions = originalReactions;
    resetClientFactoryOverrides();
  }
});

test('Discord pin system messages are not forwarded to WhatsApp', async () => {
  const originalDiscordUtils = {
    getGuild: utils.discord.getGuild,
    getControlChannel: utils.discord.getControlChannel,
    channelIdToJid: utils.discord.channelIdToJid,
  };
  const originalSettings = {
    Token: state.settings.Token,
    GuildID: state.settings.GuildID,
    ControlChannelID: state.settings.ControlChannelID,
  };
  const originalDcClient = state.dcClient;
  const originalWaClient = state.waClient;

  try {
    state.settings.Token = 'TEST_TOKEN';
    state.settings.GuildID = 'guild';
    state.settings.ControlChannelID = 'control';

    utils.discord.getGuild = async () => ({ commands: { set: async () => {} } });
    utils.discord.getControlChannel = async () => ({ send: async () => {} });
    utils.discord.channelIdToJid = () => 'jid@s.whatsapp.net';

    const waEvents = [];
    const waEv = new EventEmitter();
    waEv.on('discordMessage', (payload) => waEvents.push(payload));
    state.waClient = { ev: waEv };

    class FakeDiscordClient extends EventEmitter {
      constructor() {
        super();
        this.user = { id: 'bot-1' };
      }

      async login() {
        queueMicrotask(() => this.emit('ready'));
        return this;
      }
    }

    const fakeClient = new FakeDiscordClient();
    setClientFactoryOverrides({ createDiscordClient: () => fakeClient });

    const discordHandler = await importDiscordHandler('pin-system-message');
    state.dcClient = await discordHandler.start();

    const pinnedType = discordJs.Constants.MessageTypes.indexOf('CHANNEL_PINNED_MESSAGE');
    fakeClient.emit('messageCreate', {
      author: { id: 'user-1' },
      applicationId: null,
      webhookId: null,
      type: pinnedType,
      channel: { id: 'chan-1' },
    });
    await delay(0);

    assert.equal(waEvents.length, 0);
  } finally {
    utils.discord.getGuild = originalDiscordUtils.getGuild;
    utils.discord.getControlChannel = originalDiscordUtils.getControlChannel;
    utils.discord.channelIdToJid = originalDiscordUtils.channelIdToJid;

    state.settings.Token = originalSettings.Token;
    state.settings.GuildID = originalSettings.GuildID;
    state.settings.ControlChannelID = originalSettings.ControlChannelID;

    state.dcClient = originalDcClient;
    state.waClient = originalWaClient;
    resetClientFactoryOverrides();
  }
});

test('Discord messageUpdate emits discordEdit for bridged messages', async () => {
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
  const originalLastMessages = state.lastMessages;

  try {
    state.settings.Token = 'TEST_TOKEN';
    state.settings.GuildID = 'guild';
    state.lastMessages = { 'dc-edit': 'wa-edit' };

    utils.discord.getGuild = async () => ({ commands: { set: async () => {} } });
    utils.discord.getControlChannel = async () => ({ send: async () => {} });
    utils.discord.channelIdToJid = () => 'jid@s.whatsapp.net';

    const waEvents = [];
    const waEv = new EventEmitter();
    waEv.on('discordEdit', (payload) => waEvents.push(payload));
    state.waClient = { ev: waEv };

    class FakeDiscordClient extends EventEmitter {
      constructor() {
        super();
        this.user = { id: 'bot-1' };
      }

      async login() {
        queueMicrotask(() => this.emit('ready'));
        return this;
      }
    }

    const fakeClient = new FakeDiscordClient();
    setClientFactoryOverrides({ createDiscordClient: () => fakeClient });
    const discordHandler = await importDiscordHandler('edit');
    state.dcClient = await discordHandler.start();

    fakeClient.emit(
      'messageUpdate',
      { pinned: false },
      {
        id: 'dc-edit',
        channelId: 'chan-1',
        webhookId: null,
        partial: false,
        pinned: false,
        editedTimestamp: Date.now(),
        content: 'updated',
        channel: { send: async () => {} },
      },
    );
    await delay(0);

    assert.equal(waEvents.length, 1);
    assert.equal(waEvents[0].jid, 'jid@s.whatsapp.net');
    assert.equal(waEvents[0].message.id, 'dc-edit');
  } finally {
    utils.discord.getGuild = originalDiscordUtils.getGuild;
    utils.discord.getControlChannel = originalDiscordUtils.getControlChannel;
    utils.discord.channelIdToJid = originalDiscordUtils.channelIdToJid;

    state.settings.Token = originalSettings.Token;
    state.settings.GuildID = originalSettings.GuildID;

    state.dcClient = originalDcClient;
    state.waClient = originalWaClient;
    state.lastMessages = originalLastMessages;
    resetClientFactoryOverrides();
  }
});

test('Discord pin changes sync to WhatsApp via waClient.sendMessage', async () => {
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
  const originalLastMessages = state.lastMessages;
  const originalSentPins = new Set(state.sentPins);

  try {
    global.setTimeout = (fn, ms, ...args) => {
      const handle = originalSetTimeout(fn, ms, ...args);
      if (handle && typeof handle.unref === 'function') {
        handle.unref();
      }
      return handle;
    };

    state.settings.Token = 'TEST_TOKEN';
    state.settings.GuildID = 'guild';
    state.lastMessages = { 'dc-pin': 'wa-pin' };
    state.sentPins.clear();

    utils.discord.getGuild = async () => ({ commands: { set: async () => {} } });
    utils.discord.getControlChannel = async () => ({ send: async () => {} });
    utils.discord.channelIdToJid = () => 'jid@s.whatsapp.net';

    const sendCalls = [];
    state.waClient = {
      ev: new EventEmitter(),
      async sendMessage(jid, content) {
        sendCalls.push({ jid, content });
        return {};
      },
    };

    class FakeDiscordClient extends EventEmitter {
      constructor() {
        super();
        this.user = { id: 'bot-1' };
      }

      async login() {
        queueMicrotask(() => this.emit('ready'));
        return this;
      }
    }

    const fakeClient = new FakeDiscordClient();
    setClientFactoryOverrides({ createDiscordClient: () => fakeClient });
    const discordHandler = await importDiscordHandler('pin');
    state.dcClient = await discordHandler.start();

    fakeClient.emit(
      'messageUpdate',
      { pinned: false },
      {
        id: 'dc-pin',
        channelId: 'chan-1',
        webhookId: null,
        partial: false,
        pinned: true,
        editedTimestamp: null,
        content: '',
        channel: { send: async () => {} },
      },
    );
    await delay(0);

    assert.equal(sendCalls.length, 1);
    assert.equal(sendCalls[0].jid, 'jid@s.whatsapp.net');
    assert.equal(sendCalls[0].content.type, 1);
    assert.equal(sendCalls[0].content.pin.id, 'wa-pin');
    assert.equal(state.sentPins.has('wa-pin'), true);
  } finally {
    global.setTimeout = originalSetTimeout;

    utils.discord.getGuild = originalDiscordUtils.getGuild;
    utils.discord.getControlChannel = originalDiscordUtils.getControlChannel;
    utils.discord.channelIdToJid = originalDiscordUtils.channelIdToJid;

    state.settings.Token = originalSettings.Token;
    state.settings.GuildID = originalSettings.GuildID;

    state.dcClient = originalDcClient;
    state.waClient = originalWaClient;
    state.lastMessages = originalLastMessages;
    state.sentPins.clear();
    originalSentPins.forEach((id) => state.sentPins.add(id));
    resetClientFactoryOverrides();
  }
});

test('Discord reactions emit discordReaction towards WhatsApp', async () => {
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
  const originalLastMessages = state.lastMessages;

  try {
    state.settings.Token = 'TEST_TOKEN';
    state.settings.GuildID = 'guild';
    state.lastMessages = { 'dc-react': 'wa-react' };

    utils.discord.getGuild = async () => ({ commands: { set: async () => {} } });
    utils.discord.getControlChannel = async () => ({ send: async () => {} });
    utils.discord.channelIdToJid = () => 'jid@s.whatsapp.net';

    const waEvents = [];
    const waEv = new EventEmitter();
    waEv.on('discordReaction', (payload) => waEvents.push(payload));
    state.waClient = { ev: waEv };

    class FakeDiscordClient extends EventEmitter {
      constructor() {
        super();
        this.user = { id: 'bot-1' };
      }

      async login() {
        queueMicrotask(() => this.emit('ready'));
        return this;
      }
    }

    const fakeClient = new FakeDiscordClient();
    setClientFactoryOverrides({ createDiscordClient: () => fakeClient });
    const discordHandler = await importDiscordHandler('reaction');
    state.dcClient = await discordHandler.start();

    fakeClient.emit('messageReactionAdd', {
      emoji: { name: '🔥' },
      message: {
        id: 'dc-react',
        channel: { id: 'chan-1', send: async () => {} },
      },
    }, { id: 'user-1' });

    await delay(0);

    assert.equal(waEvents.length, 1);
    assert.equal(waEvents[0].jid, 'jid@s.whatsapp.net');
    assert.equal(waEvents[0].removed, false);
    assert.equal(waEvents[0].reaction.emoji.name, '🔥');
  } finally {
    utils.discord.getGuild = originalDiscordUtils.getGuild;
    utils.discord.getControlChannel = originalDiscordUtils.getControlChannel;
    utils.discord.channelIdToJid = originalDiscordUtils.channelIdToJid;

    state.settings.Token = originalSettings.Token;
    state.settings.GuildID = originalSettings.GuildID;

    state.dcClient = originalDcClient;
    state.waClient = originalWaClient;
    state.lastMessages = originalLastMessages;
    resetClientFactoryOverrides();
  }
});
