import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app.js';
import type { Session } from '../auth.js';
import type { StreamEvent } from '../events.js';
import { parsePrice } from '@p2p/shared';
import { ratesView } from '../dealing/price-engine.js';

/**
 * WebSocket /v1/stream?token=<session>. Client sends
 *   { "op": "subscribe", "channels": ["book:USDTRY", "trades:USDTRY", "bank:USDTRY", "orders", "fills"] }
 * and receives { channel, data } messages. Book subscriptions get a snapshot first.
 */
export function streamRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get<{ Querystring: { token?: string } }>('/v1/stream', { websocket: true }, (socket, req) => {
    const channels = new Set<string>();
    let session: Session | undefined;
    const send = (channel: string, data: unknown) => socket.send(JSON.stringify({ channel, data }));

    // Listeners are attached synchronously so no early message is lost while the token is checked.
    const ready = ctx.auth.verifySession(req.query.token).then(
      (s) => (session = s),
      () => socket.close(4401, 'unauthorized'),
    );

    const unsubscribe = ctx.events.subscribe((e: StreamEvent) => {
      if (!session) return;
      if (e.type === 'book' && channels.has(`book:${e.pair}`)) send(`book:${e.pair}`, { pair: e.pair, bids: e.bids, asks: e.asks });
      else if (e.type === 'order' && e.customerId === session.customerId && channels.has('orders')) send('orders', e.order);
      else if (e.type === 'fill' && e.customerId === session.customerId && channels.has('fills')) send('fills', e.fill);
      else if (e.type === 'trade' && channels.has(`trades:${e.pair}`)) send(`trades:${e.pair}`, e.trade);
      else if (e.type === 'lp' && channels.has(`bank:${e.pair}`)) {
        // Each customer sees the bank's rates for their own segment.
        const rates = ratesView(ctx.config.get().data, e.pair, { bid: parsePrice(e.bid), ask: parsePrice(e.ask), at: e.at }, session.segment);
        if (rates) send(`bank:${e.pair}`, rates);
      }
    });

    socket.on('message', async (raw: Buffer) => {
      await ready;
      if (!session) return;
      let msg: { op?: string; channels?: string[] };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return send('error', { message: 'invalid JSON' });
      }
      for (const ch of msg.channels ?? []) {
        if (msg.op === 'subscribe') {
          channels.add(ch);
          if (ch.startsWith('book:')) send(ch, ctx.exchange.depth(ch.slice(5)));
          if (ch.startsWith('bank:')) {
            const agg = ctx.prices.cached(ch.slice(5));
            const rates = agg && ratesView(ctx.config.get().data, agg.pair, agg, session.segment);
            if (rates) send(ch, rates);
          }
        } else if (msg.op === 'unsubscribe') {
          channels.delete(ch);
        }
      }
      send('ack', { channels: [...channels] });
    });
    socket.on('close', unsubscribe);
  });
}
