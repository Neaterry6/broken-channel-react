'use strict';

/**
 * ChannelReactor — one paired WhatsApp account, used to react to channel posts.
 *
 * There is no API key here. Instead you pair a WhatsApp account once (scan a QR
 * or use a pairing code) and the session is saved to disk, so later runs
 * reconnect without pairing again.
 *
 * Baileys is loaded lazily through a dynamic import. That keeps it an optional
 * peer dependency: parsing links and running the pool logic works without it,
 * and only `connect()` needs it.
 *
 * What WhatsApp actually allows, stated plainly:
 *   - One account can hold exactly ONE reaction per message. Setting another
 *     replaces the previous one; it does not add a second.
 *   - So N reactions on one post needs N accounts. That is a platform rule, not
 *     a limit of this library. Use ReactorPool for that.
 */

const { EventEmitter } = require('events');
const { parseMessageLink, messageKey } = require('./link');

/** Default module specifier for the WhatsApp client. */
const DEFAULT_BAILEYS = '@whiskeysockets/baileys';

class ChannelReactor extends EventEmitter {
  /**
   * @param {object} [options]
   * @param {string} [options.authDir='./.wa-auth'] Directory the session is saved to.
   * @param {string} [options.baileys] Module to import instead of the default.
   * @param {boolean} [options.printQR=true] Print the pairing QR to stdout.
   * @param {string} [options.pairingNumber] Use a pairing code for this number instead of a QR.
   * @param {boolean} [options.logger=false] Log baileys' internal output.
   * @param {object} [options.socketOptions] Passed through to makeWASocket.
   */
  constructor(options) {
    super();
    const o = options || {};
    this.authDir = o.authDir || './.wa-auth';
    this.baileysSpecifier = o.baileys || DEFAULT_BAILEYS;
    this.printQR = o.printQR !== false;
    this.pairingNumber = o.pairingNumber || null;
    this.enableLogger = Boolean(o.logger);
    this.socketOptions = o.socketOptions || {};

    /** @type {object|null} */
    this.sock = null;
    /** @type {object|null} */
    this.baileys = null;
    this.connected = false;
    this._connectPromise = null;
  }

  /** Load baileys and hand back the module. */
  async _load() {
    if (this.baileys) return this.baileys;
    let mod;
    try {
      mod = await import(this.baileysSpecifier);
    } catch (err) {
      const e = new Error(
        'Could not load "' + this.baileysSpecifier + '". Install it first:\n' +
          '  npm i ' + this.baileysSpecifier + '\n' +
          'Original error: ' + ((err && err.message) || err)
      );
      e.code = 'BAILEYS_MISSING';
      throw e;
    }
    // Dynamic import of a CJS package can land on .default.
    this.baileys = mod && mod.makeWASocket ? mod : (mod && mod.default) || mod;
    if (!this.baileys || typeof this.baileys.makeWASocket !== 'function') {
      const e = new Error(
        '"' + this.baileysSpecifier + '" does not export makeWASocket.'
      );
      e.code = 'BAILEYS_INVALID';
      throw e;
    }
    return this.baileys;
  }

  /**
   * Open the session. Resolves once the socket is ready to send.
   * Pairing (QR or code) happens during this call.
   */
  async connect() {
    if (this.connected && this.sock) return this;
    if (this._connectPromise) return this._connectPromise;

    this._connectPromise = (async () => {
      const b = await this._load();
      const { state, saveCreds } = await b.useMultiFileAuthState(this.authDir);

      let version;
      try {
        const v = await b.fetchLatestBaileysVersion();
        version = v && v.version;
      } catch (e) {
        version = undefined; // fall back to whatever the package defaults to
      }

      const logger = this.enableLogger
        ? undefined
        : { level: 'silent', child: () => ({ level: 'silent', child: () => ({}) , trace(){}, debug(){}, info(){}, warn(){}, error(){}, fatal(){} }) };

      const sock = b.makeWASocket(Object.assign(
        {
          auth: state,
          version,
          printQRInTerminal: false,
          logger,
        },
        this.socketOptions
      ));

      this.sock = sock;

      sock.ev.on('creds.update', saveCreds);

      // Pairing code flow, if a number was given and we are not registered yet.
      if (this.pairingNumber && !sock.authState.creds.registered) {
        try {
          const code = await sock.requestPairingCode(String(this.pairingNumber).replace(/\D/g, ''));
          this.emit('pairing-code', code);
          if (this.printQR) {
            console.log('\nPairing code for ' + this.pairingNumber + ': ' + code);
            console.log('Enter it on your phone: WhatsApp → Linked devices → Link with phone number\n');
          }
        } catch (err) {
          this.emit('error', err);
        }
      }

      await new Promise((resolve, reject) => {
        let settled = false;

        const onUpdate = (update) => {
          if (update.qr) {
            this.emit('qr', update.qr);
            if (this.printQR) printQr(update.qr);
          }
          if (update.connection === 'open') {
            settled = true;
            this.connected = true;
            this.emit('open', { user: sock.user });
            resolve();
          }
          if (update.connection === 'close') {
            const code = update.lastDisconnect && update.lastDisconnect.error &&
              update.lastDisconnect.error.output && update.lastDisconnect.error.output.statusCode;
            this.connected = false;
            this.emit('close', { statusCode: code });
            if (!settled) {
              settled = true;
              const e = new Error(
                'Connection closed before it opened' + (code ? ' (status ' + code + ')' : '') + '.'
              );
              e.code = 'CONNECTION_CLOSED';
              e.statusCode = code;
              reject(e);
            }
          }
        };

        sock.ev.on('connection.update', onUpdate);
      });

      return this;
    })();

    try {
      return await this._connectPromise;
    } finally {
      this._connectPromise = null;
    }
  }

