import {
  DisconnectReason,
  proto,
  useMultiFileAuthState,
  WAMessageStatus,
  WAMessageStubType,
} from '@whiskeysockets/baileys';

import utils from './utils.js';
import state from './state.js';
import { createWhatsAppClient, getBaileysVersion } from './clientFactories.js';


let authState;
let saveState;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const formatDisconnectReason = (statusCode) => {
    if (typeof statusCode !== 'number') return 'unknown';
    const label = DisconnectReason[statusCode];
    return label ? `${label} (${statusCode})` : `code ${statusCode}`;
};
const getReconnectDelayMs = (retry) => {
    if (retry <= 3) {
        return 0;
    }
    const slowAttempt = retry - 3;
    const baseDelay = 5000;
    const maxDelay = 60000;
    return Math.min(baseDelay * 2 ** (slowAttempt - 1), maxDelay);
};

const patchSendMessageForLinkPreviews = (client) => {
    if (!client || client.__wa2dcLinkPreviewPatched) {
        return;
    }
    const defaultGetUrlInfo = (text) => utils.whatsapp.generateLinkPreview(text, {
        uploadImage: typeof client.waUploadToServer === 'function' ? client.waUploadToServer : undefined,
        logger: state.logger,
    });
    const baseSendMessage = client.sendMessage.bind(client);
    client.sendMessage = async (jid, content, options) => {
        const normalizedOptions = options ? { ...options } : {};
        if (!normalizedOptions.logger) {
            normalizedOptions.logger = state.logger;
        }
        if (!normalizedOptions.getUrlInfo) {
            normalizedOptions.getUrlInfo = defaultGetUrlInfo;
        }
        return baseSendMessage(jid, content, normalizedOptions);
    };
    client.__wa2dcLinkPreviewPatched = true;
};

const ensureSignalStoreSupport = async (keyStore) => {
    if (!keyStore?.get || !keyStore?.set) {
        return;
    }

    const requiredKeys = ['tctoken', 'lid-mapping', 'device-list', 'device-index'];
    for (const key of requiredKeys) {
        try {
            // Baileys expects a map for each category; ensure the file exists so new
            // rc.8+ entries (like tctoken and lid-mapping) can be written safely.
            // eslint-disable-next-line no-await-in-loop
            const existing = await keyStore.get(key, []);
            if (existing == null) {
                // eslint-disable-next-line no-await-in-loop
                await keyStore.set({ [key]: {} });
            }
        } catch (err) {
            state.logger?.warn({ err, key }, 'Failed to ensure auth store compatibility');
        }
    }
};

const migrateLegacyChats = async (client) => {
    const store = client.signalRepository?.lidMapping;
    if (!store) return;
    const pnJids = Object.keys(state.chats).filter((jid) => jid.endsWith('@s.whatsapp.net'));
    if (!pnJids.length) return;
    try {
        const mappings = typeof store.getLIDsForPNs === 'function'
            ? await store.getLIDsForPNs(pnJids)
            : {};
        for (const pnJid of pnJids) {
            let lidJid = mappings?.[pnJid];
            if (!lidJid && typeof store.getLIDForPN === 'function') {
                // eslint-disable-next-line no-await-in-loop
                lidJid = await store.getLIDForPN(pnJid);
            }
            if (lidJid) {
                utils.whatsapp.migrateLegacyJid(pnJid, lidJid);
            }
        }
    } catch (err) {
        state.logger?.warn({ err }, 'Failed to migrate PN chats to LIDs');
    }
};

