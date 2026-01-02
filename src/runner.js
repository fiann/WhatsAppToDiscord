import cluster from 'cluster';
import { spawn } from 'child_process';
import path from 'path';
import pino from 'pino';
import pretty from 'pino-pretty';
import fs from 'fs';
import { pathToFileURL } from 'url';
import { promisify } from 'util';

import {
  clearRestartFlagSync,
  evaluateWorkerExit,
  resolveMaxRestarts,
  resolveRestartDelayMs,
  resolveRestartFlagPath,
  resolveSafeRuntimeResetWindowMs,
} from './runnerLogic.js';

const RESTART_DELAY = resolveRestartDelayMs(process.env.WA2DC_RESTART_DELAY);
const SAFE_RUNTIME_RESET_WINDOW = resolveSafeRuntimeResetWindowMs(RESTART_DELAY);
const MAX_RESTARTS = resolveMaxRestarts(process.env.WA2DC_MAX_RESTARTS);
const RESTART_FLAG_PATH = resolveRestartFlagPath(process.env.WA2DC_RESTART_FLAG_PATH, process.cwd());

const WORKER_ENV_FLAG = 'WA2DC_WORKER';

const overrideChildUrl = process.env.WA2DC_CHILD_PATH
  ? pathToFileURL(path.resolve(process.env.WA2DC_CHILD_PATH))
  : null;

const chmodAsync = promisify(fs.chmod);

async function runWorker() {
  if (overrideChildUrl) {
    const childPath = overrideChildUrl.pathname;
    try {
      await chmodAsync(childPath, 0o755);
    } catch (err) {
      if (err?.code !== 'ENOENT') {
        // Best-effort: log but continue to attempt to start anyway.
        console.warn({ err, childPath }, 'Failed to ensure child binary is executable');
      }
    }
    await import(overrideChildUrl.href);
  } else {
    await import('./index.js');
  }
}

function setupSupervisorLogging() {
  const logger = pino({}, pino.multistream([
    { stream: pino.destination('logs.txt') },
    { stream: pretty({ colorize: true }) },
  ]));

  const termLogPath = path.resolve(process.cwd(), 'terminal.log');
  const termLog = fs.createWriteStream(termLogPath, { flags: 'a' });
  termLog.on('error', (err) => logger?.warn?.({ err }, 'terminal.log write error'));

  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  const tee = (orig) => (chunk, encoding, cb) => {
    termLog.write(chunk, encoding, () => {});
    return orig(chunk, encoding, cb);
  };
  process.stdout.write = tee(origStdoutWrite);
  process.stderr.write = tee(origStderrWrite);

  process.on('exit', () => {
    termLog.end();
  });

  return logger;
}

async function runSupervisorWithSpawn() {
  const logger = setupSupervisorLogging();

  let restartAttempts = 0;
  let workerStartTime = 0;
  let currentWorker = null;
  let shuttingDown = false;

  const handleExit = (code, signal) => {
    if (shuttingDown) {
      process.exit(code ?? 0);
    }

    const runtime = Date.now() - workerStartTime;
    const restartRequested = clearRestartFlagSync(RESTART_FLAG_PATH, { logger });

    const decision = evaluateWorkerExit({
      exitCode: code,
      restartRequested,
      runtimeMs: runtime,
      safeRuntimeResetWindowMs: SAFE_RUNTIME_RESET_WINDOW,
      restartAttempts,
      maxRestarts: MAX_RESTARTS,
      restartDelayMs: RESTART_DELAY,
    });

    restartAttempts = decision.restartAttempts;

    if (decision.action === 'exit') {
      if (decision.reason === 'max-restarts') {
        logger.error(`Maximum restart attempts (${MAX_RESTARTS}) reached. Exiting.`);
      }
      process.exit(decision.exitCode);
      return;
    }

    if (decision.reason === 'restart-flag') {
      logger.info('Restart flag detected. Restarting immediately.');
      setImmediate(start);
      return;
    }

    const reason = code !== 0 ? ` unexpectedly with code ${code ?? signal}` : '';
    logger.error(
      `Bot exited${reason}. Restarting in ${decision.delayMs / 1000}s (attempt ${restartAttempts}/${MAX_RESTARTS})...`,
    );
    setTimeout(start, decision.delayMs);
  };

  const start = () => {
    workerStartTime = Date.now();
    currentWorker = spawn(process.execPath, [], {
      env: { ...process.env, [WORKER_ENV_FLAG]: '1' },
      stdio: ['inherit', 'pipe', 'pipe'],
    });

    currentWorker.stdout?.pipe(process.stdout);
    currentWorker.stderr?.pipe(process.stderr);

    currentWorker.once('exit', (code, signal) => {
      currentWorker = null;
      handleExit(code, signal);
    });

    currentWorker.once('error', (err) => {
      logger.error({ err }, 'Worker process error');
    });
  };

  ['SIGINT', 'SIGTERM'].forEach((sig) => {
    process.on(sig, () => {
      shuttingDown = true;
      if (currentWorker && !currentWorker.killed) {
        currentWorker.kill(sig);
      }
    });
  });

  start();
}

