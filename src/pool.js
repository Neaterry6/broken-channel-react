'use strict';

/**
 * ReactorPool — many paired accounts, one reaction each.
 *
 * This is the only way to put more than one reaction on a channel post, because
 * WhatsApp stores a single reaction per sender per message. One account cannot
 * add a second; a different account can.
 *
 * So "400 reactions" means 400 linked WhatsApp accounts. There is no shortcut
 * and no API that changes that. What this class does is make the fan-out
 * manageable: it connects a set of sessions, reacts in parallel with a
 * concurrency cap, and reports per-account success or failure instead of
 * throwing on the first bad one.
 */

const { EventEmitter } = require('events');
const { ChannelReactor } = require('./reactor');
const { parseMessageLink, splitEmoji } = require('./link');

class ReactorPool extends EventEmitter {
  /**
   * @param {object} options
   * @param {string[]} options.sessions  One auth directory per account.
   * @param {string} [options.authDirPrefix='./.wa-auth-'] Prefix when generating dirs.
   * @param {number} [options.concurrency=4] Accounts connected/sent at once.
   * @param {number} [options.delayMs=350] Gap between sends per worker.
   * @param {boolean} [options.printQR=false] Pools usually pair one at a time.
   * @param {string} [options.baileys] Module to import instead of the default.
   */
  constructor(options) {
    super();
    const o = options || {};
    const sessions = o.sessions || [];
    if (!Array.isArray(sessions) || sessions.length === 0) {
      const e = new Error(
        'A pool needs at least one session directory. Pass { sessions: ["./auth-1", ...] }.'
      );
      e.code = 'NO_SESSIONS';
      throw e;
    }
    this.sessions = sessions.slice();
    this.concurrency = Math.max(1, Number(o.concurrency) || 4);
    this.delayMs = o.delayMs === undefined ? 350 : o.delayMs;
    this.baileysSpecifier = o.baileys;
    this.printQR = Boolean(o.printQR);
    // How many sessions to hold open at once. A pool of 200 accounts opening
    // 200 websockets at the same time is a memory problem on a small box, so
    // large pools are processed in waves: open a batch, send, close it, next.
    // 0 or null means "keep them all open" (fine for a handful).
    this.batchSize = Number(o.batchSize) > 0 ? Number(o.batchSize) : 0;
    /** Sessions paired and usable, once discovered. */
    this._discovered = null;

    /** @type {ChannelReactor[]} */
    this.reactors = [];
  }

  /** How many accounts are ready to send. */
  get size() {
    return this.reactors.length;
  }

  /** How many are currently connected. */
  get online() {
    return this.reactors.filter((r) => r.connected).length;
  }

  /** Build a reactor for one session directory, wired to this pool's events. */
  _makeReactor(authDir) {
    const r = new ChannelReactor({
      authDir,
      baileys: this.baileysSpecifier,
      printQR: this.printQR,
    });
    r.on('qr', (qr) => this.emit('qr', { session: authDir, qr }));
    r.on('pairing-code', (code) => this.emit('pairing-code', { session: authDir, code }));
    r.on('open', (info) => this.emit('open', { session: authDir, ...(info || {}) }));
    r.on('error', (err) => this.emit('error', { session: authDir, error: err }));
    return r;
  }

  /**
   * Connect every session, up to `concurrency` at a time.
   *
   * When `batchSize` is set this connects only the first batch and leaves the
   * rest for later waves — see reactBatched().
   *
   * @returns {Promise<{connected:number, failed:Array<{session:string,error:string}>}>}
   */
  async connect() {
    const dirs = this.batchSize ? this.sessions.slice(0, this.batchSize) : this.sessions;
    this.reactors = dirs.map((d) => this._makeReactor(d));

    const failed = [];
    let connected = 0;

    await mapLimit(this.reactors, this.concurrency, async (r) => {
      try {
        await r.connect();
        connected += 1;
      } catch (err) {
        failed.push({ session: r.authDir, error: (err && err.message) || String(err) });
        this.emit('session-failed', { session: r.authDir, error: err });
      }
    });

    return { connected, failed };
  }

  /**
   * React to a channel post with one account each.
   *
   * @param {string} link  Channel MESSAGE link.
   * @param {string} emoji Reaction emoji.
   * @param {object} [options]
   * @param {number} [options.limit] Use only the first N accounts.
   * @param {number} [options.delayMs] Override the per-send gap.
   * @returns {Promise<{ok:number, failed:number, total:number, results:Array}>}
   */
  async react(link, emoji, options) {
    const o = options || {};
    // Validate the link once, up front, so a bad link does not cost N failures.
    const target = parseMessageLink(link);

    const text = String(emoji === undefined || emoji === null ? '' : emoji).trim();
    if (!text) {
      const e = new Error('An emoji is required.');
      e.code = 'NO_EMOJI';
      throw e;
    }

    const pool = o.limit ? this.reactors.slice(0, o.limit) : this.reactors;
    const delayMs = o.delayMs === undefined ? this.delayMs : o.delayMs;
    const results = [];

    await mapLimit(pool, this.concurrency, async (r, index) => {
      const session = r.authDir;
      if (!r.connected) {
        results.push({ session, ok: false, error: 'Not connected.', code: 'NOT_CONNECTED' });
        return;
      }
      try {
        const out = await r.react(target.url, text);
        results.push({ session, ok: true, emoji: out.emoji, serverId: out.serverId });
        this.emit('reacted', { session, emoji: text, serverId: out.serverId });
      } catch (err) {
        results.push({
          session,
          ok: false,
          error: (err && err.message) || String(err),
          code: (err && err.code) || 'ERROR',
        });
        this.emit('react-failed', { session, error: err });
      }
      if (delayMs && index < pool.length - 1) await sleep(delayMs);
    });

    const ok = results.filter((r) => r.ok).length;
    return { ok, failed: results.length - ok, total: results.length, results };
  }

