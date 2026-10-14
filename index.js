'use strict';

/**
 * broken-channel-react — react to WhatsApp Channel posts, with no API key.
 *
 * Pair your own WhatsApp account once, then react to any channel message link.
 * One account holds one reaction per post; use ReactorPool with several paired
 * accounts when you need more than one.
 */

const link = require('./src/link');
const { ChannelReactor, sleep } = require('./src/reactor');
const { ReactorPool, mapLimit } = require('./src/pool');

module.exports = {
  ChannelReactor,
  ReactorPool,
  sleep,
  mapLimit,
  // link helpers
  parseChannelLink: link.parseChannelLink,
  parseMessageLink: link.parseMessageLink,
  messageKey: link.messageKey,
  channelJid: link.channelJid,
  splitEmoji: link.splitEmoji,
  isChannelJid: link.isChannelJid,
  CHANNEL_LINK_RE: link.CHANNEL_LINK_RE,
};
