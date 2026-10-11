#!/usr/bin/env node
/**
 * LP probe: measures what a real liquidity provider looks like from the machine it runs on, so the mock
 * LP in core-adapter can be tuned to reality. No dependencies (Node 20+).
 *
 *   node scripts/lp-probe.mjs net                         # DNS/TCP/TLS round trips to public LP endpoints
 *   OANDA_TOKEN=… OANDA_ACCOUNT=… node scripts/lp-probe.mjs oanda [--seconds 60] [--instruments USD_TRY,EUR_TRY,XAU_USD] [--trade 5]
 *   SAXO_TOKEN=… node scripts/lp-probe.mjs saxo [--seconds 30] [--symbols USDTRY,EURTRY,XAUUSD]
 *   LMAX_USER=… LMAX_PASS=… node scripts/lp-probe.mjs lmax [--seconds 60] [--ids 4001,4002]
 *
 * OANDA: free fxTrade Practice account, token from "Manage API Access". Only the practice hosts are used;
 * --trade N places N one-unit market orders and closes each (practice money only).
 * Saxo: free developer account, 24-hour token from the developer portal (SIM environment).
 * LMAX: London demo account; FIX 4.4 market data session over TLS. --ids are LMAX instrument ids (tag 48).
 */
import dns from 'node:dns/promises';
import net from 'node:net';
import tls from 'node:tls';
import { performance } from 'node:perf_hooks';

const args = process.argv.slice(2);
const mode = args[0];
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};

function stats(xs) {
  if (!xs.length) return { n: 0 };
  const s = [...xs].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  const r = (v) => Math.round(v * 100) / 100;
  return { n: s.length, min: r(s[0]), p50: r(q(0.5)), p90: r(q(0.9)), p99: r(q(0.99)), max: r(s[s.length - 1]) };
}

// ---- net: connection round trips -------------------------------------------------------------

const HOSTS = [
  ['OANDA practice REST', 'api-fxpractice.oanda.com'],
  ['OANDA practice stream', 'stream-fxpractice.oanda.com'],
  ['Saxo SIM gateway', 'gateway.saxobank.com'],
  ['Saxo SIM streaming', 'sim-streaming.saxobank.com'],
  ['LMAX London demo (web)', 'web-order.london-demo.lmax.com'],
  ['LMAX London demo (FIX md)', 'fix-marketdata.london-demo.lmax.com'],
  ['Integral (web)', 'www.integral.com'],
  ['360T (web)', 'www.360t.com'],
];

async function probeHost(host, rounds = 5) {
  const t0 = performance.now();
  const { address } = await dns.lookup(host);
  const dnsMs = performance.now() - t0;
  const tcp = [];
  const tlsMs = [];
  for (let i = 0; i < rounds; i++) {
    const a = performance.now();
    await new Promise((res, rej) => {
      const s = net.connect({ host: address, port: 443, timeout: 5000 }, () => (tcp.push(performance.now() - a), s.destroy(), res()));
      s.on('error', rej).on('timeout', () => (s.destroy(), rej(new Error('tcp timeout'))));
    });
    const b = performance.now();
    await new Promise((res, rej) => {
      const s = tls.connect({ host: address, servername: host, port: 443, timeout: 5000 }, () => (tlsMs.push(performance.now() - b), s.destroy(), res()));
      s.on('error', rej).on('timeout', () => (s.destroy(), rej(new Error('tls timeout'))));
    });
  }
  return { address, dnsMs: Math.round(dnsMs), tcpRtt: stats(tcp), tlsHandshake: stats(tlsMs) };
}

async function runNet() {
  for (const [label, host] of HOSTS) {
    try {
      const r = await probeHost(host);
      console.log(`${label.padEnd(28)} ${host}\n   ip=${r.address} dns=${r.dnsMs}ms tcpRTT p50=${r.tcpRtt.p50}ms max=${r.tcpRtt.max}ms  tls p50=${r.tlsHandshake.p50}ms`);
    } catch (err) {
      console.log(`${label.padEnd(28)} ${host}\n   FAILED: ${err.message}`);
    }
  }
}

