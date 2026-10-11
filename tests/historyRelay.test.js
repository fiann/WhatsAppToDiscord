import assert from "node:assert/strict";
import test from "node:test";
import {
	createHistoryRelay,
	selectHistoryMessagesToRelay,
} from "../src/historyRelay.js";

const NOW = 1_800_000_000;
const msg = (id, ageDays, extra = {}) => ({
	key: { id, remoteJid: "g@g.us", fromMe: false, ...extra.key },
	message: { conversation: id },
	messageTimestamp: { low: NOW - ageDays * 86400, high: 0, unsigned: true },
	...extra,
});
const base = {
	days: 7,
	maxMessages: 300,
	nowSeconds: NOW,
	isSeen: () => false,
	shouldRelayJid: () => true,
};

test("historyRelay: keeps recent unseen messages oldest-first", () => {
	const out = selectHistoryMessagesToRelay([msg("b", 1), msg("a", 3), msg("c", 0.5)], base);
	assert.deepEqual(out.map((m) => m.key.id), ["a", "b", "c"]);
});

test("historyRelay: drops old, own, seen, contentless and disallowed-chat messages", () => {
	const out = selectHistoryMessagesToRelay(
		[
			msg("old", 10),
			msg("mine", 1, { key: { fromMe: true } }),
			msg("seen", 1),
			{ ...msg("empty", 1), message: undefined },
			msg("other", 1, { key: { remoteJid: "x@g.us" } }),
			msg("keep", 1),
		],
		{
			...base,
			isSeen: (m) => m.key.id === "seen",
			shouldRelayJid: (jid) => jid === "g@g.us",
		},
	);
	assert.deepEqual(out.map((m) => m.key.id), ["keep"]);
});

test("historyRelay: caps to the most recent maxMessages", () => {
	const out = selectHistoryMessagesToRelay(
		[msg("a", 5), msg("b", 4), msg("c", 3), msg("d", 2)],
		{ ...base, maxMessages: 2 },
	);
	assert.deepEqual(out.map((m) => m.key.id), ["c", "d"]);
});

test("historyRelay: does nothing unless opted in", async () => {
	const relayed = [];
	const relay = createHistoryRelay({
		readConfig: async () => null,
		isSeen: () => false,
		shouldRelayJid: () => true,
		relay: async (m) => relayed.push(m.key.id),
		paceMs: 0,
		sleepFn: async () => {},
	});
	await relay.handleBatch({ messages: [msg("a", 1)] });
	await relay.flush();
	assert.deepEqual(relayed, []);
});

test("historyRelay: merges batches and relays in chronological order when opted in", async () => {
	const relayed = [];
	const relay = createHistoryRelay({
		readConfig: async () => ({ days: 7, maxMessages: 300 }),
		isSeen: () => false,
		shouldRelayJid: () => true,
		relay: async (m) => relayed.push(m.key.id),
		now: () => NOW * 1000,
		flushDelayMs: 60_000,
		paceMs: 0,
		sleepFn: async () => {},
	});
	await relay.handleBatch({ messages: [msg("new", 1), msg("mid", 2)] });
	await relay.handleBatch({ messages: [msg("oldest", 4), msg("new", 1)] });
	const result = await relay.flush();
	assert.deepEqual(relayed, ["oldest", "mid", "new"]);
	assert.equal(result.relayed, 3);
});
