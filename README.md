# broken-channel-react

React to **WhatsApp Channel** posts with emoji. **No API key** — you pair your own WhatsApp account instead.

Dual ESM + CJS. TypeScript types. Baileys is an optional peer dependency.

```bash
npm i broken-channel-react @whiskeysockets/baileys
```

## Read this first

Two facts about WhatsApp decide how you use this. Neither is a limitation of the library.

1. **One account holds one reaction per message.** Setting another replaces the first. There is no way to stack two reactions from the same number — that is how WhatsApp stores reactions.
2. **So N reactions on a post needs N accounts.** If you want 20 reactions, you pair 20 numbers and use `ReactorPool`. There is no shortcut, and no third-party API can do it either.

If someone offers you "400 reactions to any channel post" from one key, they are either cycling one account (so only the last emoji stays) or they are lying.

## Quick start

### 1. Pair once

```js
const { ChannelReactor } = require('broken-channel-react');

const reactor = new ChannelReactor({ authDir: './.wa-auth' });
await reactor.connect();          // prints a QR — scan it once
```

The session is written to `authDir`, so every later run reconnects without scanning again.

Prefer a pairing code over a QR?

```js
const reactor = new ChannelReactor({
  authDir: './.wa-auth',
  pairingNumber: '2348120478393',
});
await reactor.connect();          // prints an 8-character code
```

Enter it on the phone: **WhatsApp → Linked devices → Link with phone number**.

### 2. React

```js
const result = await reactor.react(
  'https://whatsapp.com/channel/0029Vb6EHtR5Ui2gHMW9zX2x/141',
  '🔥'
);

console.log(result.ok);        // true
console.log(result.serverId);  // '141'
```

### 3. Close

```js
await reactor.close();         // session stays on disk
```

## 200+ reactions

This is the whole reason the pool exists. Two commands.

### 1. Pair the accounts

```bash
npx broken-channel-react pair --dir ./accounts --count 200
```

It walks them one at a time: you scan the QR (or pass `--numbers` and use a code), it saves the session, and moves to the next. Re-run with `--start` to resume if a few fail.

Pairing with codes instead of a QR is faster for a batch:

```bash
npx broken-channel-react pair --dir ./accounts --count 200 \
  --numbers 2348010000001,2348010000002,2348010000003
```

### 2. Fire the reaction

```bash
npx broken-channel-react react \
  --link "https://whatsapp.com/channel/0029Vb6EHtR5Ui2gHMW9zX2x/141" \
  --emoji 🔥
```

```
Channel 0029Vb6EHtR5Ui2gHMW9zX2x, message 141
Reacting with 🔥 from 200 account(s)
waves of 25, 4 at a time

  wave 1: 25 ok, 0 failed  (25 accounts)
  wave 2: 50 ok, 0 failed  (25 accounts)
  ...
  wave 8: 200 ok, 0 failed  (25 accounts)

result: 200 of 200 reacted in 8 wave(s), 96.4s
```

Check what is paired at any time:

```bash
npx broken-channel-react list --dir ./accounts
```

### Why waves matter

200 accounts does **not** mean 200 open websockets. `reactBatched()` opens a wave, sends, closes the wave, then starts the next — so peak memory stays flat whether you have 20 accounts or 2,000.

```js
const { ReactorPool } = require('broken-channel-react');

const pool = new ReactorPool({
  sessions: listPaired('./accounts'),   // 200 directories
  concurrency: 10,                      // 10 sending at once
  batchSize: 25,                        // 25 sockets open per wave
  delayMs: 350,
});

const out = await pool.reactBatched(link, '🔥', {
  onWave: (s) => console.log('wave ' + s.wave + ': ' + s.ok + ' ok'),
});

console.log(out.ok + ' of ' + out.total + ' reacted in ' + out.waves + ' waves');
```

### Fan-out behaviour

- `concurrency` caps how many accounts send at once (default 4).
- `batchSize` / `--wave` caps how many sockets are open at once (default 25 in the CLI).
- One account failing does **not** stop the others. Each result is reported separately with a `code`.
- The link is validated **once, up front**, so a bad link costs you zero connections.
- A `401` on an account means it was logged out — re-pair just that one with `--start`.