async function main() {
  if (process.env[WORKER_ENV_FLAG] === '1') {
    await runWorker();
    return;
  }

  if (process.pkg) {
    await runSupervisorWithSpawn();
    return;
  }

  if (!cluster.isPrimary) {
    await runWorker();
    return;
  }

  const clusterExecArgv = process.pkg ? [] : ['--no-deprecation'];
  // `silent: true` pipes worker stdout/stderr so we can tee them into terminal.log.
  cluster.setupPrimary({ execArgv: clusterExecArgv, silent: true });

  const logger = setupSupervisorLogging();

  let restartAttempts = 0;
  let workerStartTime = 0;
  let currentWorker = null;
  let shuttingDown = false;

  const handleExit = (code, signal) => {
    if (shuttingDown) {
      process.exit(code ?? 0);
    }

    const runtime = Date.now() - workerStartTime;
    const restartRequested = clearRestartFlagSync(RESTART_FLAG_PATH, { logger });

    const decision = evaluateWorkerExit({
      exitCode: code,
      restartRequested,
      runtimeMs: runtime,
      safeRuntimeResetWindowMs: SAFE_RUNTIME_RESET_WINDOW,
      restartAttempts,
      maxRestarts: MAX_RESTARTS,
      restartDelayMs: RESTART_DELAY,
    });

    restartAttempts = decision.restartAttempts;

    if (decision.action === 'exit') {
      if (decision.reason === 'max-restarts') {
        logger.error(`Maximum restart attempts (${MAX_RESTARTS}) reached. Exiting.`);
      }
      process.exit(decision.exitCode);
      return;
    }

    if (decision.reason === 'restart-flag') {
      logger.info('Restart flag detected. Restarting immediately.');
      setImmediate(start);
      return;
    }

    const reason = code !== 0 ? ` unexpectedly with code ${code ?? signal}` : '';
    logger.error(
      `Bot exited${reason}. Restarting in ${decision.delayMs / 1000}s (attempt ${restartAttempts}/${MAX_RESTARTS})...`,
    );
    setTimeout(start, decision.delayMs);
  };

  const start = () => {
    workerStartTime = Date.now();
    currentWorker = cluster.fork();

    const child = currentWorker.process;
    if (child?.stdout) {
      child.stdout.pipe(process.stdout);
    }
    if (child?.stderr) {
      child.stderr.pipe(process.stderr);
    }
    if (child?.stdin && process.stdin?.readable) {
      try {
        process.stdin.pipe(child.stdin);
      } catch (err) {
        logger.warn({ err }, 'Failed to forward stdin to worker');
      }
    }

    currentWorker.once('exit', (code, signal) => {
      if (child?.stdin) {
        try {
          process.stdin.unpipe(child.stdin);
        } catch {
          // Ignore unpipe errors (worker may already be gone).
        }
      }
      currentWorker = null;
      handleExit(code, signal);
    });

    currentWorker.once('error', (err) => {
      logger.error({ err }, 'Worker process error');
    });
  };

  ['SIGINT', 'SIGTERM'].forEach((sig) => {
    process.on(sig, () => {
      shuttingDown = true;
      if (currentWorker?.process && !currentWorker.process.killed) {
        currentWorker.process.kill(sig);
      }
    });
  });

  start();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
