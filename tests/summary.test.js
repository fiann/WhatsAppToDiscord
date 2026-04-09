import assert from "node:assert/strict";
import test from "node:test";
import sqliteStore from "../src/persistence/sqliteStore.js";
import state from "../src/state.js";
import summaryAI from "../src/summaryAI.js";
import summaryBuffer from "../src/summaryBuffer.js";
import summaryScheduler from "../src/summaryScheduler.js";
import initIsolatedStorage from "./helpers/initIsolatedStorage.js";

await initIsolatedStorage(import.meta.url);

const snapshotObject = (value) => ({ ...value });
const restoreObject = (target, snapshot) => {
	Object.keys(target).forEach((key) => delete target[key]);
	Object.assign(target, snapshot);
};

// --- summaryBuffer tests ---

test("summaryBuffer: addMessage and getMessages round-trip", () => {
	const jid = "test-buffer-roundtrip@g.us";
	summaryBuffer.clearBuffer(jid);

	summaryBuffer.addMessage(jid, {
		sender: "Alice",
		content: "Hello world",
		timestamp: 1000,
	});
	summaryBuffer.addMessage(jid, {
		sender: "Bob",
		content: "Hi there",
		replyToSender: "Alice",
		replyToContent: "Hello world",
		timestamp: 2000,
	});

	const messages = summaryBuffer.getMessages(jid);
	assert.equal(messages.length, 2);
	assert.equal(messages[0].sender, "Alice");
	assert.equal(messages[0].content, "Hello world");
	assert.equal(messages[1].sender, "Bob");
	assert.equal(messages[1].replyToSender, "Alice");
	assert.equal(messages[1].replyToContent, "Hello world");

	summaryBuffer.clearBuffer(jid);
});

test("summaryBuffer: getMessageCount", () => {
	const jid = "test-buffer-count@g.us";
	summaryBuffer.clearBuffer(jid);

	assert.equal(summaryBuffer.getMessageCount(jid), 0);

	summaryBuffer.addMessage(jid, {
		sender: "Alice",
		content: "msg1",
		timestamp: 1000,
	});
	summaryBuffer.addMessage(jid, {
		sender: "Bob",
		content: "msg2",
		timestamp: 2000,
	});

	assert.equal(summaryBuffer.getMessageCount(jid), 2);

	summaryBuffer.clearBuffer(jid);
});

test("summaryBuffer: per-channel isolation", () => {
	const jid1 = "test-isolation-a@g.us";
	const jid2 = "test-isolation-b@g.us";
	summaryBuffer.clearBuffer(jid1);
	summaryBuffer.clearBuffer(jid2);

	summaryBuffer.addMessage(jid1, {
		sender: "Alice",
		content: "for channel A",
		timestamp: 1000,
	});
	summaryBuffer.addMessage(jid2, {
		sender: "Bob",
		content: "for channel B",
		timestamp: 2000,
	});

	assert.equal(summaryBuffer.getMessageCount(jid1), 1);
	assert.equal(summaryBuffer.getMessageCount(jid2), 1);

	const msgs1 = summaryBuffer.getMessages(jid1);
	assert.equal(msgs1[0].content, "for channel A");

	summaryBuffer.clearBuffer(jid1);
	summaryBuffer.clearBuffer(jid2);
});

test("summaryBuffer: shouldTrigger returns false when empty", () => {
	const jid = "test-trigger-empty@g.us";
	summaryBuffer.clearBuffer(jid);
	const originalSettings = snapshotObject(state.settings);

	state.settings.SummaryMessageThreshold = 5;
	state.settings.SummaryTimeThresholdHours = 1;
	state.settings.SummaryChannels = {};

	assert.equal(summaryBuffer.shouldTrigger(jid), false);

	restoreObject(state.settings, originalSettings);
});

