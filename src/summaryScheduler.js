import fs from "node:fs/promises";
import path from "node:path";
import state from "./state.js";
import storage from "./storage.js";
import summaryAI from "./summaryAI.js";
import summaryBuffer from "./summaryBuffer.js";
import utils from "./utils.js";

let intervalId = null;
let backfillRunning = false;
const BACKFILL_QUEUE_PATH = path.join("./storage", "backfill-queue.json");
const SETTINGS_PATCH_PATH = path.join("./storage", "settings-patch.json");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Process a one-off settings patch file (./storage/settings-patch.json), if
 * present. Applies a shallow merge into a SummaryChannels[primaryJid]
 * destinations object on the LIVE in-memory state.settings, then saves —
 * unlike a direct database edit while the process is already running, which
 * only touches disk and gets silently overwritten by the next periodic
 * autosave of the stale in-memory copy.
 * Format: { primaryJid, destinations: { whatsapp?, discord? } }.
 */
const processSettingsPatch = async () => {
	let raw;
	try {
		raw = await fs.readFile(SETTINGS_PATCH_PATH, "utf8");
	} catch {
		return;
	}
	try {
		const patch = JSON.parse(raw);
		const { primaryJid, destinations } = patch;
		if (!primaryJid || !destinations) {
			state.logger?.warn({ patch }, "Settings patch: missing primaryJid or destinations, skipping");
			return;
		}
		if (!state.settings.SummaryChannels) state.settings.SummaryChannels = {};
		const existing = state.settings.SummaryChannels[primaryJid] || {};
		state.settings.SummaryChannels[primaryJid] = {
			...existing,
			destinations: { ...existing.destinations, ...destinations },
		};
		await storage.saveSettings();
		state.logger?.info(
			{ primaryJid, destinations: state.settings.SummaryChannels[primaryJid].destinations },
			"Applied settings patch to live in-memory settings",
		);
	} catch (err) {
		state.logger?.error({ err }, "Failed to apply settings patch");
	} finally {
		await fs.unlink(SETTINGS_PATCH_PATH).catch(() => {});
	}
};

/**
 * Post an alert to the control room for a summary pipeline failure that
 * needs a human's attention — as opposed to routine connectivity blips,
 * which are throttled separately in whatsappHandler.js.
 */
