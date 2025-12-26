import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

const run = async (command, args, { cwd, env, timeoutMs = 120_000 } = {}) => new Promise((resolve) => {
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  const timeout = setTimeout(() => {
    child.kill('SIGKILL');
  }, timeoutMs);
  if (typeof timeout.unref === 'function') {
    timeout.unref();
  }

  child.on('close', (code, signal) => {
    clearTimeout(timeout);
    resolve({ code, signal, stdout, stderr });
  });
});

test('Smoke boots successfully (WA2DC_SMOKE_TEST)', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wa2dc-smoke-'));
  try {
    const result = await run(
      process.execPath,
      [path.join(ROOT, 'src', 'index.js')],
      {
        cwd: tempDir,
        env: {
          ...process.env,
          WA2DC_SMOKE_TEST: '1',
        },
        timeoutMs: 120_000,
      },
    );

    assert.equal(result.code, 0, result.stderr);
    const combined = `${result.stdout}\n${result.stderr}`;
    assert.ok(combined.includes('Smoke test completed successfully.'), combined);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

