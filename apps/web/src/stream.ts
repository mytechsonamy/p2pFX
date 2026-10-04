import type { Book, Fill, Order, Trade } from './types';

export type StreamMessage =
  | { channel: `book:${string}`; data: Book }
  | { channel: `trades:${string}`; data: Trade }
  | { channel: 'orders'; data: Order }
  | { channel: 'fills'; data: Fill }
  | { channel: 'ack' | 'error'; data: unknown };

/**
 * WebSocket /v1/stream with automatic reconnect. Subscriptions are re-sent after every reconnect,
 * and `onReconnect` lets the app refetch anything it may have missed while offline.
 */
export class Stream {
  private ws: WebSocket | undefined;
  private channels = new Set<string>();
  private attempt = 0;
  private closed = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly url: (token: string) => string,
    private readonly token: () => string | undefined,
    private readonly onMessage: (m: StreamMessage) => void,
    private readonly onStatus: (connected: boolean, reconnected: boolean) => void,
    /** The server closed the socket because the session expired; renew it, then call restart(). */
    private readonly onUnauthorized: () => void,
  ) {}

  connect() {
    const token = this.token();
    if (this.closed || !token) return;
    const ws = new WebSocket(this.url(token));
    this.ws = ws;
    ws.onopen = () => {
      const reconnected = this.attempt > 0;
      this.attempt = 0;
      if (this.channels.size) ws.send(JSON.stringify({ op: 'subscribe', channels: [...this.channels] }));
      this.onStatus(true, reconnected);
    };
    ws.onmessage = (e) => {
      try {
        this.onMessage(JSON.parse(e.data));
      } catch {
        // ignore malformed frames
      }
    };
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      this.onStatus(false, false);
      if (this.closed) return;
      if (e.code === 4401) {
        this.attempt = Math.max(this.attempt, 1);
        return this.onUnauthorized();
      }
      const delay = Math.min(30_000, 500 * 2 ** this.attempt++);
      this.timer = setTimeout(() => this.connect(), delay);
    };
  }

  /** Reconnects now, e.g. after the session token was renewed. */
  restart() {
    clearTimeout(this.timer);
    const old = this.ws;
    this.ws = undefined;
    old?.close();
    this.attempt = Math.max(this.attempt, 1);
    this.connect();
  }

  subscribe(...channels: string[]) {
    channels.forEach((c) => this.channels.add(c));
    this.send({ op: 'subscribe', channels });
  }

  unsubscribe(...channels: string[]) {
    channels.forEach((c) => this.channels.delete(c));
    this.send({ op: 'unsubscribe', channels });
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.ws?.close();
  }

  private send(msg: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }
}
