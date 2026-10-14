'use strict';

/**
 * Offline tests. Baileys is replaced by test/fake-baileys.mjs, so these run with
 * no WhatsApp connection, no network and no real account.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const {
  ChannelReactor,
  ReactorPool,
  parseChannelLink,
  parseMessageLink,
  messageKey,
  channelJid,
  splitEmoji,
  isChannelJid,
} = require('../index.js');

const FAKE = pathToFileURL(path.join(__dirname, 'fake-baileys.mjs')).href;

const LINK = 'https://whatsapp.com/channel/0029Vb6EHtR5Ui2gHMW9zX2x/141';
const PROFILE = 'https://whatsapp.com/channel/0029Vb6EHtR5Ui2gHMW9zX2x';

/** Fresh handle on the fake module's recorded state. */
async function fake() {
  const m = await import(FAKE);
  m.sent.length = 0;
  m.sockets.length = 0;
  m.control.failNextOpen = false;
  m.control.openDelayMs = 0;
  m.control.sendError = null;
  m.control.onSend = null;
  return m;
}

// ------------------------------------------------------------- link parsing

test('parseChannelLink splits the channel id and message number', () => {
  const p = parseChannelLink(LINK);
  assert.equal(p.channelId, '0029Vb6EHtR5Ui2gHMW9zX2x');
  assert.equal(p.serverId, '141');
  assert.equal(p.jid, '0029Vb6EHtR5Ui2gHMW9zX2x@newsletter');
  assert.equal(p.isMessage, true);
});

test('parseChannelLink accepts www, http, wa.me and a trailing slash', () => {
  assert.equal(parseChannelLink('http://www.whatsapp.com/channel/abc/7').serverId, '7');
  assert.equal(parseChannelLink(LINK + '/').serverId, '141');
  assert.equal(parseChannelLink('https://wa.me/channel/abc/9').serverId, '9');
});

test('parseChannelLink marks a profile link as having no message', () => {
  const p = parseChannelLink(PROFILE);
  assert.equal(p.isMessage, false);
  assert.equal(p.serverId, null);
});

test('parseChannelLink rejects non-channel and empty input', () => {
  for (const bad of ['', '   ', 'https://example.com/channel/a/1', 'not a link']) {
    assert.throws(() => parseChannelLink(bad), TypeError);
  }
});

test('parseMessageLink rejects a profile link with a helpful message', () => {
  assert.throws(() => parseMessageLink(PROFILE), (e) => {
    assert.ok(e instanceof TypeError);
    assert.match(e.message, /profile link/);
    assert.match(e.message, /141/); // shows the correct shape
    return true;
  });
});

test('messageKey addresses the channel, not a chat', () => {
  const key = messageKey({ channelId: 'abc', serverId: '5' });
  assert.deepEqual(key, { remoteJid: 'abc@newsletter', fromMe: false, id: '5' });
});

test('channelJid and isChannelJid agree', () => {
  assert.equal(channelJid('x'), 'x@newsletter');
  assert.equal(isChannelJid(channelJid('x')), true);
  assert.equal(isChannelJid('123@s.whatsapp.net'), false);
  assert.equal(isChannelJid('123@g.us'), false);
  assert.equal(isChannelJid(''), false);
});

// ---------------------------------------------------------------- emoji

test('splitEmoji handles arrays, commas, spaces and empty input', () => {
  assert.deepEqual(splitEmoji(['🔥', '❤️']), ['🔥', '❤️']);
  assert.deepEqual(splitEmoji('🔥,❤️'), ['🔥', '❤️']);
  assert.deepEqual(splitEmoji('🔥 ❤️'), ['🔥', '❤️']);
  assert.deepEqual(splitEmoji(''), []);
  assert.deepEqual(splitEmoji(undefined), []);
});

test('splitEmoji is grapheme-aware', () => {
  assert.equal(splitEmoji('❤️').length, 1, 'variation selector must not split');
  assert.equal(splitEmoji('👍🏽').length, 1, 'skin tone must not split');
});

// ------------------------------------------------------------ ChannelReactor

test('connect() opens and reports the paired user', async () => {
  const f = await fake();
  const r = new ChannelReactor({ authDir: './x', baileys: FAKE, printQR: false });
  await r.connect();
  assert.equal(r.connected, true);
  assert.equal(f.sockets.length, 1);
  await r.close();
});

test('react() sends a reaction to the channel JID with the right key', async () => {
  const f = await fake();
  const r = new ChannelReactor({ authDir: './x', baileys: FAKE, printQR: false });
  await r.connect();

  const out = await r.react(LINK, '🔥');

  assert.equal(out.ok, true);
  assert.equal(out.channelId, '0029Vb6EHtR5Ui2gHMW9zX2x');
  assert.equal(out.serverId, '141');
  assert.equal(f.sent.length, 1);

  const call = f.sent[0];
  assert.equal(call.jid, '0029Vb6EHtR5Ui2gHMW9zX2x@newsletter');
  assert.equal(call.content.react.text, '🔥');
  assert.deepEqual(call.content.react.key, {
    remoteJid: '0029Vb6EHtR5Ui2gHMW9zX2x@newsletter',
    fromMe: false,
    id: '141',
  });

  await r.close();
});

