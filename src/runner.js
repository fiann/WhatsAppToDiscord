const { fork } = require('child_process');
const path = require('path');
const pino = require('pino');
const pretty = require('pino-pretty');
const fs = require('fs');

const logger = pino({}, pino.multistream([
  { stream: pino.destination('logs.txt') },
  { stream: pretty({ colorize: true }) },
]));

// Capture everything printed to the terminal in a separate file
const termLog = fs.createWriteStream('terminal.log', { flags: 'a' });
const origStdoutWrite = process.stdout.write.bind(process.stdout);
const origStderrWrite = process.stderr.write.bind(process.stderr);

process.stdout.write = (chunk, encoding, cb) => {
  termLog.write(chunk);
  return origStdoutWrite(chunk, encoding, cb);
};

process.stderr.write = (chunk, encoding, cb) => {
  termLog.write(chunk);
  return origStderrWrite(chunk, encoding, cb);
};

process.on('exit', () => {
  termLog.end();
});

const INDEX_PATH = process.env.WA2DC_CHILD_PATH
  ? path.resolve(process.env.WA2DC_CHILD_PATH)
  : path.join(__dirname, 'index.js');

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

let restartAttempts = 0;
let childStartTime = 0;

let child;
let shuttingDown = false;

function start() {
  childStartTime = Date.now();
  child = fork(INDEX_PATH, [], {
    stdio: ['inherit', 'pipe', 'pipe', 'ipc'],
    execArgv: ['--no-deprecation'],
  });

  if (child.stdout) child.stdout.pipe(process.stdout);
  if (child.stderr) child.stderr.pipe(process.stderr);

  child.on('exit', (code, signal) => {
    if (shuttingDown) {
      process.exit(code ?? 0);
    }

    const restartRequested = fs.existsSync(RESTART_FLAG_PATH);
    if (restartRequested) {
      try {
        fs.unlinkSync(RESTART_FLAG_PATH);
      } catch (err) {
        if (err.code !== 'ENOENT') {
          logger.warn({ err }, 'Failed to remove restart flag');
        }
      }
    }

    const runtime = Date.now() - childStartTime;
    if (runtime > SAFE_RUNTIME_RESET_WINDOW) {
      restartAttempts = 0;
    }

    if (restartRequested) {
      restartAttempts = 0;
      logger.info('Restart flag detected. Restarting immediately.');
      setImmediate(start);
      return;
    }

    if (code !== 0) {
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
    } else {
      process.exit(0);
    }
  });
}

['SIGINT', 'SIGTERM'].forEach((sig) => {
  process.on(sig, () => {
    shuttingDown = true;
    if (child && !child.killed) {
      child.kill(sig);
    }
  });
});

start();

