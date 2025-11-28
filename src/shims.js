import nodeCrypto from 'crypto';

const ensureWebCrypto = () => {
  const native = globalThis.crypto;
  if (native?.subtle) {
    return;
  }

  const webcrypto = nodeCrypto.webcrypto;
  if (!webcrypto) {
    return;
  }

  // eslint-disable-next-line no-global-assign
  globalThis.crypto = webcrypto;
};

ensureWebCrypto();
