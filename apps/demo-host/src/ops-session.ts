// Back office operator session, shared by the back office and the dealer screen (same origin). The token is
// the platform's ops session; every change made with it is recorded under the operator's name.

export type OpsRole = 'viewer' | 'editor' | 'admin';

export interface Operator {
  username: string;
  displayName: string;
  role: OpsRole;
}

const KEY = 'p2pfx.ops.session';

interface Stored {
  token: string;
  operator: Operator;
  expiresAt: string;
}

export function session(): Stored | undefined {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Stored | null;
    if (s && new Date(s.expiresAt).getTime() > Date.now()) return s;
  } catch {
    // storage blocked or malformed: signed out
  }
  return undefined;
}

export function signOut() {
  memory = undefined;
  try {
    localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}

export class OpsError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

/** Calls the ops API through the demo bank backend with the operator's session. */
export async function opsFetch<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const s = current();
  const res = await fetch(`/bank/ops${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(s ? { authorization: `Bearer ${s.token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: any;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = { message: text };
  }
  if (!res.ok) throw new OpsError(res.status, data?.error ?? 'ERROR', data?.message ?? res.statusText, data?.details);
  return data as T;
}

export async function signIn(username: string, password: string): Promise<Operator> {
  const r = await opsFetch<Stored>('POST', '/login', { username, password });
  try {
    localStorage.setItem(KEY, JSON.stringify(r));
  } catch {
    // ignore: the session then lasts for this page only
  }
  memory = r;
  return r.operator;
}

// Fallback when storage is unavailable.
let memory: Stored | undefined;
export const current = () => session() ?? memory;

export const canEdit = (op?: Operator) => op?.role === 'editor' || op?.role === 'admin';
