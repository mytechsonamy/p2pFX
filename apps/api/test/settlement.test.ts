import { afterEach, describe, expect, it } from 'vitest';
import { MockCoreBank, CoreBankingError, type FxTransactionRequest } from '@p2p/core-adapter';
import { OPS, startHarness, units, type Harness } from './helpers.js';

/** Mock core whose BANK_SELL postings can be made to fail. */
class FlakyBank extends MockCoreBank {
  failBankSell = false;
  override async postFxTransaction(req: FxTransactionRequest) {
    if (this.failBankSell && req.leg === 'BANK_SELL') throw new CoreBankingError('UNAVAILABLE', 'core down');
    return super.postFxTransaction(req);
  }
}

let h: Harness;
afterEach(async () => {
  await h?.close();
});

async function trade(h: Harness) {
  h.customer('alice', { USD: '1000', TRY: '0' });
  h.customer('bob', { USD: '0', TRY: '100000' });
  const [alice, bob] = await Promise.all(['alice', 'bob'].map((r) => h.login(r)));
  await h.place(alice, { side: 'SELL', qty: '1000', price: '49.15' });
  await h.place(bob, { side: 'BUY', qty: '1000', price: '49.15' });
  return { alice, bob };
}

describe('settlement saga', () => {
  it('sends a fill to operations review when a leg keeps failing, then settles on retry', async () => {
    h = await startHarness();
    h.bank.failNextPostings = 2; // both attempts of the first leg
    const { bob } = await trade(h);

    const failed = await h.req('GET', '/ops/settlements?status=FAILED_NEEDS_REVIEW', OPS);
    expect(failed.body.map((s: { leg: string }) => s.leg).sort()).toEqual(['BANK_BUY', 'BANK_SELL']);
    expect(failed.body.find((s: { leg: string }) => s.leg === 'BANK_BUY').attempts).toBe(2);
    expect((await h.req('GET', '/v1/fills', bob)).body[0].settlementStatus).toBe('FAILED_NEEDS_REVIEW');
    expect((await h.req('GET', '/ops/revenue', OPS)).body).toEqual([]);
    // Nothing moved in core banking.
    expect(await h.balance('alice', 'TRY')).toMatchObject({ balance: 0n });

    const retry = await h.req('POST', `/ops/settlements/${failed.body[0].id}/retry`, OPS);
    expect(retry.body.outcome).toBe('SETTLED');
    expect(await h.balance('alice', 'TRY')).toMatchObject({ balance: units('49100.00') });
    expect(await h.balance('bob', 'USD')).toMatchObject({ balance: units('1000') });
    expect((await h.req('GET', '/ops/revenue', OPS)).body[0].commission.total).toBe('100.00');
  });

  it('reverses the posted leg when the other one fails', async () => {
    const bank = new FlakyBank();
    bank.setReferenceRate('USDTRY', '49.15');
    bank.failBankSell = true;
    h = await startHarness({ bank });
    await trade(h);

    const { rows } = await h.ctx.db.query('select leg, status, reversal_ref from settlements order by leg');
    expect(rows).toEqual([
      expect.objectContaining({ leg: 'BANK_BUY', status: 'REVERSED', reversal_ref: expect.stringMatching(/^REV-/) }),
      expect.objectContaining({ leg: 'BANK_SELL', status: 'FAILED_NEEDS_REVIEW' }),
    ]);
    // Seller's money and FX are back where they were.
    expect(await h.balance('alice', 'USD')).toMatchObject({ balance: units('1000') });
    expect(await h.balance('alice', 'TRY')).toMatchObject({ balance: 0n });

    bank.failBankSell = false;
    const [s] = (await h.req('GET', '/ops/settlements', OPS)).body;
    expect((await h.req('POST', `/ops/settlements/${s.fillId}/retry`, OPS)).body.outcome).toBe('SETTLED');
    const after = await h.ctx.db.query('select leg, status, idempotency_key from settlements order by leg');
    expect(after.rows.every((r) => r.status === 'SETTLED')).toBe(true);
    // Only the leg proven reversed gets a new key; the failed one, confirmed absent in core, keeps its own.
    expect(after.rows.map((r) => r.idempotency_key.endsWith(':r1'))).toEqual([true, false]);
    expect(await h.balance('alice', 'USD')).toMatchObject({ balance: 0n });
    expect(await h.balance('alice', 'TRY')).toMatchObject({ balance: units('49100.00') });
    expect(await h.balance('bob', 'TRY')).toMatchObject({ balance: units('100000') - units('49298.40') });
  });
});

describe('restart', () => {
  it('reloads the book from the database and keeps matching', async () => {
    const bank = new MockCoreBank();
    bank.setReferenceRate('USDTRY', '49.15');
    h = await startHarness({ bank });
    h.customer('alice', { USD: '1000', TRY: '0' });
    h.customer('bob', { USD: '0', TRY: '100000' });
    const alice = await h.login('alice');
    const sell = await h.place(alice, { side: 'SELL', qty: '1000', price: '49.15' });
    await h.close();

    h = await startHarness({ bank, reset: false });
    const bob = await h.login('bob');
    expect((await h.req('GET', '/v1/pairs/USDTRY/book', bob)).body.asks).toEqual([{ price: '49.15', qty: '1000.00', count: 1 }]);
    const buy = await h.place(bob, { side: 'BUY', qty: '1000', price: '49.15' });
    expect(buy.body.status).toBe('FILLED');
    expect((await h.ctx.db.query('select status from orders where id = $1', [sell.body.id])).rows[0].status).toBe('FILLED');
  });
});

describe('stream', () => {
  it('pushes book snapshots and the customer\'s own order and fill events', async () => {
    h = await startHarness();
    h.customer('alice', { USD: '1000', TRY: '0' });
    h.customer('bob', { USD: '0', TRY: '100000' });
    const [alice, bob] = await Promise.all(['alice', 'bob'].map((r) => h.login(r)));
    const ws = await h.app.injectWS(`/v1/stream?token=${alice}`);
    const messages: { channel: string; data: any }[] = [];
    ws.on('message', (m: Buffer) => messages.push(JSON.parse(m.toString())));
    ws.send(JSON.stringify({ op: 'subscribe', channels: ['book:USDTRY', 'trades:USDTRY', 'orders', 'fills'] }));
    await waitFor(() => messages.some((m) => m.channel === 'ack'));
    expect(messages[0]).toEqual({ channel: 'book:USDTRY', data: { pair: 'USDTRY', bids: [], asks: [] } });

    await h.place(alice, { side: 'SELL', qty: '1000', price: '49.15' });
    await waitFor(() => messages.some((m) => m.channel === 'book:USDTRY' && m.data.asks.length === 1));
    await h.place(bob, { side: 'BUY', qty: '1000', price: '49.15' });
    await waitFor(() => messages.some((m) => m.channel === 'fills'));
    const fill = messages.find((m) => m.channel === 'fills')!.data;
    expect(fill).toMatchObject({ side: 'SELL', total: '49100.00' });
    await waitFor(() => messages.some((m) => m.channel === 'trades:USDTRY'));
    expect(messages.find((m) => m.channel === 'trades:USDTRY')!.data).toMatchObject({ price: '49.15', qty: '1000.00', takerSide: 'BUY' });
    // Bob's events are not sent to Alice.
    expect(messages.filter((m) => m.channel === 'orders').every((m) => m.data.side === 'SELL')).toBe(true);
    ws.terminate();
  });
});

async function waitFor(cond: () => boolean, ms = 2000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}
