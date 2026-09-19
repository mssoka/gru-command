import { describe, expect, it } from 'vitest';
import { DEFAULT_MOCK_TOKEN, resolveMockExposure } from '../../mock/safety.js';

describe('mock server exposure safety', () => {
  it('binds loopback by default and emits a loud default-token warning', () => {
    const config = resolveMockExposure({});
    expect(config.host).toBe('127.0.0.1');
    expect(config.token).toBe(DEFAULT_MOCK_TOKEN);
    expect(config.warning).toContain('development-only default token');
    expect(config.warning).toContain('loopback');
  });

  it.each(['0.0.0.0', '::', '192.168.1.8'])('rejects non-loopback host %s with the default token', (host) => {
    expect(() => resolveMockExposure({ GRU_MOCK_HOST: host })).toThrow(/non-loopback.*non-default GRU_MOCK_TOKEN/i);
    expect(() =>
      resolveMockExposure({ GRU_MOCK_HOST: host, GRU_MOCK_TOKEN: DEFAULT_MOCK_TOKEN }),
    ).toThrow(/non-loopback.*non-default GRU_MOCK_TOKEN/i);
  });

  it('rejects short tokens on non-loopback but permits an explicit 16+ character token', () => {
    expect(() => resolveMockExposure({ GRU_MOCK_HOST: '0.0.0.0', GRU_MOCK_TOKEN: 'short' })).toThrow(
      /at least 16 characters/i,
    );
    expect(
      resolveMockExposure({ GRU_MOCK_HOST: '0.0.0.0', GRU_MOCK_TOKEN: 'mock-only-secret-1234' }),
    ).toMatchObject({ host: '0.0.0.0', token: 'mock-only-secret-1234', warning: null });
  });

  it.each(['127.0.0.1', '127.7.8.9', 'localhost', '::1', '[::1]'])(
    'recognizes loopback host %s',
    (host) => {
      expect(resolveMockExposure({ GRU_MOCK_HOST: host }).host).toBe(host);
    },
  );
});