// ---- OANDA v20 practice ----------------------------------------------------------------------

async function runOanda() {
  const token = process.env.OANDA_TOKEN;
  const account = process.env.OANDA_ACCOUNT;
  if (!token || !account) throw new Error('set OANDA_TOKEN and OANDA_ACCOUNT (practice account)');
  const seconds = Number(opt('seconds', '60'));
  const instruments = opt('instruments', 'USD_TRY,EUR_TRY,XAU_USD').split(',');
  const trades = Number(opt('trade', '0'));
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'accept-datetime-format': 'RFC3339' };
  const rest = 'https://api-fxpractice.oanda.com/v3';

  // REST quote round trip
  const pollRtt = [];
  for (let i = 0; i < 10; i++) {
    const a = performance.now();
    const res = await fetch(`${rest}/accounts/${account}/pricing?instruments=${instruments.join(',')}`, { headers });
    await res.json();
    if (!res.ok) throw new Error(`pricing returned ${res.status}`);
    pollRtt.push(performance.now() - a);
  }
  console.log('REST pricing round trip (ms):', stats(pollRtt));

  // Streaming prices
  const per = Object.fromEntries(instruments.map((i) => [i, { ticks: 0, gaps: [], spreadsBps: [], ageMs: [], last: 0, untradeable: 0 }]));
  const ctrl = new AbortController();
  const res = await fetch(`https://stream-fxpractice.oanda.com/v3/accounts/${account}/pricing/stream?instruments=${instruments.join(',')}`, { headers, signal: ctrl.signal });
  if (!res.ok) throw new Error(`stream returned ${res.status}: ${await res.text()}`);
  setTimeout(() => ctrl.abort(), seconds * 1000);
  console.log(`streaming ${instruments.join(', ')} for ${seconds}s…`);
  const dec = new TextDecoder();
  let buf = '';
  try {
    for await (const chunk of res.body) {
      buf += dec.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        const m = JSON.parse(line);
        if (m.type !== 'PRICE' || !per[m.instrument]) continue;
        const s = per[m.instrument];
        const now = Date.now();
        s.ticks++;
        if (s.last) s.gaps.push(now - s.last);
        s.last = now;
        s.ageMs.push(now - Date.parse(m.time));
        if (!m.tradeable) s.untradeable++;
        const bid = Number(m.bids?.[0]?.price);
        const ask = Number(m.asks?.[0]?.price);
        if (bid && ask) s.spreadsBps.push(((ask - bid) / ((ask + bid) / 2)) * 1e4);
      }
    }
  } catch (err) {
    if (err.name !== 'AbortError') throw err;
  }
  for (const [i, s] of Object.entries(per)) {
    console.log(`\n${i}: ${s.ticks} ticks (${(s.ticks / seconds).toFixed(2)}/s), untradeable=${s.untradeable}`);
    console.log('  gap between ticks ms', stats(s.gaps));
    console.log('  spread bps         ', stats(s.spreadsBps));
    console.log('  price age on arrival ms (clock-skew sensitive)', stats(s.ageMs));
  }

  // Execution round trips
  if (trades > 0) {
    const fill = [];
    const slip = [];
    const instrument = instruments[0];
    for (let i = 0; i < trades; i++) {
      const q = await (await fetch(`${rest}/accounts/${account}/pricing?instruments=${instrument}`, { headers })).json();
      const shownAsk = Number(q.prices[0].asks[0].price);
      const a = performance.now();
      const r = await fetch(`${rest}/accounts/${account}/orders`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ order: { type: 'MARKET', instrument, units: '1', timeInForce: 'FOK', positionFill: 'DEFAULT' } }),
      });
      const body = await r.json();
      fill.push(performance.now() - a);
      const fx = body.orderFillTransaction;
      if (!fx) {
        console.log('order not filled:', body.orderCancelTransaction?.reason ?? r.status);
        continue;
      }
      slip.push(((Number(fx.price) - shownAsk) / shownAsk) * 1e4);
      await fetch(`${rest}/accounts/${account}/positions/${instrument}/close`, { method: 'PUT', headers, body: JSON.stringify({ longUnits: 'ALL' }) });
    }
    console.log(`\n${instrument} market order round trip ms`, stats(fill));
    console.log(`${instrument} fill vs last polled ask, bps (+ = worse)`, stats(slip));
  }
}

