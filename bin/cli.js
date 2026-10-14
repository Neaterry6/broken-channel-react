#!/usr/bin/env node
'use strict';

/**
 * broken-channel-react CLI.
 *
 *   pair    Pair accounts one after another into a folder.
 *   react   Fire a reaction from every paired account.
 *   list    Show what is paired.
 *
 * Pairing 200 accounts by hand is the tedious part, so `pair` walks them in
 * sequence: you scan or enter a code, it saves the session, and moves to the
 * next number. `react` then fans out in waves, so 200 accounts does not mean
 * 200 sockets open at once.
 */

const fs = require('fs');
const path = require('path');

const { ChannelReactor, ReactorPool, parseMessageLink } = require('..');

const USAGE = `
broken-channel-react

  pair    Pair one or more accounts into a folder
  react   React to a channel post from every paired account
  list    Show the accounts in a folder

pair
  --dir <path>        Where sessions are stored         (default ./accounts)
  --count <n>         How many accounts to pair         (default 1)
  --numbers <a,b,c>   Use pairing codes for these numbers instead of a QR
  --start <n>         Start numbering at this index     (default: next free)

react
  --link <url>        Channel MESSAGE link              (required)
  --emoji <e>         Reaction emoji                    (default 🔥)
  --dir <path>        Where sessions are stored         (default ./accounts)
  --limit <n>         Use at most this many accounts
  --concurrency <n>   Accounts sending at once          (default 4)
  --wave <n>          Accounts held open per wave       (default 25)
  --delay <ms>        Gap between sends                 (default 350)

list
  --dir <path>        Where sessions are stored         (default ./accounts)

examples
  npx broken-channel-react pair --dir ./accounts --count 200 --numbers 234801...,234802...
  npx broken-channel-react react --link "https://whatsapp.com/channel/<id>/141" --emoji 🔥
`;

/** Minimal flag parser: --key value, --key=value, --flag. */
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) {
        out[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) {
          out[a.slice(2)] = true;
        } else {
          out[a.slice(2)] = next;
          i += 1;
        }
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

/** Session directories that already hold a creds.json, in numeric order. */
function listPaired(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => fs.existsSync(path.join(dir, name, 'creds.json')))
    .sort((a, b) => {
      const na = parseInt(a.replace(/\D/g, ''), 10) || 0;
      const nb = parseInt(b.replace(/\D/g, ''), 10) || 0;
      return na - nb;
    })
    .map((name) => path.join(dir, name));
}

/** Next free account folder name, e.g. account-001. */
function nextIndex(dir, start) {
  if (start) return Number(start);
  const existing = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  let max = 0;
  for (const name of existing) {
    const n = parseInt(name.replace(/\D/g, ''), 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max + 1;
}

// ---------------------------------------------------------------------- pair

async function cmdPair(args) {
  const dir = path.resolve(args.dir || './accounts');
  const count = Math.max(1, Number(args.count) || 1);
  const numbers = args.numbers
    ? String(args.numbers).split(',').map((s) => s.trim()).filter(Boolean)
    : [];

  fs.mkdirSync(dir, { recursive: true });

  let index = nextIndex(dir, args.start);
  console.log('Pairing ' + count + ' account(s) into ' + dir);
  console.log('');

  let paired = 0;
  let failed = 0;

  for (let i = 0; i < count; i += 1) {
    const name = 'account-' + String(index).padStart(3, '0');
    const authDir = path.join(dir, name);
    const number = numbers[i];

    console.log('--- ' + name + ' (' + (i + 1) + ' of ' + count + ')' +
      (number ? '  number ' + number : '') + ' ---');

    const reactor = new ChannelReactor({
      authDir,
      pairingNumber: number,
      printQR: true,
    });

    try {
      await reactor.connect();
      console.log('paired ' + name + '\n');
      paired += 1;
    } catch (err) {
      console.error('failed ' + name + ': ' + ((err && err.message) || err) + '\n');
      failed += 1;
    } finally {
      await reactor.close().catch(() => {});
      // Leave a moment between accounts so WhatsApp does not see a burst.
      if (i < count - 1) await new Promise((r) => setTimeout(r, 1500));
    }

    index += 1;
  }

  console.log('done: ' + paired + ' paired, ' + failed + ' failed');
  if (failed) console.log('re-run with --start to retry from a specific number');
}

// --------------------------------------------------------------------- react

async function cmdReact(args) {
  const dir = path.resolve(args.dir || './accounts');
  const link = args.link;
  const emoji = args.emoji || '🔥';

  if (!link || link === true) {
    console.error('--link is required. See --help.');
    process.exit(1);
  }

  // Fail fast on a bad link before opening any sockets.
  try {
    const parsed = parseMessageLink(link);
    console.log('Channel ' + parsed.channelId + ', message ' + parsed.serverId);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  const sessions = listPaired(dir);
  if (!sessions.length) {
    console.error('No paired accounts in ' + dir + '. Run `pair` first.');
    process.exit(1);
  }

  const waveSize = Number(args.wave) || 25;
  const limit = Number(args.limit) || 0;
  const use = limit ? sessions.slice(0, limit) : sessions;

  console.log('Reacting with ' + emoji + ' from ' + use.length + ' account(s)');
  console.log('waves of ' + waveSize + ', ' + (Number(args.concurrency) || 4) + ' at a time');
  console.log('');

  const pool = new ReactorPool({
    sessions: use,
    concurrency: Number(args.concurrency) || 4,
    delayMs: args.delay === undefined ? 350 : Number(args.delay),
    batchSize: waveSize,
  });

  const started = Date.now();

  pool.on('wave', (s) => {
    console.log(
      '  wave ' + s.wave + ': ' + s.ok + ' ok, ' + s.failed + ' failed' +
        '  (' + s.sessions + ' accounts)'
    );
  });

  let summary;
  try {
    summary = await pool.reactBatched(link, emoji);
  } finally {
    await pool.close().catch(() => {});
  }

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log('');
  console.log('result: ' + summary.ok + ' of ' + summary.total + ' reacted in ' +
    summary.waves + ' wave(s), ' + seconds + 's');

  const failures = summary.results.filter((r) => !r.ok);
  if (failures.length) {
    const byCode = {};
    for (const f of failures) byCode[f.code] = (byCode[f.code] || 0) + 1;
    console.log('failures: ' + Object.entries(byCode).map(([c, n]) => c + ' x' + n).join(', '));
    console.log('(a 401 usually means that account was logged out — re-pair it)');
  }

  // Non-zero exit when nothing landed, so a script can tell.
  if (summary.ok === 0) process.exit(1);
}

// ---------------------------------------------------------------------- list

function cmdList(args) {
  const dir = path.resolve(args.dir || './accounts');
  const sessions = listPaired(dir);
  if (!sessions.length) {
    console.log('No paired accounts in ' + dir);
    return;
  }
  console.log(sessions.length + ' paired account(s) in ' + dir + ':');
  for (const s of sessions) console.log('  ' + path.basename(s));
}

// ---------------------------------------------------------------------- main

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];

  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    console.log(USAGE.trim());
    return;
  }

  const args = parseArgs(argv.slice(1));

  if (cmd === 'pair') return cmdPair(args);
  if (cmd === 'react') return cmdReact(args);
  if (cmd === 'list') return cmdList(args);

  console.error('Unknown command: ' + cmd);
  console.log(USAGE.trim());
  process.exit(1);
}

main().catch((err) => {
  console.error((err && err.message) || err);
  process.exit(1);
});
