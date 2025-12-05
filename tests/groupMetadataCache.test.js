import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { GroupMetadataCache } from '../src/groupMetadataCache.js';

const WAIT_MS = 30;

const buildCache = (ttlMs = WAIT_MS) => new GroupMetadataCache({ ttlMs });

test('GroupMetadataCache hit/miss, ttl, prime, prune, clear', async () => {
  const cache = buildCache();

  cache.set('group-1', { id: 'group-1', subject: 'Hello' });
  assert.equal(cache.get('group-1').subject, 'Hello');

  cache.prime({ 'group-2': { id: 'group-2', subject: 'World' } });
  assert.equal(cache.get('group-2').subject, 'World');

  cache.invalidate('group-1');
  assert.equal(cache.get('group-1'), undefined);

  cache.set('group-ttl', { id: 'group-ttl', subject: 'Soon stale' });
  await delay(WAIT_MS + 10);
  cache.prune();
  assert.equal(cache.get('group-ttl'), undefined);

  cache.clear();
  assert.equal(cache.get('group-2'), undefined);
});
