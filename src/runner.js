import cluster from 'cluster';
import path from 'path';
import pino from 'pino';
import pretty from 'pino-pretty';
import fs from 'fs';
import { pathToFileURL } from 'url';

const DEFAULT_RESTART_DELAY = 10000; // ms
const parsedRestartDelay = Number(process.env.WA2DC_RESTART_DELAY);
const RESTART_DELAY = Number.isFinite(parsedRestartDelay) && parsedRestartDelay >= 0
  ? parsedRestartDelay
  : DEFAULT_RESTART_DELAY;

const SAFE_RUNTIME_RESET_WINDOW = Math.max(RESTART_DELAY, DEFAULT_RESTART_DELAY);

const parsedMaxRestarts = Number(process.env.WA2DC_MAX_RESTARTS);
const MAX_RESTARTS = Number.isFinite(parsedMaxRestarts) && parsedMaxRestarts > 0
  ? parsedMaxRestarts
  : 5;

const RESTART_FLAG_PATH = process.env.WA2DC_RESTART_FLAG_PATH
  ? path.resolve(process.env.WA2DC_RESTART_FLAG_PATH)
  : path.resolve(process.cwd(), 'restart.flag');

const overrideChildUrl = process.env.WA2DC_CHILD_PATH
  ? pathToFileURL(path.resolve(process.env.WA2DC_CHILD_PATH))
  : null;

async function runWorker() {
  if (overrideChildUrl) {
    await import(overrideChildUrl.href);
  } else {
    await import('./index.js');
  }
}

async function main() {
  if (!cluster.isPrimary) {
    await runWorker();
    return;
  }

  const clusterExecArgv = process.pkg ? [] : ['--no-deprecation'];
  cluster.setupPrimary({ execArgv: clusterExecArgv });

  const logger = pino({}, pino.multistream([
    { stream: pino.destination('logs.txt') },
    { stream: pretty({ colorize: true }) },
  ]));

  // Capture everything printed to the terminal in a separate file
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

  let restartAttempts = 0;
  let workerStartTime = 0;
  let currentWorker = null;
  let shuttingDown = false;

  const clearRestartFlag = () => {
    if (!fs.existsSync(RESTART_FLAG_PATH)) {
      return false;
    }
    try {
      fs.unlinkSync(RESTART_FLAG_PATH);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        logger.warn({ err }, 'Failed to remove restart flag');
      }
    }
    return true;
  };

  const handleExit = (code, signal) => {
    if (shuttingDown) {
      process.exit(code ?? 0);
    }

    const restartRequested = clearRestartFlag();
    const runtime = Date.now() - workerStartTime;
    if (runtime > SAFE_RUNTIME_RESET_WINDOW) {
      restartAttempts = 0;
    }

    if (restartRequested) {
      restartAttempts = 0;
      logger.info('Restart flag detected. Restarting immediately.');
      setImmediate(start);
      return;
    }

    if (code === 0) {
      process.exit(0);
      return;
    }

    restartAttempts += 1;
    if (restartAttempts > MAX_RESTARTS) {
      logger.error(`Maximum restart attempts (${MAX_RESTARTS}) reached. Exiting.`);
      process.exit(code ?? 1);
      return;
    }

    const delay = RESTART_DELAY * (2 ** (restartAttempts - 1));
    const reason = code !== 0 ? ` unexpectedly with code ${code ?? signal}` : '';
    logger.error(
      `Bot exited${reason}. Restarting in ${delay / 1000}s (attempt ${restartAttempts}/${MAX_RESTARTS})...`,
    );
    setTimeout(start, delay);
  };

  const start = () => {
    workerStartTime = Date.now();
    currentWorker = cluster.fork();

    const child = currentWorker.process;
    if (child?.stdout) {
      child.stdout.on('data', (chunk) => termLog.write(chunk));
      child.stdout.pipe(process.stdout);
    }
    if (child?.stderr) {
      child.stderr.on('data', (chunk) => termLog.write(chunk));
      child.stderr.pipe(process.stderr);
    }

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
