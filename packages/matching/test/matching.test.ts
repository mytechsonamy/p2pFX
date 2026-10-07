import { describe, expect, it } from 'vitest';
import { OrderBook, matchIncoming, type BookOrder, type MatchDecision } from '../src/index.js';

let seq = 0n;
const o = (id: string, side: 'BUY' | 'SELL', price: number, qty: number, owner = id): BookOrder => ({
  id,
  principalId: owner,
  side,
  price: BigInt(price),
  remaining: BigInt(qty),
  seq: ++seq,
});
const fill = (): MatchDecision => ({ action: 'filled' });

describe('OrderBook', () => {
  it('orders levels best-first and orders within a level by time', () => {
    const b = new OrderBook();
    b.add(o('s1', 'SELL', 101, 5));
    b.add(o('s2', 'SELL', 100, 5));
    b.add(o('s3', 'SELL', 100, 7));
    b.add(o('b1', 'BUY', 98, 1));
    b.add(o('b2', 'BUY', 99, 1));
    expect(b.best('SELL')?.id).toBe('s2');
    expect(b.best('BUY')?.id).toBe('b2');
    expect(b.depth('SELL')).toEqual([
      { price: 100n, qty: 12n, count: 2 },
      { price: 101n, qty: 5n, count: 1 },
    ]);
  });

  it('keeps time priority when reloading orders out of sequence', () => {
    const b = new OrderBook();
    const first = o('a', 'SELL', 100, 1);
    const second = o('b', 'SELL', 100, 1);
    b.add(second);
    b.add(first);
    expect(b.best('SELL')?.id).toBe('a');
  });
});

describe('matchIncoming', () => {
  it('fills at the maker price with price-time priority and partial fills', async () => {
    const b = new OrderBook();
    b.add(o('s1', 'SELL', 100, 5));
    b.add(o('s2', 'SELL', 100, 5));
    b.add(o('s3', 'SELL', 102, 5));
    const r = await matchIncoming(b, o('t', 'BUY', 101, 8), fill);
    expect(r.fills).toEqual([
      { makerId: 's1', qty: 5n, price: 100n },
      { makerId: 's2', qty: 3n, price: 100n },
    ]);
    expect(r.remaining).toBe(0n);
    expect(r.rested).toBe(false);
    expect(b.get('s2')?.remaining).toBe(2n);
    expect(b.has('s1')).toBe(false);
  });

  it('rests the remainder when the book no longer crosses', async () => {
    const b = new OrderBook();
    b.add(o('s1', 'SELL', 100, 5));
    const r = await matchIncoming(b, o('t', 'BUY', 100, 8), fill);
    expect(r.remaining).toBe(3n);
    expect(r.rested).toBe(true);
    expect(b.best('BUY')?.id).toBe('t');
  });

  it('cancels the incoming order on self-match', async () => {
    const b = new OrderBook();
    b.add(o('s1', 'SELL', 100, 5, 'alice'));
    const r = await matchIncoming(b, o('t', 'BUY', 100, 5, 'alice'), fill);
    expect(r.takerCancelled).toBe('SELF_MATCH');
    expect(r.fills).toHaveLength(0);
    expect(b.has('s1')).toBe(true);
    expect(b.has('t')).toBe(false);
  });

  it('skips a maker the caller cancels and continues with the next one', async () => {
    const b = new OrderBook();
    b.add(o('s1', 'SELL', 100, 5));
    b.add(o('s2', 'SELL', 100, 5));
    const r = await matchIncoming(b, o('t', 'BUY', 100, 5), ({ maker }) =>
      maker.id === 's1' ? { action: 'cancelMaker', reason: 'INSUFFICIENT_BALANCE' } : { action: 'filled' },
    );
    expect(r.cancelledMakers).toEqual([{ id: 's1', reason: 'INSUFFICIENT_BALANCE' }]);
    expect(r.fills).toEqual([{ makerId: 's2', qty: 5n, price: 100n }]);
    expect(b.size).toBe(0);
  });

  it('stops when the caller cancels the taker', async () => {
    const b = new OrderBook();
    b.add(o('s1', 'SELL', 100, 5));
    const r = await matchIncoming(b, o('t', 'BUY', 100, 5), () => ({ action: 'cancelTaker', reason: 'INSUFFICIENT_BALANCE' }));
    expect(r.takerCancelled).toBe('INSUFFICIENT_BALANCE');
    expect(b.has('s1')).toBe(true);
    expect(b.has('t')).toBe(false);
  });

  it('cancels the resting order instead when self trade prevention is CANCEL_MAKER, and goes on', async () => {
    const b = new OrderBook();
    b.add(o('s1', 'SELL', 100, 5, 'bank'));
    b.add(o('s2', 'SELL', 100, 5, 'ayse'));
    const r = await matchIncoming(b, o('t', 'BUY', 100, 5, 'bank'), fill, { selfTrade: 'CANCEL_MAKER' });
    expect(r.cancelledMakers).toEqual([{ id: 's1', reason: 'SELF_MATCH' }]);
    expect(r.fills).toEqual([{ makerId: 's2', qty: 5n, price: 100n }]);
    expect(r.takerCancelled).toBeUndefined();
  });

  it('never rests a market order: the unfilled remainder is cancelled', async () => {
    const b = new OrderBook();
    b.add(o('s1', 'SELL', 100, 3));
    const r = await matchIncoming(b, o('t', 'BUY', 101, 8), fill, { rest: false });
    expect(r.fills).toEqual([{ makerId: 's1', qty: 3n, price: 100n }]);
    expect(r.remaining).toBe(5n);
    expect(r.rested).toBe(false);
    expect(r.takerCancelled).toBe('NO_LIQUIDITY');
    expect(b.size).toBe(0);
  });
});

describe('PRICE → TIME across liquidity sources (v1.1 D001)', () => {
  const src = (id: string, price: number, source: string, at: number, principal = id): BookOrder => ({
    id,
    principalId: principal,
    side: 'SELL',
    price: BigInt(price),
    remaining: 10n,
    seq: BigInt(at),
    source,
  });

  it('T01 / T02: the best price works first whatever its source; at one price the earlier sequence wins', async () => {
    // The worked example of the product definition: a buyer takes 49.2900 (bank), then 49.3000 bot (seq 90)
    // before 49.3000 customer (seq 100), then 49.3500.
    const b = new OrderBook();
    b.add(src('cust-100', 493000, 'CUSTOMER', 100));
    b.add(src('bank-120', 492900, 'BANK_MM', 120, 'bank'));
    b.add(src('cust-80', 493500, 'CUSTOMER', 80));
    b.add(src('bot-90', 493000, 'BOT_MM', 90, 'bank'));
    const r = await matchIncoming(b, { id: 't', principalId: 'zeynep', side: 'BUY', price: 493500n, remaining: 40n, seq: 200n }, fill);
    expect(r.fills.map((f) => f.makerId)).toEqual(['bank-120', 'bot-90', 'cust-100', 'cust-80']);
    expect(r.fills.map((f) => f.price)).toEqual([492900n, 493000n, 493000n, 493500n]);
  });

  it('reports quantity per source only when asked, without changing priority', () => {
    const b = new OrderBook();
    b.add(src('c', 100, 'CUSTOMER', 1));
    b.add(src('m', 100, 'BANK_MM', 2, 'bank'));
    expect(b.depth('SELL')).toEqual([{ price: 100n, qty: 20n, count: 2 }]);
    expect(b.depth('SELL', 20, true)[0].bySource).toEqual({ CUSTOMER: 10n, BANK_MM: 10n });
    expect(b.best('SELL')?.id).toBe('c');
  });
});
