import { describe, expect, it } from 'vitest';
import { checkEmbedding } from '../src/guard';

const bank = 'https://bank.example';

describe('embedding guard', () => {
  it('refuses to run outside the bank app', () => {
    expect(checkEmbedding({ transport: 'none', allowedOrigins: [bank], parentOrigin: undefined, dev: true })).toEqual({ ok: false, reason: 'notEmbedded' });
  });

  it('runs in the native WebViews the bank app provides', () => {
    for (const transport of ['ios', 'android', 'react-native'] as const) {
      expect(checkEmbedding({ transport, allowedOrigins: [], parentOrigin: undefined, dev: false })).toEqual({ ok: true });
    }
  });

  it('accepts an iframe host only from an allowed origin', () => {
    expect(checkEmbedding({ transport: 'iframe', allowedOrigins: [bank], parentOrigin: bank, dev: false })).toEqual({ ok: true });
    expect(checkEmbedding({ transport: 'iframe', allowedOrigins: [bank], parentOrigin: 'https://evil.example', dev: false })).toEqual({ ok: false, reason: 'untrustedHost' });
    expect(checkEmbedding({ transport: 'iframe', allowedOrigins: [bank], parentOrigin: undefined, dev: false })).toEqual({ ok: false, reason: 'untrustedHost' });
  });

  it('requires an allow-list for iframe hosts outside development', () => {
    expect(checkEmbedding({ transport: 'iframe', allowedOrigins: [], parentOrigin: bank, dev: false })).toEqual({ ok: false, reason: 'untrustedHost' });
    expect(checkEmbedding({ transport: 'iframe', allowedOrigins: [], parentOrigin: bank, dev: true })).toEqual({ ok: true });
  });
});
