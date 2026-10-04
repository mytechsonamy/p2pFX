import { SignJWT, importSPKI, jwtVerify } from 'jose';
import type { FastifyRequest } from 'fastify';
import type { Db } from './db/pool.js';
import { unauthorized } from './errors.js';

export interface Session {
  customerId: string;
  customerRef: string;
  segment: string;
  locale?: string;
}

const LAUNCH_AUDIENCE = 'p2pfx';
const LAUNCH_MAX_AGE_SECONDS = 60;
const SESSION_TTL_SECONDS = 30 * 60;

/**
 * Bank launch tokens (RS256, minted by the bank backend for a logged-in customer, ≤60s)
 * are exchanged once for a platform session token (HS256, 30 minutes).
 */
export class AuthService {
  private bankKey?: CryptoKey;
  private readonly sessionKey: Uint8Array;
  private readonly usedJti = new Map<string, number>();

  constructor(
    private readonly db: Db,
    private readonly opts: { bankPublicKeyPem: string; sessionSecret: string; opsToken: string; clock: () => Date },
  ) {
    this.sessionKey = new TextEncoder().encode(opts.sessionSecret);
  }

  private async key() {
    this.bankKey ??= (await importSPKI(this.opts.bankPublicKeyPem, 'RS256'));
    return this.bankKey;
  }

  async exchangeLaunchToken(token: string): Promise<{ token: string; session: Session; expiresAt: string }> {
    const now = this.opts.clock();
    let payload;
    try {
      ({ payload } = await jwtVerify(token, await this.key(), {
        algorithms: ['RS256'],
        audience: LAUNCH_AUDIENCE,
        maxTokenAge: `${LAUNCH_MAX_AGE_SECONDS}s`,
        currentDate: now,
        requiredClaims: ['customer_ref', 'iat', 'exp', 'jti'],
      }));
    } catch (err) {
      throw unauthorized(`invalid launch token: ${(err as Error).message}`);
    }
    if ((payload.exp ?? 0) - (payload.iat ?? 0) > LAUNCH_MAX_AGE_SECONDS) throw unauthorized('launch token lifetime exceeds 60 seconds');

    // One-time use.
    const nowSec = Math.floor(now.getTime() / 1000);
    for (const [jti, exp] of this.usedJti) if (exp < nowSec) this.usedJti.delete(jti);
    if (this.usedJti.has(payload.jti!)) throw unauthorized('launch token already used');
    this.usedJti.set(payload.jti!, payload.exp!);

    const customerRef = String(payload.customer_ref);
    const segment = typeof payload.segment === 'string' ? payload.segment : 'default';
    const locale = typeof payload.locale === 'string' ? payload.locale : undefined;
    const { rows } = await this.db.query(
      `insert into customers (customer_ref, segment, locale) values ($1, $2, $3)
       on conflict (customer_ref) do update set segment = excluded.segment, locale = excluded.locale, last_seen_at = now()
       returning id`,
      [customerRef, segment, locale],
    );
    const session: Session = { customerId: rows[0].id, customerRef, segment, locale };
    const exp = nowSec + SESSION_TTL_SECONDS;
    const jwt = await new SignJWT({ ref: customerRef, seg: segment, loc: locale })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(session.customerId)
      .setIssuedAt(nowSec)
      .setExpirationTime(exp)
      .sign(this.sessionKey);
    return { token: jwt, session, expiresAt: new Date(exp * 1000).toISOString() };
  }

  async verifySession(token: string | undefined): Promise<Session> {
    if (!token) throw unauthorized();
    try {
      const { payload } = await jwtVerify(token, this.sessionKey, { algorithms: ['HS256'], currentDate: this.opts.clock() });
      return {
        customerId: payload.sub!,
        customerRef: String(payload.ref),
        segment: String(payload.seg ?? 'default'),
        locale: payload.loc ? String(payload.loc) : undefined,
      };
    } catch {
      throw unauthorized('session expired or invalid');
    }
  }

  async customer(req: FastifyRequest): Promise<Session> {
    return this.verifySession(bearer(req));
  }

  /** Bank operations API: static bearer token in the prototype (the bank's SSO in production). */
  ops(req: FastifyRequest): string {
    if (bearer(req) !== this.opts.opsToken) throw unauthorized('ops token required');
    return 'ops';
  }
}

export function bearer(req: FastifyRequest): string | undefined {
  const h = req.headers.authorization;
  return h?.startsWith('Bearer ') ? h.slice(7) : undefined;
}
