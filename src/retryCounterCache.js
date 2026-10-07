// Baileys counts how many times it has resent a message to each device (and
// how many retry receipts it has sent for messages it couldn't decrypt) in a
// cache it creates itself with a 1-hour TTL. A device that can't decrypt a
// message keeps asking indefinitely, so with that default every device gets
// another full allowance of resends every hour, forever — in production this
// kept a single undecryptable message being resent ~90k times over several
// days. Passing our own long-lived cache makes the per-device cap permanent
// (for the TTL below) instead of hourly.
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 50000;

class RetryCounterCache {
	constructor({ ttlMs = DEFAULT_TTL_MS, maxEntries = DEFAULT_MAX_ENTRIES } = {}) {
		this.ttlMs = ttlMs;
		this.maxEntries = maxEntries;
		this.entries = new Map();
	}

	get(key) {
		const entry = this.entries.get(key);
		if (!entry) return undefined;
		if (entry.expiresAt <= Date.now()) {
			this.entries.delete(key);
			return undefined;
		}
		return entry.value;
	}

	set(key, value) {
		// Re-insert so Map iteration order stays oldest-first for eviction.
		this.entries.delete(key);
		this.entries.set(key, { value, expiresAt: Date.now() + this.ttlMs });
		if (this.entries.size > this.maxEntries) this.prune();
		return true;
	}

	del(key) {
		return this.entries.delete(key) ? 1 : 0;
	}

	flushAll() {
		this.entries.clear();
	}

	prune() {
		const now = Date.now();
		for (const [key, entry] of this.entries) {
			if (entry.expiresAt <= now) this.entries.delete(key);
		}
		while (this.entries.size > this.maxEntries) {
			this.entries.delete(this.entries.keys().next().value);
		}
	}
}

export { DEFAULT_MAX_ENTRIES, DEFAULT_TTL_MS, RetryCounterCache };
export default new RetryCounterCache();
