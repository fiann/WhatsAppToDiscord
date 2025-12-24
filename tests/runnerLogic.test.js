import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  clearRestartFlagSync,
  computeBackoffDelayMs,
  evaluateWorkerExit,
} from '../src/runnerLogic.js';

test('computeBackoffDelayMs doubles per attempt', () => {
  assert.equal(computeBackoffDelayMs(10, 1), 10);
  assert.equal(computeBackoffDelayMs(10, 2), 20);
  assert.equal(computeBackoffDelayMs(10, 3), 40);
});

test('evaluateWorkerExit exits cleanly on code 0', () => {
  const result = evaluateWorkerExit({
    exitCode: 0,
    restartRequested: false,
    restartAttempts: 3,
  });

  assert.deepEqual(result, {
    action: 'exit',
    reason: 'clean-exit',
    exitCode: 0,
    restartAttempts: 3,
    delayMs: null,
  });
});

test('evaluateWorkerExit restarts immediately when restart.flag is present (even on code 0)', () => {
  const result = evaluateWorkerExit({
    exitCode: 0,
    restartRequested: true,
    restartAttempts: 4,
  });

  assert.deepEqual(result, {
    action: 'restart',
    reason: 'restart-flag',
    exitCode: null,
    restartAttempts: 0,
    delayMs: 0,
  });
});

test('evaluateWorkerExit applies exponential backoff for crashes', () => {
  const first = evaluateWorkerExit({
    exitCode: 1,
    restartRequested: false,
    restartAttempts: 0,
    maxRestarts: 5,
    restartDelayMs: 10,
  });
  assert.deepEqual(first, {
    action: 'restart',
    reason: 'crash',
    exitCode: null,
    restartAttempts: 1,
    delayMs: 10,
  });

  const second = evaluateWorkerExit({
    exitCode: 1,
    restartRequested: false,
    restartAttempts: first.restartAttempts,
    maxRestarts: 5,
    restartDelayMs: 10,
  });
  assert.equal(second.action, 'restart');
  assert.equal(second.restartAttempts, 2);
  assert.equal(second.delayMs, 20);
});

test('evaluateWorkerExit exits once MAX_RESTARTS is exceeded', () => {
  const result = evaluateWorkerExit({
    exitCode: 2,
    restartRequested: false,
    restartAttempts: 5,
    maxRestarts: 5,
    restartDelayMs: 10,
  });

  assert.deepEqual(result, {
    action: 'exit',
    reason: 'max-restarts',
    exitCode: 2,
    restartAttempts: 6,
    delayMs: null,
  });
});

test('evaluateWorkerExit resets restartAttempts after long stable runtime', () => {
  const result = evaluateWorkerExit({
    exitCode: 1,
    restartRequested: false,
    runtimeMs: 20_000,
    safeRuntimeResetWindowMs: 10_000,
    restartAttempts: 4,
    maxRestarts: 5,
    restartDelayMs: 10,
  });

  assert.equal(result.action, 'restart');
  assert.equal(result.restartAttempts, 1);
  assert.equal(result.delayMs, 10);
});

test('clearRestartFlagSync returns false when missing', async () => {
  const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'wa2dc-restartflag-'));
  const flagPath = path.join(tempDir, 'restart.flag');
  try {
    assert.equal(clearRestartFlagSync(flagPath, { fsModule: fs }), false);
  } finally {
    await fsPromises.rm(tempDir, { recursive: true, force: true });
  }
});

test('clearRestartFlagSync removes restart.flag when present', async () => {
  const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'wa2dc-restartflag-'));
  const flagPath = path.join(tempDir, 'restart.flag');
  try {
    await fsPromises.writeFile(flagPath, '');
    assert.equal(clearRestartFlagSync(flagPath, { fsModule: fs }), true);
    await assert.rejects(() => fsPromises.stat(flagPath), /ENOENT/);
  } finally {
    await fsPromises.rm(tempDir, { recursive: true, force: true });
  }
});

test('clearRestartFlagSync treats ENOENT unlink races as success', () => {
  const calls = [];
  const logger = { warn: (...args) => calls.push(args) };
  const fakeFs = {
    existsSync: () => true,
    unlinkSync: () => {
      const err = new Error('gone');
      err.code = 'ENOENT';
      throw err;
    },
  };

  assert.equal(clearRestartFlagSync('restart.flag', { logger, fsModule: fakeFs }), true);
  assert.equal(calls.length, 0);
});

