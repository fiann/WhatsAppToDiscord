import discordJs from 'discord.js';
import fs from 'fs';

import state from './state.js';
import utils from './utils.js';
import storage from './storage.js';

const { Client, Intents, Constants } = discordJs;

const DEFAULT_AVATAR_URL = 'https://cdn.discordapp.com/embed/avatars/0.png';

const client = new Client({
  intents: [
    Intents.FLAGS.GUILDS,
    Intents.FLAGS.GUILD_MESSAGES,
    Intents.FLAGS.GUILD_MESSAGE_REACTIONS,
    Intents.FLAGS.MESSAGE_CONTENT,
  ],
});
let controlChannel;
let slashRegisterWarned = false;
const pendingAlbums = {};
const typingTimeouts = {};
const whatsappTypingLoops = new Map();
const deliveredMessages = new Set();
const FORCE_TOKENS = new Set(['--force', '-f']);
const BOT_PERMISSIONS = 536879120;

class CommandResponder {
  constructor({ interaction, channel }) {
    this.interaction = interaction;
    this.channel = channel;
    this.replied = false;
    this.deferred = false;
    this.firstEditSent = false;
    this.ephemeral = interaction ? interaction.channelId !== state.settings.ControlChannelID : false;
  }

  async defer() {
    if (!this.interaction || this.deferred || this.replied) {
      return;
    }
    this.deferred = true;
    this.replied = true;
    await this.interaction.deferReply({ ephemeral: this.ephemeral });
  }

  async send(payload) {
    const normalized = typeof payload === 'string' ? { content: payload } : payload;
    if (this.interaction) {
      if (this.deferred) {
        if (!this.firstEditSent) {
          this.firstEditSent = true;
          return this.interaction.editReply(normalized);
        }
        return this.interaction.followUp({ ...normalized, ephemeral: this.ephemeral });
      }
      if (!this.replied) {
        this.replied = true;
        return this.interaction.reply({ ...normalized, ephemeral: this.ephemeral });
      }
      return this.interaction.followUp({ ...normalized, ephemeral: this.ephemeral });
    }

    return this.channel?.send(normalized);
  }

  async sendPartitioned(text) {
    const parts = utils.discord.partitionText(text || '');
    for (const part of parts) {
      // eslint-disable-next-line no-await-in-loop
      await this.send(part);
    }
  }
}

class CommandContext {
  constructor({ interaction, message, rawArgs = [], lowerArgs = [], responder }) {
    this.interaction = interaction;
    this.message = message;
    this.rawArgs = rawArgs;
    this.lowerArgs = lowerArgs;
    this.responder = responder;
  }

  get channel() {
    return this.interaction?.channel ?? this.message?.channel ?? null;
  }

  get createdTimestamp() {
    return this.interaction?.createdTimestamp ?? this.message?.createdTimestamp ?? Date.now();
  }

  get isControlChannel() {
    return this.channel?.id === state.settings.ControlChannelID;
  }

  get argString() {
    return this.rawArgs.join(' ');
  }

  async reply(payload) {
    return this.responder.send(payload);
  }

  async replyPartitioned(text) {
    return this.responder.sendPartitioned(text);
  }

  async defer() {
    return this.responder.defer();
  }

  getStringOption(name) {
    return this.interaction?.options?.getString(name);
  }

  getBooleanOption(name) {
    return this.interaction?.options?.getBoolean(name);
  }

  getIntegerOption(name) {
    return this.interaction?.options?.getInteger(name);
  }

  getNumberOption(name) {
    return this.interaction?.options?.getNumber(name);
  }

  getChannelOption(name) {
    return this.interaction?.options?.getChannel(name);
  }

  getMentionedChannel(index = 0) {
    if (!this.message?.mentions?.channels?.size) {
      return null;
    }
    const channels = [...this.message.mentions.channels.values()];
    return channels[index] ?? null;
  }
}

const sendWhatsappMessage = async (message, mediaFiles = [], messageIds = []) => {
  let msgContent = '';
  const files = [];
  const webhook = await utils.discord.getOrCreateChannel(message.channelJid);
  const avatarURL = message.profilePic || DEFAULT_AVATAR_URL;
  const content = utils.discord.convertWhatsappFormatting(message.content);
  const quoteContent = message.quote ? utils.discord.convertWhatsappFormatting(message.quote.content) : null;

  if (message.isGroup && state.settings.WAGroupPrefix) { msgContent += `[${message.name}] `; }

  if (message.isForwarded) {
    msgContent += `forwarded message:\n${(content || '').split('\n').join('\n> ')}`;
  }
  else if (message.quote) {
    const lines = [];

    const qContentRaw = quoteContent ?? '';
    const qContent = qContentRaw ? qContentRaw.split('\n').join('\n> ') : '';
    if (message.quote.name || qContent) {
      let quoteLine = '> ';
      if (message.quote.name) {
        quoteLine += message.quote.name;
        quoteLine += qContent ? ': ' : ':';
      }
      if (qContent) {
        quoteLine += qContent;
      }
      lines.push(quoteLine.trimEnd());
    }

    let segment = lines.join('\n');
    if (content) {
      segment += (segment ? '\n' : '') + content;
    }
    msgContent += segment || content || '';

    if (message.quote.file) {
      if (message.quote.file.largeFile && state.settings.LocalDownloads) {
        msgContent += await utils.discord.downloadLargeFile(message.quote.file);
      } else if (message.quote.file === -1 && !state.settings.LocalDownloads) {
        msgContent += "WA2DC Attention: Received a file, but it's over Discord's upload limit. Check WhatsApp on your phone or enable local downloads.";
      } else {
        files.push(message.quote.file);
      }
    }
  }
  else {
    msgContent += content;
  }

  for (const file of mediaFiles) {
    if (file.largeFile && state.settings.LocalDownloads) {
      // eslint-disable-next-line no-await-in-loop
      msgContent += await utils.discord.downloadLargeFile(file);
    }
    else if (file === -1 && !state.settings.LocalDownloads) {
      msgContent += "WA2DC Attention: Received a file, but it's over Discord's upload limit. Check WhatsApp on your phone or enable local downloads.";
    } else if (file !== -1) {
      files.push(file);
    }
  }

  if (message.isEdit) {
    const dcMessageId = state.lastMessages[message.id];
    if (dcMessageId) {
      try {
        await utils.discord.safeWebhookEdit(webhook, dcMessageId, { content: msgContent || null }, message.channelJid);
        return;
      } catch (err) {
        state.logger?.error(err);
      }
    }
    msgContent = `Edited message:\n${msgContent}`;
    const dcMessage = await utils.discord.safeWebhookSend(webhook, {
      content: msgContent,
      username: message.name,
      avatarURL,
    }, message.channelJid);
    if (message.id != null) {
      // bidirectional map automatically stores both directions
      state.lastMessages[dcMessage.id] = message.id;
    }
    return;
  }

  if (msgContent || files.length) {
    msgContent = utils.discord.partitionText(msgContent);
    while (msgContent.length > 1) {
      // eslint-disable-next-line no-await-in-loop
      await utils.discord.safeWebhookSend(webhook, {
        content: msgContent.shift(),
        username: message.name,
        avatarURL,
      }, message.channelJid);
    }

    const chunkArray = (arr, size) => {
      const chunks = [];
      for (let i = 0; i < arr.length; i += size) {
        chunks.push(arr.slice(i, i + size));
      }
      return chunks;
    };

    const fileChunks = chunkArray(files, 10);
    const idChunks = chunkArray(messageIds.length ? messageIds : [message.id], 10);

    if (!fileChunks.length) fileChunks.push([]);

    let lastDcMessage;
    for (let i = 0; i < fileChunks.length; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const sendArgs = {
        content: i === 0 ? (msgContent.shift() || null) : null,
        username: message.name,
        files: fileChunks[i],
        avatarURL,
      };
      lastDcMessage = await utils.discord.safeWebhookSend(webhook, sendArgs, message.channelJid);

      if (i === 0 && lastDcMessage.channel.type === 'GUILD_NEWS' && state.settings.Publish) {
        // eslint-disable-next-line no-await-in-loop
        await lastDcMessage.crosspost();
      }

      if (message.id != null) {
        for (const waId of idChunks[i] || []) {
          // bidirectional map automatically stores both directions
          state.lastMessages[waId] = lastDcMessage.id;
        }
        if (i === 0) {
          // store mapping for Discord -> first WhatsApp id for edits
          state.lastMessages[lastDcMessage.id] = message.id;
        }
      }
    }
  }
};