  /**
   * Send a reaction payload. No validation — callers decide whether an empty
   * string is allowed, because an empty string is how a reaction is cleared.
   */
  async _send(link, text) {
    if (!this.sock || !this.connected) {
      const e = new Error('Not connected. Call connect() first.');
      e.code = 'NOT_CONNECTED';
      throw e;
    }

    const target = parseMessageLink(link);
    const key = messageKey(target);
    const response = await this.sock.sendMessage(target.jid, { react: { text, key } });

    return {
      ok: true,
      channelId: target.channelId,
      serverId: target.serverId,
      emoji: text,
      response: response || null,
    };
  }

  /**
   * React to a channel message.
   *
   * @param {string} link  Channel MESSAGE link (must end with the message number).
   * @param {string} emoji The reaction.
   * @returns {Promise<{ok:boolean, channelId:string, serverId:string, emoji:string, response:any}>}
   */
  async react(link, emoji) {
    const text = String(emoji === undefined || emoji === null ? '' : emoji).trim();
    if (!text) {
      const e = new Error('An emoji is required.');
      e.code = 'NO_EMOJI';
      throw e;
    }
    return this._send(link, text);
  }

  /**
   * React with several emoji in turn.
   *
   * Note this is sequential and each one replaces the last for this account —
   * WhatsApp keeps a single reaction per sender per message. It is useful for
   * cycling or for A/B testing, not for stacking.
   */
  async reactMany(link, emoji, options) {
    const list = require('./link').splitEmoji(emoji);
    const o = options || {};
    const delayMs = o.delayMs === undefined ? 600 : o.delayMs;
    const results = [];

    for (let i = 0; i < list.length; i += 1) {
      try {
        results.push(await this.react(link, list[i]));
      } catch (err) {
        results.push({ ok: false, emoji: list[i], error: err.message, code: err.code || 'ERROR' });
      }
      if (delayMs && i < list.length - 1) await sleep(delayMs);
    }
    return results;
  }

  /**
   * Remove this account's reaction from a message.
   *
   * Sends an empty reaction, which is how WhatsApp clears one. This cannot go
   * through react(), because that correctly rejects an empty emoji.
   */
  async unreact(link) {
    return this._send(link, '');
  }

  /** Close the socket. The session on disk is kept, so connect() can resume. */
  async close() {
    if (this.sock) {
      try {
        this.sock.end(undefined);
      } catch (e) {
        /* already gone */
      }
    }
    this.sock = null;
    this.connected = false;
    this.emit('closed');
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Render a QR to the terminal when the helper is available. */
function printQr(qr) {
  try {
    // baileys ships qrcode-terminal in its own tree; try the local one first.
    let terminal;
    try {
      terminal = require('qrcode-terminal');
    } catch (e) {
      terminal = require('@whiskeysockets/baileys/node_modules/qrcode-terminal');
    }
    terminal.generate(qr, { small: true });
    console.log('\nScan the QR above: WhatsApp → Settings → Linked devices → Link a device\n');
  } catch (e) {
    // No renderer: hand the raw payload over so the caller can draw it.
    console.log('\nPairing QR payload (render it yourself, or listen for the "qr" event):\n' + qr + '\n');
  }
}

module.exports = { ChannelReactor, sleep };