const notifyControlRoom = async (message) => {
	try {
		const channel = await utils.discord.getControlChannel();
		await channel?.send(`⚠️ Summary pipeline: ${message}`);
	} catch (err) {
		state.logger?.debug?.({ err }, "Failed to post summary alert to control room");
	}
};

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
			await notifyControlRoom(
				`couldn't post to WhatsApp (${jid}) — the group only allows admins to send, and the bot isn't one there.`,
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
		await notifyControlRoom(
			`failed to post to WhatsApp (${jid}): ${err.message}`,
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
			await notifyControlRoom(
				`couldn't post — Discord channel ${channelId} not found.`,
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
		await notifyControlRoom(
			`failed to post to Discord channel ${channelId}: ${err.message}`,
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

		if (config.destinations.whatsapp && state.waClient) {
			try {
				const metadata = await state.waClient.groupMetadata(
					config.destinations.whatsapp,
				);
				const ownJid = state.waClient.user?.id;
				const ownNumber = ownJid?.split(":")[0]?.split("@")[0];
				const ownParticipant = metadata?.participants?.find((p) => {
					const pNumber = p.id?.split(":")[0]?.split("@")[0];
					return p.id === ownJid || (pNumber && pNumber === ownNumber);
				});
				state.logger?.info(
					{
						requestedJid: config.destinations.whatsapp,
						resolvedId: metadata?.id,
						subject: metadata?.subject,
						size: metadata?.size,
						announce: metadata?.announce,
						participantCount: metadata?.participants?.length,
						ownParticipant,
						ownJid,
					},
					"Backfill queue: WhatsApp destination group metadata",
				);
			} catch (err) {
				state.logger?.error(
					{ err, jid: config.destinations.whatsapp },
					"Backfill queue: failed to fetch WhatsApp destination group metadata",
				);
			}
		}

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
 * Group buffered messages into calendar-day buckets in the given timezone,
 * so a multi-day gap (e.g. the bot was down) produces one summary per day
 * instead of a single summary spanning the whole gap.
 */
const groupMessagesByDay = (messages, timezone) => {
	const dayFormatter = new Intl.DateTimeFormat("en-CA", {
		timeZone: timezone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	});
	const byDay = new Map();
	for (const message of messages) {
		const dayKey = dayFormatter.format(new Date(message.timestamp));
		if (!byDay.has(dayKey)) byDay.set(dayKey, []);
		byDay.get(dayKey).push(message);
	}
	return [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b));
};

/**
 * Process a single channel: generate and deliver one summary per calendar
 * day represented in the buffer. In normal operation this is just today's
 * messages (identical to the old single-summary behavior). After an outage
 * spanning multiple days, this naturally produces a proper day-by-day
 * backfill instead of one summary lumping the whole gap together.
 */
const processChannel = async (primaryJid, triggerReason = "manual") => {
	const config = state.settings.SummaryChannels?.[primaryJid];
	if (!config?.destinations) return;

	const messages = summaryBuffer.getMessages(primaryJid);
	if (messages.length === 0) return;

	const tz = state.settings.SummaryTimezone || "America/Los_Angeles";
	const dayBuckets = groupMessagesByDay(messages, tz);
	const isMultiDayCatchUp = dayBuckets.length > 1;
	const channelName = utils.whatsapp.jidToName(primaryJid) || primaryJid;
	const footer = buildFooter();

	let previousSummary =
		summaryBuffer.getState(primaryJid)?.previousSummary || null;
	let lastGoodSummary = previousSummary;
	let deliveredAny = false;

	for (const [dayKey, dayMessages] of dayBuckets) {
		state.logger?.info(
			{ primaryJid, dayKey, messageCount: dayMessages.length },
			"Generating summary",
		);

		const { summary, error } = await summaryAI.generateSummary(
			dayMessages,
			previousSummary,
		);

		if (error) {
			state.logger?.error(
				{ primaryJid, dayKey, error },
				"Summary generation failed for this day, skipping",
			);
			await notifyControlRoom(
				`generation failed for #${channelName} on ${dayKey}: ${error}`,
			);
			continue;
		}

		const dateStr = new Date(`${dayKey}T12:00:00Z`).toLocaleDateString(
			"en-US",
			{ timeZone: "UTC", day: "numeric", month: "long", year: "numeric" },
		);
		const summaryType =
			triggerReason === "schedule" || isMultiDayCatchUp
				? "Daily summary"
				: "Summary continuation";
		const recoveredTag = isMultiDayCatchUp ? " [recovered]" : "";
		const title = `✨ **${summaryType} of #${channelName} for ${dateStr}${recoveredTag}**`;
		const fullSummary = title + "\n" + summary + footer;

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

		state.logger?.info({ primaryJid, dayKey }, "Summary delivered successfully");
		previousSummary = summary;
		lastGoodSummary = summary;
		deliveredAny = true;

		if (isMultiDayCatchUp) await sleep(8000);
	}

	if (!deliveredAny) return;

	// Update state and clear buffer once the whole catch-up run is done.
	// Days that failed after retries are logged above rather than retried
	// indefinitely — matches how a human would handle a single bad day
	// during a manual backfill.
	summaryBuffer.setPreviousSummary(primaryJid, lastGoodSummary);
	summaryBuffer.clearBuffer(primaryJid);
};

/**
 * Scheduler tick — check all configured channels.
 */
const tick = async () => {
	processSettingsPatch().catch((err) =>
		state.logger?.error({ err }, "Settings patch tick failed"),
	);

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