const connectToWhatsApp = async (retry = 1) => {
    const controlChannel = await utils.discord.getControlChannel();
    const { version } = await getBaileysVersion();

    const client = createWhatsAppClient({
        version,
        printQRInTerminal: false,
        auth: authState,
        logger: state.logger,
        markOnlineOnConnect: false,
        syncFullHistory: true,
        shouldSyncHistoryMessage: () => true,
        generateHighQualityLinkPreview: true,
        browser: ["Firefox (Linux)", "", ""]
    });
    client.contacts = state.contacts;
    patchSendMessageForLinkPreviews(client);

    client.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            utils.whatsapp.sendQR(qr);
        }
        if (connection === 'close') {
            state.logger.error(lastDisconnect?.error);
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            if (statusCode === DisconnectReason.loggedOut || statusCode === DisconnectReason.badSession) {
                await controlChannel.send('WhatsApp session invalid. Please rescan the QR code.');
                await utils.whatsapp.deleteSession();
                await actions.start(true);
                return;
            }
            const delayMs = getReconnectDelayMs(retry);
            const humanReason = formatDisconnectReason(statusCode);
            if (delayMs === 0) {
                await controlChannel?.send(`WhatsApp connection failed (${humanReason}). Trying to reconnect! Retry #${retry}`);
            } else {
                const delaySeconds = Math.round(delayMs / 1000);
                await controlChannel?.send(`WhatsApp connection failed (${humanReason}). Waiting ${delaySeconds} seconds before trying to reconnect! Retry #${retry}.`);
                await sleep(delayMs);
            }
            await connectToWhatsApp(retry + 1);
            return;
        } else if (connection === 'open') {
            state.waClient = client;
            // eslint-disable-next-line no-param-reassign
            retry = 1;
            await controlChannel.send('WhatsApp connection successfully opened!');

            try {
                const groups = await client.groupFetchAllParticipating();
                for (const [jid, data] of Object.entries(groups)) {
                    state.contacts[jid] = data.subject;
                    client.contacts[jid] = data.subject;
                }
                await migrateLegacyChats(client);
            } catch (err) {
                state.logger?.error(err);
            }
        }
    });
    const credsListener = typeof saveState === 'function' ? saveState : () => {};
    client.ev.on('creds.update', credsListener);
    const contactUpdater = utils.whatsapp.updateContacts.bind(utils.whatsapp);
    ['chats.set', 'contacts.set', 'chats.upsert', 'chats.update', 'contacts.upsert', 'contacts.update', 'groups.upsert', 'groups.update']
      .forEach((eventName) => client.ev.on(eventName, contactUpdater));

    client.ev.on('lid-mapping.update', ({ lid, pn }) => {
        const normalizedLid = utils.whatsapp.formatJid(lid);
        const normalizedPn = utils.whatsapp.formatJid(pn);
        if (!normalizedLid || !normalizedPn) return;
        const firstIsLid = utils.whatsapp.isLidJid(normalizedLid);
        const secondIsLid = utils.whatsapp.isLidJid(normalizedPn);
        if (firstIsLid && !secondIsLid) {
            utils.whatsapp.migrateLegacyJid(normalizedPn, normalizedLid);
        } else if (!firstIsLid && secondIsLid) {
            utils.whatsapp.migrateLegacyJid(normalizedLid, normalizedPn);
        }
    });

    client.ev.on('messages.upsert', async (update) => {
        if (['notify', 'append'].includes(update.type)) {
            for await (const rawMessage of update.messages) {
                const messageId = utils.whatsapp.getId(rawMessage);
                if (state.sentMessages.has(messageId)) {
                    state.sentMessages.delete(messageId);
                    continue;
                }
                const messageType = utils.whatsapp.getMessageType(rawMessage);
                if (!utils.whatsapp.inWhitelist(rawMessage) || !utils.whatsapp.sentAfterStart(rawMessage) || !messageType) continue;

                const [nMsgType, message] = utils.whatsapp.getMessage(rawMessage, messageType);
                state.dcClient.emit('whatsappMessage', {
                    id: utils.whatsapp.getId(rawMessage),
                    name: await utils.whatsapp.getSenderName(rawMessage),
                    content: utils.whatsapp.getContent(message, nMsgType, messageType),
                    quote: await utils.whatsapp.getQuote(rawMessage),
                    file: await utils.whatsapp.getFile(rawMessage, messageType),
                    profilePic: await utils.whatsapp.getProfilePic(rawMessage),
                    channelJid: await utils.whatsapp.getChannelJid(rawMessage),
                    isGroup: utils.whatsapp.isGroup(rawMessage),
                    isForwarded: utils.whatsapp.isForwarded(message),
                    isEdit: messageType === 'editedMessage'
                });
                const ts = utils.whatsapp.getTimestamp(rawMessage);
                if (ts > state.startTime) state.startTime = ts;
            }
        }
    });

    client.ev.on('messages.reaction', async (reactions) => {
        for await (const rawReaction of reactions) {
            if (!utils.whatsapp.inWhitelist(rawReaction) || !utils.whatsapp.sentAfterStart(rawReaction))
                return;

            const msgId = utils.whatsapp.getId(rawReaction);
            if (state.sentReactions.has(msgId)) {
                state.sentReactions.delete(msgId);
                continue;
            }

            state.dcClient.emit('whatsappReaction', {
                id: msgId,
                jid: await utils.whatsapp.getChannelJid(rawReaction),
                text: rawReaction.reaction.text,
                author: await utils.whatsapp.getSenderJid(rawReaction, rawReaction.key.fromMe),
            });
            const ts = utils.whatsapp.getTimestamp(rawReaction);
            if (ts > state.startTime) state.startTime = ts;
        }
    });

    client.ev.on('messages.delete', async (updates) => {
        const keys = 'keys' in updates ? updates.keys : updates;
        for (const key of keys) {
            if (!utils.whatsapp.inWhitelist({ key })) continue;
            const jid = await utils.whatsapp.getChannelJid({ key });
            if (!jid) continue;
            state.dcClient.emit('whatsappDelete', {
                id: key.id,
                jid,
            });
        }
    });

    client.ev.on('messages.update', async (updates) => {
        for (const { update, key } of updates) {
            if (typeof update.status !== 'undefined' && key.fromMe &&
                [WAMessageStatus.READ, WAMessageStatus.PLAYED].includes(update.status)) {
                state.dcClient.emit('whatsappRead', {
                    id: key.id,
                    jid: await utils.whatsapp.getChannelJid({ key }),
                });
            }

            const protocol = update.message?.protocolMessage;
            const isDelete =
                protocol?.type === proto.Message.ProtocolMessage.Type.REVOKE ||
                update.messageStubType === WAMessageStubType.REVOKE;
            if (!isDelete) continue;
            const msgKey = protocol?.key || key;
            if (!utils.whatsapp.inWhitelist({ key: msgKey })) continue;
            state.dcClient.emit('whatsappDelete', {
                id: msgKey.id,
                jid: await utils.whatsapp.getChannelJid({ key: msgKey }),
            });
        }
    });

    client.ev.on('call', async (calls) => {
        for await (const call of calls) {
            if (!utils.whatsapp.inWhitelist(call) || !utils.whatsapp.sentAfterStart(call))
                return;

            state.dcClient.emit('whatsappCall', {
                jid: await utils.whatsapp.getChannelJid(call),
                call,
            });
            const ts = utils.whatsapp.getTimestamp(call);
            if (ts > state.startTime) state.startTime = ts;
        }
    });

    client.ev.on('contacts.update', async (contacts) => {
        for await (const contact of contacts) {
            if (typeof contact.imgUrl === 'undefined') continue;
            if (!utils.whatsapp.inWhitelist({ chatId: contact.id })) continue;

            utils.whatsapp._profilePicsCache[contact.id] = await client.profilePictureUrl(contact.id, 'preview').catch(() => null);

            if (!state.settings.ChangeNotifications) continue;
            const removed = utils.whatsapp._profilePicsCache[contact.id] === null;
            state.dcClient.emit('whatsappMessage', {
                id: null,
                name: "WA2DC",
                content: "[BOT] " + (removed ? "User removed their profile picture!" : "User changed their profile picture!"),
                profilePic: utils.whatsapp._profilePicsCache[contact.id],
                channelJid: await utils.whatsapp.getChannelJid({ chatId: contact.id }),
                isGroup: contact.id.endsWith('@g.us'),
                isForwarded: false,
                file: removed ? null : await client.profilePictureUrl(contact.id, 'image').catch(() => null),
            });
        }
    });

    client.ev.on('presence.update', async ({ id, presences }) => {
        if (!utils.whatsapp.inWhitelist({ chatId: id })) return;
        for (const presence of Object.values(presences)) {
            const isTyping = ['composing', 'recording'].includes(presence?.lastKnownPresence);
            if (isTyping) {
                state.dcClient.emit('whatsappTyping', {
                    jid: utils.whatsapp.formatJid(id),
                    isTyping: true,
                });
                break;
            }
        }
    });

    client.ws.on(`CB:notification,type:status,set`, async (update) => {
        if (!utils.whatsapp.inWhitelist({ chatId: update.attrs.from })) return;

        if (!state.settings.ChangeNotifications) return;
        const status = update.content[0]?.content?.toString();
        if (!status) return;
        state.dcClient.emit('whatsappMessage', {
            id: null,
            name: "WA2DC",
            content: "[BOT] User changed their status to: " + status,
            profilePic: utils.whatsapp._profilePicsCache[update.attrs.from],
            channelJid: await utils.whatsapp.getChannelJid({ chatId: update.attrs.from }),
            isGroup: update.attrs.from.endsWith('@g.us'),
            isForwarded: false,
        });
    });

    client.ev.on('discordMessage', async ({ jid, message }) => {
        if ((state.settings.oneWay >> 1 & 1) === 0) {
            return;
        }
        
        const options = {
            getUrlInfo: (urlText) => utils.whatsapp.generateLinkPreview(urlText, {
                uploadImage: typeof client.waUploadToServer === 'function' ? client.waUploadToServer : undefined,
                logger: state.logger,
            }),
        };

        if (message.reference) {
            options.quoted = await utils.whatsapp.createQuoteMessage(message);
            if (options.quoted == null) {
                message.channel.send("Couldn't find the message quoted. You can only reply to last ${state.settings.lastMessageStorage} messages. Sending the message without the quoted message.");
            }
        }

        const emojiData = utils.discord.extractCustomEmojiData(message);
        const hasOnlyCustomEmoji = emojiData.matches.length > 0 && emojiData.rawWithoutEmoji.trim() === '';
        const emojiFallbackText = emojiData.matches.map((entry) => `:${entry.name}:`).join(' ');

        let text = utils.whatsapp.convertDiscordFormatting(message.cleanContent ?? '');
        if (message.reference) {
            // Discord prepends a mention to replies which results in all
            // participants being tagged on WhatsApp. Remove the leading
            // mention so no unintended mass mentions occur.
            text = text.replace(/^@\S+\s*/, '');
        }

        const stripped = utils.discord.stripCustomEmojiCodes(text).trim();
        let composedText = stripped;

        if (state.settings.DiscordPrefix) {
            const prefix = state.settings.DiscordPrefixText || message.member?.nickname || message.author.username;
            composedText = stripped ? `*${prefix}*\n${stripped}` : `*${prefix}*`;
        }

        const urlEnforcement = utils.discord.ensureExplicitUrlScheme(composedText);
        text = urlEnforcement.text;

        const media = utils.discord.collectMessageMedia(message, {
            includeEmojiAttachments: emojiData.matches.length > 0,
            emojiMatches: emojiData.matches,
        });
        const attachments = media.attachments || [];
        const consumedUrls = media.consumedUrls || [];
        const shouldSendAttachments = state.settings.UploadAttachments && attachments.length > 0;

        if (shouldSendAttachments && consumedUrls.length && text) {
            for (const consumed of consumedUrls) {
                if (!consumed) continue;
                const variants = [consumed, `<${consumed}>`];
                for (const variant of variants) {
                    text = text.split(variant).join(' ');
                }
            }
            text = text.replace(/\s{2,}/g, ' ').trim();
        }

        const mentionJids = utils.whatsapp.getMentionedJids(text);

        if (shouldSendAttachments) {
            let first = true;
            for (const file of attachments) {
                const doc = utils.whatsapp.createDocumentContent(file);
                if (!doc) continue;
                if (first) {
                    const captionText = hasOnlyCustomEmoji ? '' : text;
                    if (captionText || mentionJids.length) doc.caption = captionText;
                    if (mentionJids.length) doc.mentions = mentionJids;
                }
                try {
                    const sentMessage = await client.sendMessage(jid, doc, first ? options : undefined);
                    state.lastMessages[message.id] = sentMessage.key.id;
                    state.lastMessages[sentMessage.key.id] = message.id;
                    state.sentMessages.add(sentMessage.key.id);
                } catch (err) {
                    state.logger?.error(err);
                }
                if (first) {
                    first = false;
                }
            }
            return;
        }

        const fallbackParts = [];
        if (text) {
            fallbackParts.push(text);
        } else if (hasOnlyCustomEmoji && emojiFallbackText) {
            fallbackParts.push(emojiFallbackText);
        }
        const attachmentLinks = attachments.map((file) => file.url).filter(Boolean);
        fallbackParts.push(...attachmentLinks);
        const finalText = fallbackParts.join(' ').trim();
        if (!finalText) {
            return;
        }

        const content = { text: finalText };
        if (mentionJids.length) {
            content.mentions = mentionJids;
        }

        try {
            const sent = await client.sendMessage(jid, content, options);
            state.lastMessages[message.id] = sent.key.id;
            state.lastMessages[sent.key.id] = message.id;
            state.sentMessages.add(sent.key.id);
        } catch (err) {
            state.logger?.error(err);
        }
    });

    client.ev.on('discordEdit', async ({ jid, message }) => {
        if ((state.settings.oneWay >> 1 & 1) === 0) {
            return;
        }

        const key = {
            id: state.lastMessages[message.id],
            fromMe: message.webhookId == null || message.author.username === 'You',
            remoteJid: jid,
        };

        if (jid.endsWith('@g.us')) {
            key.participant = utils.whatsapp.toJid(message.author.username);
        }

        let text = utils.whatsapp.convertDiscordFormatting(message.cleanContent);
        if (message.reference) {
            // Remove Discord's automatic reply mention to avoid tagging
            // every participant on WhatsApp when editing a reply.
            text = text.replace(/^@\S+\s*/, '');
        }
        if (state.settings.DiscordPrefix) {
            const prefix = state.settings.DiscordPrefixText || message.member?.nickname || message.author.username;
            text = `*${prefix}*\n${text}`;
        }
        const editMentions = utils.whatsapp.getMentionedJids(text);
        try {
            const editMsg = await client.sendMessage(
                jid,
                {
                    text,
                    edit: key,
                    ...(editMentions.length ? { mentions: editMentions } : {}),
                }
            );
            state.sentMessages.add(editMsg.key.id);
        } catch (err) {
            state.logger?.error(err);
            await message.channel.send("Couldn't edit the message on WhatsApp.");
        }
    });

    client.ev.on('discordReaction', async ({ jid, reaction, removed }) => {
        if ((state.settings.oneWay >> 1 & 1) === 0) {
            return;
        }

        const key = {
            id: state.lastMessages[reaction.message.id],
            fromMe: reaction.message.webhookId == null || reaction.message.author.username === 'You',
            remoteJid: jid,
        };

        if (jid.endsWith('@g.us')) {
            key.participant = utils.whatsapp.toJid(reaction.message.author.username);
        }

        try {
            const reactionMsg = await client.sendMessage(jid, {
                react: {
                    text: removed ? '' : reaction.emoji.name,
                    key,
                },
            });
            const messageId = reactionMsg.key.id;
            state.lastMessages[messageId] = true;
            state.sentMessages.add(messageId);
            state.sentReactions.add(key.id);
        } catch (err) {
            state.logger?.error(err);
        }
    });

    client.ev.on('discordDelete', async ({ jid, id }) => {
        if ((state.settings.oneWay >> 1 & 1) === 0) {
            return;
        }

        try {
            await client.sendMessage(jid, {
                delete: {
                    remoteJid: jid,
                    id,
                    fromMe: true,
                },
            });
        } catch (err) {
            state.logger?.error(err);
        }
    });

    return client;
};

const actions = {
    async start() {
        const baileyState = await useMultiFileAuthState('./storage/baileys');
        await ensureSignalStoreSupport(baileyState.state?.keys);
        authState = baileyState.state;
        saveState = baileyState.saveCreds;
        state.waClient = await connectToWhatsApp();
    },
};

export { connectToWhatsApp };
export default actions;
