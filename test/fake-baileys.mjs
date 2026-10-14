/**
 * A stand-in for @whiskeysockets/baileys, used by the offline tests.
 *
 * It implements only the surface the library touches, and records every
 * sendMessage so a test can assert on the exact payload. Exported as ESM so the
 * dynamic import in ChannelReactor resolves named exports, matching the real
 * package's shape.
 */

import { EventEmitter } from 'events';

/** Every sendMessage call, across every socket. */
export const sent = [];

/** Sockets created, for inspection. */
export const sockets = [];

/** Set to make the next makeWASocket emit a failure instead of opening. */
export const control = {
  failNextOpen: false,
  /** Milliseconds before 'open' fires. */
  openDelayMs: 0,
  /** Set to make sendMessage reject. */
  sendError: null,
  /** Called before each send, so a test can measure concurrency. */
  onSend: null,
  /** Milliseconds sendMessage stays in flight, for measuring true overlap. */
  sendDelayMs: 0,
};

export async function useMultiFileAuthState(dir) {
  const state = {
    creds: { registered: true, me: { id: 'test@s.whatsapp.net' } },
    keys: {},
    _dir: dir,
  };
  return { state, saveCreds: async () => {} };
}

export async function fetchLatestBaileysVersion() {
  return { version: [2, 3000, 0], isLatest: true };
}

export const Browsers = { ubuntu: () => ['Ubuntu', 'Chrome', '1.0'] };

export function makeWASocket(options) {
  const ev = new EventEmitter();

  const sock = {
    ev,
    authState: options.auth || { creds: { registered: true } },
    user: { id: 'test@s.whatsapp.net', name: 'Test' },
    options,
    ended: false,

    async sendMessage(jid, content) {
      // Stay in flight for a moment so a caller can measure real overlap rather
      // than how many sends happened inside a timing window.
      if (control.onSend) control.onSend('start');
      try {
        if (control.sendDelayMs) {
          await new Promise((r) => setTimeout(r, control.sendDelayMs));
        }
        if (control.sendError) throw control.sendError;
        sent.push({ jid, content, dir: options.auth && options.auth._dir });
        return { key: { id: 'sent-1', remoteJid: jid } };
      } finally {
        if (control.onSend) control.onSend('end');
      }
    },

    async requestPairingCode(number) {
      sock.pairingNumber = number;
      return 'ABCD-1234';
    },

    end() {
      sock.ended = true;
      ev.emit('connection.update', { connection: 'close' });
    },
  };

  sockets.push(sock);

  // Open (or fail) on the next tick, after the caller has attached listeners.
  setTimeout(() => {
    if (control.failNextOpen) {
      control.failNextOpen = false;
      ev.emit('connection.update', {
        connection: 'close',
        lastDisconnect: { error: { output: { statusCode: 401 } } },
      });
      return;
    }
    ev.emit('connection.update', { connection: 'open' });
  }, control.openDelayMs);

  return sock;
}

export default { makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, Browsers };
