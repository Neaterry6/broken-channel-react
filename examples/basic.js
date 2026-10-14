'use strict';

/**
 * Pair once, then react to a channel post.
 *
 *   node examples/basic.js "https://whatsapp.com/channel/<id>/<msgId>" 🔥
 *
 * The first run prints a QR — scan it with WhatsApp → Linked devices. The
 * session is saved, so later runs skip the scan.
 */

const { ChannelReactor } = require('..');

const link = process.argv[2];
const emoji = process.argv[3] || '🔥';

if (!link) {
  console.error('Usage: node examples/basic.js <channel-message-link> [emoji]');
  console.error('Example: node examples/basic.js "https://whatsapp.com/channel/0029Vb6EHtR5Ui2gHMW9zX2x/141" 🔥');
  process.exit(1);
}

async function main() {
  const reactor = new ChannelReactor({ authDir: './.wa-auth' });

  reactor.on('qr', () => {
    // The QR itself is already printed by the library; this is here to show the
    // event exists if you would rather render it somewhere else.
  });

  console.log('Connecting…');
  await reactor.connect();
  console.log('Connected as', reactor.sock && reactor.sock.user && reactor.sock.user.id);

  try {
    const result = await reactor.react(link, emoji);
    console.log('Reacted with', result.emoji, 'to message', result.serverId);
  } catch (err) {
    console.error('Failed:', err.code || '', err.message);
  } finally {
    await reactor.close();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
