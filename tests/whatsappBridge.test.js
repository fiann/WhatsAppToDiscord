import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

import { resetClientFactoryOverrides, setClientFactoryOverrides } from '../src/clientFactories.js';
import state from '../src/state.js';
import utils from '../src/utils.js';

const snapshotObject = (value) => ({ ...value });
const restoreObject = (target, snapshot) => {
  Object.keys(target).forEach((key) => { delete target[key]; });
  Object.assign(target, snapshot);
};
const snapshotSet = (value) => Array.from(value);
const restoreSet = (target, snapshot) => {
  target.clear();
  snapshot.forEach((entry) => target.add(entry));
};

test('WhatsApp message emits Discord event', async () => {
  const originalLogger = state.logger;
  const originalOneWay = state.settings.oneWay;
  const originalLastMessages = state.lastMessages;
  const originalStartTime = state.startTime;
  const originalSentMessages = snapshotSet(state.sentMessages);
  const originalSentReactions = snapshotSet(state.sentReactions);
  const originalSentPins = snapshotSet(state.sentPins);
  const originalChats = snapshotObject(state.chats);
  const originalContacts = snapshotObject(state.contacts);
  const originalDcClient = state.dcClient;
  const originalWaClient = state.waClient;
  const originalGetControlChannel = utils.discord.getControlChannel;
  const originalWhatsappUtils = utils.whatsapp;

  try {
    state.logger = { info() {}, error() {}, warn() {}, debug() {} };
    state.settings.oneWay = 0b11;
    state.lastMessages = {};
    state.startTime = 0;
    state.sentMessages.clear();
    state.sentReactions.clear();
    state.sentPins.clear();
    restoreObject(state.chats, {});
    restoreObject(state.contacts, {});

    const controlMessages = [];
    const controlChannel = { send: async (msg) => { controlMessages.push(msg); } };
    utils.discord.getControlChannel = async () => controlChannel;

    utils.whatsapp = {
      _profilePicsCache: {},
      sendQR() {},
      getId: (raw) => raw.key.id,
      getMessageType: () => 'conversation',
      inWhitelist: () => true,
      sentAfterStart: () => true,
      getMessage: (raw) => ['conversation', { text: raw.message }],
      getSenderName: async () => 'Tester',
      getContent: (message) => message.text,
      getQuote: async () => null,
      getFile: async () => null,
      getProfilePic: async () => null,
      getChannelJid: async (raw) => raw.key.remoteJid,
      isGroup: () => false,
      isForwarded: () => false,
      getTimestamp: () => Date.now(),
      formatJid: (jid) => jid,
      migrateLegacyJid: () => {},
      isLidJid: () => true,
      toJid: (value) => value,
      deleteSession: async () => {},
      getSenderJid: async (raw) => raw.key.remoteJid,
      getMentionedJids: () => [],
      convertDiscordFormatting: (text) => text,
      createQuoteMessage: async () => null,
      createDocumentContent: () => ({}),
      jidToName: (jid) => jid,
      updateContacts() {},
      generateLinkPreview: async () => null,
    };

    const forwarded = [];
    state.dcClient = new EventEmitter();
    state.dcClient.on('whatsappMessage', (payload) => forwarded.push(payload));

    class FakeWhatsAppClient {
      constructor() {
        this.ev = new EventEmitter();
        this.contacts = {};
        this.signalRepository = {};
        this.ws = { on() {} };
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

    fakeClient.ev.emit('connection.update', { connection: 'open' });
    fakeClient.ev.emit('messages.upsert', {
      type: 'notify',
      messages: [{
        key: { id: 'abc', remoteJid: 'jid@s.whatsapp.net' },
        message: 'hello world',
      }],
    });

    await delay(0);

    assert.equal(forwarded[0]?.id, 'abc');
    assert.equal(forwarded[0]?.content, 'hello world');
    assert.equal(forwarded[0]?.channelJid, 'jid@s.whatsapp.net');
    assert.ok(controlMessages.length >= 1);
  } finally {
    state.logger = originalLogger;
    state.settings.oneWay = originalOneWay;
    state.lastMessages = originalLastMessages;
    state.startTime = originalStartTime;
    restoreSet(state.sentMessages, originalSentMessages);
    restoreSet(state.sentReactions, originalSentReactions);
    restoreSet(state.sentPins, originalSentPins);
    restoreObject(state.chats, originalChats);
    restoreObject(state.contacts, originalContacts);
    state.dcClient = originalDcClient;
    state.waClient = originalWaClient;
    utils.discord.getControlChannel = originalGetControlChannel;
    utils.whatsapp = originalWhatsappUtils;
    resetClientFactoryOverrides();
  }
});

