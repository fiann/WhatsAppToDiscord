import fs from "node:fs/promises";
import path from "node:path";
import state from "./state.js";
import summaryAI from "./summaryAI.js";
import summaryBuffer from "./summaryBuffer.js";
import utils from "./utils.js";

let intervalId = null;
let backfillRunning = false;
const BACKFILL_QUEUE_PATH = path.join("./storage", "backfill-queue.json");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Tracks the last time a redirect reply was sent per summary channel. */
const redirectTimestamps = new Map();

const REDIRECT_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

/**
 * Look up all summary destination JIDs (WhatsApp) across all configured
 * channels so we can quickly detect if an incoming WhatsApp message is
 * in a summary channel.
 */
const getSummaryWhatsAppJids = () => {
	const jids = new Set();
	for (const config of Object.values(
		state.settings.SummaryChannels || {},
	)) {
		if (config.destinations?.whatsapp) {
			jids.add(config.destinations.whatsapp);
		}
	}
	return jids;
};

/**
 * Look up all summary destination Discord channel IDs.
 */
const getSummaryDiscordChannelIds = () => {
	const ids = new Set();
	for (const config of Object.values(
		state.settings.SummaryChannels || {},
	)) {
		if (config.destinations?.discord) {
			ids.add(config.destinations.discord);
		}
	}
	return ids;
};

/**
 * Build the footer text with join links.
 */
const buildFooter = () => {
	const links = state.settings.SummaryJoinLinks || {};
	const parts = [];
	if (links.discord) parts.push(links.discord);
	if (links.whatsapp) parts.push(links.whatsapp);
	if (parts.length === 0) return "";
	return `\n---\nJoin the conversation: ${parts.join(" | ")}`;
};

/**
 * Check whether the bot's own WhatsApp account is allowed to post in a
 * group. Returns true for non-group JIDs, groups that aren't admin-only,
 * or if the check itself fails (so we don't block sends on a metadata
 * hiccup — the send attempt below will surface a real error instead).
 */
const canSendToWhatsAppGroup = async (jid) => {
	if (!jid?.endsWith("@g.us") || !state.waClient) return true;
	try {
		const metadata = await state.waClient.groupMetadata(jid);
		if (!metadata?.announce) return true;
		const ownJid = state.waClient.user?.id;
		const ownNumber = ownJid?.split(":")[0]?.split("@")[0];
		const isAdmin = metadata.participants?.some((p) => {
			const pNumber = p.id?.split(":")[0]?.split("@")[0];
			return (
				(p.id === ownJid || (pNumber && pNumber === ownNumber)) &&
				(p.admin === "admin" || p.admin === "superadmin")
			);
		});
		return !!isAdmin;
	} catch (err) {
		state.logger?.warn(
			{ err, jid },
			"Could not verify WhatsApp group send permission, attempting send anyway",
		);
		return true;
	}
};

/**
 * Send a summary to the configured WhatsApp destination.
 * Returns true on confirmed send, false otherwise (Baileys does not always
 * throw when a group rejects the message server-side, e.g. admin-only
 * groups where the bot isn't an admin — so we check permission up front).
 */
const sendToWhatsApp = async (jid, text) => {
	if (!state.waClient) return false;
	try {
		const allowed = await canSendToWhatsAppGroup(jid);
		if (!allowed) {
			state.logger?.error(
				{ jid },
				"Cannot send to WhatsApp: this group only allows admins to post, and the bot account is not an admin there",
			);
			return false;
		}
		await state.waClient.sendMessage(jid, { text });
		return true;
	} catch (err) {
		state.logger?.error(
			{ err, jid },
			"Failed to send summary to WhatsApp",
		);
		return false;
	}
};

/**
 * Send a summary to the configured Discord channel.
 */
const sendToDiscord = async (channelId, text) => {
	if (!state.dcClient) return false;
	try {
		const channel = await utils.discord.getChannel(channelId);
		if (!channel) {
			state.logger?.warn(
				{ channelId },
				"Summary Discord channel not found",
			);
			return false;
		}
		// Split long messages for Discord's 2000 char limit
		const chunks = splitMessage(text, 2000);
		for (const chunk of chunks) {
			await channel.send(chunk);
		}
		return true;
	} catch (err) {
		state.logger?.error(
			{ err, channelId },
			"Failed to send summary to Discord",
		);
		return false;
	}
};

/**
 * Split a message into chunks that fit within a character limit,
 * breaking at newlines when possible.
 */
