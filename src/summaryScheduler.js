import state from "./state.js";
import summaryAI from "./summaryAI.js";
import summaryBuffer from "./summaryBuffer.js";
import utils from "./utils.js";

let intervalId = null;

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
 * Send a summary to the configured WhatsApp destination.
 */
const sendToWhatsApp = async (jid, text) => {
	if (!state.waClient) return;
	try {
		await state.waClient.sendMessage(jid, { text });
	} catch (err) {
		state.logger?.error(
			{ err, jid },
			"Failed to send summary to WhatsApp",
		);
	}
};

/**
 * Send a summary to the configured Discord channel.
 */
const sendToDiscord = async (channelId, text) => {
	if (!state.dcClient) return;
	try {
		const channel = await utils.discord.getChannel(channelId);
		if (!channel) {
			state.logger?.warn(
				{ channelId },
				"Summary Discord channel not found",
			);
			return;
		}
		// Split long messages for Discord's 2000 char limit
		const chunks = splitMessage(text, 2000);
		for (const chunk of chunks) {
			await channel.send(chunk);
		}
	} catch (err) {
		state.logger?.error(
			{ err, channelId },
			"Failed to send summary to Discord",
		);
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
 * Process a single channel: generate and deliver summary.
 */
const processChannel = async (primaryJid) => {
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

	const footer = buildFooter();
	const fullSummary = summary + footer;

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

	const channels = summaryBuffer.getConfiguredChannels();
	for (const jid of channels) {
		if (summaryBuffer.shouldTrigger(jid)) {
			try {
				await processChannel(jid);
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
