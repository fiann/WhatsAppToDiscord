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


def test_discord_typing_updates_whatsapp():
    script = dedent(
        """
        const { EventEmitter } = require('node:events');
        const { setClientFactoryOverrides, resetClientFactoryOverrides } = require('./src/clientFactories.js');
        const state = require('./src/state.js').default;
        const utils = require('./src/utils.js').default;

        const originalSetTimeout = global.setTimeout;
        const originalClearTimeout = global.clearTimeout;
        global.setTimeout = (fn, ms, ...args) => {
          if (typeof ms === 'number' && ms >= 1000) {
            fn(...args);
            return { __immediate: true };
          }
          return originalSetTimeout(fn, ms, ...args);
        };
        global.clearTimeout = (handle) => {
          if (handle && handle.__immediate) {
            return;
          }
          return originalClearTimeout(handle);
        };

        state.settings.Token = 'TEST_TOKEN';
        state.settings.GuildID = 'guild';
        state.chats['123@jid'] = { channelId: 'chan-1' };
        state.waClient = {
          updates: [],
          async sendPresenceUpdate(status, jid) {
            this.updates.push({ status, jid });
          },
        };

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
        const discordHandler = require('./src/discordHandler.js').default;

        (async () => {
          state.dcClient = await discordHandler.start();
          fakeClient.emit('typingStart', { channel: { id: 'chan-1' } });
          setTimeout(() => {
            console.log(JSON.stringify({
              loginCalls: fakeClient.loginCalls,
              presenceUpdates: state.waClient.updates,
            }));
            resetClientFactoryOverrides();
          }, 0);
        })();
        """
    )
    output = node_eval(script)
    payload = json.loads(output)
    assert payload["loginCalls"] == ["TEST_TOKEN"]
    assert payload["presenceUpdates"] == [
        {"status": "composing", "jid": "123@jid"},
        {"status": "paused", "jid": "123@jid"},
    ]
