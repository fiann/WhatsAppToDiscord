const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7d
const DEFAULT_MAX_ENTRIES = 2000;

const buildKey = (key = {}) => {
  const id = key.id || key?.keyId || null;
  if (!id) return null;
  const remoteJid = key.remoteJid || key?.participant || key?.participantId || '';
  return `${remoteJid}|${id}`;
};

class MessageStore {
  constructor({ ttlMs = DEFAULT_TTL_MS, maxEntries = DEFAULT_MAX_ENTRIES } = {}) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.cache = new Map();
  }

  get(key) {
    const cacheKey = buildKey(key);
    if (!cacheKey) return null;
    const entry = this.cache.get(cacheKey);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.cache.delete(cacheKey);
      return null;
    }
    return entry.message;
  }

  set(message) {
    const cacheKey = buildKey(message?.key);
    if (!cacheKey || !message) return null;
    const expiresAt = Date.now() + this.ttlMs;
    this.cache.set(cacheKey, { message, expiresAt });
    this.prune();
    return message;
  }

  prune() {
    if (this.cache.size <= this.maxEntries) return;
    const overflow = this.cache.size - this.maxEntries;
    const keys = this.cache.keys();
    for (let i = 0; i < overflow; i += 1) {
      const { value, done } = keys.next();
      if (done) break;
      this.cache.delete(value);
    }
  }
}

const messageStore = new MessageStore();

export { MessageStore, DEFAULT_TTL_MS, DEFAULT_MAX_ENTRIES };
export default messageStore;