const flushAlbum = async (key) => {
  const album = pendingAlbums[key];
  if (!album) return;
  clearTimeout(album.timer);
  delete pendingAlbums[key];
  try {
    await sendWhatsappMessage(album.message, album.files, album.ids);
  } catch (err) {
    state.logger?.error({ err }, 'Failed to forward WhatsApp album to Discord');
  }
};

const setControlChannel = async () => {
  controlChannel = await utils.discord.getControlChannel();
};

client.on('ready', async () => {
  await setControlChannel();
  await registerSlashCommands();
});

client.on('channelDelete', async (channel) => {
  if (channel.id === state.settings.ControlChannelID) {
    controlChannel = await utils.discord.getControlChannel();
  } else {
    const jid = utils.discord.channelIdToJid(channel.id);
    delete state.chats[jid];
    delete state.goccRuns[jid];
    state.settings.Categories = state.settings.Categories.filter((id) => channel.id !== id);
  }
});

client.on('typingStart', async (typing) => {
  if ((state.settings.oneWay >> 1 & 1) === 0) { return; }
  const { channel } = typing;
  const jid = utils.discord.channelIdToJid(channel.id);
  if (!jid) { return; }
  if (!state.waClient) { return; }
  try {
    await state.waClient.sendPresenceUpdate('composing', jid);
    clearTimeout(typingTimeouts[jid]);
    typingTimeouts[jid] = setTimeout(() => {
      state.waClient.sendPresenceUpdate('paused', jid).catch(() => {});
    }, 5000);
  } catch (err) {
    state.logger?.error(err);
  }
});

client.on('whatsappMessage', async (message) => {
  if ((state.settings.oneWay >> 0 & 1) === 0) {
    return;
  }
  try {
    const key = `${message.channelJid}:${message.name}`;

    if (message.file && !message.isEdit) {
      if (pendingAlbums[key]) {
        pendingAlbums[key].files.push(message.file);
        pendingAlbums[key].ids.push(message.id);
        clearTimeout(pendingAlbums[key].timer);
        pendingAlbums[key].timer = setTimeout(() => flushAlbum(key), 500);
        return;
      }
      pendingAlbums[key] = {
        message,
        files: [message.file],
        ids: [message.id],
        timer: setTimeout(() => flushAlbum(key), 500),
      };
      return;
    }

    if (pendingAlbums[key]) {
      await flushAlbum(key);
    }

    await sendWhatsappMessage(message, message.file ? [message.file] : []);
  } catch (err) {
    state.logger?.error({ err }, 'Failed to process incoming WhatsApp message');
  }
});

client.on('whatsappReaction', async (reaction) => {
  if ((state.settings.oneWay >> 0 & 1) === 0) {
    return;
  }

  const channelId = state.chats[reaction.jid]?.channelId;
  const messageId = state.lastMessages[reaction.id];
  if (channelId == null || messageId == null) { return; }

  const channel = await utils.discord.getChannel(channelId);
  const message = await channel.messages.fetch(messageId);
  const msgReactions = state.reactions[messageId] || (state.reactions[messageId] = {});
  const prev = msgReactions[reaction.author];
  if (prev) {
    await message.reactions.cache.get(prev)?.remove().catch(() => {});
    delete msgReactions[reaction.author];
  }
  if (reaction.text) {
    await message.react(reaction.text).catch(async err => {
      if (err.code === 10014) {
        await channel.send(`Unknown emoji reaction (${reaction.text}) received. Check WhatsApp app to see it.`);
      }
    });
    msgReactions[reaction.author] = reaction.text;
  }
  if (!Object.keys(msgReactions).length) {
    delete state.reactions[messageId];
  }
});

client.on('whatsappTyping', async ({ jid, isTyping }) => {
  if ((state.settings.oneWay >> 0 & 1) === 0) { return; }
  const stopTypingLoop = () => {
    const existing = whatsappTypingLoops.get(jid);
    if (existing) {
      clearTimeout(existing);
      whatsappTypingLoops.delete(jid);
    }
  };
  const channelId = state.chats[jid]?.channelId;
  if (!channelId) {
    stopTypingLoop();
    return;
  }
  const channel = await utils.discord.getChannel(channelId);
  if (!channel) {
    stopTypingLoop();
    return;
  }
  if (!isTyping) {
    stopTypingLoop();
    return;
  }
  stopTypingLoop();
  const runTypingLoop = () => {
    channel.sendTyping().catch(() => {});
    const timeout = setTimeout(runTypingLoop, 6000);
    whatsappTypingLoops.set(jid, timeout);
  };
  runTypingLoop();
});

client.on('whatsappRead', async ({ id, jid }) => {
  if ((state.settings.oneWay >> 0 & 1) === 0 || !state.settings.ReadReceipts) { return; }
  const channelId = state.chats[jid]?.channelId;
  const messageId = state.lastMessages[id];
  if (!channelId || !messageId || deliveredMessages.has(messageId)) { return; }
  deliveredMessages.add(messageId);
  const channel = await utils.discord.getChannel(channelId);
  const message = await channel.messages.fetch(messageId).catch(() => null);
  if (!message) { return; }
  const receiptMode = state.settings.ReadReceiptMode;

  if (message.webhookId) {
    await message.react('☑️').catch(() => {});
    return;
  }

  if (receiptMode === 'dm') {
    const name = utils.whatsapp.jidToName(jid);
    const messageContent = (message.cleanContent ?? message.content ?? '').trim();
    let quote = null;

    if (messageContent) {
      const truncated = messageContent.length > 1800 ? `${messageContent.slice(0, 1797)}...` : messageContent;
      quote = truncated
        .split('\n')
        .map((line) => `> ${line || ' '}`)
        .join('\n');
    } else if (message.attachments?.size) {
      const attachments = [...message.attachments.values()].map((attachment) => attachment.name || attachment.url);
      const [firstAttachment, ...restAttachments] = attachments;
      quote = `> [Attachment] ${firstAttachment}`;
      if (restAttachments.length) {
        quote += `\n> ... (${restAttachments.length} more attachment${restAttachments.length === 1 ? '' : 's'})`;
      }
    } else {
      quote = '> *(No text content)*';
    }

    const receiptLines = [`✅ Your message to ${name} was read.`];
    if (quote) {
      receiptLines.push('', quote);
    }
    if (message.url) {
      receiptLines.push('', message.url);
    }

    message.author.send(receiptLines.join('\n')).catch(() => {});
    return;
  }

  if (receiptMode === 'reaction') {
    await message.react('☑️').catch(() => {});
    return;
  }

  const receipt = await channel.send({ content: '✅ Read', reply: { messageReference: messageId } }).catch(() => null);
  if (receipt) {
    setTimeout(() => receipt.delete().catch(() => {}), 5000);
  }
});

