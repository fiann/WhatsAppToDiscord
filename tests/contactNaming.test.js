import assert from 'node:assert/strict';
import test from 'node:test';

import state from '../src/state.js';
import utils from '../src/utils.js';

const snapshotObject = (value) => ({ ...value });
const restoreObject = (target, snapshot) => {
  Object.keys(target).forEach((key) => { delete target[key]; });
  Object.assign(target, snapshot);
};

test('updateContacts does not overwrite existing names with pushName updates', () => {
  const originalWaClient = state.waClient;
  const originalContacts = snapshotObject(state.contacts);

  try {
    restoreObject(state.contacts, {});
    state.waClient = { contacts: state.contacts };

    const jid = '14155550123@s.whatsapp.net';
    state.contacts[jid] = 'Alice Doe';

    utils.whatsapp.updateContacts([{
      id: jid,
      notify: 'Alice',
      pushName: 'Alice',
    }]);

    assert.equal(state.contacts[jid], 'Alice Doe');
  } finally {
    state.waClient = originalWaClient;
    restoreObject(state.contacts, originalContacts);
  }
});

test('updateContacts overwrites fallback phone numbers with better names', () => {
  const originalWaClient = state.waClient;
  const originalContacts = snapshotObject(state.contacts);

  try {
    restoreObject(state.contacts, {});
    state.waClient = { contacts: state.contacts };

    const jid = '14155550123@s.whatsapp.net';
    state.contacts[jid] = '14155550123';

    utils.whatsapp.updateContacts([{
      id: jid,
      notify: 'Alice',
    }]);

    assert.equal(state.contacts[jid], 'Alice');
  } finally {
    state.waClient = originalWaClient;
    restoreObject(state.contacts, originalContacts);
  }
});

