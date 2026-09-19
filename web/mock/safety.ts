/** Exposure guardrails for the development-only mock server. */

export const DEFAULT_MOCK_TOKEN = 'dev-token';

export interface MockExposure {
  readonly host: string;
  readonly token: string;
  readonly warning: string | null;
}

function normalizeBindHost(host: string): string {
  // URL authorities bracket IPv6 literals; node:http.listen expects the
  // bare address. Only strip a complete bracket pair so malformed values
  // still fail closed at the exposure check or bind boundary.
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

function isLoopbackHost(host: string): boolean {
  const normalized = normalizeBindHost(host).toLowerCase();
  return normalized === 'localhost' || normalized === '::1' || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

export function resolveMockExposure(
  env: Readonly<Record<string, string | undefined>>,
): MockExposure {
  const configuredHost = env.GRU_MOCK_HOST?.trim() || '127.0.0.1';
  const host = normalizeBindHost(configuredHost);
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
