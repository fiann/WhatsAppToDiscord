import assert from 'node:assert/strict';
import test from 'node:test';

import state from '../src/state.js';
import utils from '../src/utils.js';

const snapshotObject = (value) => ({ ...value });
const restoreObject = (target, snapshot) => {
  Object.keys(target).forEach((key) => { delete target[key]; });
  Object.assign(target, snapshot);
};

test('HidePhoneNumbers replaces phone-only names with pseudonyms', () => {
  const originalWaClient = state.waClient;
  const originalContacts = snapshotObject(state.contacts);
  const originalSettings = snapshotObject(state.settings);

  try {
    restoreObject(state.contacts, {});
    state.settings.HidePhoneNumbers = true;
    state.settings.PrivacySalt = Buffer.alloc(32, 7).toString('base64url');

    const jid = '14155550123@s.whatsapp.net';
    state.contacts[jid] = '14155550123';
    state.waClient = { contacts: state.contacts, user: { id: '0@s.whatsapp.net' } };

    const name = utils.whatsapp.jidToName(jid);
    assert.ok(name.startsWith('WA User '), name);
    assert.notEqual(name, '14155550123');

    const tag = utils.whatsapp.privacyTagForJid(jid);
    assert.equal(utils.whatsapp.jidToChannelName(jid), `wa-user-${tag}`);
    assert.equal(utils.whatsapp.toJid(name), jid);
    assert.equal(utils.whatsapp.formatJidForDisplay(jid), `pn:redacted:${tag}`);
  } finally {
    state.waClient = originalWaClient;
    restoreObject(state.contacts, originalContacts);
    restoreObject(state.settings, originalSettings);
  }
});

test('HidePhoneNumbers keeps real contact names intact', () => {
  const originalWaClient = state.waClient;
  const originalContacts = snapshotObject(state.contacts);
  const originalSettings = snapshotObject(state.settings);

  try {
    restoreObject(state.contacts, {});
    state.settings.HidePhoneNumbers = true;
    state.settings.PrivacySalt = Buffer.alloc(32, 9).toString('base64url');

    const jid = '14155550123@s.whatsapp.net';
    state.contacts[jid] = 'Alice Doe';
    state.waClient = { contacts: state.contacts, user: { id: '0@s.whatsapp.net' } };

    assert.equal(utils.whatsapp.jidToName(jid), 'Alice Doe');
    assert.equal(utils.whatsapp.jidToChannelName(jid), 'Alice Doe');
    assert.equal(utils.whatsapp.toJid('Alice Doe'), jid);
  } finally {
    state.waClient = originalWaClient;
    restoreObject(state.contacts, originalContacts);
    restoreObject(state.settings, originalSettings);
  }
});

