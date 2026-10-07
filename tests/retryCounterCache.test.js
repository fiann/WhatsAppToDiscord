import assert from "node:assert/strict";
import test from "node:test";
import { RetryCounterCache } from "../src/retryCounterCache.js";

test("retryCounterCache: keeps counts well beyond Baileys' default 1h TTL", () => {
	const cache = new RetryCounterCache();
	cache.set("msg:device", 5);
	assert.equal(cache.get("msg:device"), 5);
	assert.ok(cache.ttlMs > 24 * 60 * 60 * 1000);
});

test("retryCounterCache: expires entries after the TTL", async () => {
	const cache = new RetryCounterCache({ ttlMs: 5 });
	cache.set("k", 1);
	await new Promise((resolve) => setTimeout(resolve, 15));
	assert.equal(cache.get("k"), undefined);
});

test("retryCounterCache: evicts oldest entries beyond maxEntries and supports del/flushAll", () => {
	const cache = new RetryCounterCache({ maxEntries: 2 });
	cache.set("a", 1);
	cache.set("b", 1);
	cache.set("c", 1);
	assert.equal(cache.get("a"), undefined);
	assert.equal(cache.get("b"), 1);
	assert.equal(cache.del("b"), 1);
	assert.equal(cache.get("b"), undefined);
	cache.flushAll();
	assert.equal(cache.get("c"), undefined);
});
