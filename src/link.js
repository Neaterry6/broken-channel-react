'use strict';

/**
 * Channel link parsing.
 *
 * A WhatsApp Channel *message* link looks like:
 *
 *   https://whatsapp.com/channel/0029Vb6EHtR5Ui2gHMW9zX2x/141
 *                                     ^ channel id        ^ message (server) id
 *
 * A channel *profile* link stops at the id and has no message number. Reacting
 * needs the message, so a profile link is rejected with a clear reason rather
 * than being sent and failing somewhere further down.
 */

const CHANNEL_LINK_RE =
  /^https?:\/\/(?:www\.)?(?:whatsapp\.com|wa\.me|api\.whatsapp\.com)\/channel\/([A-Za-z0-9_-]+)(?:\/(\d+))?(?:[/?#].*)?$/i;

/** The channel JID WhatsApp uses for newsletters. */
function channelJid(channelId) {
  return String(channelId) + '@newsletter';
}

/**
 * Parse a channel link.
 * @param {string} link
 * @returns {{url:string, channelId:string, serverId:string|null, jid:string, isMessage:boolean}}
 * @throws {TypeError} when the link is not a WhatsApp Channel link at all
 */
function parseChannelLink(link) {
  const value = String(link === undefined || link === null ? '' : link).trim();
  if (!value) {
    throw new TypeError('A WhatsApp Channel link is required.');
  }

  const m = CHANNEL_LINK_RE.exec(value);
  if (!m) {
    throw new TypeError(
      'Not a WhatsApp Channel link. Expected something like ' +
        'https://whatsapp.com/channel/<channelId>/<messageId>'
    );
  }

  const channelId = m[1];
  const serverId = m[2] || null;

  return {
    url: value,
    channelId,
    serverId,
    jid: channelJid(channelId),
    isMessage: serverId !== null,
  };
}

/**
 * Parse and require a message id.
 * @throws {TypeError} when the link is a channel profile link with no message
 */
function parseMessageLink(link) {
  const parsed = parseChannelLink(link);
  if (!parsed.isMessage) {
    throw new TypeError(
      'That is a channel profile link, which has no message to react to. ' +
        'Use the link of a specific post — it ends with the message number, ' +
        'for example https://whatsapp.com/channel/' + parsed.channelId + '/141'
    );
  }
  return parsed;
}

/**
 * Build the message key a reaction is addressed to.
 * @param {{channelId:string, serverId:string}} parsed
 */
function messageKey(parsed) {
  return {
    remoteJid: channelJid(parsed.channelId),
    fromMe: false,
    id: String(parsed.serverId),
  };
}

/**
 * Split emoji input into an array, grapheme-aware so a variation selector or a
 * skin-tone modifier does not become its own entry.
 * @param {string|string[]} input
 * @returns {string[]}
 */
function splitEmoji(input) {
  if (Array.isArray(input)) {
    return input.map((v) => String(v).trim()).filter(Boolean);
  }
  const raw = String(input === undefined || input === null ? '' : input).trim();
  if (!raw) return [];
  if (raw.includes(',')) {
    return raw.split(',').map((v) => v.trim()).filter(Boolean);
  }
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    return Array.from(seg.segment(raw), (s) => s.segment).filter((v) => v.trim() !== '');
  }
  return Array.from(raw).filter((v) => v.trim() !== '');
}

/**
 * True when a JID points at a channel rather than a chat or group.
 * Implemented locally so the package works before baileys is loaded.
 */
function isChannelJid(jid) {
  return /@newsletter$/i.test(String(jid || ''));
}

module.exports = {
  CHANNEL_LINK_RE,
  channelJid,
  parseChannelLink,
  parseMessageLink,
  messageKey,
  splitEmoji,
  isChannelJid,
};
