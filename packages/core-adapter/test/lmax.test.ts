import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LiquidityError,
  LiquidityOutcomeUnknownError,
  LmaxLiquidity,
  checksum,
  encodeFix,
  lmaxClOrdId,
  parseFix,
  splitFix,
  type FixMessage,
} from '../src/index.js';

type Fill = 'fill' | 'kill' | 'reject' | 'silent' | 'drop';

/** A fake LMAX: a market data and a trading FIX acceptor on local ports, scripted per test. */
async function fakeLmax(opts: { password?: string; fill?: Fill; history?: { clOrdId: string; qty: string; px: string }[]; status?: Record<string, string> } = {}) {
  const received: { session: string; msg: FixMessage }[] = [];
  const sockets: net.Socket[] = [];
  const state = { fill: opts.fill ?? 'fill' };
  const serve = (session: 'md' | 'trade', sender: string) => {
    const server = net.createServer((socket) => {
      sockets.push(socket);
      socket.setEncoding('latin1');
      let seq = 1;
      let buffer = '';
      const send = (type: string, fields: [number, string | number][]) =>
        socket.write(encodeFix(type, { sender, target: 'mustilee', seq: seq++, time: new Date('2026-10-15T15:00:00Z') }, fields), 'latin1');
      socket.on('data', (chunk: string) => {
        const { messages, rest } = splitFix(buffer + chunk);
        buffer = rest;
        for (const raw of messages) {
          const msg = parseFix(raw);
          received.push({ session, msg });
          if (msg.type === 'A') {
            if (opts.password && msg.get(554) !== opts.password) send('5', [[58, 'Invalid password']]);
            else send('A', [[98, 0], [108, msg.get(108)!], [141, 'Y']]);
          } else if (msg.type === 'V') {
            for (const [tag, id] of msg.fields) {
              if (tag !== 48) continue;
              send('W', [[262, msg.get(262)!], [48, id], [22, 8], [268, 2], [269, 0], [270, id === '100541' ? '41.95012' : '1.08001'], [271, 50], [272, '20261015'], [273, '14:59:59.500'], [269, 1], [270, id === '100541' ? '41.95233' : '1.08003'], [271, 50]]);
            }
          } else if (msg.type === 'D') {
            const id = msg.get(11)!;
            const base: [number, string | number][] = [[11, id], [37, `ORD${id.slice(0, 4)}`], [48, msg.get(48)!], [22, 8], [54, msg.get(54)!], [38, msg.get(38)!], [60, '20261015-15:00:00.100']];
            if (state.fill === 'drop') socket.destroy();
            else if (state.fill === 'fill') send('8', [...base, [39, 2], [150, 'F'], [14, msg.get(38)!], [151, 0], [6, '41.95233'], [31, '41.95233'], [32, msg.get(38)!]]);
            else if (state.fill === 'kill') send('8', [...base, [39, 4], [150, 4], [14, 0], [151, 0], [6, 0]]);
            else if (state.fill === 'reject') send('8', [...base, [39, 8], [150, 8], [14, 0], [58, 'INSUFFICIENT_LIQUIDITY']]);
          } else if (msg.type === 'H') {
            const st = opts.status?.[msg.get(11)!];
            send('8', [[11, msg.get(11)!], [790, msg.get(790)!], [37, 'ORDH'], [48, msg.get(48)!], [22, 8], [54, msg.get(54)!], [39, st ?? 8], [150, 'I'], [14, st === '2' ? '0.1' : '0'], [6, st === '2' ? '41.9' : '0'], [60, '20261015-14:00:00.000'], ...(st ? [] : ([[58, 'UNKNOWN ORDER']] as [number, string][]))]);
          } else if (msg.type === 'AD') {
            // Like LMAX: a range of 7 days or more is refused.
            const [from, to] = msg.fields.filter(([t]) => t === 60).map(([, v]) => Date.parse(v.replace(/^(\d{4})(\d{2})(\d{2})-/, '$1-$2-$3T') + 'Z'));
            if (to! - from! >= 7 * 86_400_000) {
              send('AQ', [[568, msg.get(568)!], [569, 1], [749, 99], [750, 2], [58, 'TIME_RANGE_REQUESTED_GREATER_THAN_7_DAYS']]);
              continue;
            }
            const rows = opts.history ?? [];
            send('AQ', [[568, msg.get(568)!], [569, 1], [749, 0], [750, 0], ...(rows.length ? [] : ([[748, 0]] as [number, number][]))]);
            rows.forEach((r, i) => send('AE', [[568, msg.get(568)!], [912, i === rows.length - 1 ? 'Y' : 'N'], [17, `EX${i}`], [48, '100541'], [22, 8], [32, r.qty], [31, r.px], [75, '20261014'], [60, '20261014-10:00:00.000'], [552, 1], [54, 1], [37, `O${i}`], [11, r.clOrdId]]));
          } else if (msg.type === '1') {
            send('0', [[112, msg.get(112)!]]);
          }
        }
      });
    });
    return new Promise<net.Server>((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
  };
  const md = await serve('md', 'LMXBDM');
  const trade = await serve('trade', 'LMXBD');
  const port = (s: net.Server) => (s.address() as net.AddressInfo).port;
  const lmax = new LmaxLiquidity({
    username: 'mustilee',
    password: 'secret',
    pairs: ['USDTRY', 'EURUSD', 'XAUUSD'],
    marketData: { host: '127.0.0.1', port: port(md), targetCompId: 'LMXBDM' },
    trading: { host: '127.0.0.1', port: port(trade), targetCompId: 'LMXBD' },
    tls: false,
    reconnectMs: 50,
    fillTimeoutMs: 300,
    lookupTimeoutMs: 300,
  });
  const close = async () => {
    lmax.stop();
    for (const s of sockets) s.destroy();
    await Promise.all([md, trade].map((s) => new Promise((r) => s.close(r))));
  };
  return { lmax, received, state, close };
}

const until = async (cond: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

let env: Awaited<ReturnType<typeof fakeLmax>> | undefined;
afterEach(async () => {
  await env?.close();
  env = undefined;
});

const order = { lp: 'LMAX', pair: 'USDTRY', side: 'BUY' as const, qty: '1000' };

describe('FIX framing', () => {
  it('computes body length and checksum like LMAX, and splits a stream into messages', () => {
    // LMAX's own sample heartbeat (Sample LogOn_HB_MD_TD_TR.txt): its length and checksum.
    const sample = '8=FIX.4.4|9=59|35=0|34=5738|49=FIXtest1|52=20121003-08:44:38.692|56=LMXBD|10=212|'.replace(/\|/g, '\x01');
    expect(checksum(sample.slice(0, sample.indexOf('10=')))).toBe('212');
    const body = sample.slice(sample.indexOf('35='), sample.indexOf('10='));
    expect(Buffer.byteLength(body, 'latin1')).toBe(59);
    const raw = encodeFix('0', { sender: 'A', target: 'B', seq: 2, time: new Date('2026-10-15T15:00:00.123Z') }, []);
    expect(raw.replace(/\x01/g, '|')).toBe(`8=FIX.4.4|9=45|35=0|49=A|56=B|34=2|52=20261015-15:00:00.123|10=${checksum(raw.slice(0, raw.indexOf('10=')))}|`);
    const { messages, rest } = splitFix(raw + raw + raw.slice(0, 20));
    expect(messages).toEqual([raw, raw]);
    expect(rest).toBe(raw.slice(0, 20));
    expect(parseFix(raw).get(52)).toBe('20261015-15:00:00.123');
  });
});

describe('LMAX over FIX', () => {
  it('logs on with the username and password, subscribes to top of book and quotes from it', async () => {
    env = await fakeLmax();
    env.lmax.start();
    await until(() => env!.lmax.connected);
    const logon = env.received.find((r) => r.msg.type === 'A')!.msg;
    expect([logon.get(553), logon.get(554), logon.get(141), logon.get(49), logon.get(56)]).toEqual(['mustilee', 'secret', 'Y', 'mustilee', 'LMXBDM']);
    const sub = env.received.find((r) => r.msg.type === 'V')!.msg;
    expect(sub.fields.filter(([t]) => t === 48).map(([, v]) => v)).toEqual(['100541', '4001', '100637']);
    expect([sub.get(263), sub.get(264), sub.get(265)]).toEqual(['1', '1', '0']);
    let quoted = false;
    for (let i = 0; i < 200 && !quoted; i++) {
      quoted = (await env.lmax.quotes('USDTRY').catch(() => [])).length > 0;
      if (!quoted) await new Promise((r) => setTimeout(r, 10));
    }
    expect(await env.lmax.quotes('USDTRY')).toEqual([{ lp: 'LMAX', pair: 'USDTRY', bid: '41.95012', ask: '41.95233', at: '2026-10-15T14:59:59.500Z' }]);
    await expect(env.lmax.quotes('USDCHF')).rejects.toBeInstanceOf(LiquidityError);
  });

  it('refuses a wrong password without logging on, and does not try again (no account lockout)', async () => {
    env = await fakeLmax({ password: 'right' });
    env.lmax.start();
    await until(() => env!.received.some((r) => r.msg.type === 'A'));
    // Reconnects are 50 ms apart in these tests: a session that kept trying would log on again several times.
    await new Promise((r) => setTimeout(r, 300));
    expect(env.lmax.connected).toBe(false);
    expect(env.received.filter((r) => r.msg.type === 'A')).toHaveLength(2);
    await expect(env.lmax.execute({ ...order, ref: 'r0' })).rejects.toBeInstanceOf(LiquidityError);
  });

  it('sends a Fill-or-Kill limit order in contracts at the limit on the tick, and reads the fill', async () => {
    env = await fakeLmax();
    env.lmax.start();
    await until(() => env!.lmax.connected);
    const exec = await env.lmax.execute({ ...order, ref: 'clip-1', limitRate: '41.9530049' });
    const sent = env.received.find((r) => r.msg.type === 'D')!.msg;
    expect([sent.get(11), sent.get(48), sent.get(54), sent.get(38), sent.get(40), sent.get(44), sent.get(59)]).toEqual([lmaxClOrdId('clip-1'), '100541', '1', '0.1', '2', '41.953', '4']);
    expect(exec).toMatchObject({ lp: 'LMAX', ref: 'clip-1', pair: 'USDTRY', side: 'BUY', qty: '1000', rate: '41.95233' });
    expect(lmaxClOrdId('clip-1')).toHaveLength(20);
  });

  it('a killed or rejected order is a definite rejection; a silent one or a dropped session is unknown', async () => {
    env = await fakeLmax({ fill: 'kill' });
    env.lmax.start();
    await until(() => env!.lmax.connected);
    await expect(env.lmax.execute({ ...order, ref: 'k1' })).rejects.toBeInstanceOf(LiquidityError);
    env.state.fill = 'reject';
    const err = await env.lmax.execute({ ...order, ref: 'k2' }).catch((e) => e);
    expect(err).toBeInstanceOf(LiquidityError);
    expect(err.message).toContain('INSUFFICIENT_LIQUIDITY');
    env.state.fill = 'silent';
    await expect(env.lmax.execute({ ...order, ref: 'k3' })).rejects.toBeInstanceOf(LiquidityOutcomeUnknownError);
    env.state.fill = 'drop';
    await expect(env.lmax.execute({ ...order, ref: 'k4' })).rejects.toBeInstanceOf(LiquidityOutcomeUnknownError);
  });

  it('never sends a reference twice', async () => {
    env = await fakeLmax({ fill: 'silent' });
    env.lmax.start();
    await until(() => env!.lmax.connected);
    await expect(env.lmax.execute({ ...order, ref: 'once' })).rejects.toBeInstanceOf(LiquidityOutcomeUnknownError);
    await expect(env.lmax.execute({ ...order, ref: 'once' })).rejects.toBeInstanceOf(LiquidityOutcomeUnknownError);
    expect(env.received.filter((r) => r.msg.type === 'D')).toHaveLength(1);
  });

  it('rejects a quantity that is not a whole number of the smallest order, before sending anything', async () => {
    env = await fakeLmax();
    env.lmax.start();
    await until(() => env!.lmax.connected);
    await expect(env.lmax.execute({ ...order, qty: '1500', ref: 'q1' })).rejects.toBeInstanceOf(LiquidityError);
    await expect(env.lmax.execute({ ...order, pair: 'XAUUSD', qty: '0.5', ref: 'q2' })).rejects.toBeInstanceOf(LiquidityError);
    expect(await env.lmax.execute({ ...order, pair: 'XAUUSD', qty: '3', ref: 'q3' })).toMatchObject({ qty: '3' });
    expect(env.received.filter((r) => r.msg.type === 'D').map((r) => r.msg.get(38))).toEqual(['0.3']);
  });

  it('looks an order up by its status, or in the trade history without the original request', async () => {
    env = await fakeLmax({ status: { [lmaxClOrdId('filled')]: '2' }, history: [{ clOrdId: lmaxClOrdId('old'), qty: '0.1', px: '41.8' }] });
    env.lmax.start();
    await until(() => env!.lmax.connected);
    expect(await env.lmax.findExecution('LMAX', 'filled', { pair: 'USDTRY', side: 'BUY', qty: '1000' })).toMatchObject({ rate: '41.9', qty: '1000' });
    expect(await env.lmax.findExecution('LMAX', 'never', { pair: 'USDTRY', side: 'BUY', qty: '1000' })).toBeUndefined();
    expect(await env.lmax.findExecution('LMAX', 'old')).toMatchObject({ pair: 'USDTRY', qty: '1000', rate: '41.8', side: 'BUY' });
    expect(await env.lmax.findExecution('LMAX', 'nothing')).toBeUndefined();
    expect(await env.lmax.findExecution('SAXO', 'filled')).toBeUndefined();
  });

  it('answers a test request with its id', async () => {
    env = await fakeLmax();
    env.lmax.start();
    await until(() => env!.lmax.connected);
    // The fake answers our test requests; here the session answers one from the counterparty.
    const session = (env.lmax as unknown as { trading: { socket: net.Socket } }).trading;
    session.socket.emit('data', encodeFix('1', { sender: 'LMXBD', target: 'mustilee', seq: 99, time: new Date() }, [[112, 'TR-42']]));
    await until(() => env!.received.some((r) => r.session === 'trade' && r.msg.type === '0' && r.msg.get(112) === 'TR-42'));
  });

  it('reconnects after the trading session drops and trades again', async () => {
    env = await fakeLmax();
    env.lmax.start();
    await until(() => env!.lmax.connected);
    await until(() => env!.received.filter((r) => r.msg.type === 'A').length === 2);
    const logons = env.received.filter((r) => r.msg.type === 'A').length;
    env.state.fill = 'drop';
    await env.lmax.execute({ ...order, ref: 'd1' }).catch(() => {});
    env.state.fill = 'fill';
    await until(() => env!.received.filter((r) => r.msg.type === 'A').length > logons);
    await until(() => env!.lmax.connected);
    expect(await env.lmax.execute({ ...order, ref: 'd2' })).toMatchObject({ ref: 'd2' });
  });
});
