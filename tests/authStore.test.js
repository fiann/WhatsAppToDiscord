import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { useMultiFileAuthState } from '@whiskeysockets/baileys';

test('Baileys multi-file auth state supports newer signal keys', async () => {
  const authDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wa2dc-auth-'));
  try {
    const { state } = await useMultiFileAuthState(authDir);
    await state.keys.set({
      tctoken: { test: Buffer.from('rc8') },
      'lid-mapping': { pn: '161040050426060:29@lid' },
      'device-index': { primary: Buffer.from('device-index') },
      'device-list': { primary: Buffer.from('device-list') },
    });

    const stored = await state.keys.get('tctoken', ['test']);
    const lidMapping = await state.keys.get('lid-mapping', ['pn']);
    const deviceIndex = await state.keys.get('device-index', ['primary']);
    const deviceList = await state.keys.get('device-list', ['primary']);

    assert.equal(stored.test.toString('base64'), 'cmM4');
    assert.equal(lidMapping.pn, '161040050426060:29@lid');
    assert.equal(deviceIndex.primary.toString('utf8'), 'device-index');
    assert.equal(deviceList.primary.toString('utf8'), 'device-list');

    const files = (await fs.readdir(authDir))
      .filter((name) => /^(tctoken|lid-mapping|device-(index|list))/.test(name));

    assert.ok(files.some((name) => name.startsWith('tctoken-')));
    assert.ok(files.some((name) => name.startsWith('lid-mapping-')));
    assert.ok(files.some((name) => name.startsWith('device-index-')));
    assert.ok(files.some((name) => name.startsWith('device-list-')));
  } finally {
    await fs.rm(authDir, { recursive: true, force: true });
  }
});

