/** Exposure guardrails for the development-only mock server. */

export const DEFAULT_MOCK_TOKEN = 'dev-token';

export interface MockExposure {
  readonly host: string;
  readonly token: string;
  readonly warning: string | null;
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost' || normalized === '::1' || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

export function resolveMockExposure(
  env: Readonly<Record<string, string | undefined>>,
): MockExposure {
  const host = env.GRU_MOCK_HOST?.trim() || '127.0.0.1';
  const token = env.GRU_MOCK_TOKEN?.trim() || DEFAULT_MOCK_TOKEN;
  const loopback = isLoopbackHost(host);

  if (!loopback && token === DEFAULT_MOCK_TOKEN) {
    throw new Error(
      `refusing non-loopback mock bind (${host}) without a non-default GRU_MOCK_TOKEN; ` +
        'the development-only default token must never be network-exposed',
    );
  }
  if (!loopback && token.length < 16) {
    throw new Error(
      `refusing non-loopback mock bind (${host}): GRU_MOCK_TOKEN must be at least 16 characters`,
    );
  }

  return {
    host,
    token,
    warning:
      token === DEFAULT_MOCK_TOKEN
        ? 'WARNING: using the development-only default token; mock server is restricted to loopback.'
        : null,
  };
}
