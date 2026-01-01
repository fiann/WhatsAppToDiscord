import assert from 'node:assert/strict';
import test from 'node:test';

import utils from '../src/utils.js';

test('Update message formatting stays within Discord 2000 character limit', () => {
  const updateInfo = {
    currVer: 'v0.0.0',
    version: 'v9.9.9',
    url: 'https://example.com/releases/v9.9.9',
    changes: 'a'.repeat(10_000),
    channel: 'unstable',
    canSelfUpdate: false,
  };

  const message = utils.updater.formatUpdateMessage(updateInfo);

  assert.ok(message.length <= 2000);
  assert.match(message, /A new unstable version is available/);
  assert.ok(message.includes(`See ${updateInfo.url}`));
  assert.match(message, /Changelog:/);
  assert.ok(message.includes('...'));
});
