#!/usr/bin/env node
/**
 * LP probe: measures what a real liquidity provider looks like from the machine it runs on, so the mock
 * LP in core-adapter can be tuned to reality. No dependencies (Node 20+).
 *
 *   node scripts/lp-probe.mjs net                         # DNS/TCP/TLS round trips to public LP endpoints
 *   OANDA_TOKEN=… OANDA_ACCOUNT=… node scripts/lp-probe.mjs oanda [--seconds 60] [--instruments USD_TRY,EUR_TRY,XAU_USD] [--trade 5]
 *   SAXO_TOKEN=… node scripts/lp-probe.mjs saxo [--seconds 30] [--symbols USDTRY,EURTRY,XAUUSD]
 *
 * OANDA: free fxTrade Practice account, token from "Manage API Access". Only the practice hosts are used;
 * --trade N places N one-unit market orders and closes each (practice money only).
 * Saxo: free developer account, 24-hour token from the developer portal (SIM environment).
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

const run = { net: runNet, oanda: runOanda, saxo: runSaxo }[mode];
if (!run) {
  console.log('usage: node scripts/lp-probe.mjs net|oanda|saxo [options] (see header)');
  process.exit(1);
}
run().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
