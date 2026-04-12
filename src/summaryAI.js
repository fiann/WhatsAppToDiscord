import state from "./state.js";

const SYSTEM_PROMPT = `You are a conversation summarizer for a chat group that spans WhatsApp and Discord. You receive transcripts of messages from a bridged channel. Your job is to produce a clear, concise summary that captures all discussion topics.

Format rules:
- Each topic is a single paragraph: a bold heading followed by a period, then 1-3 sentences of summary on the same line. Example:
  *Topic Heading.* Summary sentence one. Summary sentence two.
- Separate topics with a blank line.
- Do not use bullet points, numbered lists, or sub-headings within a topic.
- Do not add any preamble, title, or closing remarks — just the topic paragraphs.

Content rules:
1. Identify separate conversation topics, even when they are interleaved in the main channel. People often discuss multiple topics simultaneously using quoted replies. Group related exchanges together by topic.
2. If a thread section appears in the transcript, summarize it as its own topic.
3. Note any action items, decisions made, or unresolved questions.
4. If the transcript contains more than 3 distinct topics, prioritize the most active or important ones. Use no more than one sentence for any additional topics beyond the top 3. It is fine to have no summary text if the topic heading captures the important information.
5. Use the participants' names when attributing key points. Use the name of the person who initiated a topic or made a key point. If multiple people contributed, you can say "X and Y" or "Several participants".
6. Write in a conversational tone suitable for reading in a WhatsApp message.
7. If the previous summary mentions ongoing topics, note if they are still being discussed or have been resolved.`;

/**
 * Format buffered messages into a transcript string for the AI.
 */
const formatTranscript = (messages) => {
  const lines = [];
  let currentThread = null;

  for (const msg of messages) {
    if (msg.threadId && msg.threadId !== currentThread) {
      if (currentThread) lines.push("--- End Thread ---\n");
      lines.push(`--- Thread ---`);
      currentThread = msg.threadId;
    } else if (!msg.threadId && currentThread) {
      lines.push("--- End Thread ---\n");
      currentThread = null;
    }

    const time = new Date(msg.timestamp).toLocaleTimeString("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "UTC",
    });

    let line = `[${time}] ${msg.sender}`;
    if (msg.replyToSender) {
      line += ` (replying to ${msg.replyToSender})`;
    }
    line += ": ";

    const parts = [];
    if (msg.mediaDescription) parts.push(`[${msg.mediaDescription}]`);
    if (msg.content) parts.push(msg.content);
    line += parts.join(" ") || "[empty message]";

    lines.push(line);
  }

  if (currentThread) lines.push("--- End Thread ---");

  return lines.join("\n");
};

/**
 * Build the user prompt including previous summary context and transcript.
 */
const buildUserPrompt = (transcript, previousSummary, periodLabel) => {
  const parts = [];

  if (previousSummary) {
    parts.push(
      "Here is the previous summary for context (the conversation may be continuing topics from this period):\n",
    );
    parts.push("---");
    parts.push(previousSummary);
    parts.push("---\n");
  }

  parts.push(`Now summarize the following transcript:\n`);
  parts.push(`=== TRANSCRIPT ===`);
  if (periodLabel) parts.push(`=== Period: ${periodLabel} ===`);
  parts.push("");
  parts.push(transcript);

  return parts.join("\n");
};

/**
 * Provider implementations. Each provider must implement:
 *   async generate(userPrompt, config) => { summary, error }
 */
const providers = {
  async claude(userPrompt, config) {
    const apiKey = process.env.WA2DC_SUMMARY_AI_KEY;
    if (!apiKey) {
      return { error: "WA2DC_SUMMARY_AI_KEY environment variable is not set" };
    }

    const baseUrl = config.baseUrl || "https://api.anthropic.com";
    const model = config.model || "claude-sonnet-4-20250514";
    const maxTokens = config.maxTokens || 4096;

    try {
      const response = await fetch(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: userPrompt }],
        }),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        return {
          error: `Claude API returned ${response.status}: ${body.slice(0, 500)}`,
        };
      }

      const data = await response.json();
      const text = data?.content?.[0]?.text;
      if (!text) {
        return { error: "Claude API returned empty response" };
      }

      return { summary: text };
    } catch (err) {
      return { error: `Claude API request failed: ${err.message}` };
    }
  },
};

const summaryAI = {
  /**
   * Generate a summary from buffered messages.
   * @param {object[]} messages - Array of message objects from summaryBuffer.
   * @param {string|null} previousSummary - The previous summary text for context.
   * @param {object} [config] - Provider configuration overrides.
   * @returns {Promise<{summary?: string, error?: string}>}
   */
  async generateSummary(messages, previousSummary, config = {}) {
    const providerName = config.provider || state.settings.SummaryAIProvider || "claude";
    const provider = providers[providerName];
    if (!provider) {
      return { error: `Unknown summary AI provider: ${providerName}` };
    }

    const transcript = formatTranscript(messages);
    if (!transcript.trim()) {
      return { error: "No messages to summarize" };
    }

    const oldest = messages[0];
    const newest = messages[messages.length - 1];
    const periodLabel =
      oldest && newest
        ? `${new Date(oldest.timestamp).toISOString().slice(0, 16)} to ${new Date(newest.timestamp).toISOString().slice(0, 16)}`
        : null;

    const userPrompt = buildUserPrompt(transcript, previousSummary, periodLabel);

    const providerConfig = {
      model: config.model || state.settings.SummaryAIModel,
      maxTokens: config.maxTokens || state.settings.SummaryAIMaxTokens,
      baseUrl: config.baseUrl || state.settings.SummaryAIBaseUrl || "",
    };

    return provider(userPrompt, providerConfig);
  },

  /** Exposed for testing. */
  formatTranscript,
  buildUserPrompt,
  SYSTEM_PROMPT,
};

export default summaryAI;