test("summaryBuffer: shouldTrigger on message count threshold", () => {
	const jid = "test-trigger-count@g.us";
	summaryBuffer.clearBuffer(jid);
	const originalSettings = snapshotObject(state.settings);

	state.settings.SummaryMessageThreshold = 3;
	state.settings.SummaryTimeThresholdHours = 999;
	state.settings.SummaryChannels = {};

	for (let i = 0; i < 3; i++) {
		summaryBuffer.addMessage(jid, {
			sender: "User",
			content: `msg ${i}`,
			timestamp: Date.now(),
		});
	}

	assert.equal(summaryBuffer.shouldTrigger(jid), true);

	summaryBuffer.clearBuffer(jid);
	restoreObject(state.settings, originalSettings);
});

test("summaryBuffer: shouldTrigger on time threshold", () => {
	const jid = "test-trigger-time@g.us";
	summaryBuffer.clearBuffer(jid);
	const originalSettings = snapshotObject(state.settings);

	state.settings.SummaryMessageThreshold = 999;
	state.settings.SummaryTimeThresholdHours = 1;
	state.settings.SummaryChannels = {};

	// Set last summary to 2 hours ago
	summaryBuffer.setPreviousSummary(jid, "old summary");
	sqliteStore.upsertSummaryState(jid, {
		messageCount: 0,
		lastSummaryAt: Date.now() - 2 * 60 * 60 * 1000,
		previousSummary: "old summary",
	});

	summaryBuffer.addMessage(jid, {
		sender: "User",
		content: "hi",
		timestamp: Date.now(),
	});

	assert.equal(summaryBuffer.shouldTrigger(jid), true);

	summaryBuffer.clearBuffer(jid);
	restoreObject(state.settings, originalSettings);
});

test("summaryBuffer: setPreviousSummary and getState", () => {
	const jid = "test-state@g.us";

	summaryBuffer.setPreviousSummary(jid, "This is a test summary");

	const summaryState = summaryBuffer.getState(jid);
	assert.equal(summaryState.previousSummary, "This is a test summary");
	assert.equal(typeof summaryState.lastSummaryAt, "number");
	assert.ok(summaryState.lastSummaryAt > 0);
});

// --- summaryAI tests ---

test("summaryAI: formatTranscript basic messages", () => {
	const messages = [
		{ sender: "Alice", content: "Hello", timestamp: 1700000000000 },
		{
			sender: "Bob",
			content: "Hi",
			replyToSender: "Alice",
			timestamp: 1700000060000,
		},
	];

	const transcript = summaryAI.formatTranscript(messages);
	assert.ok(transcript.includes("Alice: Hello"));
	assert.ok(transcript.includes("Bob (replying to Alice): Hi"));
});

test("summaryAI: formatTranscript with media", () => {
	const messages = [
		{
			sender: "Carol",
			content: "Check this",
			mediaDescription: "image",
			timestamp: 1700000000000,
		},
	];

	const transcript = summaryAI.formatTranscript(messages);
	assert.ok(transcript.includes("[image]"));
	assert.ok(transcript.includes("Check this"));
});

test("summaryAI: formatTranscript with thread sections", () => {
	const messages = [
		{ sender: "Alice", content: "Main", timestamp: 1700000000000 },
		{
			sender: "Bob",
			content: "In thread",
			threadId: "thread-1",
			timestamp: 1700000060000,
		},
		{
			sender: "Carol",
			content: "Also in thread",
			threadId: "thread-1",
			timestamp: 1700000120000,
		},
		{ sender: "Dave", content: "Back to main", timestamp: 1700000180000 },
	];

	const transcript = summaryAI.formatTranscript(messages);
	assert.ok(transcript.includes("--- Thread ---"));
	assert.ok(transcript.includes("--- End Thread ---"));
	assert.ok(transcript.includes("In thread"));
	assert.ok(transcript.includes("Back to main"));
});

test("summaryAI: buildUserPrompt includes previous summary", () => {
	const prompt = summaryAI.buildUserPrompt(
		"[08:00] Alice: Hello",
		"Previous topics discussed...",
		"2026-04-06 to 2026-04-07",
	);
	assert.ok(prompt.includes("Previous topics discussed..."));
	assert.ok(prompt.includes("Alice: Hello"));
	assert.ok(prompt.includes("2026-04-06 to 2026-04-07"));
});