client.on('whatsappDelete', async ({ id, jid }) => {
  if (!state.settings.DeleteMessages || (state.settings.oneWay >> 0 & 1) === 0) {
    return;
  }

  const messageId = state.lastMessages[id];
  if (state.chats[jid] == null || messageId == null) {
    return;
  }

  const webhook = await utils.discord.getOrCreateChannel(jid);
  try {
    await utils.discord.safeWebhookDelete(webhook, messageId, jid);
  } catch {
    try {
      await utils.discord.safeWebhookEdit(
        webhook,
        messageId,
        { content: 'Message Deleted' },
        jid,
      );
    } catch (err) {
      state.logger?.error(err);
    }
  }
  delete state.lastMessages[id];
  delete state.lastMessages[messageId];
});

client.on('whatsappCall', async ({ call, jid }) => {
  if ((state.settings.oneWay >> 0 & 1) === 0) {
    return;
  }
  
  const webhook = await utils.discord.getOrCreateChannel(jid);

  const name = utils.whatsapp.jidToName(jid);
  const callType = call.isVideo ? 'video' : 'voice';
  let content = '';

  switch (call.status) {
    case 'offer':
      content = `${name} is ${callType} calling you! Check your phone to respond.`
      break;
    case 'timeout':
      content = `Missed a ${callType} call from ${name}!`
      break;
  }

  if (content !== '') {
    const avatarURL = (await utils.whatsapp.getProfilePic(call)) || DEFAULT_AVATAR_URL;
    await webhook.send({
      content,
      username: name,
      avatarURL,
    });
  }
});

const { ApplicationCommandOptionTypes } = Constants;