test('react() refuses a profile link without sending anything', async () => {
  const f = await fake();
  const r = new ChannelReactor({ authDir: './x', baileys: FAKE, printQR: false });
  await r.connect();

  await assert.rejects(r.react(PROFILE, '🔥'), (e) => {
    assert.ok(e instanceof TypeError);
    assert.match(e.message, /profile link/);
    return true;
  });
  assert.equal(f.sent.length, 0, 'nothing should have been sent');

  await r.close();
});

test('react() requires a non-empty emoji', async () => {
  const f = await fake();
  const r = new ChannelReactor({ authDir: './x', baileys: FAKE, printQR: false });
  await r.connect();

  await assert.rejects(r.react(LINK, '  '), (e) => e.code === 'NO_EMOJI');
  assert.equal(f.sent.length, 0);

  await r.close();
});

test('react() before connect() fails with NOT_CONNECTED', async () => {
  await fake();
  const r = new ChannelReactor({ authDir: './x', baileys: FAKE, printQR: false });
  await assert.rejects(r.react(LINK, '🔥'), (e) => e.code === 'NOT_CONNECTED');
});

test('unreact() sends an empty reaction, which clears it', async () => {
  const f = await fake();
  const r = new ChannelReactor({ authDir: './x', baileys: FAKE, printQR: false });
  await r.connect();

  await r.unreact(LINK);
  assert.equal(f.sent[0].content.react.text, '');

  await r.close();
});

test('reactMany() sends each emoji in order', async () => {
  const f = await fake();
  const r = new ChannelReactor({ authDir: './x', baileys: FAKE, printQR: false });
  await r.connect();

  const out = await r.reactMany(LINK, ['🔥', '❤️'], { delayMs: 0 });

  assert.equal(out.length, 2);
  assert.deepEqual(f.sent.map((s) => s.content.react.text), ['🔥', '❤️']);

  await r.close();
});

test('reactMany() records a per-emoji failure instead of throwing', async () => {
  const f = await fake();
  const r = new ChannelReactor({ authDir: './x', baileys: FAKE, printQR: false });
  await r.connect();

  f.control.sendError = new Error('rate limited');
  const out = await r.reactMany(LINK, ['🔥'], { delayMs: 0 });

  assert.equal(out[0].ok, false);
  assert.match(out[0].error, /rate limited/);

  f.control.sendError = null;
  await r.close();
});

test('a session that closes before opening rejects with the status code', async () => {
  const f = await fake();
  f.control.failNextOpen = true;

  const r = new ChannelReactor({ authDir: './x', baileys: FAKE, printQR: false });
  await assert.rejects(r.connect(), (e) => {
    assert.equal(e.code, 'CONNECTION_CLOSED');
    assert.equal(e.statusCode, 401);
    return true;
  });
});

test('a missing baileys install gives an actionable error', async () => {
  const r = new ChannelReactor({
    authDir: './x',
    baileys: 'this-package-does-not-exist-anywhere',
    printQR: false,
  });
  await assert.rejects(r.connect(), (e) => {
    assert.equal(e.code, 'BAILEYS_MISSING');
    assert.match(e.message, /npm i/);
    return true;
  });
});

test('connect() is idempotent', async () => {
  const f = await fake();
  const r = new ChannelReactor({ authDir: './x', baileys: FAKE, printQR: false });
  await r.connect();
  await r.connect();
  assert.equal(f.sockets.length, 1, 'should not open a second socket');
  await r.close();
});

test('close() ends the socket and allows reconnecting', async () => {
  const f = await fake();
  const r = new ChannelReactor({ authDir: './x', baileys: FAKE, printQR: false });
  await r.connect();
  await r.close();

  assert.equal(r.connected, false);
  assert.equal(f.sockets[0].ended, true);
});

// ---------------------------------------------------------------- ReactorPool

test('a pool requires at least one session', () => {
  assert.throws(() => new ReactorPool({ sessions: [] }), (e) => e.code === 'NO_SESSIONS');
  assert.throws(() => new ReactorPool({}), (e) => e.code === 'NO_SESSIONS');
});

test('pool connects every session and reports the count', async () => {
  const f = await fake();
  const pool = new ReactorPool({
    sessions: ['./a', './b', './c'],
    baileys: FAKE,
    concurrency: 2,
  });

  const out = await pool.connect();
  assert.equal(out.connected, 3);
  assert.equal(out.failed.length, 0);
  assert.equal(f.sockets.length, 3);
  assert.equal(pool.online, 3);

  await pool.close();
});

test('pool react() puts exactly one reaction per account', async () => {
  const f = await fake();
  const pool = new ReactorPool({
    sessions: ['./a', './b', './c'],
    baileys: FAKE,
    concurrency: 3,
    delayMs: 0,
  });
  await pool.connect();

  const out = await pool.react(LINK, '🔥');

  assert.equal(out.total, 3);
  assert.equal(out.ok, 3);
  assert.equal(out.failed, 0);
  assert.equal(f.sent.length, 3, 'one send per account, not one per emoji');
  for (const s of f.sent) {
    assert.equal(s.content.react.text, '🔥');
    assert.equal(s.jid, '0029Vb6EHtR5Ui2gHMW9zX2x@newsletter');
  }

  await pool.close();
});