  /**
   * React across an arbitrarily large set of accounts, in waves.
   *
   * This is the entry point for real fan-out: 200 sessions does not mean 200
   * open sockets. Each wave is connected, sends, and is closed before the next
   * begins, so peak memory stays flat regardless of how many accounts there are.
   *
   * @param {string} link
   * @param {string} emoji
   * @param {object} [options]
   * @param {number} [options.limit]  Cap the number of accounts used.
   * @param {number} [options.waveSize] Override `batchSize` for this call.
   * @param {function} [options.onWave] Called after each wave with a summary.
   * @returns {Promise<{ok:number, failed:number, total:number, waves:number, results:Array}>}
   */
  async reactBatched(link, emoji, options) {
    const o = options || {};
    // Validate once up front so a bad link costs zero connections.
    const target = parseMessageLink(link);
    const text = String(emoji === undefined || emoji === null ? '' : emoji).trim();
    if (!text) {
      const e = new Error('An emoji is required.');
      e.code = 'NO_EMOJI';
      throw e;
    }

    const all = o.limit ? this.sessions.slice(0, o.limit) : this.sessions.slice();
    const waveSize = Number(o.waveSize) > 0 ? Number(o.waveSize) : (this.batchSize || all.length);

    const results = [];
    let waves = 0;

    for (let start = 0; start < all.length; start += waveSize) {
      const wave = all.slice(start, start + waveSize);
      waves += 1;

      const reactors = wave.map((d) => this._makeReactor(d));
      const failedToConnect = [];

      await mapLimit(reactors, this.concurrency, async (r) => {
        try {
          await r.connect();
        } catch (err) {
          failedToConnect.push(r.authDir);
          results.push({
            session: r.authDir,
            ok: false,
            error: (err && err.message) || String(err),
            code: (err && err.code) || 'CONNECT_FAILED',
          });
          this.emit('session-failed', { session: r.authDir, error: err });
        }
      });

      const live = reactors.filter((r) => r.connected);
      await mapLimit(live, this.concurrency, async (r) => {
        try {
          const out = await r.react(target.url, text);
          results.push({ session: r.authDir, ok: true, emoji: out.emoji, serverId: out.serverId });
          this.emit('reacted', { session: r.authDir, emoji: text, serverId: out.serverId });
        } catch (err) {
          results.push({
            session: r.authDir,
            ok: false,
            error: (err && err.message) || String(err),
            code: (err && err.code) || 'ERROR',
          });
          this.emit('react-failed', { session: r.authDir, error: err });
        }
      });

      // Close the wave before opening the next one.
      await Promise.all(reactors.map((r) => r.close().catch(() => {})));

      const summary = {
        wave: waves,
        sessions: wave.length,
        ok: results.filter((r) => r.ok).length,
        failed: results.filter((r) => !r.ok).length,
      };
      this.emit('wave', summary);
      if (typeof o.onWave === 'function') o.onWave(summary);

      if (this.delayMs && start + waveSize < all.length) await sleep(this.delayMs);
    }

    const ok = results.filter((r) => r.ok).length;
    return { ok, failed: results.length - ok, total: results.length, waves, results };
  }

  /**
   * Rotate the reaction on a post, one emoji at a time, across the whole pool.
   * Every account ends on the last emoji.
   */
  async reactMany(link, emoji, options) {
    const list = splitEmoji(emoji);
    const summary = [];
    for (const e of list) {
      summary.push({ emoji: e, ...(await this.react(link, e, options)) });
    }
    return summary;
  }

  /** Close every session. Sessions on disk are kept. */
  async close() {
    await Promise.all(this.reactors.map((r) => r.close().catch(() => {})));
    this.reactors = [];
    this.emit('closed');
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Run an async fn over items with a concurrency cap, preserving no order.
 * Small and local on purpose — no dependency for this.
 */
async function mapLimit(items, limit, fn) {
  const list = items.slice();
  let cursor = 0;
  const workers = new Array(Math.min(limit, list.length)).fill(0).map(async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= list.length) return;
      await fn(list[index], index);
    }
  });
  await Promise.all(workers);
}

module.exports = { ReactorPool, mapLimit };
