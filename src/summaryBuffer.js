import sqliteStore from "./persistence/sqliteStore.js";
import state from "./state.js";

/**
 * Resolves the effective threshold settings for a given primary channel JID,
 * falling back to the global defaults when per-channel overrides are absent.
 */
const getChannelConfig = (channelJid) => {
	const perChannel = state.settings.SummaryChannels?.[channelJid];
	return {
		messageThreshold:
			perChannel?.messageThreshold ??
			state.settings.SummaryMessageThreshold,
		timeThresholdHours:
			perChannel?.timeThresholdHours ??
			state.settings.SummaryTimeThresholdHours,
		scheduleTime:
			perChannel?.scheduleTime ??
			state.settings.SummaryScheduleTime ??
			null,
	};
};

/**
 * Get the current time in the configured timezone as { hour, minute, dateStr }.
 */
const getNowInTimezone = (timezone) => {
	const tz = timezone || state.settings.SummaryTimezone || "America/Los_Angeles";
	const now = new Date();
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone: tz,
		hour: "numeric",
		minute: "numeric",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour12: false,
	}).formatToParts(now);
	const get = (type) => Number(parts.find((p) => p.type === type)?.value || 0);
	return {
		hour: get("hour"),
		minute: get("minute"),
		year: get("year"),
		month: get("month"),
		day: get("day"),
		timestamp: now.getTime(),
	};
};

/**
 * Build a Date object for a given HH:MM in the configured timezone on a
 * specific date. Returns the UTC timestamp.
 */