const commandHandlers = {
  ping: {
    description: 'Check the bot latency.',
    async execute(ctx) {
      await ctx.reply(`Pong ${Date.now() - ctx.createdTimestamp}ms!`);
    },
  },
  pairwithcode: {
    description: 'Request a WhatsApp pairing code.',
    options: [
      {
        name: 'number',
        description: 'Phone number with country code.',
        type: ApplicationCommandOptionTypes.STRING,
        required: true,
      },
    ],
    async execute(ctx) {
      const number = ctx.getStringOption('number') ?? ctx.rawArgs[0];
      if (!number) {
        await ctx.reply('Please enter your number. Usage: `pairWithCode <number>`. Don\'t use "+" or any other special characters.');
        return;
      }

      const code = await state.waClient.requestPairingCode(number);
      await ctx.reply(`Your pairing code is: ${code}`);
    },
  },
  start: {
    description: 'Start a conversation with a contact or number.',
    options: [
      {
        name: 'contact',
        description: 'Number with country code or contact name.',
        type: ApplicationCommandOptionTypes.STRING,
        required: true,
      },
    ],
    async execute(ctx) {
      const contact = ctx.getStringOption('contact') ?? ctx.argString;
      if (!contact) {
        await ctx.reply('Please enter a phone number or name. Usage: `start <number with country code or name>`.');
        return;
      }

      // eslint-disable-next-line no-restricted-globals
      const jid = utils.whatsapp.toJid(contact);
      if (!jid) {
        await ctx.reply(`Couldn't find \`${contact}\`.`);
        return;
      }
      const webhook = await utils.discord.getOrCreateChannel(jid);
      if (!webhook) {
        await ctx.reply('Failed to start the conversation. Please try again.');
        return;
      }

      if (state.settings.Whitelist.length) {
        const normalized = utils.whatsapp.formatJid(jid);
        if (normalized && !state.settings.Whitelist.includes(normalized)) {
          state.settings.Whitelist.push(normalized);
        }
      }

      const channelMention = webhook.channelId ? `<#${webhook.channelId}>` : 'the linked channel';
      await ctx.reply(`Started a conversation in ${channelMention}.`);
    },
  },
  link: {
    description: 'Link a WhatsApp chat to an existing channel.',
    options: [
      {
        name: 'contact',
        description: 'Number with country code or contact name.',
        type: ApplicationCommandOptionTypes.STRING,
        required: true,
      },
      {
        name: 'channel',
        description: 'Target Discord channel.',
        type: ApplicationCommandOptionTypes.CHANNEL,
        required: true,
      },
      {
        name: 'force',
        description: 'Override an existing link.',
        type: ApplicationCommandOptionTypes.BOOLEAN,
        required: false,
      },
    ],
    async execute(ctx) {
      const force = ctx.getBooleanOption('force') ?? ctx.lowerArgs?.some((token) => FORCE_TOKENS.has(token));
      const slashChannel = ctx.getChannelOption('channel');
      const messageChannel = ctx.message?.mentions?.channels?.first();
      const channel = slashChannel ?? messageChannel;
      const argsWithoutFlags = (ctx.lowerArgs || []).filter((token) => !FORCE_TOKENS.has(token));
      const mentionTokenLower = channel ? `<#${channel.id}>`.toLowerCase() : null;

      let contactQuery = ctx.getStringOption('contact');
      if (!contactQuery && ctx.rawArgs?.length) {
        const mentionIndex = mentionTokenLower != null ? argsWithoutFlags.indexOf(mentionTokenLower) : -1;
        if (mentionIndex === -1) {
          contactQuery = ctx.rawArgs.filter((token, idx) => !FORCE_TOKENS.has(ctx.lowerArgs[idx]) && token !== mentionTokenLower).join(' ');
        } else {
          contactQuery = ctx.rawArgs.slice(0, mentionIndex).join(' ');
        }
      }

      if (!channel || !contactQuery) {
        await ctx.reply('Please provide a contact and a channel. Usage: `link <number with country code or name> #<channel>`');
        return;
      }

      if (channel.id === state.settings.ControlChannelID) {
        await ctx.reply('The control channel cannot be linked. Please choose another channel.');
        return;
      }

      if (channel.guildId !== state.settings.GuildID) {
        await ctx.reply('Please choose a channel from the configured Discord server.');
        return;
      }

      if (!['GUILD_TEXT', 'GUILD_NEWS'].includes(channel.type)) {
        await ctx.reply('Only text channels can be linked. Please choose a text channel.');
        return;
      }

      const jid = utils.whatsapp.toJid(contactQuery);
      const normalizedJid = utils.whatsapp.formatJid(jid);
      if (!normalizedJid) {
        await ctx.reply(`Couldn't find \`${contactQuery}\`.`);
        return;
      }

      const existingJid = utils.discord.channelIdToJid(channel.id);
      const forcedTakeover = Boolean(existingJid && existingJid !== normalizedJid && force);
      let displacedChat;
      let displacedRun;
      if (existingJid && existingJid !== normalizedJid) {
        if (!force) {
          await ctx.reply('That channel is already linked to another WhatsApp conversation. Add `--force` (or use the `move` command) to override it.');
          return;
        }
        displacedChat = state.chats[existingJid];
        displacedRun = state.goccRuns[existingJid];
        delete state.chats[existingJid];
        delete state.goccRuns[existingJid];
      }

      let webhook;
      try {
        const webhooks = await channel.fetchWebhooks();
        webhook = webhooks.find((hook) => hook.token && hook.owner?.id === client.user.id);
        if (!webhook) {
          webhook = await channel.createWebhook('WA2DC');
        }
      } catch (err) {
        state.logger?.error(err);
        await ctx.reply('Failed to access or create a webhook for that channel. Check the bot\'s permissions.');
        return;
      }

      const previousChat = state.chats[normalizedJid];
      const previousChannelId = previousChat?.channelId;
      const previousRun = state.goccRuns[normalizedJid];
      state.chats[normalizedJid] = {
        id: webhook.id,
        type: webhook.type,
        token: webhook.token,
        channelId: webhook.channelId,
      };
      delete state.goccRuns[normalizedJid];

      try {
        await utils.discord.getOrCreateChannel(normalizedJid);
        await storage.save();
      } catch (err) {
        state.logger?.error(err);
        if (previousChat) {
          state.chats[normalizedJid] = previousChat;
        } else {
          delete state.chats[normalizedJid];
        }
        if (previousRun) {
          state.goccRuns[normalizedJid] = previousRun;
        } else {
          delete state.goccRuns[normalizedJid];
        }
        if (forcedTakeover) {
          if (displacedChat) {
            state.chats[existingJid] = displacedChat;
          }
          if (displacedRun) {
            state.goccRuns[existingJid] = displacedRun;
          }
        }
        await ctx.reply('Linked the channel, but failed to finalize the setup. Please try again.');
        return;
      }

      if (previousChannelId && previousChannelId !== channel.id && previousChat?.id) {
        try {
          const previousChannel = await utils.discord.getChannel(previousChannelId);
          const previousWebhooks = await previousChannel?.fetchWebhooks();
          const previousWebhook = previousWebhooks?.get(previousChat.id) || previousWebhooks?.find((hook) => hook.id === previousChat.id);
          await previousWebhook?.delete('WA2DC channel relinked');
        } catch (err) {
          state.logger?.warn(err);
        }
      }

      const forcedSuffix = forcedTakeover
        ? ` (overrode the previous link to \`${utils.whatsapp.jidToName(existingJid)}\`).`
        : '.';
      await ctx.reply(`Linked ${channel} with \`${utils.whatsapp.jidToName(normalizedJid)}\`${forcedSuffix}`);
    },
  },
  move: {
    description: 'Move a WhatsApp link from one channel to another.',
    options: [
      {
        name: 'from',
        description: 'Current channel.',
        type: ApplicationCommandOptionTypes.CHANNEL,
        required: true,
      },
      {
        name: 'to',
        description: 'Destination channel.',
        type: ApplicationCommandOptionTypes.CHANNEL,
        required: true,
      },
      {
        name: 'force',
        description: 'Override any existing link on the destination.',
        type: ApplicationCommandOptionTypes.BOOLEAN,
        required: false,
      },
    ],
    async execute(ctx) {
      const slashFrom = ctx.getChannelOption('from');
      const slashTo = ctx.getChannelOption('to');
      const mentionMatches = ctx.message?.content?.match(/<#(\d+)>/g) || [];
      const orderedIds = [];
      for (const token of mentionMatches) {
        const id = token.replace(/[^\d]/g, '');
        if (id && !orderedIds.includes(id)) {
          orderedIds.push(id);
        }
        if (orderedIds.length === 2) {
          break;
        }
      }
      const messageFrom = orderedIds[0] ? ctx.message?.mentions?.channels?.get(orderedIds[0]) : null;
      const messageTo = orderedIds[1] ? ctx.message?.mentions?.channels?.get(orderedIds[1]) : null;
      const source = slashFrom ?? messageFrom;
      const target = slashTo ?? messageTo;
      const force = ctx.getBooleanOption('force') ?? (ctx.lowerArgs?.some((token) => FORCE_TOKENS.has(token)));

      if (!source || !target) {
        await ctx.reply('Please mention the current channel and the new channel. Usage: `move #old-channel #new-channel [--force]`');
        return;
      }

      if (source.id === target.id) {
        await ctx.reply('Please mention two different channels to move between.');
        return;
      }

      if (source.id === state.settings.ControlChannelID || target.id === state.settings.ControlChannelID) {
        await ctx.reply('The control channel cannot participate in moves. Choose two regular text channels.');
        return;
      }

      if (source.guildId !== state.settings.GuildID || target.guildId !== state.settings.GuildID) {
        await ctx.reply('Please choose channels from the configured Discord server.');
        return;
      }

      if (!['GUILD_TEXT', 'GUILD_NEWS'].includes(target.type)) {
        await ctx.reply('Only text or announcement channels can be targets. Please choose a different channel.');
        return;
      }

      const sourceJidRaw = utils.discord.channelIdToJid(source.id);
      const normalizedJid = utils.whatsapp.formatJid(sourceJidRaw);
      if (!normalizedJid) {
        await ctx.reply('The source channel is not linked to any WhatsApp conversation.');
        return;
      }

      const existingTargetJid = utils.discord.channelIdToJid(target.id);
      const forcedTakeover = Boolean(existingTargetJid && existingTargetJid !== normalizedJid && force);
      let displacedChat;
      let displacedRun;
      if (existingTargetJid && existingTargetJid !== normalizedJid) {
        if (!force) {
          await ctx.reply('That destination channel is already linked to another conversation. Add `--force` to override it.');
          return;
        }
        displacedChat = state.chats[existingTargetJid];
        displacedRun = state.goccRuns[existingTargetJid];
        delete state.chats[existingTargetJid];
        delete state.goccRuns[existingTargetJid];
      }

      let webhook;
      try {
        const webhooks = await target.fetchWebhooks();
        webhook = webhooks.find((hook) => hook.token && hook.owner?.id === client.user.id);
        if (!webhook) {
          webhook = await target.createWebhook('WA2DC');
        }
      } catch (err) {
        state.logger?.error(err);
        if (forcedTakeover) {
          if (displacedChat) {
            state.chats[existingTargetJid] = displacedChat;
          }
          if (displacedRun) {
            state.goccRuns[existingTargetJid] = displacedRun;
          }
        }
        await ctx.reply('Failed to access or create a webhook for the destination channel. Check the bot\'s permissions.');
        return;
      }

      const previousChat = state.chats[normalizedJid];
      const previousRun = state.goccRuns[normalizedJid];
      state.chats[normalizedJid] = {
        id: webhook.id,
        type: webhook.type,
        token: webhook.token,
        channelId: webhook.channelId,
      };
      delete state.goccRuns[normalizedJid];

      try {
        await utils.discord.getOrCreateChannel(normalizedJid);
        await storage.save();
      } catch (err) {
        state.logger?.error(err);
        if (previousChat) {
          state.chats[normalizedJid] = previousChat;
        } else {
          delete state.chats[normalizedJid];
        }
        if (previousRun) {
          state.goccRuns[normalizedJid] = previousRun;
        } else {
          delete state.goccRuns[normalizedJid];
        }
        if (forcedTakeover) {
          if (displacedChat) {
            state.chats[existingTargetJid] = displacedChat;
          }
          if (displacedRun) {
            state.goccRuns[existingTargetJid] = displacedRun;
          }
        }
        await ctx.reply('Moved the channel, but failed to finalize the setup. Please try again.');
        return;
      }

      if (previousChat?.channelId && previousChat.channelId !== webhook.channelId && previousChat.id) {
        try {
          const previousChannel = await utils.discord.getChannel(previousChat.channelId);
          const previousWebhooks = await previousChannel?.fetchWebhooks();
          const previousWebhook = previousWebhooks?.get(previousChat.id) || previousWebhooks?.find((hook) => hook.id === previousChat.id);
          await previousWebhook?.delete('WA2DC channel moved');
        } catch (err) {
          state.logger?.warn(err);
        }
      }

      const forcedSuffix = forcedTakeover
        ? ` (overrode the previous link to \`${utils.whatsapp.jidToName(existingTargetJid)}\`).`
        : '.';
      await ctx.reply(
        `Moved \`${utils.whatsapp.jidToName(normalizedJid)}\` from ${source} to ${target}${forcedSuffix}`,
      );
    },
  },
  list: {
    description: 'List contacts and groups.',
    options: [
      {
        name: 'query',
        description: 'Optional search text.',
        type: ApplicationCommandOptionTypes.STRING,
        required: false,
      },
    ],
    async execute(ctx) {
      let contacts = utils.whatsapp.contacts();
      const query = (ctx.getStringOption('query') ?? ctx.argString)?.toLowerCase();
      if (query) { contacts = contacts.filter((name) => name.toLowerCase().includes(query)); }
      contacts = contacts.sort((a, b) => a.localeCompare(b)).join('\n');
      const message = utils.discord.partitionText(
        contacts.length
          ? `${contacts}\n\nNot the whole list? You can refresh your contacts by typing \`resync\``
          : 'No results were found.',
      );
      while (message.length !== 0) {
        // eslint-disable-next-line no-await-in-loop
        await ctx.reply(message.shift());
      }
    },
  },
  addtowhitelist: {
    description: 'Add a channel to the whitelist.',
    options: [
      {
        name: 'channel',
        description: 'Channel linked to a WhatsApp chat.',
        type: ApplicationCommandOptionTypes.CHANNEL,
        required: true,
      },
    ],
    async execute(ctx) {
      const channel = ctx.getChannelOption('channel') ?? ctx.getMentionedChannel();
      if (!channel) {
        await ctx.reply('Please enter a valid channel name. Usage: `addToWhitelist #<target channel>`.');
        return;
      }

      const jid = utils.discord.channelIdToJid(channel.id);
      if (!jid) {
        await ctx.reply("Couldn't find a chat with the given channel.");
        return;
      }

      const normalized = utils.whatsapp.formatJid(jid);
      if (normalized && !state.settings.Whitelist.includes(normalized)) {
        state.settings.Whitelist.push(normalized);
      }
      await ctx.reply('Added to the whitelist!');
    },
  },
  removefromwhitelist: {
    description: 'Remove a channel from the whitelist.',
    options: [
      {
        name: 'channel',
        description: 'Channel linked to a WhatsApp chat.',
        type: ApplicationCommandOptionTypes.CHANNEL,
        required: true,
      },
    ],
    async execute(ctx) {
      const channel = ctx.getChannelOption('channel') ?? ctx.getMentionedChannel();
      if (!channel) {
        await ctx.reply('Please enter a valid channel name. Usage: `removeFromWhitelist #<target channel>`.');
        return;
      }

      const jid = utils.discord.channelIdToJid(channel.id);
      if (!jid) {
        await ctx.reply("Couldn't find a chat with the given channel.");
        return;
      }

      const normalized = utils.whatsapp.formatJid(jid);
      state.settings.Whitelist = state.settings.Whitelist.filter((el) => el !== normalized);
      await ctx.reply('Removed from the whitelist!');
    },
  },
  listwhitelist: {
    description: 'List whitelisted channels.',
    async execute(ctx) {
      await ctx.reply(
        state.settings.Whitelist.length
          ? `\`\`\`${state.settings.Whitelist.map((jid) => utils.whatsapp.jidToName(jid)).join('\n')}\`\`\``
          : 'Whitelist is empty/inactive.',
      );
    },
  },
  setdcprefix: {
    description: 'Set a static prefix for Discord messages.',
    options: [
      {
        name: 'prefix',
        description: 'Prefix text. Leave empty to reset to username.',
        type: ApplicationCommandOptionTypes.STRING,
        required: false,
      },
    ],
    async execute(ctx) {
      const prefix = ctx.getStringOption('prefix') ?? ctx.argString;
      if (prefix) {
        state.settings.DiscordPrefixText = prefix;
        await ctx.reply(`Discord prefix is set to ${prefix}!`);
      } else {
        state.settings.DiscordPrefixText = null;
        await ctx.reply('Discord prefix is set to your discord username!');
      }
    },
  },
  enabledcprefix: {
    description: 'Enable Discord username prefixes.',
    async execute(ctx) {
      state.settings.DiscordPrefix = true;
      await ctx.reply('Discord username prefix enabled!');
    },
  },
  disabledcprefix: {
    description: 'Disable Discord username prefixes.',
    async execute(ctx) {
      state.settings.DiscordPrefix = false;
      await ctx.reply('Discord username prefix disabled!');
    },
  },
  enablewaprefix: {
    description: 'Enable WhatsApp name prefixes on Discord.',
    async execute(ctx) {
      state.settings.WAGroupPrefix = true;
      await ctx.reply('WhatsApp name prefix enabled!');
    },
  },
  disablewaprefix: {
    description: 'Disable WhatsApp name prefixes on Discord.',
    async execute(ctx) {
      state.settings.WAGroupPrefix = false;
      await ctx.reply('WhatsApp name prefix disabled!');
    },
  },
  enablewaupload: {
    description: 'Enable uploading attachments to WhatsApp.',
    async execute(ctx) {
      state.settings.UploadAttachments = true;
      await ctx.reply('Enabled uploading files to WhatsApp!');
    },
  },
  disablewaupload: {
    description: 'Disable uploading attachments to WhatsApp.',
    async execute(ctx) {
      state.settings.UploadAttachments = false;
      await ctx.reply('Disabled uploading files to WhatsApp!');
    },
  },
  enabledeletes: {
    description: 'Enable message delete syncing.',
    async execute(ctx) {
      state.settings.DeleteMessages = true;
      await ctx.reply('Enabled message delete syncing!');
    },
  },
  disabledeletes: {
    description: 'Disable message delete syncing.',
    async execute(ctx) {
      state.settings.DeleteMessages = false;
      await ctx.reply('Disabled message delete syncing!');
    },
  },
  enablereadreceipts: {
    description: 'Enable read receipts.',
    async execute(ctx) {
      state.settings.ReadReceipts = true;
      await ctx.reply('Enabled read receipts!');
    },
  },
  disablereadreceipts: {
    description: 'Disable read receipts.',
    async execute(ctx) {
      state.settings.ReadReceipts = false;
      await ctx.reply('Disabled read receipts!');
    },
  },
  dmreadreceipts: {
    description: 'Send read receipts via DM.',
    async execute(ctx) {
      state.settings.ReadReceiptMode = 'dm';
      await ctx.reply('Read receipts will be sent via DM.');
    },
  },
  publicreadreceipts: {
    description: 'Send read receipts as channel replies.',
    async execute(ctx) {
      state.settings.ReadReceiptMode = 'public';
      await ctx.reply('Read receipts will be posted publicly.');
    },
  },
  reactionreadreceipts: {
    description: 'Send read receipts as reactions.',
    async execute(ctx) {
      state.settings.ReadReceiptMode = 'reaction';
      await ctx.reply('Read receipts will be added as ☑️ reactions.');
    },
  },
  help: {
    description: 'Show help link.',
    async execute(ctx) {
      await ctx.reply('See all the available commands at https://arespawn.github.io/WhatsAppToDiscord/#/commands');
    },
  },
  resync: {
    description: 'Re-sync WhatsApp contacts and groups.',
    options: [
      {
        name: 'rename',
        description: 'Rename channels to match WhatsApp names.',
        type: ApplicationCommandOptionTypes.BOOLEAN,
        required: false,
      },
    ],
    async execute(ctx) {
      await ctx.defer();
      await state.waClient.authState.keys.set({
        'app-state-sync-version': { critical_unblock_low: null },
      });
      await state.waClient.resyncAppState(['critical_unblock_low']);
      for (const [jid, attributes] of Object.entries(await state.waClient.groupFetchAllParticipating())) { state.waClient.contacts[jid] = attributes.subject; }
      const shouldRename = ctx.getBooleanOption('rename') ?? (ctx.lowerArgs || []).includes('rename');
      if (shouldRename) {
        try {
          await utils.discord.renameChannels();
        } catch (err) {
          state.logger?.error(err);
        }
      }
      await ctx.reply('Re-synced!');
    },
  },
  enablelocaldownloads: {
    description: 'Enable local downloads for large files.',
    async execute(ctx) {
      state.settings.LocalDownloads = true;
      await ctx.reply('Enabled local downloads. You can now download files larger than Discord\'s upload limit.');
    },
  },
  disablelocaldownloads: {
    description: 'Disable local downloads for large files.',
    async execute(ctx) {
      state.settings.LocalDownloads = false;
      await ctx.reply('Disabled local downloads. You won\'t be able to download files larger than Discord\'s upload limit.');
    },
  },
  getdownloadmessage: {
    description: 'Show the current download message template.',
    async execute(ctx) {
      await ctx.reply(`Download message format is set to "${state.settings.LocalDownloadMessage}"`);
    },
  },
  setdownloadmessage: {
    description: 'Update the download message template.',
    options: [
      {
        name: 'message',
        description: 'Template text.',
        type: ApplicationCommandOptionTypes.STRING,
        required: true,
      },
    ],
    async execute(ctx) {
      const message = ctx.getStringOption('message') ?? ctx.argString;
      if (!message) {
        await ctx.reply('Please provide a template. Usage: `setDownloadMessage <your message here>`');
        return;
      }
      state.settings.LocalDownloadMessage = message;
      await ctx.reply(`Set download message format to "${state.settings.LocalDownloadMessage}"`);
    },
  },
  getdownloaddir: {
    description: 'Show the download directory.',
    async execute(ctx) {
      await ctx.reply(`Download path is set to "${state.settings.DownloadDir}"`);
    },
  },
  setdownloaddir: {
    description: 'Set the download directory.',
    options: [
      {
        name: 'path',
        description: 'Directory path for downloads.',
        type: ApplicationCommandOptionTypes.STRING,
        required: true,
      },
    ],
    async execute(ctx) {
      const dir = ctx.getStringOption('path') ?? ctx.argString;
      if (!dir) {
        await ctx.reply('Please provide a path. Usage: `setDownloadDir <desired save path>`');
        return;
      }
      state.settings.DownloadDir = dir;
      await ctx.reply(`Set download path to "${state.settings.DownloadDir}"`);
    },
  },
  setdownloadlimit: {
    description: 'Set the local download directory size limit in GB.',
    options: [
      {
        name: 'size',
        description: 'Size limit in gigabytes.',
        type: ApplicationCommandOptionTypes.NUMBER,
        required: true,
      },
    ],
    async execute(ctx) {
      const gb = ctx.getNumberOption('size') ?? parseFloat(ctx.rawArgs?.[0]);
      if (!Number.isNaN(gb) && gb >= 0) {
        state.settings.DownloadDirLimitGB = gb;
        await ctx.reply(`Set download directory size limit to ${gb} GB.`);
      } else {
        await ctx.reply('Please provide a valid size in gigabytes.');
      }
    },
  },
  setfilesizelimit: {
    description: 'Set the Discord upload size limit used by the bot.',
    options: [
      {
        name: 'bytes',
        description: 'Maximum size in bytes.',
        type: ApplicationCommandOptionTypes.INTEGER,
        required: true,
      },
    ],
    async execute(ctx) {
      const size = ctx.getIntegerOption('bytes') ?? parseInt(ctx.rawArgs?.[0], 10);
      if (!Number.isNaN(size) && size > 0) {
        state.settings.DiscordFileSizeLimit = size;
        await ctx.reply(`Set Discord file size limit to ${size} bytes.`);
      } else {
        await ctx.reply('Please provide a valid size in bytes.');
      }
    },
  },
  enablelocaldownloadserver: {
    description: 'Start the local download server.',
    async execute(ctx) {
      state.settings.LocalDownloadServer = true;
      utils.ensureDownloadServer();
      await ctx.reply(`Enabled local download server on port ${state.settings.LocalDownloadServerPort}.`);
    },
  },
  disablelocaldownloadserver: {
    description: 'Stop the local download server.',
    async execute(ctx) {
      state.settings.LocalDownloadServer = false;
      utils.stopDownloadServer();
      await ctx.reply('Disabled local download server.');
    },
  },
  setlocaldownloadserverport: {
    description: 'Set the download server port.',
    options: [
      {
        name: 'port',
        description: 'Port number.',
        type: ApplicationCommandOptionTypes.INTEGER,
        required: true,
      },
    ],
    async execute(ctx) {
      const port = ctx.getIntegerOption('port') ?? parseInt(ctx.rawArgs?.[0], 10);
      if (!Number.isNaN(port) && port > 0 && port <= 65535) {
        state.settings.LocalDownloadServerPort = port;
        utils.stopDownloadServer();
        utils.ensureDownloadServer();
        await ctx.reply(`Set local download server port to ${port}.`);
      } else {
        await ctx.reply('Please provide a valid port.');
      }
    },
  },
  setlocaldownloadserverhost: {
    description: 'Set the download server host.',
    options: [
      {
        name: 'host',
        description: 'Hostname or IP for the download server.',
        type: ApplicationCommandOptionTypes.STRING,
        required: true,
      },
    ],
    async execute(ctx) {
      const host = ctx.getStringOption('host') ?? ctx.rawArgs?.[0];
      if (host) {
        state.settings.LocalDownloadServerHost = host;
        utils.stopDownloadServer();
        utils.ensureDownloadServer();
        await ctx.reply(`Set local download server host to ${host}.`);
      } else {
        await ctx.reply('Please provide a host name or IP.');
      }
    },
  },
  enablehttpsdownloadserver: {
    description: 'Enable HTTPS for the local download server.',
    async execute(ctx) {
      state.settings.UseHttps = true;
      utils.stopDownloadServer();
      utils.ensureDownloadServer();
      await ctx.reply('Enabled HTTPS for local download server.');
    },
  },
  disablehttpsdownloadserver: {
    description: 'Disable HTTPS for the local download server.',
    async execute(ctx) {
      state.settings.UseHttps = false;
      utils.stopDownloadServer();
      utils.ensureDownloadServer();
      await ctx.reply('Disabled HTTPS for local download server.');
    },
  },
  sethttpscert: {
    description: 'Set HTTPS certificate paths for the download server.',
    options: [
      {
        name: 'key_path',
        description: 'Path to the TLS key.',
        type: ApplicationCommandOptionTypes.STRING,
        required: true,
      },
      {
        name: 'cert_path',
        description: 'Path to the TLS certificate.',
        type: ApplicationCommandOptionTypes.STRING,
        required: true,
      },
    ],
    async execute(ctx) {
      const key = ctx.getStringOption('key_path') ?? ctx.rawArgs?.[0];
      const cert = ctx.getStringOption('cert_path') ?? ctx.rawArgs?.[1];
      if (!key || !cert) {
        await ctx.reply('Usage: `setHttpsCert <key> <cert>`');
        return;
      }
      [state.settings.HttpsKeyPath, state.settings.HttpsCertPath] = [key, cert];
      utils.stopDownloadServer();
      utils.ensureDownloadServer();
      await ctx.reply(`Set HTTPS key path to ${key} and cert path to ${cert}.`);
    },
  },
  enablepublishing: {
    description: 'Publish messages sent to news channels automatically.',
    async execute(ctx) {
      state.settings.Publish = true;
      await ctx.reply('Enabled publishing messages sent to news channels.');
    },
  },
  disablepublishing: {
    description: 'Stop publishing messages sent to news channels automatically.',
    async execute(ctx) {
      state.settings.Publish = false;
      await ctx.reply('Disabled publishing messages sent to news channels.');
    },
  },
  enablechangenotifications: {
    description: 'Enable profile/status change notifications.',
    async execute(ctx) {
      state.settings.ChangeNotifications = true;
      await ctx.reply('Enabled profile picture change and status update notifications.');
    },
  },
  disablechangenotifications: {
    description: 'Disable profile/status change notifications.',
    async execute(ctx) {
      state.settings.ChangeNotifications = false;
      await ctx.reply('Disabled profile picture change and status update notifications.');
    },
  },
  autosaveinterval: {
    description: 'Set the auto-save interval (seconds).',
    options: [
      {
        name: 'seconds',
        description: 'Number of seconds between saves.',
        type: ApplicationCommandOptionTypes.INTEGER,
        required: true,
      },
    ],
    async execute(ctx) {
      const seconds = ctx.getIntegerOption('seconds') ?? parseInt(ctx.rawArgs?.[0], 10);
      if (Number.isNaN(seconds)) {
        await ctx.reply("Usage: autoSaveInterval <seconds>\nExample: autoSaveInterval 60");
        return;
      }
      state.settings.autoSaveInterval = seconds;
      await ctx.reply(`Changed auto save interval to ${seconds}.`);
    },
  },
  lastmessagestorage: {
    description: 'Set how many recent messages can be edited/deleted.',
    options: [
      {
        name: 'size',
        description: 'Number of messages to keep.',
        type: ApplicationCommandOptionTypes.INTEGER,
        required: true,
      },
    ],
    async execute(ctx) {
      const size = ctx.getIntegerOption('size') ?? parseInt(ctx.rawArgs?.[0], 10);
      if (Number.isNaN(size)) {
        await ctx.reply("Usage: lastMessageStorage <size>\nExample: lastMessageStorage 1000");
        return;
      }
      state.settings.lastMessageStorage = size;
      await ctx.reply(`Changed last message storage size to ${size}.`);
    },
  },
  oneway: {
    description: 'Set one-way communication mode.',
    options: [
      {
        name: 'direction',
        description: 'Choose direction or disable one-way.',
        type: ApplicationCommandOptionTypes.STRING,
        required: true,
        choices: [
          { name: 'discord', value: 'discord' },
          { name: 'whatsapp', value: 'whatsapp' },
          { name: 'disabled', value: 'disabled' },
        ],
      },
    ],
    async execute(ctx) {
      const direction = ctx.getStringOption('direction') ?? ctx.rawArgs?.[0];
      if (!direction || !['discord', 'whatsapp', 'disabled'].includes(direction)) {
        await ctx.reply("Usage: oneWay <discord|whatsapp|disabled>\nExample: oneWay whatsapp");
        return;
      }

      if (direction === 'disabled') {
        state.settings.oneWay = 0b11;
        await ctx.reply('Two way communication is enabled.');
      } else if (direction === 'whatsapp') {
        state.settings.oneWay = 0b10;
        await ctx.reply('Messages will be only sent to WhatsApp.');
      } else if (direction === 'discord') {
        state.settings.oneWay = 0b01;
        await ctx.reply('Messages will be only sent to Discord.');
      }
    },
  },
  redirectwebhooks: {
    description: 'Toggle redirecting webhook messages to WhatsApp.',
    options: [
      {
        name: 'enabled',
        description: 'Whether webhook messages should be redirected.',
        type: ApplicationCommandOptionTypes.BOOLEAN,
        required: true,
      },
    ],
    async execute(ctx) {
      const enabledOption = ctx.getBooleanOption('enabled');
      const raw = ctx.rawArgs?.[0]?.toLowerCase?.();
      const rawValue = raw === 'yes' ? true : raw === 'no' ? false : null;
      const enabled = enabledOption ?? rawValue;
      if (enabled == null) {
        await ctx.reply("Usage: redirectWebhooks <yes|no>\nExample: redirectWebhooks yes");
        return;
      }

      state.settings.redirectWebhooks = Boolean(enabled);
      await ctx.reply(`Redirecting webhooks is set to ${state.settings.redirectWebhooks}.`);
    },
  },
  updatechannel: {
    description: 'Switch update channel between stable and unstable.',
    options: [
      {
        name: 'channel',
        description: 'Release channel.',
        type: ApplicationCommandOptionTypes.STRING,
        required: true,
        choices: [
          { name: 'stable', value: 'stable' },
          { name: 'unstable', value: 'unstable' },
        ],
      },
    ],
    async execute(ctx) {
      const channel = (ctx.getStringOption('channel') ?? ctx.rawArgs?.[0])?.toLowerCase();
      if (!['stable', 'unstable'].includes(channel)) {
        await ctx.reply("Usage: updateChannel <stable|unstable>\nExample: updateChannel unstable");
        return;
      }

      state.settings.UpdateChannel = channel;
      await ctx.reply(`Update channel set to ${channel}. Checking for new releases...`);
      await utils.updater.run(state.version, { prompt: false });
      if (state.updateInfo) {
        const message = utils.updater.formatUpdateMessage(state.updateInfo);
        await ctx.replyPartitioned(message);
      } else {
        await ctx.reply('No updates are available on that channel right now.');
      }
    },
  },
  update: {
    description: 'Install the available update.',
    async execute(ctx) {
      await ctx.defer();
      if (!state.updateInfo) {
        await ctx.reply('No update available.');
        return;
      }
      if (!state.updateInfo.canSelfUpdate) {
        await ctx.replyPartitioned(
          `A new ${state.updateInfo.channel || 'stable'} release (${state.updateInfo.version}) is available, but this installation cannot self-update.\n` +
          'Pull the new image or binary for the requested release and restart the bot.',
        );
        return;
      }

      await ctx.reply('Updating...');
      const success = await utils.updater.update(state.updateInfo.version);
      if (!success) {
        await ctx.reply('Update failed. Check logs.');
        return;
      }

      await ctx.reply('Update downloaded. Restarting...');
      await fs.promises.writeFile('restart.flag', '');
      process.exit();
    },
  },
  checkupdate: {
    description: 'Check for updates now.',
    async execute(ctx) {
      await ctx.defer();
      await utils.updater.run(state.version, { prompt: false });
      if (state.updateInfo) {
        const message = utils.updater.formatUpdateMessage(state.updateInfo);
        await ctx.replyPartitioned(message);
      } else {
        await ctx.reply('No update available.');
      }
    },
  },
  skipupdate: {
    description: 'Clear the current update notification.',
    async execute(ctx) {
      state.updateInfo = null;
      await ctx.reply('Update skipped.');
    },
  },
  rollback: {
    description: 'Roll back to the previous packaged binary.',
    async execute(ctx) {
      await ctx.defer();
      const result = await utils.updater.rollback();
      if (result.success) {
        await ctx.reply('Rolled back to the previous packaged binary. Restarting...');
        await fs.promises.writeFile('restart.flag', '');
        process.exit();
        return;
      }

      if (result.reason === 'node') {
        await ctx.replyPartitioned(
          'Rollback is only available for packaged binaries. To roll back a Docker or source install, pull the previous image/tag and restart.'
        );
        return;
      }

      if (result.reason === 'no-backup') {
        await ctx.reply('No previous packaged binary is available to roll back to.');
        return;
      }

      await ctx.reply('Rollback failed. Check logs for details.');
    },
  },
  unknown: {
    register: false,
    async execute(ctx) {
      if (ctx.message) {
        await ctx.reply(`Unknown command: \`${ctx.message.content}\`\nType \`/help\` to see available commands`);
      } else {
        await ctx.reply('Unknown command.');
      }
    },
  },
};

const slashCommands = Object.entries(commandHandlers)
  .filter(([, def]) => def.register !== false)
  .map(([name, def]) => ({
    name,
    description: def.description || 'No description provided.',
    options: def.options || [],
  }));

const buildInviteLink = () => (
  client?.user?.id
    ? `https://discordapp.com/oauth2/authorize?client_id=${client.user.id}&scope=bot%20application.commands&permissions=${BOT_PERMISSIONS}`
    : null
);

const registerSlashCommands = async () => {
  try {
    const guild = await utils.discord.getGuild();
    if (!guild) {
      state.logger?.error('Failed to load guild while registering commands.');
      return;
    }
    await guild.commands.set(slashCommands);
  } catch (err) {
    state.logger?.error({ err }, 'Failed to register slash commands');
    const missingAccess = err?.code === 50001 || /Missing Access/i.test(err?.message || '');
    if (missingAccess && !slashRegisterWarned) {
      slashRegisterWarned = true;
      const link = buildInviteLink();
      const warning = link
        ? `Slash commands could not be registered (missing application.commands scope). Re-invite the bot with this link:\n${link}`
        : 'Slash commands could not be registered (missing application.commands scope). Re-invite the bot with both bot and application.commands scopes.';
      controlChannel?.send(warning).catch(() => {});
    }
  }
};

const executeCommand = async (name, ctx) => {
  const handler = commandHandlers[name] || commandHandlers.unknown;
  await handler.execute(ctx);
};

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isCommand?.() && !interaction.isChatInputCommand?.()) {
    return;
  }

  const responder = new CommandResponder({ interaction, channel: interaction.channel });
  await responder.defer();
  const ctx = new CommandContext({ interaction, responder });
  const commandName = interaction.commandName?.toLowerCase();
  await executeCommand(commandName, ctx);
});

