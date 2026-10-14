import { EventEmitter } from 'events';

export interface ParsedChannelLink {
  url: string;
  channelId: string;
  /** The message number, or null for a channel profile link. */
  serverId: string | null;
  /** `<channelId>@newsletter` */
  jid: string;
  isMessage: boolean;
}

export interface MessageKey {
  remoteJid: string;
  fromMe: boolean;
  id: string;
}

export interface ReactResult {
  ok: boolean;
  channelId: string;
  serverId: string;
  emoji: string;
  response: unknown;
}

export interface PoolReactResult {
  session: string;
  ok: boolean;
  emoji?: string;
  serverId?: string;
  error?: string;
  code?: string;
}

export interface PoolSummary {
  ok: number;
  failed: number;
  total: number;
  results: PoolReactResult[];
}

export interface ReactorOptions {
  /** Where the paired session is saved. Default './.wa-auth'. */
  authDir?: string;
  /** Module to import instead of '@whiskeysockets/baileys'. */
  baileys?: string;
  /** Print the pairing QR. Default true. */
  printQR?: boolean;
  /** Use a pairing code for this phone number instead of a QR. */
  pairingNumber?: string;
  /** Show baileys' internal logging. Default false. */
  logger?: boolean;
  /** Passed straight through to makeWASocket. */
  socketOptions?: Record<string, unknown>;
}

export interface PoolOptions {
  /** One auth directory per account. Required. */
  sessions: string[];
  /** Accounts connected and sent to at once. Default 4. */
  concurrency?: number;
  /** Gap between sends per worker, ms. Default 350. */
  delayMs?: number;
  /** Print QRs. Default false — pair a pool one account at a time. */
  printQR?: boolean;
  baileys?: string;
}

export declare class ChannelReactor extends EventEmitter {
  constructor(options?: ReactorOptions);
  authDir: string;
  connected: boolean;
  connect(): Promise<this>;
  react(link: string, emoji: string): Promise<ReactResult>;
  reactMany(
    link: string,
    emoji: string | string[],
    options?: { delayMs?: number }
  ): Promise<Array<ReactResult | { ok: false; emoji: string; error: string; code: string }>>;
  unreact(link: string): Promise<ReactResult>;
  close(): Promise<void>;

  on(event: 'qr', listener: (qr: string) => void): this;
  on(event: 'pairing-code', listener: (code: string) => void): this;
  on(event: 'open', listener: (info: { user?: unknown }) => void): this;
  on(event: 'close', listener: (info: { statusCode?: number }) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
  on(event: string, listener: (...args: unknown[]) => void): this;
}

export declare class ReactorPool extends EventEmitter {
  constructor(options: PoolOptions);
  readonly size: number;
  readonly online: number;
  connect(): Promise<{ connected: number; failed: Array<{ session: string; error: string }> }>;
  react(
    link: string,
    emoji: string,
    options?: { limit?: number; delayMs?: number }
  ): Promise<PoolSummary>;
  reactMany(
    link: string,
    emoji: string | string[],
    options?: { limit?: number; delayMs?: number }
  ): Promise<Array<{ emoji: string } & PoolSummary>>;
  close(): Promise<void>;
}

/** Parse a channel link. Throws TypeError when it is not one. */
export declare function parseChannelLink(link: string): ParsedChannelLink;

/** Parse a channel MESSAGE link. Throws when the link has no message number. */
export declare function parseMessageLink(link: string): ParsedChannelLink & { serverId: string };

/** Build the reaction target key. */
export declare function messageKey(parsed: { channelId: string; serverId: string }): MessageKey;

/** `<channelId>@newsletter` */
export declare function channelJid(channelId: string): string;

/** Split emoji input, grapheme-aware. */
export declare function splitEmoji(input?: string | string[]): string[];

/** True when a JID points at a channel. */
export declare function isChannelJid(jid: string): boolean;

export declare const CHANNEL_LINK_RE: RegExp;
export declare function sleep(ms: number): Promise<void>;
export declare function mapLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<void>
): Promise<void>;

declare const _default: {
  ChannelReactor: typeof ChannelReactor;
  ReactorPool: typeof ReactorPool;
  parseChannelLink: typeof parseChannelLink;
  parseMessageLink: typeof parseMessageLink;
  messageKey: typeof messageKey;
  channelJid: typeof channelJid;
  splitEmoji: typeof splitEmoji;
  isChannelJid: typeof isChannelJid;
  CHANNEL_LINK_RE: typeof CHANNEL_LINK_RE;
  sleep: typeof sleep;
  mapLimit: typeof mapLimit;
};
export default _default;