// ---- Saxo OpenAPI SIM ------------------------------------------------------------------------

async function runSaxo() {
  const token = process.env.SAXO_TOKEN;
  if (!token) throw new Error('set SAXO_TOKEN (24-hour SIM token from the developer portal)');
  const base = 'https://gateway.saxobank.com/sim/openapi';
  const headers = { authorization: `Bearer ${token}` };
  const seconds = Number(opt('seconds', '30'));
  const symbols = opt('symbols', 'USDTRY,EURTRY,XAUUSD').split(',');
  const uics = {};
  for (const sym of symbols) {
    const r = await (await fetch(`${base}/ref/v1/instruments?Keywords=${sym}&AssetTypes=FxSpot`, { headers })).json();
    const hit = r.Data?.find((d) => d.Symbol?.toUpperCase().startsWith(sym));
    if (hit) uics[sym] = hit.Identifier;
    else console.log(`${sym}: not offered as FxSpot`);
  }
  console.log('instruments', uics);
  const per = Object.fromEntries(Object.keys(uics).map((s) => [s, { rtt: [], spreadsBps: [], changes: 0, last: '', types: new Set() }]));
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    for (const [sym, uic] of Object.entries(uics)) {
      const a = performance.now();
      const r = await fetch(`${base}/trade/v1/infoprices?Uic=${uic}&AssetType=FxSpot&FieldGroups=Quote`, { headers });
      const q = (await r.json()).Quote ?? {};
      const s = per[sym];
      s.rtt.push(performance.now() - a);
      if (q.Bid && q.Ask) s.spreadsBps.push(((q.Ask - q.Bid) / ((q.Ask + q.Bid) / 2)) * 1e4);
      const key = `${q.Bid}/${q.Ask}`;
      if (key !== s.last) (s.changes++, (s.last = key));
      if (q.PriceTypeAsk) s.types.add(q.PriceTypeAsk);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  for (const [sym, s] of Object.entries(per)) {
    console.log(`\n${sym}: price changed ${s.changes} times in ${seconds}s polls, price types=${[...s.types].join(',')}`);
    console.log('  REST round trip ms', stats(s.rtt));
    console.log('  spread bps        ', stats(s.spreadsBps));
  }
}


// ---- LMAX demo FIX 4.4 market data ---------------------------------------------------------

const SOH = '\x01';
const fixTime = (d = new Date()) => d.toISOString().replace(/-/g, '').replace('T', '-').replace('Z', '');

function fixMessage(fields) {
  const body = fields.map(([t, v]) => `${t}=${v}${SOH}`).join('');
  const head = `8=FIX.4.4${SOH}9=${Buffer.byteLength(body)}${SOH}`;
  const sum = [...Buffer.from(head + body)].reduce((a, b) => a + b, 0) % 256;
  return `${head}${body}10=${String(sum).padStart(3, '0')}${SOH}`;
}

function parseFix(raw) {
  const out = [];
  for (const kv of raw.split(SOH)) {
    const i = kv.indexOf('=');
    if (i > 0) out.push([kv.slice(0, i), kv.slice(i + 1)]);
  }
  return out;
}

async function runLmax() {
  const user = process.env.LMAX_USER;
  const pass = process.env.LMAX_PASS;
  if (!user || !pass) throw new Error('set LMAX_USER and LMAX_PASS (London demo account)');
  const seconds = Number(opt('seconds', '60'));
  const ids = opt('ids', '4001').split(',');
  const host = opt('host', 'fix-marketdata.london-demo.lmax.com');
  const target = opt('target', 'LMXBDM');
  const port = Number(opt('port', '443'));
  let seq = 0;
  const send = (sock, type, fields) =>
    sock.write(fixMessage([['35', type], ['49', user], ['56', target], ['34', ++seq], ['52', fixTime()], ...fields]));

  const per = Object.fromEntries(ids.map((id) => [id, { ticks: 0, gaps: [], spreadsBps: [], ageMs: [], last: 0, bid: 0, ask: 0 }]));
  const t0 = performance.now();
  const sock = tls.connect({ host, port, servername: host });
  await new Promise((res, rej) => sock.once('secureConnect', res).once('error', rej));
  const connectMs = performance.now() - t0;
  const logonAt = performance.now();
  send(sock, 'A', [['98', '0'], ['108', '30'], ['141', 'Y'], ['553', user], ['554', pass]]);
  let logonMs;
  const hb = setInterval(() => send(sock, '0', []), 30_000);
  let buf = '';
  const done = new Promise((resolve, reject) => {
    sock.on('data', (chunk) => {
      buf += chunk.toString('latin1');
      for (;;) {
        const end = buf.search(/\x0110=\d{3}\x01/);
        if (end < 0) break;
        const raw = buf.slice(0, end + 8);
        buf = buf.slice(end + 8);
        const f = parseFix(raw);
        const get = (t) => f.find(([k]) => k === t)?.[1];
        const type = get('35');
        if (type === 'A') {
          logonMs = performance.now() - logonAt;
          console.log(`logged on: TLS connect ${connectMs.toFixed(1)} ms, logon round trip ${logonMs.toFixed(1)} ms`);
          send(sock, 'V', [
            ['262', `probe-${Date.now()}`], ['263', '1'], ['264', '1'], ['265', '0'],
            ['146', ids.length], ...ids.flatMap((id) => [['48', id], ['22', '8']]),
            ['267', '2'], ['269', '0'], ['269', '1'],
          ]);
          console.log(`subscribed to ${ids.join(', ')} for ${seconds}s…`);
          setTimeout(resolve, seconds * 1000);
        } else if (type === '1') {
          send(sock, '0', [['112', get('112') ?? '']]);
        } else if (type === 'W' || type === 'X') {
          const id = get('48');
          const s = per[id];
          if (!s) continue;
          let side;
          for (const [k, v] of f) {
            if (k === '269') side = v;
            if (k === '270' && side === '0') s.bid = Number(v);
            if (k === '270' && side === '1') s.ask = Number(v);
          }
          const now = Date.now();
          s.ticks++;
          if (s.last) s.gaps.push(now - s.last);
          s.last = now;
          const sent = get('52');
          if (sent) s.ageMs.push(now - Date.parse(`${sent.slice(0, 4)}-${sent.slice(4, 6)}-${sent.slice(6, 8)}T${sent.slice(9)}Z`));
          if (s.bid && s.ask) s.spreadsBps.push(((s.ask - s.bid) / ((s.ask + s.bid) / 2)) * 1e4);
        } else if (type === '5' || type === '3' || type === 'Y' || type === 'j') {
          console.log(`LMAX ${type === '5' ? 'logout' : 'reject'} (35=${type}): ${get('58') ?? raw.replaceAll(SOH, '|')}`);
          if (type === '5') reject(new Error('logged out'));
        }
      }
    });
    sock.on('error', reject);
    sock.on('close', () => reject(new Error('connection closed')));
  });
  try {
    await done;
  } finally {
    clearInterval(hb);
    try {
      send(sock, '5', []);
    } catch {}
    sock.destroy();
  }
  for (const [id, s] of Object.entries(per)) {
    console.log(`\n${id}: ${s.ticks} updates (${(s.ticks / seconds).toFixed(2)}/s), last bid/ask ${s.bid}/${s.ask}`);
    console.log('  gap between updates ms', stats(s.gaps));
    console.log('  spread bps            ', stats(s.spreadsBps));
    console.log('  age on arrival ms (clock-skew sensitive)', stats(s.ageMs));
  }
}

const run = { net: runNet, oanda: runOanda, saxo: runSaxo, lmax: runLmax }[mode];
if (!run) {
  console.log('usage: node scripts/lp-probe.mjs net|oanda|saxo|lmax [options] (see header)');
  process.exit(1);
}
run().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
