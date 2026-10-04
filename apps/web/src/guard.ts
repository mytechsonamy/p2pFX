import type { BridgeTransport } from '@p2p/sdk-bridge';

export type EmbedCheck = { ok: true } | { ok: false; reason: 'notEmbedded' | 'untrustedHost' };

/**
 * The marketplace only runs inside the bank's mobile app. Opened from a link in a browser there is no host
 * to hand over a launch token, so the app stops before calling the API; embedded in a page whose origin is
 * not on the bank's allow-list it stops too. (Without a bank-signed launch token the API refuses anyway.)
 *
 * - Native WebViews (iOS, Android, React Native) are recognised by the bridge the bank app injects.
 * - In an iframe the parent's origin must be in `allowedOrigins`. An empty list is accepted only in
 *   development builds.
 */
export function checkEmbedding(opts: {
  transport: BridgeTransport;
  allowedOrigins: string[];
  parentOrigin: string | undefined;
  dev: boolean;
}): EmbedCheck {
  switch (opts.transport) {
    case 'none':
      return { ok: false, reason: 'notEmbedded' };
    case 'iframe':
      if (!opts.allowedOrigins.length) return opts.dev ? { ok: true } : { ok: false, reason: 'untrustedHost' };
      return opts.parentOrigin && opts.allowedOrigins.includes(opts.parentOrigin) ? { ok: true } : { ok: false, reason: 'untrustedHost' };
    default:
      return { ok: true };
  }
}

/** Origin of the page embedding this one, when the browser tells us. */
export function parentOrigin(win: Window = window): string | undefined {
  const ancestors = win.location.ancestorOrigins;
  if (ancestors?.length) return ancestors[0];
  try {
    return win.document.referrer ? new URL(win.document.referrer).origin : undefined;
  } catch {
    return undefined;
  }
}
