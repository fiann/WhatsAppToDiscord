import assert from 'node:assert/strict';
import test from 'node:test';

import state from '../src/state.js';
import utils from '../src/utils.js';

const snapshotObject = (value) => ({ ...value });
const restoreObject = (target, snapshot) => {
  Object.keys(target).forEach((key) => { delete target[key]; });
  Object.assign(target, snapshot);
};

test('WhatsApp mentions can be converted to linked Discord user mentions', async () => {
  const originalWaClient = state.waClient;
  const originalContacts = snapshotObject(state.contacts);
  const originalLinks = snapshotObject(state.settings.WhatsAppDiscordMentionLinks);

  try {
    restoreObject(state.contacts, {});
    state.waClient = {
      contacts: state.contacts,
      user: { id: '0@s.whatsapp.net' },
      signalRepository: { lidMapping: {} },
    };

    const pnJid = '14155550123@s.whatsapp.net';
    const discordUserId = '123456789012345678';
    state.contacts[pnJid] = 'Alice';
    state.settings.WhatsAppDiscordMentionLinks = { [pnJid]: discordUserId };

    const msg = {
      text: 'Hi @14155550123',
      contextInfo: { mentionedJid: [pnJid] },
    };

    const result = await utils.whatsapp.getContent(msg, 'extendedTextMessage', 'extendedTextMessage', { mentionTarget: 'discord' });
    assert.equal(result.content, `Hi <@${discordUserId}>`);
    assert.deepEqual(result.discordMentions, [discordUserId]);
  } finally {
    state.waClient = originalWaClient;
    restoreObject(state.contacts, originalContacts);
    state.settings.WhatsAppDiscordMentionLinks = originalLinks;
  }
});

test('Unlinked WhatsApp mentions fall back to WhatsApp contact names', async () => {
  const originalWaClient = state.waClient;
  const originalContacts = snapshotObject(state.contacts);
  const originalLinks = snapshotObject(state.settings.WhatsAppDiscordMentionLinks);

  try {
    restoreObject(state.contacts, {});
    state.waClient = {
      contacts: state.contacts,
      user: { id: '0@s.whatsapp.net' },
      signalRepository: { lidMapping: {} },
    };

    const pnJid = '14155550123@s.whatsapp.net';
    state.contacts[pnJid] = 'Alice';
    state.settings.WhatsAppDiscordMentionLinks = {};

    const msg = {
      text: 'Hi @14155550123',
      contextInfo: { mentionedJid: [pnJid] },
    };

    const result = await utils.whatsapp.getContent(msg, 'extendedTextMessage', 'extendedTextMessage', { mentionTarget: 'discord' });
    assert.equal(result.content, 'Hi @Alice');
    assert.deepEqual(result.discordMentions, []);
  } finally {
    state.waClient = originalWaClient;
    restoreObject(state.contacts, originalContacts);
    state.settings.WhatsAppDiscordMentionLinks = originalLinks;
  }
});

test('Linked mentions work when WhatsApp provides LID JIDs but message text contains the PN token', async () => {
  const originalWaClient = state.waClient;
  const originalContacts = snapshotObject(state.contacts);
  const originalLinks = snapshotObject(state.settings.WhatsAppDiscordMentionLinks);

  try {
    restoreObject(state.contacts, {});

    const pnJid = '14155550123@s.whatsapp.net';
    const lidJid = '161040050426060@lid';
    const discordUserId = '123456789012345678';

    state.waClient = {
      contacts: state.contacts,
      user: { id: '0@s.whatsapp.net' },
      signalRepository: {
        lidMapping: {
          getPNForLID: async (jid) => (jid === lidJid ? pnJid : null),
        },
      },
    };

    state.contacts[pnJid] = 'Alice';
    state.settings.WhatsAppDiscordMentionLinks = { [pnJid]: discordUserId };

    const msg = {
      text: 'Hi @14155550123',
      contextInfo: { mentionedJid: [lidJid] },
    };

    const result = await utils.whatsapp.getContent(msg, 'extendedTextMessage', 'extendedTextMessage', { mentionTarget: 'discord' });
    assert.equal(result.content, `Hi <@${discordUserId}>`);
    assert.deepEqual(result.discordMentions, [discordUserId]);
  } finally {
    state.waClient = originalWaClient;
    restoreObject(state.contacts, originalContacts);
    state.settings.WhatsAppDiscordMentionLinks = originalLinks;
  }
});

test('Linked mentions resolve when mention links were saved with a leading + phone JID', async () => {
  const originalWaClient = state.waClient;
  const originalContacts = snapshotObject(state.contacts);
  const originalLinks = snapshotObject(state.settings.WhatsAppDiscordMentionLinks);

  try {
    restoreObject(state.contacts, {});
    state.waClient = {
      contacts: state.contacts,
      user: { id: '0@s.whatsapp.net' },
      signalRepository: { lidMapping: {} },
    };

    const pnJid = '14155550123@s.whatsapp.net';
    const legacyKey = '+14155550123@s.whatsapp.net';
    const discordUserId = '123456789012345678';
    state.contacts[pnJid] = 'Alice';
    state.settings.WhatsAppDiscordMentionLinks = { [legacyKey]: discordUserId };

    const msg = {
      text: 'Hi @14155550123',
      contextInfo: { mentionedJid: [pnJid] },
    };

    const result = await utils.whatsapp.getContent(msg, 'extendedTextMessage', 'extendedTextMessage', { mentionTarget: 'discord' });
    assert.equal(result.content, `Hi <@${discordUserId}>`);
    assert.deepEqual(result.discordMentions, [discordUserId]);
  } finally {
    state.waClient = originalWaClient;
    restoreObject(state.contacts, originalContacts);
    state.settings.WhatsAppDiscordMentionLinks = originalLinks;
  }
});

test('Linked mentions ping when WhatsApp message text uses the contact name token', async () => {
  const originalWaClient = state.waClient;
  const originalContacts = snapshotObject(state.contacts);
  const originalLinks = snapshotObject(state.settings.WhatsAppDiscordMentionLinks);

  try {
    restoreObject(state.contacts, {});
    state.waClient = {
      contacts: state.contacts,
      user: { id: '0@s.whatsapp.net' },
      signalRepository: { lidMapping: {} },
    };

    const pnJid = '14155550123@s.whatsapp.net';
    const discordUserId = '123456789012345678';
    state.contacts[pnJid] = 'Alice';
    state.settings.WhatsAppDiscordMentionLinks = { [pnJid]: discordUserId };

    const msg = {
      text: 'Hi @Alice',
      contextInfo: { mentionedJid: [pnJid] },
    };

    const result = await utils.whatsapp.getContent(msg, 'extendedTextMessage', 'extendedTextMessage', { mentionTarget: 'discord' });
    assert.equal(result.content, `Hi <@${discordUserId}>`);
    assert.deepEqual(result.discordMentions, [discordUserId]);
  } finally {
    state.waClient = originalWaClient;
    restoreObject(state.contacts, originalContacts);
    state.settings.WhatsAppDiscordMentionLinks = originalLinks;
  }
});
