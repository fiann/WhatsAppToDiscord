import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { resetClientFactoryOverrides, setClientFactoryOverrides } from '../src/clientFactories.js';
import state from '../src/state.js';
import utils from '../src/utils.js';

const snapshotObject = (value) => ({ ...value });
const restoreObject = (target, snapshot) => {
  Object.keys(target).forEach((key) => { delete target[key]; });
  Object.assign(target, snapshot);
};

const snapshotWhitelist = () => Array.isArray(state.settings.Whitelist) ? [...state.settings.Whitelist] : [];

test('hydrateJidPair prefers PN and migrates LID chat keys', async () => {
  const originalWaClient = state.waClient;
  const originalLogger = state.logger;
  const originalChats = snapshotObject(state.chats);
  const originalContacts = snapshotObject(state.contacts);
  const originalWhitelist = snapshotWhitelist();

  try {
    state.logger = { warn() {} };
    restoreObject(state.chats, {});
    restoreObject(state.contacts, {});
    state.settings.Whitelist = [];

    const lidJid = '161040050426060@lid';
    const pnJid = '14155550123@s.whatsapp.net';

    state.chats[lidJid] = { channelId: 'chan-1' };
    state.contacts[lidJid] = 'Alice';

    state.waClient = {
      signalRepository: {
        lidMapping: {
          getPNForLID: async (lid) => (utils.whatsapp.formatJid(lid) === lidJid ? pnJid : null),
          getLIDForPN: async (pn) => (utils.whatsapp.formatJid(pn) === pnJid ? lidJid : null),
        },
      },
      contacts: {},
    };

    const [preferred, fallback] = await utils.whatsapp.hydrateJidPair(lidJid);

    assert.equal(preferred, pnJid);
    assert.equal(fallback, lidJid);
    assert.equal(state.chats[lidJid], undefined);
    assert.equal(state.chats[pnJid]?.channelId, 'chan-1');
  } finally {
    state.waClient = originalWaClient;
    state.logger = originalLogger;
    restoreObject(state.chats, originalChats);
    restoreObject(state.contacts, originalContacts);
    state.settings.Whitelist = originalWhitelist;
  }
});

test('hydrateJidPair keeps PN preferred when a LID mapping exists', async () => {
  const originalWaClient = state.waClient;
  const originalLogger = state.logger;
  const originalChats = snapshotObject(state.chats);
  const originalContacts = snapshotObject(state.contacts);
  const originalWhitelist = snapshotWhitelist();

  try {
    state.logger = { warn() {} };
    restoreObject(state.chats, {});
    restoreObject(state.contacts, {});
    state.settings.Whitelist = [];

    const lidJid = '161040050426060@lid';
    const pnJid = '14155550123@s.whatsapp.net';

    state.chats[pnJid] = { channelId: 'chan-pn' };
    state.chats[lidJid] = { channelId: 'chan-lid' };

    state.waClient = {
      signalRepository: {
        lidMapping: {
          getPNForLID: async (lid) => (utils.whatsapp.formatJid(lid) === lidJid ? pnJid : null),
          getLIDForPN: async (pn) => (utils.whatsapp.formatJid(pn) === pnJid ? lidJid : null),
        },
      },
      contacts: {},
    };

    const [preferred, fallback] = await utils.whatsapp.hydrateJidPair(pnJid);

    assert.equal(preferred, pnJid);
    assert.equal(fallback, lidJid);
    assert.equal(state.chats[pnJid]?.channelId, 'chan-pn');
    assert.equal(state.chats[lidJid], undefined);
  } finally {
    state.waClient = originalWaClient;
    state.logger = originalLogger;
    restoreObject(state.chats, originalChats);
    restoreObject(state.contacts, originalContacts);
    state.settings.Whitelist = originalWhitelist;
  }
});

test('WhatsApp sendMessage wrapper prefers PN when available', async () => {
  const originalWaClient = state.waClient;
  const originalLogger = state.logger;
  const originalChats = snapshotObject(state.chats);
  const originalContacts = snapshotObject(state.contacts);
  const originalWhitelist = snapshotWhitelist();
  const originalGetControlChannel = utils.discord.getControlChannel;

  try {
    state.logger = { info() {}, warn() {}, error() {}, debug() {} };
    restoreObject(state.chats, {});
    restoreObject(state.contacts, {});
    state.settings.Whitelist = [];
    utils.discord.getControlChannel = async () => ({ send: async () => {} });

    const lidJid = '161040050426060@lid';
    const pnJid = '14155550123@s.whatsapp.net';

    class FakeWhatsAppClient {
      constructor() {
        this.ev = new EventEmitter();
        this.ws = { on() {} };
        this.user = { id: '0@s.whatsapp.net' };
        this.contacts = {};
        this.signalRepository = {
          lidMapping: {
            getPNForLID: async (lid) => (utils.whatsapp.formatJid(lid) === lidJid ? pnJid : null),
          },
        };
        this.sendCalls = [];
      }

      async sendMessage(jid, content, options) {
        this.sendCalls.push({ jid, content, options });
        return { key: { id: 'sent-1', remoteJid: jid } };
      }

      async groupFetchAllParticipating() {
        return {};
      }

      async profilePictureUrl() {
        return null;
      }
    }

    const fakeClient = new FakeWhatsAppClient();
    setClientFactoryOverrides({
      createWhatsAppClient: () => fakeClient,
      getBaileysVersion: async () => ({ version: [1, 0, 0] }),
    });

    const { connectToWhatsApp } = await import('../src/whatsappHandler.js');
    await connectToWhatsApp();
    state.waClient = fakeClient;

    await fakeClient.sendMessage(lidJid, { text: 'hi', linkPreview: {} }, {});

    assert.equal(fakeClient.sendCalls[0]?.jid, pnJid);
  } finally {
    utils.discord.getControlChannel = originalGetControlChannel;
    resetClientFactoryOverrides();
    state.waClient = originalWaClient;
    state.logger = originalLogger;
    restoreObject(state.chats, originalChats);
    restoreObject(state.contacts, originalContacts);
    state.settings.Whitelist = originalWhitelist;
  }
});

test('getChannelJid keeps status@broadcast for WhatsApp Status messages', async () => {
  const originalWaClient = state.waClient;
  const originalLogger = state.logger;
  const originalChats = snapshotObject(state.chats);
  const originalContacts = snapshotObject(state.contacts);
  const originalWhitelist = snapshotWhitelist();

  try {
    state.logger = { warn() {}, debug() {} };
    restoreObject(state.chats, {});
    restoreObject(state.contacts, {});
    state.settings.Whitelist = [];

    state.chats['161040050426060@lid'] = { channelId: 'chan-lid' };

    state.waClient = {
      user: { id: '0@s.whatsapp.net' },
      signalRepository: {},
      contacts: state.contacts,
    };

    const channelJid = await utils.whatsapp.getChannelJid({
      key: {
        remoteJid: 'status@broadcast',
        remoteJidAlt: '161040050426060@lid',
        participant: '14155550123@s.whatsapp.net',
      },
    });

    assert.equal(channelJid, 'status@broadcast');
    assert.equal(utils.whatsapp.isGroup({
      key: {
        remoteJid: 'status@broadcast',
        participant: '14155550123@s.whatsapp.net',
      },
    }), false);
  } finally {
    state.waClient = originalWaClient;
    state.logger = originalLogger;
    restoreObject(state.chats, originalChats);
    restoreObject(state.contacts, originalContacts);
    state.settings.Whitelist = originalWhitelist;
  }
});