const splitMessage = (text, limit) => {
	if (text.length <= limit) return [text];
	const chunks = [];
	let remaining = text;
	while (remaining.length > limit) {
		let breakPoint = remaining.lastIndexOf("\n", limit);
		if (breakPoint <= 0) breakPoint = limit;
		chunks.push(remaining.slice(0, breakPoint));
		remaining = remaining.slice(breakPoint).replace(/^\n/, "");
	}
	if (remaining) chunks.push(remaining);
	return chunks;
};

/**
 * Process a one-off backfill queue file (./storage/backfill-queue.json), if
 * present. Used to post pre-approved, pre-generated summaries (e.g. after a
 * manual review) using the already-connected clients, spaced out by delayMs.
 * Format: { primaryJid, delayMs, entries: [{ title, summary }] }.
 */
const processBackfillQueue = async () => {
	if (backfillRunning) return;

	let raw;
	try {
		raw = await fs.readFile(BACKFILL_QUEUE_PATH, "utf8");
	} catch {
		return;
	}

	backfillRunning = true;
	try {
		const queue = JSON.parse(raw);
		const { primaryJid, entries, delayMs = 8000 } = queue;
		const config = state.settings.SummaryChannels?.[primaryJid];
		if (!config?.destinations || !entries?.length) {
			state.logger?.warn(
				{ primaryJid },
				"Backfill queue: no destinations or entries, skipping",
			);
			return;
		}

		state.logger?.info(
			{ primaryJid, count: entries.length },
			"Processing summary backfill queue",
		);

		let whatsappBroken = false;
		const failures = [];

		for (const entry of entries) {
			const fullText = `${entry.title}\n${entry.summary}`;
			const entryFailures = [];

			if (config.destinations.discord) {
				const ok = await sendToDiscord(
					config.destinations.discord,
					fullText,
				);
				if (!ok) entryFailures.push("discord");
			}

			if (config.destinations.whatsapp && !whatsappBroken) {
				const ok = await sendToWhatsApp(
					config.destinations.whatsapp,
					fullText,
				);
				if (!ok) {
					entryFailures.push("whatsapp");
					// Group permission issues won't clear up mid-run — stop
					// hammering WhatsApp for the rest of this queue, but keep
					// posting to Discord for the remaining entries.
					whatsappBroken = true;
				}
			} else if (config.destinations.whatsapp && whatsappBroken) {
				entryFailures.push("whatsapp");
			}

			if (entryFailures.length) {
				failures.push({ ...entry, failedPlatforms: entryFailures });
				state.logger?.error(
					{ primaryJid, title: entry.title, failed: entryFailures },
					"Backfill entry partially or fully failed",
				);
			} else {
				state.logger?.info(
					{ primaryJid, title: entry.title },
					"Backfill entry delivered",
				);
			}
			await sleep(delayMs);
		}

		if (failures.length) {
			const failurePath = BACKFILL_QUEUE_PATH.replace(
				".json",
				"-failures.json",
			);
			await fs.writeFile(
				failurePath,
				JSON.stringify({ primaryJid, delayMs, entries: failures }, null, 2),
			);
			state.logger?.error(
				{ primaryJid, count: failures.length, failurePath },
				"Summary backfill queue finished with failures — see failures file",
			);
		} else {
			state.logger?.info({ primaryJid }, "Summary backfill queue complete");
		}
	} catch (err) {
		state.logger?.error({ err }, "Summary backfill queue processing failed");
	} finally {
		await fs.unlink(BACKFILL_QUEUE_PATH).catch(() => {});
		backfillRunning = false;
	}
};

/**
 * Process a single channel: generate and deliver summary.
 */
const processChannel = async (primaryJid, triggerReason = "manual") => {
	const config = state.settings.SummaryChannels?.[primaryJid];
	if (!config?.destinations) return;

	const messages = summaryBuffer.getMessages(primaryJid);
	if (messages.length === 0) return;

	const summaryState = summaryBuffer.getState(primaryJid);
	const previousSummary = summaryState?.previousSummary || null;

	state.logger?.info(
		{ primaryJid, messageCount: messages.length },
		"Generating summary",
	);

	const { summary, error } = await summaryAI.generateSummary(
		messages,
		previousSummary,
	);

	if (error) {
		state.logger?.error({ primaryJid, error }, "Summary generation failed");
		return;
	}

	// Build title line with channel name and date
	const channelName =
		utils.whatsapp.jidToName(primaryJid) || primaryJid;
	const tz = state.settings.SummaryTimezone || "America/Los_Angeles";
	const dateStr = new Date().toLocaleDateString("en-US", {
		timeZone: tz,
		day: "numeric",
		month: "long",
		year: "numeric",
	});
	const summaryType = triggerReason === "schedule" ? "Daily summary" : "Summary continuation";
	const title = `✨ **${summaryType} of #${channelName} for ${dateStr}**`;

	const footer = buildFooter();
	const fullSummary = title + "\n" + summary + footer;

	// Send to configured destinations
	const deliveries = [];
	if (config.destinations.whatsapp) {
		deliveries.push(
			sendToWhatsApp(config.destinations.whatsapp, fullSummary),
		);
	}
	if (config.destinations.discord) {
		deliveries.push(
			sendToDiscord(config.destinations.discord, fullSummary),
		);
	}
	await Promise.allSettled(deliveries);

	// Update state and clear buffer
	summaryBuffer.setPreviousSummary(primaryJid, summary);
	summaryBuffer.clearBuffer(primaryJid);

	state.logger?.info({ primaryJid }, "Summary delivered successfully");
};

