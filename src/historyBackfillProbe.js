import fs from "node:fs/promises";
import path from "node:path";
import sqliteStore from "./persistence/sqliteStore.js";
import state from "./state.js";
import utils from "./utils.js";

const REQUEST_PATH = path.join("./storage", "history-backfill-request.json");
const RESULT_PATH = path.join("./storage", "history-backfill-result.json");

// How long to wait for WhatsApp's async on-demand history response after
// requesting it. This is a single request with a single wait window — no
// retries or pagination — to keep this to exactly the same shape of
// request a real client makes when a user scrolls up in a chat once.
const RESPONSE_WAIT_MS = 25000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const getMessageTimestampSeconds = (message) => {
	const ts = message?.messageTimestamp;
	if (ts == null) return null;
	if (typeof ts === "number") return ts;
	if (typeof ts === "object" && "low" in ts) return Number(ts.low);
	return Number(ts) || null;
};

/**
 * Process a one-off history backfill probe request
 * (./storage/history-backfill-request.json), if present. Anchors on the
 * oldest locally-known message for the target chat and issues a single
 * on-demand history request to WhatsApp (the same mechanism a real client
 * uses when a user scrolls up in a chat) — deliberately one request, no
 * pagination — then records whatever comes back for manual review before
 * anything is relayed to Discord.
 * Format: { jid, count? }.
 */
const processHistoryBackfillProbe = async () => {
	let raw;
	try {
		raw = await fs.readFile(REQUEST_PATH, "utf8");
	} catch {
		return;
	}

	try {
		const { jid: rawJid, count = 50 } = JSON.parse(raw);
		const jid = utils.whatsapp.formatJid(rawJid);
		if (!jid) {
			await fs.writeFile(
				RESULT_PATH,
				JSON.stringify({ error: `Invalid jid: ${rawJid}` }, null, 2),
			);
			return;
		}
		if (!state.waClient) {
			await fs.writeFile(
				RESULT_PATH,
				JSON.stringify({ jid, error: "WhatsApp client not connected" }, null, 2),
			);
			return;
		}

		const known = sqliteStore.getMessageStoreEntriesForJid(jid);
		if (!known.length) {
			await fs.writeFile(
				RESULT_PATH,
				JSON.stringify(
					{ jid, error: "No locally-cached message found to anchor the request" },
					null,
					2,
				),
			);
			return;
		}
		known.sort(
			(a, b) => getMessageTimestampSeconds(a) - getMessageTimestampSeconds(b),
		);
		const anchor = known[0];

		const anchorSeconds = getMessageTimestampSeconds(anchor);
		const collected = [];
		const onHistorySet = (payload) => {
			for (const message of payload?.messages || []) {
				if (utils.whatsapp.formatJid(message.key?.remoteJid) === jid) {
					collected.push(message);
				}
			}
		};
		state.waClient.ev.on("messaging-history.set", onHistorySet);

		state.logger?.info(
			{ jid, count, anchorId: anchor.key?.id, anchorSeconds },
			"History backfill probe: requesting on-demand WhatsApp history (single request)",
		);

		try {
			// The request field is oldestMsgTimestampMs — Baileys expects
			// milliseconds here, while message timestamps elsewhere (and in
			// our own storage) are in seconds.
			await state.waClient.fetchMessageHistory(
				count,
				anchor.key,
				anchorSeconds * 1000,
			);
			await sleep(RESPONSE_WAIT_MS);
		} finally {
			state.waClient.ev.off("messaging-history.set", onHistorySet);
		}

		const timestamps = collected
			.map(getMessageTimestampSeconds)
			.filter((ts) => Number.isFinite(ts));
		const result = {
			jid,
			requestedCount: count,
			anchorTimestamp: anchorSeconds
				? new Date(anchorSeconds * 1000).toISOString()
				: null,
			messagesReceived: collected.length,
			oldestReceivedTimestamp: timestamps.length
				? new Date(Math.min(...timestamps) * 1000).toISOString()
				: null,
			newestReceivedTimestamp: timestamps.length
				? new Date(Math.max(...timestamps) * 1000).toISOString()
				: null,
		};
		await fs.writeFile(RESULT_PATH, JSON.stringify(result, null, 2));
		state.logger?.info(result, "History backfill probe complete");
	} catch (err) {
		state.logger?.error({ err }, "History backfill probe failed");
		await fs
			.writeFile(RESULT_PATH, JSON.stringify({ error: String(err?.message || err) }, null, 2))
			.catch(() => {});
	} finally {
		await fs.unlink(REQUEST_PATH).catch(() => {});
	}
};

export default { processHistoryBackfillProbe };