client.on('messageCreate', async (message) => {
  if (message.author === client.user || message.applicationId === client.user.id || (message.webhookId != null && !state.settings.redirectWebhooks)) {
    return;
  }

  if (message.channel.id === state.settings.ControlChannelID) {
    const [commandNameRaw, ...rawArgs] = message.content.trim().split(/\s+/);
    const commandName = (commandNameRaw || '').toLowerCase();
    const responder = new CommandResponder({ channel: controlChannel || message.channel });
    const ctx = new CommandContext({
      message,
      responder,
      rawArgs,
      lowerArgs: rawArgs.map((arg) => arg.toLowerCase()),
    });
    await executeCommand(commandName, ctx);
    return;
  }

  const jid = utils.discord.channelIdToJid(message.channel.id);
  if (jid == null) {
    return;
  }

  state.waClient.ev.emit('discordMessage', { jid, message });
});

client.on('messageUpdate', async (_, message) => {
  if (message.webhookId != null) {
    return;
  }

  if (message.partial) {
    try {
      await message.fetch();
    } catch (err) {
      state.logger?.warn(err);
      return;
    }
  }

  if (message.editedTimestamp == null) {
    return;
  }

  const jid = utils.discord.channelIdToJid(message.channelId);
  if (jid == null) {
    return;
  }

  const messageId = state.lastMessages[message.id];
  if (messageId == null) {
    await message.channel.send(`Couldn't edit the message. You can only edit the last ${state.settings.lastMessageStorage} messages.`);
    return;
  }

  if (message.content.trim() === '') {
    await message.channel.send('Edited message has no text to send to WhatsApp.');
    return;
  }

  state.waClient.ev.emit('discordEdit', { jid, message });
});

