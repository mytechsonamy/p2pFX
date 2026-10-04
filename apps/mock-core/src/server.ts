import Fastify, { type FastifyInstance } from 'fastify';
import { CoreBankingError, MockCoreBank, fxRequestFromWire, toWire } from '@p2p/core-adapter';
import { parseDecimal } from '@p2p/shared';

const STATUS: Record<string, number> = { INSUFFICIENT_FUNDS: 422, NOT_FOUND: 404, INVALID_REQUEST: 400, UNAVAILABLE: 503 };

/**
 * HTTP facade over MockCoreBank. The routes mirror CoreBankingAdapter; /admin routes
 * are for seeding and demos (create customers, statements, bank accounts, fault injection).
 */
export function buildMockCore(bank = new MockCoreBank(), opts: { logger?: boolean } = {}): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? false });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof CoreBankingError) {
      return reply.status(STATUS[err.code] ?? 500).send({ code: err.code, message: (err as Error).message });
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    return reply.status(status).send({ code: status >= 500 ? 'UNAVAILABLE' : 'INVALID_REQUEST', message: (err as Error).message });
  });

  const send = (v: unknown) => toWire(v);

  app.get('/health', async () => ({ ok: true }));

  app.get<{ Params: { ref: string } }>('/customers/:ref/accounts', async (req) => send(await bank.getAccounts(req.params.ref)));

  app.post<{ Body: { accountId: string; amount: string; ref: string } }>('/holds', async (req) =>
    bank.placeHold(req.body.accountId, BigInt(req.body.amount), req.body.ref),
  );
  app.put<{ Params: { id: string }; Body: { amount: string } }>('/holds/:id', async (req) => {
    await bank.adjustHold(req.params.id, BigInt(req.body.amount));
    return { ok: true };
  });
  app.delete<{ Params: { id: string } }>('/holds/:id', async (req) => {
    await bank.releaseHold(req.params.id);
    return { ok: true };
  });

  app.post<{ Body: Record<string, unknown> }>('/fx-transactions', async (req) => bank.postFxTransaction(fxRequestFromWire(req.body)));
  app.post<{ Params: { ref: string }; Body: { idempotencyKey: string } }>('/fx-transactions/:ref/reverse', async (req) =>
    bank.reverseFxTransaction(req.params.ref, req.body.idempotencyKey),
  );
  app.get<{ Params: { ref: string } }>('/receipts/:ref', async (req) => bank.getReceipt(req.params.ref));

  app.get<{ Params: { pair: string } }>('/rates/:pair', async (req) => bank.getReferenceRate(req.params.pair));
  app.put<{ Params: { pair: string }; Body: { rate: string } }>('/rates/:pair', async (req) => {
    parseDecimal(req.body.rate, 8);
    return bank.setReferenceRate(req.params.pair, req.body.rate);
  });

  app.post<{ Body: { customerRef: string; event: { type: string; title: string; body: string } } }>('/notifications', async (req) => {
    await bank.notify(req.body.customerRef, req.body.event);
    return { ok: true };
  });

  // ---- admin (prototype only) ----

  app.post<{ Body: { customerRef: string; accounts: { currency: string; balance: string; name?: string }[] } }>(
    '/admin/customers',
    async (req) =>
      send(
        req.body.accounts.map((a) =>
          bank.createAccount(req.body.customerRef, a.currency, parseDecimal(a.balance, a.currency === 'JPY' ? 0 : 2), a.name),
        ),
      ),
  );
  app.get('/admin/bank-accounts', async () => send(bank.bankAccounts()));
  app.get<{ Params: { id: string } }>('/admin/accounts/:id', async (req) => send(bank.getAccount(req.params.id)));
  app.get<{ Params: { id: string } }>('/admin/accounts/:id/statement', async (req) => send(bank.getStatement(req.params.id)));
  app.get('/admin/notifications', async () => bank.notifications);
  app.post<{ Body: { failNextPostings: number } }>('/admin/faults', async (req) => {
    bank.failNextPostings = req.body.failNextPostings;
    return { failNextPostings: bank.failNextPostings };
  });

  return app;
}