test('pool honours the concurrency cap', async () => {
  const f = await fake();
  // Measure true overlap: the fake stays in flight, and we count starts and
  // ends around that window rather than sampling on a timer.
  f.control.sendDelayMs = 8;
  let inFlight = 0;
  let peak = 0;
  f.control.onSend = (phase) => {
    if (phase === 'start') {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
    } else {
      inFlight -= 1;
    }
  };

  const pool = new ReactorPool({
    sessions: ['./a', './b', './c', './d', './e', './f'],
    baileys: FAKE,
    concurrency: 2,
    delayMs: 0,
  });
  await pool.connect();
  const out = await pool.react(LINK, '🔥');

  assert.equal(out.ok, 6, 'all six should have reacted');
  assert.ok(peak <= 2, 'peak in-flight was ' + peak + ', expected <= 2');
  assert.ok(peak >= 2, 'expected the cap to actually be used, peak was ' + peak);

  f.control.onSend = null;
  f.control.sendDelayMs = 0;
  await pool.close();
});

test('pool validates the link once and sends nothing when it is wrong', async () => {
  const f = await fake();
  const pool = new ReactorPool({
    sessions: ['./a', './b'],
    baileys: FAKE,
    concurrency: 2,
    delayMs: 0,
  });
  await pool.connect();

  await assert.rejects(pool.react(PROFILE, '🔥'), (e) => {
    assert.match(e.message, /profile link/);
    return true;
  });
  assert.equal(f.sent.length, 0);

  await pool.close();
});

test('pool reports per-account failures without throwing', async () => {
  const f = await fake();
  const pool = new ReactorPool({
    sessions: ['./a', './b'],
    baileys: FAKE,
    concurrency: 2,
    delayMs: 0,
  });
  await pool.connect();

  // Knock one account offline by hand.
  pool.reactors[0].connected = false;

  const out = await pool.react(LINK, '🔥');
  assert.equal(out.total, 2);
  assert.equal(out.ok, 1);
  assert.equal(out.failed, 1);
  const bad = out.results.find((r) => !r.ok);
  assert.equal(bad.code, 'NOT_CONNECTED');

  await pool.close();
});

test('pool limit uses only the first N accounts', async () => {
  const f = await fake();
  const pool = new ReactorPool({
    sessions: ['./a', './b', './c', './d'],
    baileys: FAKE,
    concurrency: 2,
    delayMs: 0,
  });
  await pool.connect();

  const out = await pool.react(LINK, '🔥', { limit: 2 });
  assert.equal(out.total, 2);
  assert.equal(f.sent.length, 2);

  await pool.close();
});

test('pool surfaces a session that fails to connect', async () => {
  const f = await fake();
  f.control.failNextOpen = true;

  const pool = new ReactorPool({
    sessions: ['./bad', './good'],
    baileys: FAKE,
    concurrency: 1,
    delayMs: 0,
  });

  const out = await pool.connect();
  assert.equal(out.connected, 1);
  assert.equal(out.failed.length, 1);
  assert.equal(out.failed[0].session, './bad');

  await pool.close();
});

test('pool reactMany rotates the whole pool through each emoji', async () => {
  const f = await fake();
  const pool = new ReactorPool({
    sessions: ['./a', './b'],
    baileys: FAKE,
    concurrency: 2,
    delayMs: 0,
  });
  await pool.connect();

  const out = await pool.reactMany(LINK, ['🔥', '❤️']);
  assert.equal(out.length, 2);
  assert.equal(f.sent.length, 4, 'two accounts x two emoji');

  await pool.close();
});

// -------------------------------------------------------------------- surface

test('the public surface is complete', () => {
  const mod = require('../index.js');
  for (const key of [
    'ChannelReactor', 'ReactorPool', 'parseChannelLink', 'parseMessageLink',
    'messageKey', 'channelJid', 'splitEmoji', 'isChannelJid', 'CHANNEL_LINK_RE',
    'sleep', 'mapLimit',
  ]) {
    assert.ok(key in mod, 'missing export: ' + key);
  }
});

test('the ESM build exposes the same names', async () => {
  const esm = await import('../index.mjs');
  assert.equal(typeof esm.ChannelReactor, 'function');
  assert.equal(typeof esm.ReactorPool, 'function');
  assert.equal(typeof esm.parseMessageLink, 'function');
  assert.equal(esm.splitEmoji('❤️').length, 1);
  assert.equal(typeof esm.default.ChannelReactor, 'function');
});

test('mapLimit runs everything and never exceeds the cap', async () => {
  const { mapLimit } = require('../index.js');
  const seen = [];
  let inFlight = 0;
  let peak = 0;

  await mapLimit([1, 2, 3, 4, 5], 2, async (n) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 3));
    seen.push(n);
    inFlight -= 1;
  });

  assert.equal(seen.length, 5);
  assert.ok(peak <= 2, 'peak was ' + peak);
});
