import { EventEmitter } from 'node:events';
import net from 'node:net';
import tls from 'node:tls';

/** FIX field separator. */
export const SOH = '\x01';

/** A FIX message as received: its type, its fields in order (repeating groups keep their order) and a tag lookup. */
export interface FixMessage {
  type: string;
  fields: [number, string][];
  /** The first value of a tag. */
  get(tag: number): string | undefined;
}

export type FixFields = [number, string | number][];

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** UTCTimestamp with milliseconds: YYYYMMDD-HH:MM:SS.sss */
export function fixTime(d: Date): string {
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}`;
}

/** Parses a UTCTimestamp (with or without milliseconds), or a date (272) and time (273) pair, to an ISO string. */
export function fromFixTime(stamp: string | undefined, time?: string): string | undefined {
  const s = time ? `${stamp}-${time}` : stamp;
  const m = s && /^(\d{4})(\d{2})(\d{2})-(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/.exec(s);
  if (!m) return undefined;
  return new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!, +(m[7] ?? '0').padEnd(3, '0'))).toISOString();
}

/** A complete message: header, body, BodyLength and CheckSum. */
export function encodeFix(type: string, header: { sender: string; target: string; seq: number; time: Date }, fields: FixFields): string {
  const body =
    [[35, type], [49, header.sender], [56, header.target], [34, header.seq], [52, fixTime(header.time)], ...fields]
      .map(([t, v]) => `${t}=${v}${SOH}`)
      .join('');
  const head = `8=FIX.4.4${SOH}9=${Buffer.byteLength(body, 'latin1')}${SOH}`;
  return `${head}${body}10=${checksum(head + body)}${SOH}`;
}

export function checksum(s: string): string {
  let sum = 0;
  for (const b of Buffer.from(s, 'latin1')) sum = (sum + b) % 256;
  return String(sum).padStart(3, '0');
}

export function parseFix(raw: string): FixMessage {
  const fields: [number, string][] = [];
  for (const part of raw.split(SOH)) {
    if (!part) continue;
    const i = part.indexOf('=');
    fields.push([Number(part.slice(0, i)), part.slice(i + 1)]);
  }
  return { type: fields.find(([t]) => t === 35)?.[1] ?? '', fields, get: (tag) => fields.find(([t]) => t === tag)?.[1] };
}

/** Splits complete messages off a stream buffer; returns them and what is left. */
export function splitFix(buffer: string): { messages: string[]; rest: string } {
  const messages: string[] = [];
  let rest = buffer;
  for (;;) {
    const start = rest.indexOf(`8=FIX`);
    if (start < 0) return { messages, rest: '' };
    const end = /\x0110=\d{3}\x01/.exec(rest.slice(start));
    if (!end) return { messages, rest: rest.slice(start) };
    const stop = start + end.index + end[0].length;
    messages.push(rest.slice(start, stop));
    rest = rest.slice(stop);
  }
}

export interface FixSessionOptions {
  host: string;
  port: number;
  senderCompId: string;
  targetCompId: string;
  username: string;
  password: string;
  heartbeatSec?: number;
  /** TLS (LMAX requires it); false for a plain TCP test server. */
  tls?: boolean;
  /** Wait before reconnecting after a disconnection. */
  reconnectMs?: number;
  log?: { info(obj: object, msg: string): void; warn(obj: object, msg: string): void };
  clock?: () => Date;
}

/**
 * One FIX 4.4 initiator session: logon with a sequence reset (LMAX recommends application recovery over FIX
 * resends), heartbeats, test requests, and a reconnect after any disconnection until `stop()`. Application messages
 * are emitted as 'message'; 'logon' and 'logout' tell when the session can be used.
 */
export class FixSession extends EventEmitter {
  private socket?: net.Socket;
  private buffer = '';
  private outSeq = 1;
  private stopped = true;
  private heartbeat?: NodeJS.Timeout;
  private reconnect?: NodeJS.Timeout;
  private lastIn = 0;
  private lastOut = 0;
  private testSent = false;
  loggedOn = false;

  constructor(private readonly opts: FixSessionOptions) {
    super();
  }

  private now() {
    return (this.opts.clock ?? (() => new Date()))();
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.reconnect);
    if (this.loggedOn) this.send('5', []);
    this.drop('stopped');
  }

  private connect() {
    if (this.stopped) return;
    this.buffer = '';
    this.outSeq = 1;
    const onConnect = () => {
      this.lastIn = Date.now();
      this.send('A', [
        [98, 0],
        [108, this.opts.heartbeatSec ?? 30],
        [141, 'Y'],
        [553, this.opts.username],
        [554, this.opts.password],
      ]);
    };
    const socket =
      this.opts.tls === false
        ? net.connect({ host: this.opts.host, port: this.opts.port }, onConnect)
        : tls.connect({ host: this.opts.host, port: this.opts.port, servername: this.opts.host, minVersion: 'TLSv1.2' }, onConnect);
    this.socket = socket;
    socket.setNoDelay(true);
    socket.setEncoding('latin1');
    socket.on('data', (chunk: string) => this.receive(chunk));
    socket.on('error', (err) => this.opts.log?.warn({ err, host: this.opts.host }, 'FIX connection error'));
    socket.on('close', () => {
      if (this.socket !== socket) return;
      this.drop('disconnected');
      if (!this.stopped) this.reconnect = setTimeout(() => this.connect(), this.opts.reconnectMs ?? 5000);
    });
  }

  private drop(reason: string) {
    clearInterval(this.heartbeat);
    const was = this.loggedOn;
    this.loggedOn = false;
    const socket = this.socket;
    this.socket = undefined;
    socket?.destroy();
    if (was) {
      this.opts.log?.warn({ host: this.opts.host, reason }, 'FIX session logged out');
      this.emit('logout', reason);
    }
  }

  /** Sends an application or session message; false when the session cannot send (nothing was written). */
  send(type: string, fields: FixFields): number | false {
    const socket = this.socket;
    if (!socket || socket.destroyed || (type !== 'A' && !this.loggedOn)) return false;
    const seq = this.outSeq++;
    socket.write(encodeFix(type, { sender: this.opts.senderCompId, target: this.opts.targetCompId, seq, time: this.now() }, fields), 'latin1');
    this.lastOut = Date.now();
    return seq;
  }

  private receive(chunk: string) {
    this.lastIn = Date.now();
    this.testSent = false;
    const { messages, rest } = splitFix(this.buffer + chunk);
    this.buffer = rest;
    for (const raw of messages) {
      const msg = parseFix(raw);
      switch (msg.type) {
        case 'A':
          this.loggedOn = true;
          this.startHeartbeat();
          this.opts.log?.info({ host: this.opts.host }, 'FIX session logged on');
          this.emit('logon');
          break;
        case '0':
          break;
        case '1':
          this.send('0', [[112, msg.get(112) ?? '']]);
          break;
        case '2':
          // Nothing is resent (LMAX ignores resent application messages): gap-fill up to the next sequence number.
          this.send('4', [[123, 'Y'], [36, this.outSeq + 1]]);
          break;
        case '5':
          this.opts.log?.warn({ host: this.opts.host, text: msg.get(58) }, 'FIX logout from the counterparty');
          this.drop(msg.get(58) ?? 'logout');
          break;
        default:
          this.emit('message', msg);
      }
    }
  }

  private startHeartbeat() {
    clearInterval(this.heartbeat);
    const hb = (this.opts.heartbeatSec ?? 30) * 1000;
    this.heartbeat = setInterval(() => {
      const now = Date.now();
      if (now - this.lastOut >= hb) this.send('0', []);
      if (now - this.lastIn >= hb * 2) {
        if (this.testSent) return this.drop('no heartbeat from the counterparty');
        this.testSent = true;
        this.send('1', [[112, String(now)]]);
      }
    }, Math.min(hb, 1000));
    this.heartbeat.unref?.();
  }
}
