import { describe, expect, it, vi } from 'vitest';
import { createWebBridge, unwrap, wrap, type HostMessage } from '../src/index';

function fakeWindow(extra: Record<string, unknown> = {}) {
  const listeners: ((e: MessageEvent) => void)[] = [];
  const parent = { postMessage: vi.fn() };
  const win = {
    parent,
    addEventListener: (_: string, l: (e: MessageEvent) => void) => listeners.push(l),
    dispatch: (e: Partial<MessageEvent>) => listeners.forEach((l) => l(e as MessageEvent)),
    ...extra,
  };
  return win as unknown as Window & typeof win;
}

describe('envelope', () => {
  it('round-trips objects and JSON strings', () => {
    const env = wrap({ type: 'close' });
    expect(unwrap(env)).toEqual({ type: 'close' });
    expect(unwrap(JSON.stringify(env))).toEqual({ type: 'close' });
  });

  it('ignores foreign or newer messages', () => {
    expect(unwrap({ type: 'close' })).toBeUndefined();
    expect(unwrap('not json')).toBeUndefined();
    expect(unwrap({ protocol: 'p2pfx.bridge', version: 99, message: { type: 'close' } })).toBeUndefined();
  });
});

describe('web bridge', () => {
  it('uses the React Native channel when injected', () => {
    const postMessage = vi.fn();
    const win = fakeWindow({ ReactNativeWebView: { postMessage } });
    const bridge = createWebBridge(win);
    expect(bridge.transport).toBe('react-native');
    bridge.send({ type: 'tokenExpired' });
    expect(JSON.parse(postMessage.mock.calls[0][0])).toEqual(wrap({ type: 'tokenExpired' }));
  });

  it('uses the iOS script handler with an object payload', () => {
    const postMessage = vi.fn();
    const bridge = createWebBridge(fakeWindow({ webkit: { messageHandlers: { p2pfx: { postMessage } } } }));
    expect(bridge.transport).toBe('ios');
    bridge.send({ type: 'close' });
    expect(postMessage).toHaveBeenCalledWith(wrap({ type: 'close' }));
  });

  it('delivers host messages from native evaluateJavascript and from the iframe parent only', () => {
    const win = fakeWindow();
    const bridge = createWebBridge(win, ['https://bank.example']);
    expect(bridge.transport).toBe('iframe');
    const got: HostMessage[] = [];
    bridge.onMessage((m) => got.push(m));

    (win as unknown as { __p2pfxReceive: (d: unknown) => void }).__p2pfxReceive(JSON.stringify(wrap({ type: 'back' })));
    win.dispatch({ source: win.parent as never, origin: 'https://evil.example', data: wrap({ type: 'refreshToken', launchToken: 'x' }) });
    win.dispatch({ source: {} as never, origin: 'https://bank.example', data: wrap({ type: 'refreshToken', launchToken: 'y' }) });
    win.dispatch({ source: win.parent as never, origin: 'https://bank.example', data: wrap({ type: 'refreshToken', launchToken: 'z' }) });

    expect(got).toEqual([{ type: 'back' }, { type: 'refreshToken', launchToken: 'z' }]);
  });

  it('posts to the parent window with the allowed origin', () => {
    const win = fakeWindow();
    createWebBridge(win, ['https://bank.example']).send({ type: 'ready', version: 1 });
    expect(win.parent.postMessage).toHaveBeenCalledWith(wrap({ type: 'ready', version: 1 }), 'https://bank.example');
  });
});
