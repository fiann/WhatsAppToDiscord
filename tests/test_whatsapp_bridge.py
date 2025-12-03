import json
import subprocess
from pathlib import Path
from textwrap import dedent

ROOT = Path(__file__).resolve().parents[1]


def node_eval(code: str) -> str:
    result = subprocess.run(
        ["node", "-e", code],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=60,
        check=True,
    )
    return result.stdout.strip()


def test_whatsapp_message_emits_discord_event():
    script = dedent(
        """
        const { EventEmitter } = require('node:events');
        const { setClientFactoryOverrides, resetClientFactoryOverrides } = require('./src/clientFactories.js');
        const state = require('./src/state.js').default;
        const utils = require('./src/utils.js').default;
        const { connectToWhatsApp } = require('./src/whatsappHandler.js');

        state.logger = { info() {}, error() {}, warn() {} };
        state.settings.oneWay = 0b11;
        state.lastMessages = {};
        state.startTime = 0;
        state.sentMessages.clear();
        state.chats = {};
        state.contacts = {};

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
          updateContacts: () => {},
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

        (async () => {
          await connectToWhatsApp();
          fakeClient.ev.emit('connection.update', { connection: 'open' });
          fakeClient.ev.emit('messages.upsert', {
            type: 'notify',
            messages: [{
              key: { id: 'abc', remoteJid: 'jid@s.whatsapp.net' },
              message: 'hello world',
            }],
          });
          setTimeout(() => {
            console.log(JSON.stringify({
              forwarded,
              controlMessages,
            }));
            resetClientFactoryOverrides();
          }, 0);
        })();
        """
    )
    output = node_eval(script)
    payload = json.loads(output)
    assert payload["forwarded"][0]["id"] == "abc"
    assert payload["forwarded"][0]["content"] == "hello world"
    assert payload["forwarded"][0]["channelJid"] == "jid@s.whatsapp.net"
    assert len(payload["controlMessages"]) >= 1
