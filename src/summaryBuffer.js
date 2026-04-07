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
	};
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
	shouldTrigger(channelJid) {
		const config = getChannelConfig(channelJid);
		const count = this.getMessageCount(channelJid);
		if (count === 0) return false;

		if (count >= config.messageThreshold) return true;

		const summaryState = sqliteStore.getSummaryState(channelJid);
		const lastSummaryAt = summaryState?.lastSummaryAt ?? 0;
		const elapsedMs = Date.now() - lastSummaryAt;
		const thresholdMs = config.timeThresholdHours * 60 * 60 * 1000;
		return elapsedMs >= thresholdMs;
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
	 * Return the list of primary channel JIDs that have summary config.
	 */
	getConfiguredChannels() {
		return Object.keys(state.settings.SummaryChannels || {});
	},
};

export default summaryBuffer;