```js
const out = await pool.reactBatched(link, '🔥', { limit: 50 });

const failed = out.results.filter(r => !r.ok);
if (failed.length) {
  console.log(failed.map(r => r.session + ': ' + r.code));
}
```

## API

### `new ChannelReactor(options)`

| Option | Default | Notes |
|---|---|---|
| `authDir` | `'./.wa-auth'` | Where the paired session is stored. |
| `baileys` | `'@whiskeysockets/baileys'` | Module to import. Useful for pinning a version. |
| `printQR` | `true` | Print the QR / pairing code to stdout. |
| `pairingNumber` | `null` | Use a pairing code for this number instead of a QR. |
| `logger` | `false` | Show baileys' internal logging. |
| `socketOptions` | `{}` | Passed through to `makeWASocket`. |

**Methods**

| Method | Returns |
|---|---|
| `connect()` | `this`. Idempotent. |
| `react(link, emoji)` | `{ ok, channelId, serverId, emoji, response }` |
| `reactMany(link, emoji[], { delayMs })` | Array, one entry per emoji. Failures are recorded, not thrown. |
| `unreact(link)` | Clears this account's reaction. |
| `close()` | Ends the socket; keeps the session on disk. |

**Events** — `qr`, `pairing-code`, `open`, `close`, `error`, `closed`

```js
reactor.on('qr', qr => { /* render it yourself */ });
reactor.on('open', ({ user }) => console.log('paired as', user.id));
```

### `new ReactorPool(options)`

| Option | Default | Notes |
|---|---|---|
| `sessions` | — | **Required.** One auth directory per account. |
| `concurrency` | `4` | Accounts sending at once. |
| `delayMs` | `350` | Gap between sends per worker. |
| `printQR` | `false` | |
| `baileys` | default | |

`pool.connect()` resolves to `{ connected, failed }`. `pool.react()` resolves to `{ ok, failed, total, results }`. `pool.reactMany()` rotates the whole pool through each emoji in turn.

### Link helpers

```js
const { parseChannelLink, parseMessageLink, splitEmoji } = require('broken-channel-react');

parseChannelLink('https://whatsapp.com/channel/abc/141');
// { channelId: 'abc', serverId: '141', jid: 'abc@newsletter', isMessage: true }

parseMessageLink('https://whatsapp.com/channel/abc');   // throws: profile link
splitEmoji('❤️');    // ['❤️']  — grapheme-aware, not 2 code points
```

## Errors

Thrown errors carry a `code`:

| Code | Meaning |
|---|---|
| `NO_EMOJI` | Empty emoji passed to `react()`. |
| `NOT_CONNECTED` | `react()` before a successful `connect()`. |
| `BAILEYS_MISSING` | Baileys is not installed. The message names the install command. |
| `BAILEYS_INVALID` | The module resolved but does not export `makeWASocket`. |
| `CONNECTION_CLOSED` | The socket closed before it opened. `statusCode` says why (401 = logged out). |
| `NO_SESSIONS` | `ReactorPool` built without sessions. |
| `TypeError` | The link is not a channel link, or is a profile link with no message. |

In a pool, per-account problems come back in `results` instead of throwing.

## Notes

- **The message link must end with the message number.** A channel *profile* link has nothing to react to; that is rejected before any request.
- **Baileys is a peer dependency**, not bundled, so this package stays tiny for anyone who only wants the link helpers. It is loaded with a dynamic `import()` on the first `connect()`.
- **Baileys 6.7.x works on Node 18.** Baileys 7 requires Node 20 or newer — if you install 7 on 18, its own postinstall will refuse.
- **Pairing links a real WhatsApp account.** Treat `authDir` like a password=[REDACTED] can send as that account. Do not commit it.
- Sending reactions to channels you do not own is your call and your risk. Use it on your own channels.
- WhatsApp can change its protocol at any time; that is what baileys absorbs, and why the version is a peer dependency you control.

## Tests

```bash
npm test        # 33 offline tests, no network, no account
```

Baileys is replaced by a stub that records every send, so the suite asserts on the exact payload and on pool behaviour (concurrency cap, per-account failure, one send per account) without touching WhatsApp.

## License

MIT