test("summaryAI: buildUserPrompt without previous summary", () => {
	const prompt = summaryAI.buildUserPrompt(
		"[08:00] Alice: Hello",
		null,
		null,
	);
	assert.ok(!prompt.includes("previous summary"));
	assert.ok(prompt.includes("Alice: Hello"));
});

test("summaryAI: generateSummary returns error for unknown provider", async () => {
	const result = await summaryAI.generateSummary(
		[{ sender: "A", content: "B", timestamp: Date.now() }],
		null,
		{ provider: "nonexistent" },
	);
	assert.ok(result.error);
	assert.ok(result.error.includes("Unknown"));
});

test("summaryAI: generateSummary returns error when no API key", async () => {
	const originalKey = process.env.WA2DC_SUMMARY_AI_KEY;
	delete process.env.WA2DC_SUMMARY_AI_KEY;

	const result = await summaryAI.generateSummary(
		[{ sender: "A", content: "B", timestamp: Date.now() }],
		null,
		{ provider: "claude" },
	);
	assert.ok(result.error);
	assert.ok(result.error.includes("WA2DC_SUMMARY_AI_KEY"));

	if (originalKey !== undefined) {
		process.env.WA2DC_SUMMARY_AI_KEY = originalKey;
	}
});

test("summaryBuffer: deleteByWhatsAppId removes the correct message", () => {
	const jid = "test-delete-wa@g.us";
	summaryBuffer.clearBuffer(jid);

	summaryBuffer.addMessage(jid, {
		sender: "Alice",
		content: "keep this",
		timestamp: 1000,
		whatsappMessageId: "wa-msg-1",
	});
	summaryBuffer.addMessage(jid, {
		sender: "Bob",
		content: "delete this",
		timestamp: 2000,
		whatsappMessageId: "wa-msg-2",
	});
	summaryBuffer.addMessage(jid, {
		sender: "Carol",
		content: "also keep",
		timestamp: 3000,
		whatsappMessageId: "wa-msg-3",
	});

	assert.equal(summaryBuffer.getMessageCount(jid), 3);

	summaryBuffer.deleteByWhatsAppId("wa-msg-2");

	assert.equal(summaryBuffer.getMessageCount(jid), 2);
	const remaining = summaryBuffer.getMessages(jid);
	assert.equal(remaining[0].content, "keep this");
	assert.equal(remaining[1].content, "also keep");

	summaryBuffer.clearBuffer(jid);
});

test("summaryBuffer: deleteByDiscordId removes the correct message", () => {
	const jid = "test-delete-dc@g.us";
	summaryBuffer.clearBuffer(jid);

	summaryBuffer.addMessage(jid, {
		sender: "Alice",
		content: "keep this",
		timestamp: 1000,
		discordMessageId: "dc-msg-1",
	});
	summaryBuffer.addMessage(jid, {
		sender: "Bob",
		content: "delete this",
		timestamp: 2000,
		discordMessageId: "dc-msg-2",
	});

	assert.equal(summaryBuffer.getMessageCount(jid), 2);

	summaryBuffer.deleteByDiscordId("dc-msg-2");

	assert.equal(summaryBuffer.getMessageCount(jid), 1);
	const remaining = summaryBuffer.getMessages(jid);
	assert.equal(remaining[0].content, "keep this");

	summaryBuffer.clearBuffer(jid);
});

test("summaryBuffer: deleteByWhatsAppId with null is a no-op", () => {
	const jid = "test-delete-null@g.us";
	summaryBuffer.clearBuffer(jid);

	summaryBuffer.addMessage(jid, {
		sender: "Alice",
		content: "test",
		timestamp: 1000,
	});

	summaryBuffer.deleteByWhatsAppId(null);
	assert.equal(summaryBuffer.getMessageCount(jid), 1);

	summaryBuffer.clearBuffer(jid);
});

// --- summaryScheduler tests ---

test("summaryScheduler: onMessage does nothing when disabled", () => {
	const originalSettings = snapshotObject(state.settings);
	state.settings.SummaryEnabled = false;
	state.settings.SummaryChannels = {
		"test-disabled@g.us": { destinations: { whatsapp: "summary@g.us" } },
	};

	summaryScheduler.onMessage({
		channelJid: "test-disabled@g.us",
		sender: "Alice",
		content: "test",
		timestamp: Date.now(),
	});

	assert.equal(summaryBuffer.getMessageCount("test-disabled@g.us"), 0);

	restoreObject(state.settings, originalSettings);
});

