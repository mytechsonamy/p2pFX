import { describe, expect, it } from 'vitest';
import { OrderBook, matchIncoming, type BookOrder, type MatchDecision } from '../src/index.js';

let seq = 0n;
const o = (id: string, side: 'BUY' | 'SELL', price: number, qty: number, owner = id): BookOrder => ({
  id,
  ownerId: owner,
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
});
