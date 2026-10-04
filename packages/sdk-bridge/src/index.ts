/**
 * postMessage protocol between the bank's mobile app (the host) and the embedded P2P web app.
 *
 * Every message travels in an envelope `{ protocol: 'p2pfx.bridge', version: 1, message }`, as an object
 * (iframe, WKWebView script handler) or as its JSON string (Android, React Native).
 */
export const PROTOCOL = 'p2pfx.bridge';
export const PROTOCOL_VERSION = 1;

/** Branding fields a host may override. Honoured only by builds with branding preview enabled (demo). */
export interface BrandingPreview {
  bankName?: string;
  productName?: string;
  logoUrl?: string;
  colors?: Record<string, string>;
  radius?: number;
  font?: string;
}

/** Host → web. */
export type HostMessage =
  /** First message after `ready`: a fresh bank launch token (RS256 JWT, ≤60s) and display options. */
  | {
      type: 'init';
      launchToken: string;
      locale?: string;
      appearance?: 'light' | 'dark';
      /** Insets the web app should keep clear, in CSS pixels. */
      safeArea?: { top?: number; bottom?: number };
      preview?: { branding?: BrandingPreview };
    }
  /** Answer to `tokenExpired`: a new launch token. */
  | { type: 'refreshToken'; launchToken: string }
  /** Hardware or navigation-bar back pressed; the web app pops its own navigation or asks to close. */
  | { type: 'back' };

/** Screens in the bank app the web app can ask the host to open. */
export type BankScreen = 'accounts' | 'openFxAccount' | 'transfer';

/** Web → host. */
export type WebMessage =
  /** The web app has loaded and is waiting for `init`. */
  | { type: 'ready'; version: number }
  /** The customer closed the marketplace. */
  | { type: 'close' }
  /** The platform session ended; the host should send `refreshToken`. */
  | { type: 'tokenExpired' }
  | { type: 'openBankScreen'; screen: BankScreen; params?: Record<string, string> }
  | { type: 'analyticsEvent'; name: string; props?: Record<string, string | number | boolean> };

export interface Envelope<M> {
  protocol: typeof PROTOCOL;
  version: number;
  message: M;
}

export const wrap = <M>(message: M): Envelope<M> => ({ protocol: PROTOCOL, version: PROTOCOL_VERSION, message });

/** Returns the message if `data` (object or JSON string) is a protocol envelope, otherwise undefined. */
export function unwrap<M extends { type: string }>(data: unknown): M | undefined {
  let v = data;
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v);
    } catch {
      return undefined;
    }
  }
  if (!v || typeof v !== 'object') return undefined;
  const env = v as Partial<Envelope<M>>;
  if (env.protocol !== PROTOCOL || typeof env.version !== 'number' || env.version > PROTOCOL_VERSION) return undefined;
  if (!env.message || typeof env.message.type !== 'string') return undefined;
  return env.message;
}

interface NativeWindow {
  ReactNativeWebView?: { postMessage(s: string): void };
  webkit?: { messageHandlers?: { p2pfx?: { postMessage(v: unknown): void } } };
  P2PFXAndroid?: { postMessage(s: string): void };
  __p2pfxReceive?: (data: unknown) => void;
}

export type BridgeTransport = 'react-native' | 'ios' | 'android' | 'iframe' | 'none';

export interface WebBridge {
  readonly transport: BridgeTransport;
  send(message: WebMessage): void;
  onMessage(listener: (message: HostMessage) => void): () => void;
}

/**
 * Bridge used inside the web app. Picks the native channel the host injected, or the parent window when
 * embedded in an iframe. Native hosts deliver messages by calling `window.__p2pfxReceive(json)` or by
 * dispatching a `message` event on the window.
 *
 * `allowedOrigins` restricts which parent origins an iframe host may use; empty means any (development).
 */
export function createWebBridge(win: Window = window, allowedOrigins: string[] = []): WebBridge {
  const w = win as Window & NativeWindow;
  const parentOrigin = () => {
    try {
      return allowedOrigins[0] ?? (document.referrer ? new URL(document.referrer).origin : '*');
    } catch {
      return '*';
    }
  };
  const transport: BridgeTransport = w.ReactNativeWebView
    ? 'react-native'
    : w.webkit?.messageHandlers?.p2pfx
      ? 'ios'
      : w.P2PFXAndroid
        ? 'android'
        : w.parent !== w
          ? 'iframe'
          : 'none';

  const listeners = new Set<(m: HostMessage) => void>();
  const deliver = (data: unknown) => {
    const m = unwrap<HostMessage>(data);
    if (m) listeners.forEach((l) => l(m));
  };
  w.__p2pfxReceive = deliver;
  w.addEventListener('message', (e: MessageEvent) => {
    if (transport === 'iframe') {
      if (e.source !== w.parent) return;
      if (allowedOrigins.length && !allowedOrigins.includes(e.origin)) return;
    }
    deliver(e.data);
  });

  return {
    transport,
    send(message) {
      const env = wrap(message);
      switch (transport) {
        case 'react-native':
          return w.ReactNativeWebView!.postMessage(JSON.stringify(env));
        case 'ios':
          return w.webkit!.messageHandlers!.p2pfx!.postMessage(env);
        case 'android':
          return w.P2PFXAndroid!.postMessage(JSON.stringify(env));
        case 'iframe':
          return w.parent.postMessage(env, parentOrigin());
      }
    },
    onMessage(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** Host side for a web host that embeds the app in an iframe (the demo bank app uses this). */
export function createIframeHost(iframe: HTMLIFrameElement, appOrigin: string) {
  const listeners = new Set<(m: WebMessage) => void>();
  const onWindowMessage = (e: MessageEvent) => {
    if (e.source !== iframe.contentWindow || e.origin !== appOrigin) return;
    const m = unwrap<WebMessage>(e.data);
    if (m) listeners.forEach((l) => l(m));
  };
  window.addEventListener('message', onWindowMessage);
  return {
    send(message: HostMessage) {
      iframe.contentWindow?.postMessage(wrap(message), appOrigin);
    },
    onMessage(listener: (m: WebMessage) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      window.removeEventListener('message', onWindowMessage);
      listeners.clear();
    },
  };
}