test("summaryScheduler: onMessage buffers when enabled and configured", () => {
	const jid = "test-enabled@g.us";
	summaryBuffer.clearBuffer(jid);
	const originalSettings = snapshotObject(state.settings);

	state.settings.SummaryEnabled = true;
	state.settings.SummaryChannels = {
		[jid]: { destinations: { whatsapp: "summary@g.us" } },
	};

	summaryScheduler.onMessage({
		channelJid: jid,
		sender: "Alice",
		content: "test message",
		timestamp: Date.now(),
	});

	assert.equal(summaryBuffer.getMessageCount(jid), 1);

	summaryBuffer.clearBuffer(jid);
	restoreObject(state.settings, originalSettings);
});

test("summaryScheduler: onMessage ignores unconfigured channels", () => {
	const jid = "test-unconfigured@g.us";
	summaryBuffer.clearBuffer(jid);
	const originalSettings = snapshotObject(state.settings);

	state.settings.SummaryEnabled = true;
	state.settings.SummaryChannels = {};

	summaryScheduler.onMessage({
		channelJid: jid,
		sender: "Alice",
		content: "test",
		timestamp: Date.now(),
	});

	assert.equal(summaryBuffer.getMessageCount(jid), 0);

	restoreObject(state.settings, originalSettings);
});

test("summaryScheduler: isSummaryWhatsAppChannel", () => {
	const originalSettings = snapshotObject(state.settings);

	state.settings.SummaryChannels = {
		"primary@g.us": {
			destinations: { whatsapp: "summary-wa@g.us", discord: "12345" },
		},
	};

	assert.equal(
		summaryScheduler.isSummaryWhatsAppChannel("summary-wa@g.us"),
		true,
	);
	assert.equal(
		summaryScheduler.isSummaryWhatsAppChannel("primary@g.us"),
		false,
	);
	assert.equal(
		summaryScheduler.isSummaryWhatsAppChannel("random@g.us"),
		false,
	);

	restoreObject(state.settings, originalSettings);
});

test("summaryScheduler: isSummaryDiscordChannel", () => {
	const originalSettings = snapshotObject(state.settings);

	state.settings.SummaryChannels = {
		"primary@g.us": {
			destinations: { whatsapp: "summary-wa@g.us", discord: "12345" },
		},
	};

	assert.equal(summaryScheduler.isSummaryDiscordChannel("12345"), true);
	assert.equal(summaryScheduler.isSummaryDiscordChannel("99999"), false);

	restoreObject(state.settings, originalSettings);
});

test("summaryScheduler: splitMessage splits at newlines", () => {
	const text = "Line 1\nLine 2\nLine 3\nLine 4";
	const chunks = summaryScheduler._splitMessage(text, 15);
	assert.ok(chunks.length > 1);
	for (const chunk of chunks) {
		assert.ok(chunk.length <= 15);
	}
});

test("summaryScheduler: splitMessage returns single chunk if short", () => {
	const text = "short";
	const chunks = summaryScheduler._splitMessage(text, 100);
	assert.equal(chunks.length, 1);
	assert.equal(chunks[0], "short");
});

test("summaryScheduler: buildFooter with links", () => {
	const originalSettings = snapshotObject(state.settings);

	state.settings.SummaryJoinLinks = {
		discord: "https://discord.gg/test",
		whatsapp: "https://wa.me/test",
	};

	const footer = summaryScheduler._buildFooter();
	assert.ok(footer.includes("discord.gg/test"));
	assert.ok(footer.includes("wa.me/test"));

	restoreObject(state.settings, originalSettings);
});

test("summaryScheduler: buildFooter empty when no links", () => {
	const originalSettings = snapshotObject(state.settings);

	state.settings.SummaryJoinLinks = {};

	const footer = summaryScheduler._buildFooter();
	assert.equal(footer, "");

	restoreObject(state.settings, originalSettings);
});