client.on('messageDelete', async (message) => {
  if (!state.settings.DeleteMessages) {
    return;
  }

  const jid = utils.discord.channelIdToJid(message.channelId);
  if (jid == null) {
    return;
  }

  const waIds = [];
  for (const [waId, dcId] of Object.entries(state.lastMessages)) {
    if (dcId === message.id && waId !== message.id) {
      waIds.push(waId);
    }
  }

  if (message.webhookId != null && waIds.length === 0) {
    return;
  }

  if (message.author?.id === client.user.id) {
    return;
  }

  if (waIds.length === 0) {
    await message.channel.send(`Couldn't delete the message. You can only delete the last ${state.settings.lastMessageStorage} messages.`);
    return;
  }

  for (const waId of waIds) {
    state.waClient.ev.emit('discordDelete', { jid, id: waId });
    delete state.lastMessages[waId];
  }
  delete state.lastMessages[message.id];
});

client.on('messageReactionAdd', async (reaction, user) => {
  const jid = utils.discord.channelIdToJid(reaction.message.channel.id);
  if (jid == null) {
    return;
  }
  const isBotUser = user?.id === state.dcClient?.user?.id;
  if (
    isBotUser
    && reaction.emoji?.name === '☑️'
    && (
      reaction.message.webhookId != null
      || deliveredMessages.has(reaction.message.id)
    )
  ) {
    return;
  }
  const messageId = state.lastMessages[reaction.message.id];
  if (messageId == null) {
    await reaction.message.channel.send(`Couldn't send the reaction. You can only react to last ${state.settings.lastMessageStorage} messages.`);
    return;
  }
  if (isBotUser) {
    return;
  }
  const selfJid = state.waClient?.user?.id && utils.whatsapp.formatJid(state.waClient.user.id);
  if (selfJid && state.reactions[reaction.message.id]?.[selfJid]) {
    const prev = state.reactions[reaction.message.id][selfJid];
    await reaction.message.reactions.cache.get(prev)?.remove().catch(() => {});
    delete state.reactions[reaction.message.id][selfJid];
    if (!Object.keys(state.reactions[reaction.message.id]).length) {
      delete state.reactions[reaction.message.id];
    }
  }
  state.waClient.ev.emit('discordReaction', { jid, reaction, removed: false });
});

