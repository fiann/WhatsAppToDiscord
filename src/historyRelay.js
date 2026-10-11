import fs from "node:fs/promises";
import path from "node:path";

// When the bot's WhatsApp device is (re-)paired, WhatsApp pushes a history
// sync of recent messages. Normally that is ignored. This lets an operator
// opt in (by creating ./storage/history-relay.json) to relay history-sync
// messages that never reached Discord — e.g. group messages the bot couldn't
// decrypt while its key exchange was broken — in chronological order.
//
// It is deliberately conservative: opt-in via a file, a recent-days window,
// a hard message cap, no messages sent from this account, and anything the
// bot already received (message store) or bridged (lastMessages) is skipped.
const CONFIG_PATH = path.join("./storage", "history-relay.json");
const DEFAULT_DAYS = 7;
const DEFAULT_MAX_MESSAGES = 300;
const DEFAULT_FLUSH_DELAY_MS = 45 * 1000;
const DEFAULT_PACE_MS = 1500;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const getTimestampSeconds = (message) => {
	const ts = message?.messageTimestamp;
	if (ts == null) return 0;
	if (typeof ts === "number") return ts;
	if (typeof ts === "object" && "low" in ts) return Number(ts.low);
	return Number(ts) || 0;
};

const readHistoryRelayConfig = async (configPath = CONFIG_PATH) => {
	let raw;
	try {
		raw = await fs.readFile(configPath, "utf8");
	} catch {
		return null;
	}
	try {
		const parsed = JSON.parse(raw);
		const days = Number(parsed?.days) > 0 ? Number(parsed.days) : DEFAULT_DAYS;
		const maxMessages =
			Number(parsed?.maxMessages) > 0
				? Number(parsed.maxMessages)
				: DEFAULT_MAX_MESSAGES;
		return { days, maxMessages };
	} catch {
		return null;
	}
};

/**
 * Pick the history messages worth relaying: recent, not sent by this
 * account, not already seen, for a chat we're allowed to relay. Returned
 * oldest-first, capped to the most recent `maxMessages`.
 */
const selectHistoryMessagesToRelay = (
	messages,
	{ days, maxMessages, nowSeconds, isSeen, shouldRelayJid },
) => {
	const cutoff = nowSeconds - days * 24 * 60 * 60;
	const selected = [];
	for (const message of messages || []) {
		if (!message?.key?.id || !message.message) continue;
		if (message.key.fromMe) continue;
		const ts = getTimestampSeconds(message);
		if (!ts || ts < cutoff) continue;
		if (!shouldRelayJid(message.key.remoteJid)) continue;
		if (isSeen(message)) continue;
		selected.push(message);
	}
	selected.sort((a, b) => getTimestampSeconds(a) - getTimestampSeconds(b));
	return selected.length > maxMessages
		? selected.slice(selected.length - maxMessages)
		: selected;
};

/**
 * History arrives in several chunks, newest chunk first, so batches are
 * collected until a quiet period and then relayed together in order.
 */
const createHistoryRelay = ({
	readConfig = readHistoryRelayConfig,
	isSeen,
	shouldRelayJid,
	relay,
	logger,
	now = () => Date.now(),
	flushDelayMs = DEFAULT_FLUSH_DELAY_MS,
	paceMs = DEFAULT_PACE_MS,
	sleepFn = sleep,
}) => {
	const pending = new Map();
	let timer = null;
	let flushing = Promise.resolve();

	const flush = async () => {
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
		const config = await readConfig();
		const batch = [...pending.values()];
		pending.clear();
		if (!config || !batch.length) return { relayed: 0, candidates: batch.length };

		const toRelay = selectHistoryMessagesToRelay(batch, {
			...config,
			nowSeconds: Math.floor(now() / 1000),
			isSeen,
			shouldRelayJid,
		});
		logger?.info?.(
			{ received: batch.length, relaying: toRelay.length, days: config.days },
			"History relay: relaying unbridged history messages",
		);
		let relayed = 0;
		for (const message of toRelay) {
			try {
				await relay(message);
				relayed += 1;
			} catch (err) {
				logger?.warn?.({ err, id: message.key.id }, "History relay: message failed");
			}
			await sleepFn(paceMs);
		}
		logger?.info?.({ relayed }, "History relay: complete");
		return { relayed, candidates: batch.length };
	};

	const handleBatch = async (payload) => {
		const config = await readConfig();
		if (!config) return;
		for (const message of payload?.messages || []) {
			if (message?.key?.id) pending.set(message.key.id, message);
		}
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => {
			flushing = flushing.then(flush).catch((err) =>
				logger?.error?.({ err }, "History relay flush failed"),
			);
		}, flushDelayMs);
		timer.unref?.();
	};

	return { handleBatch, flush };
};

export {
	createHistoryRelay,
	DEFAULT_DAYS,
	DEFAULT_MAX_MESSAGES,
	readHistoryRelayConfig,
	selectHistoryMessagesToRelay,
};
