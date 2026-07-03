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
7. If the previous summary mentions ongoing topics, note if they are still being discussed or have been resolved.
8. Do not mention moderation actions, bans, kicks, or warnings issued to members — omit these entirely, including any discussion of a member being banned or the reasons for it.
9. If a member was banned (e.g. for spam, unsolicited job/recruitment posts, or other rule violations), exclude all of that member's messages from that day entirely — do not summarize or reference their content, even indirectly.
10. Omit procedural housekeeping that isn't part of the actual conversation — e.g. a moderator reminding someone to follow posting guidelines, a member apologizing for or explaining an absence, logistics about who can or can't attend/remote into a session, or other administrative back-and-forth. Capture the substance of what people discussed, not the guardrails around how they discussed it. Never frame any member's conduct in a way that could embarrass them.
11. Do still include procedural content that is a genuine announcement to the whole group: a change to community rules (not just a reminder of existing ones), a welcome to a new member, an announcement of an upcoming event, or reading/prep material assigned for a future event.`;

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
 * Raw Claude API call shared by summarization and verification — same
 * transport, different system prompt per caller.
 * @returns {Promise<{text?: string, error?: string}>}
 */
const callClaudeAPI = async (systemPrompt, userPrompt, config) => {
  const apiKey = process.env.WA2DC_SUMMARY_AI_KEY;
  if (!apiKey) {
    return { error: "WA2DC_SUMMARY_AI_KEY environment variable is not set" };
  }

  const baseUrl = config.baseUrl || "https://api.anthropic.com";
  const model = config.model || "claude-sonnet-5";
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
        system: systemPrompt,
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
    const text = data?.content?.find((block) => block.type === "text")?.text;
    if (!text) {
      return { error: "Claude API returned empty response" };
    }

    return { text };
  } catch (err) {
    return { error: `Claude API request failed: ${err.message}` };
  }
};

/**
 * Provider implementations. Each provider must implement:
 *   async generate(userPrompt, config) => { summary, error }
 */
const providers = {
  async claude(userPrompt, config) {
    const { text, error } = await callClaudeAPI(SYSTEM_PROMPT, userPrompt, config);
    if (error) return { error };
    return { summary: text };
  },
};

const VERIFICATION_SYSTEM_PROMPT = `You are fact-checking an AI-generated chat summary against its source transcript. Your only job is to catch fabrication — check whether every person, event, date, or claim in the summary is actually supported by the transcript below it.

Do not evaluate style, tone, formatting, or completeness (it's fine and expected for a summary to omit things). Only flag content that is fabricated, i.e. not grounded in the transcript at all — invented people, invented events, invented quotes, or dates/details that contradict the transcript.

Respond with exactly one line:
- If every claim in the summary is grounded in the transcript, respond with exactly: VALID
- If the summary contains fabricated content, respond with: INVALID: <one sentence naming the specific fabrication>`;

/**
 * Ask the model to fact-check a candidate summary against its source
 * transcript, to catch fabrication that doesn't trip the structural
 * looksDegenerate() heuristic (e.g. a clean-looking paragraph that still
 * invents a person or event not present in the transcript).
 * @returns {Promise<{grounded: boolean, reason?: string}>}
 */
const verifyGrounding = async (transcript, summary, config) => {
  const userPrompt = `=== TRANSCRIPT ===\n${transcript}\n\n=== CANDIDATE SUMMARY ===\n${summary}`;
  const { text, error } = await callClaudeAPI(
    VERIFICATION_SYSTEM_PROMPT,
    userPrompt,
    // Extended thinking can consume tokens on reasoning before the verdict
    // — too tight a budget truncates the response before it ever says
    // VALID/INVALID, which we'd otherwise misread as a pass-through.
    { ...config, maxTokens: 500 },
  );
  if (error) {
    // Don't block delivery on a verification-call failure — log and pass
    // through, since the structural check already ran.
    state.logger?.warn({ error }, "Summary verification call failed, skipping check");
    return { grounded: true };
  }
  const trimmed = text.trim();
  const invalidMatch = trimmed.match(/INVALID:?\s*(.*)/is);
  if (invalidMatch) return { grounded: false, reason: invalidMatch[1].trim() };
  return { grounded: true };
};

/**
 * Basic sanity check to catch a degenerate model response (echoed prompt
 * scaffolding, leaked raw transcript lines, runaway repetition) before it
 * ever gets posted to a real channel. Seen in practice on transcripts
 * containing moderation/guideline-enforcement exchanges, which can send the
 * model into a hallucinated "continuation" instead of a summary.
 */
const looksDegenerate = (text) => {
  if (!text) return true;
  if (text.includes("===")) return true;
  if (/\[\d{1,2}:\d{2}\]/.test(text)) return true;
  if (/^>\s/m.test(text)) return true;
  if (text.length > 3000) return true;
  const lines = text.split("\n").filter(Boolean);
  const dupeCount = lines.length - new Set(lines).size;
  if (lines.length > 5 && dupeCount / lines.length > 0.3) return true;
  return false;
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

    for (let attempt = 1; attempt <= 3; attempt++) {
      const result = await provider(userPrompt, providerConfig);
      if (result.error) return result;

      if (looksDegenerate(result.summary)) {
        state.logger?.warn(
          { attempt },
          "Summary generation looked degenerate, retrying",
        );
        continue;
      }

      // Structural check passed — also fact-check the summary against the
      // transcript to catch a clean-looking but fabricated summary (e.g.
      // an invented person or event) that wouldn't trip looksDegenerate.
      if (providerName === "claude") {
        const { grounded, reason } = await verifyGrounding(
          transcript,
          result.summary,
          providerConfig,
        );
        if (!grounded) {
          state.logger?.warn(
            { attempt, reason },
            "Summary failed grounding verification, retrying",
          );
          continue;
        }
      }

      return result;
    }

    return { error: "Summary generation produced degenerate or unverifiable output after retries" };
  },

  /** Exposed for testing. */
  formatTranscript,
  buildUserPrompt,
  SYSTEM_PROMPT,
};

export default summaryAI;