const getTargetTimestamp = (hour, minute, year, month, day, timezone) => {
	const tz = timezone || state.settings.SummaryTimezone || "America/Los_Angeles";
	// Build an ISO-ish string and parse it in the target timezone
	const dateStr = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`;
	// Use a formatter round-trip to get the UTC equivalent
	const guess = new Date(dateStr);
	// Adjust by comparing the timezone offset
	const utcStr = guess.toLocaleString("en-US", { timeZone: "UTC" });
	const tzStr = guess.toLocaleString("en-US", { timeZone: tz });
	const diff = new Date(utcStr).getTime() - new Date(tzStr).getTime();
	return guess.getTime() + diff;
};

/**
 * Check if the scheduled time of day has passed since the last summary.
 * @param {string} scheduleTime - Time in "HH:MM" format.
 * @param {number} lastSummaryAt - Timestamp of the last summary.
 * @returns {boolean}
 */
const isScheduledTimeDue = (scheduleTime, lastSummaryAt) => {
	const match = /^(\d{1,2}):(\d{2})$/.exec(scheduleTime);
	if (!match) return false;

	const targetHour = Number(match[1]);
	const targetMinute = Number(match[2]);
	const tz = state.settings.SummaryTimezone || "America/Los_Angeles";
	const now = getNowInTimezone(tz);

	const todayTarget = getTargetTimestamp(
		targetHour, targetMinute, now.year, now.month, now.day, tz,
	);

	// If it's past the target time today and the last summary was before it
	if (now.timestamp >= todayTarget && lastSummaryAt < todayTarget) {
		return true;
	}

	// Also check yesterday's target in case the bot was offline
	const yesterdayDate = new Date(now.timestamp - 24 * 60 * 60 * 1000);
	const yd = getNowInTimezone(tz);
	const yesterdayParts = new Intl.DateTimeFormat("en-US", {
		timeZone: tz,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).formatToParts(yesterdayDate);
	const yGet = (type) => Number(yesterdayParts.find((p) => p.type === type)?.value || 0);
	const yesterdayTarget = getTargetTimestamp(
		targetHour, targetMinute, yGet("year"), yGet("month"), yGet("day"), tz,
	);
	if (now.timestamp >= yesterdayTarget && lastSummaryAt < yesterdayTarget) {
		return true;
	}

	return false;
};

const summaryBuffer = {
	/**
	 * Add a message to the summary buffer for a primary channel.
	 * @param {string} channelJid - The primary channel's WhatsApp JID.
	 * @param {object} data - Message data.
	 * @param {string} data.sender
	 * @param {string} [data.content]
	 * @param {string} [data.mediaDescription]
	 * @param {string} [data.replyToSender]
	 * @param {string} [data.replyToContent]
	 * @param {string} [data.threadId]
	 * @param {number} data.timestamp
	 * @param {string} [data.discordMessageId]
	 */
	addMessage(channelJid, data) {
		sqliteStore.insertSummaryMessage(channelJid, data);
	},

	/**
	 * Retrieve all buffered messages for a primary channel, ordered by time.
	 */
	getMessages(channelJid) {
		return sqliteStore.getSummaryMessages(channelJid);
	},

	/**
	 * Get the number of buffered messages for a primary channel.
	 */
	getMessageCount(channelJid) {
		return sqliteStore.getSummaryMessageCount(channelJid);
	},

	/**
	 * Check whether the summary should be triggered for a channel based on
	 * message count or elapsed time since the last summary.
	 */
	/**
	 * Check whether the summary should be triggered and return the reason.
	 * Returns null if not triggered, or one of: "schedule", "count", "time".
	 */
	getTriggerReason(channelJid) {
		const config = getChannelConfig(channelJid);
		const count = this.getMessageCount(channelJid);
		const summaryState = sqliteStore.getSummaryState(channelJid);
		const lastSummaryAt = summaryState?.lastSummaryAt ?? 0;

		if (
			config.scheduleTime &&
			isScheduledTimeDue(config.scheduleTime, lastSummaryAt)
		) {
			if (count === 0) {
				// Nothing to summarize for today's scheduled window. Mark it
				// acknowledged so a message that trickles in later today
				// doesn't read as "we're still owed today's digest" and
				// trigger a belated one-message catch-up at whatever time
				// it happens to arrive — it should just wait for the next
				// real trigger instead.
				sqliteStore.upsertSummaryState(channelJid, {
					messageCount: 0,
					lastSummaryAt: Date.now(),
					previousSummary: summaryState?.previousSummary || null,
				});
				return null;
			}
			return "schedule";
		}

		if (count === 0) return null;

		if (count >= config.messageThreshold) return "count";

		if (!config.scheduleTime) {
			const elapsedMs = Date.now() - lastSummaryAt;
			const thresholdMs = config.timeThresholdHours * 60 * 60 * 1000;
			if (elapsedMs >= thresholdMs) return "time";
		}

		return null;
	},

	shouldTrigger(channelJid) {
		return this.getTriggerReason(channelJid) !== null;
	},

	/**
	 * Clear the message buffer for a channel after a successful summary.
	 */
	clearBuffer(channelJid) {
		sqliteStore.clearSummaryBuffer(channelJid);
	},

	/**
	 * Get the summary state (last summary time, previous summary text, etc.)
	 */
	getState(channelJid) {
		return sqliteStore.getSummaryState(channelJid);
	},

	/**
	 * Store the previous summary text and update the last-summary timestamp.
	 */
	setPreviousSummary(channelJid, summaryText) {
		sqliteStore.upsertSummaryState(channelJid, {
			messageCount: 0,
			lastSummaryAt: Date.now(),
			previousSummary: summaryText,
		});
	},

	/**
	 * Remove a message from the buffer by its WhatsApp message ID.
	 * Called when a message is deleted on WhatsApp.
	 */
	deleteByWhatsAppId(whatsappMessageId) {
		if (!whatsappMessageId) return;
		sqliteStore.deleteSummaryMessageByWhatsAppId(whatsappMessageId);
	},

	/**
	 * Remove a message from the buffer by its Discord message ID.
	 * Called when a message is deleted on Discord.
	 */
	deleteByDiscordId(discordMessageId) {
		if (!discordMessageId) return;
		sqliteStore.deleteSummaryMessageByDiscordId(discordMessageId);
	},

	/**
	 * Return the list of primary channel JIDs that have summary config.
	 */
	getConfiguredChannels() {
		return Object.keys(state.settings.SummaryChannels || {});
	},
};

export default summaryBuffer;
