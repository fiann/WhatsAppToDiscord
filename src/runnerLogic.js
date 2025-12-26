import fs from 'fs';
import path from 'path';

export const DEFAULT_RESTART_DELAY_MS = 10_000;
export const DEFAULT_MAX_RESTARTS = 5;

export const resolveRestartDelayMs = (rawValue, defaultDelayMs = DEFAULT_RESTART_DELAY_MS) => {
  const parsed = Number(rawValue);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : defaultDelayMs;
};

export const resolveMaxRestarts = (rawValue, defaultMaxRestarts = DEFAULT_MAX_RESTARTS) => {
  const parsed = Number(rawValue);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultMaxRestarts;
};

export const resolveSafeRuntimeResetWindowMs = (
  restartDelayMs,
  defaultDelayMs = DEFAULT_RESTART_DELAY_MS,
) => Math.max(restartDelayMs, defaultDelayMs);

export const resolveRestartFlagPath = (rawValue, cwd = process.cwd()) => (
  rawValue ? path.resolve(rawValue) : path.resolve(cwd, 'restart.flag')
);

export const computeBackoffDelayMs = (baseDelayMs, attempt) => baseDelayMs * (2 ** (attempt - 1));

export const clearRestartFlagSync = (flagPath, { logger, fsModule = fs } = {}) => {
  if (!fsModule.existsSync(flagPath)) {
    return false;
  }

  try {
    fsModule.unlinkSync(flagPath);
  } catch (err) {
    if (err?.code !== 'ENOENT') {
      logger?.warn?.({ err }, 'Failed to remove restart flag');
    }
  }

  return true;
};

export const evaluateWorkerExit = ({
  shuttingDown = false,
  exitCode,
  restartRequested = false,
  runtimeMs = 0,
  safeRuntimeResetWindowMs = DEFAULT_RESTART_DELAY_MS,
  restartAttempts = 0,
  maxRestarts = DEFAULT_MAX_RESTARTS,
  restartDelayMs = DEFAULT_RESTART_DELAY_MS,
} = {}) => {
  if (shuttingDown) {
    return {
      action: 'exit',
      reason: 'shutting-down',
      exitCode: exitCode ?? 0,
      restartAttempts,
      delayMs: null,
    };
  }

  let attempts = restartAttempts;
  if (runtimeMs > safeRuntimeResetWindowMs) {
    attempts = 0;
  }

  if (restartRequested) {
    return {
      action: 'restart',
      reason: 'restart-flag',
      exitCode: null,
      restartAttempts: 0,
      delayMs: 0,
    };
  }

  if (exitCode === 0) {
    return {
      action: 'exit',
      reason: 'clean-exit',
      exitCode: 0,
      restartAttempts: attempts,
      delayMs: null,
    };
  }

  attempts += 1;
  if (attempts > maxRestarts) {
    return {
      action: 'exit',
      reason: 'max-restarts',
      exitCode: exitCode ?? 1,
      restartAttempts: attempts,
      delayMs: null,
    };
  }

  return {
    action: 'restart',
    reason: 'crash',
    exitCode: null,
    restartAttempts: attempts,
    delayMs: computeBackoffDelayMs(restartDelayMs, attempts),
  };
};

