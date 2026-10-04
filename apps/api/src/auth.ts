import { createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { SignJWT, importSPKI, jwtVerify } from 'jose';
import type { FastifyRequest } from 'fastify';
import type { Db } from './db/pool.js';
import { ApiError, unauthorized } from './errors.js';
import type { ConfigService } from './config-service.js';

export interface Session {
  customerId: string;
  customerRef: string;
  segment: string;
  locale?: string;
}

export type OpsRole = 'viewer' | 'editor' | 'admin';

export interface Operator {
  username: string;
  displayName: string;
  role: OpsRole;
}

// Protocol limits of the bank integration (the launch token contract), not business parameters.
const LAUNCH_AUDIENCE = 'p2pfx';
const LAUNCH_MAX_AGE_SECONDS = 60;
const OPS_AUDIENCE = 'p2pfx-ops';
const OPS_SESSION_SECONDS = 8 * 60 * 60;
const RANK: Record<OpsRole, number> = { viewer: 0, editor: 1, admin: 2 };

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 32);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

async function checkPassword(password: string, stored: string): Promise<boolean> {
  const [kind, salt, hash] = stored.split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const actual = await scrypt(password, Buffer.from(salt, 'hex'), 32);
  return timingSafeEqual(actual, Buffer.from(hash, 'hex'));
}

/**
 * Bank launch tokens (RS256, minted by the bank backend for a logged-in customer, ≤60s)
 * are exchanged once for a platform session token (HS256, lifetime from `session.ttlMinutes`).
 *
 * Back office: named operators log in with a password and get an ops session (HS256, 8 hours) that
 * carries their role. The static OPS_TOKEN remains for service integrations (scripts, the bank's own
 * back end); those act as `service:<X-Ops-Actor>` so the audit log still says who called.
 */
export class AuthService {
  private bankKey?: CryptoKey;
  private readonly sessionKey: Uint8Array;
  private readonly opsKey: Uint8Array;
  private readonly usedJti = new Map<string, number>();

  constructor(
    private readonly db: Db,
    private readonly opts: { bankPublicKeyPem: string; sessionSecret: string; opsToken: string; clock: () => Date; config: ConfigService },
  ) {
    this.sessionKey = new TextEncoder().encode(opts.sessionSecret);
    // A separate key so an ops session can never pass as a customer session, or the other way round.
    this.opsKey = createHmac('sha256', opts.sessionSecret).update('p2pfx-ops-session').digest();
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
    const exp = nowSec + this.opts.config.get().data.session.ttlMinutes * 60;
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

  /**
   * Bank operations API: the caller's audit name if they hold at least `role`. Service tokens may do
   * anything an editor can; managing users needs a named admin.
   */
  async ops(req: FastifyRequest, role: OpsRole = 'viewer'): Promise<string> {
    const token = bearer(req);
    if (!token) throw unauthorized('ops login required');
    if (token === this.opts.opsToken) {
      if (role === 'admin') throw new ApiError(403, 'FORBIDDEN', 'a named administrator is required');
      const who = String(req.headers['x-ops-actor'] ?? '').replace(/[^\w.@-]/g, '').slice(0, 64);
      return `service:${who || 'ops'}`;
    }
    const op = await this.operator(token);
    if (RANK[op.role] < RANK[role]) throw new ApiError(403, 'FORBIDDEN', `the ${role} role is required`);
    return op.username;
  }

  /** The operator behind an ops session; the account must still be active with the same role. */
  async operator(token: string): Promise<Operator> {
    let payload;
    try {
      ({ payload } = await jwtVerify(token, this.opsKey, { algorithms: ['HS256'], audience: OPS_AUDIENCE, currentDate: this.opts.clock() }));
    } catch {
      throw unauthorized('ops session expired or invalid');
    }
    const { rows } = await this.db.query('select username, display_name, role from ops_users where username = $1 and active', [payload.sub]);
    if (!rows.length) throw unauthorized('operator is disabled');
    return { username: rows[0].username, displayName: rows[0].display_name, role: rows[0].role };
  }

  async opsLogin(username: string, password: string): Promise<{ token: string; operator: Operator; expiresAt: string }> {
    const { rows } = await this.db.query('select * from ops_users where username = $1 and active', [username]);
    if (!rows.length || !(await checkPassword(password, rows[0].password_hash))) throw unauthorized('wrong username or password');
    await this.db.query('update ops_users set last_login_at = now() where username = $1', [username]);
    const nowSec = Math.floor(this.opts.clock().getTime() / 1000);
    const exp = nowSec + OPS_SESSION_SECONDS;
    const token = await new SignJWT({ role: rows[0].role })
      .setProtectedHeader({ alg: 'HS256' })
      .setAudience(OPS_AUDIENCE)
      .setSubject(username)
      .setIssuedAt(nowSec)
      .setExpirationTime(exp)
      .sign(this.opsKey);
    return { token, operator: { username, displayName: rows[0].display_name, role: rows[0].role }, expiresAt: new Date(exp * 1000).toISOString() };
  }

  /** Creates the first administrator on a deployment without operators. */
  async bootstrapAdmin(password: string | undefined) {
    if (!password) return;
    const { rows } = await this.db.query('select 1 from ops_users limit 1');
    if (rows.length) return;
    await this.db.query(
      `insert into ops_users (username, display_name, role, password_hash, created_by) values ('admin', 'Yönetici', 'admin', $1, 'system')
       on conflict do nothing`,
      [await hashPassword(password)],
    );
  }
}

export function bearer(req: FastifyRequest): string | undefined {
  const h = req.headers.authorization;
  return h?.startsWith('Bearer ') ? h.slice(7) : undefined;
}
