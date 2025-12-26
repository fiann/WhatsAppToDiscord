import assert from 'node:assert/strict';
import test from 'node:test';

import { sentMessages, settings } from '../src/state.js';

test('Default settings include DownloadDir', () => {
  assert.equal(settings.DownloadDir, './downloads');
});

test('sentMessages starts empty', () => {
  assert.deepEqual(Array.from(sentMessages), []);
});