/**
 * Scheduler tick — check all configured channels.
 */
const tick = async () => {
	if (!state.settings.SummaryEnabled) return;

	processBackfillQueue().catch((err) =>
		state.logger?.error({ err }, "Backfill queue tick failed"),
	);

	const channels = summaryBuffer.getConfiguredChannels();
	for (const jid of channels) {
		const reason = summaryBuffer.getTriggerReason(jid);
		if (reason) {
			try {
				await processChannel(jid, reason);
			} catch (err) {
				state.logger?.error(
					{ err, jid },
					"Error processing summary for channel",
				);
			}
		}
	}
};

const summaryScheduler = {
	/**
	 * Start the summary scheduler.
	 */
	start() {
		if (intervalId) return;
		const intervalMs =
			(state.settings.SummaryCheckIntervalSeconds || 60) * 1000;
		intervalId = setInterval(tick, intervalMs);
		state.logger?.info("Summary scheduler started");

		// Check immediately on startup in case thresholds were met while offline
		tick().catch((err) =>
			state.logger?.error(err, "Summary tick failed on startup"),
		);
	},

	/**
	 * Stop the summary scheduler.
	 */
	stop() {
		if (intervalId) {
			clearInterval(intervalId);
			intervalId = null;
		}
	},

	/**
	 * Called by message handlers to feed messages into the buffer.
	 */
	onMessage(data) {
		if (!state.settings.SummaryEnabled) return;
		if (!data.channelJid) return;

		// Only buffer if this primary channel has summary config
		const config = state.settings.SummaryChannels?.[data.channelJid];
		if (!config) return;

		summaryBuffer.addMessage(data.channelJid, {
			sender: data.sender || "Unknown",
			content: data.content || null,
			mediaDescription: data.mediaDescription || null,
			replyToSender: data.replyToSender || null,
			replyToContent: data.replyToContent || null,
			threadId: data.threadId || null,
			timestamp: data.timestamp || Date.now(),
			discordMessageId: data.discordMessageId || null,
			whatsappMessageId: data.whatsappMessageId || null,
		});
	},

	/**
	 * Handle a message posted in a summary channel. Sends a throttled
	 * redirect reply directing the user to the main conversation.
	 * @param {"whatsapp"|"discord"} platform
	 * @param {string} channelId - WhatsApp JID or Discord channel ID
	 */
	async onSummaryChannelMessage(platform, channelId) {
		const key = `${platform}:${channelId}`;
		const lastSent = redirectTimestamps.get(key) || 0;
		if (Date.now() - lastSent < REDIRECT_COOLDOWN_MS) return;

		const links = state.settings.SummaryJoinLinks || {};
		const linkParts = [];
		if (links.discord) linkParts.push(links.discord);
		if (links.whatsapp) linkParts.push(links.whatsapp);
		const linkText = linkParts.join(" | ") || "(no links configured)";

		const template =
			state.settings.SummaryRedirectMessage ||
			"This is a read-only summary channel. Join the conversation at {links}";
		const message = template.replace("{links}", linkText);

		if (platform === "whatsapp") {
			await sendToWhatsApp(channelId, message);
		} else if (platform === "discord") {
			await sendToDiscord(channelId, message);
		}

		redirectTimestamps.set(key, Date.now());
	},

	/**
	 * Trigger an immediate summary for a given primary channel,
	 * regardless of thresholds.
	 */
	async triggerNow(primaryJid) {
		await processChannel(primaryJid);
	},

	/**
	 * Check if a WhatsApp JID is a summary channel destination.
	 */
	isSummaryWhatsAppChannel(jid) {
		return getSummaryWhatsAppJids().has(jid);
	},

	/**
	 * Check if a Discord channel ID is a summary channel destination.
	 */
	isSummaryDiscordChannel(channelId) {
		return getSummaryDiscordChannelIds().has(channelId);
	},

	/** Exposed for testing. */
	_tick: tick,
	_splitMessage: splitMessage,
	_buildFooter: buildFooter,
};

export default summaryScheduler;