client.on('messageReactionRemove', async (reaction, user) => {
  const jid = utils.discord.channelIdToJid(reaction.message.channel.id);
  if (jid == null) {
    return;
  }
  const isBotUser = user?.id === state.dcClient?.user?.id;
  if (
    isBotUser
    && reaction.emoji?.name === '☑️'
    && (
      reaction.message.webhookId != null
      || deliveredMessages.has(reaction.message.id)
    )
  ) {
    return;
  }
  const messageId = state.lastMessages[reaction.message.id];
  if (messageId == null) {
    await reaction.message.channel.send(`Couldn't remove the reaction. You can only react to last ${state.settings.lastMessageStorage} messages.`);
    return;
  }
  if (isBotUser) {
    return;
  }
  const selfJid = state.waClient?.user?.id && utils.whatsapp.formatJid(state.waClient.user.id);
  if (selfJid && state.reactions[reaction.message.id]?.[selfJid]) {
    const prev = state.reactions[reaction.message.id][selfJid];
    await reaction.message.reactions.cache.get(prev)?.remove().catch(() => {});
    delete state.reactions[reaction.message.id][selfJid];
    if (!Object.keys(state.reactions[reaction.message.id]).length) {
      delete state.reactions[reaction.message.id];
    }
  }
  state.waClient.ev.emit('discordReaction', { jid, reaction, removed: true });
});

const discordHandler = {
  start: async () => {
    await client.login(state.settings.Token);
    return client;
  },
  setControlChannel,
};

export default discordHandler;
