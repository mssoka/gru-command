/**
 * Decision provider profiles (issue #222): the shared, dependency-free
 * vocabulary for `[decisions.providers.<name>]` — protocols, credential
 * slots, and the endpoint/credential binding rules.
 *
 * THE SECURITY PROPERTY (kept from the single-provider design): a resolved
 * credential slot is bound to one pinned origin, and a key resolved for a
 * slot is never sent anywhere else — enforced here at config validation,
 * at provider construction, and again immediately before every request.
 * A keyless profile (`credential = "none"`) may only target a loopback
 * host. Both checks are pure so config parsing, the runtime and the CLI
 * share one implementation.
 */

export const DECISION_PROTOCOLS = ['openrouter-decisions', 'systemone'] as const;
export type DecisionProtocol = (typeof DECISION_PROTOCOLS)[number];

/** Named credential slots; each binds to exactly one origin. */
export const CREDENTIAL_SLOTS = ['openrouter', 'typesafe'] as const;
export type CredentialSlot = (typeof CREDENTIAL_SLOTS)[number];
/** Keyless: allowed only for loopback hosts. */
export const KEYLESS_CREDENTIAL = 'none';

export const OPENROUTER_ORIGIN = 'https://openrouter.ai';
export const TYPESAFE_ORIGIN = 'https://api.typesafe.ai';
/** The one TypeSafe/System One request path (same shape local servers expose). */
export const SYSTEMONE_PATH = '/v1/systemone';

export function credentialOrigin(slot: string): string | null {
  if (slot === 'openrouter') return OPENROUTER_ORIGIN;
  if (slot === 'typesafe') return TYPESAFE_ORIGIN;
  return null;
}

/** Private env var name for a slot (isolated before child processes spawn). */
export function credentialEnvVar(slot: CredentialSlot): string {
  return `${slot.toUpperCase()}_API_KEY`;
}

/** Per-slot key file under `<instance>/credentials/`. */
export function credentialFileFor(slot: CredentialSlot): string {
  return `${slot}.key`;
}

/** Every slot env var that must never leak into a child environment. */
export const CREDENTIAL_ENV_VARS: readonly string[] = CREDENTIAL_SLOTS.map(credentialEnvVar);

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', '::1', 'localhost']);

export function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.replace(/^\[|\]$/gu, '').toLowerCase());
}

/** One provider profile as the runtime, CLI and provider consume it. */
export interface DecisionProviderProfile {
  readonly protocol: DecisionProtocol;
  readonly endpoint: string;
  readonly model: string;
  /** A {@link CREDENTIAL_SLOTS} name, or `"none"` (loopback only). */
  readonly credential: string;
  readonly timeoutMs: number;
  /** USD per million input tokens, used ONLY when a systemone response
   * carries no `usage.cost` (TypeSafe reports token counts, not cost). */
  readonly inputPricePerMtok: number;
}

export function inputPricePerMtokOf(profile: DecisionProviderProfile): number {
  return profile.inputPricePerMtok;
}

/** The default TypeSafe/System One input price when a profile does not
 * override `input_price_per_mtok`. */
export const DEFAULT_INPUT_PRICE_PER_MTOK = 0.042;

export class ProfileEndpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProfileEndpointError';
  }
}

function parseEndpoint(endpoint: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new ProfileEndpointError(`endpoint is not a valid URL: ${JSON.stringify(endpoint)}`);
  }
  if (parsed.username !== '' || parsed.password !== '' || parsed.search !== '' || parsed.hash !== '') {
    throw new ProfileEndpointError('endpoint must not carry userinfo, a query string or a fragment');
  }
  return parsed;
}

function requireHttpsOrigin(parsed: URL, pinnedOrigin: string, label: string): void {
  if (parsed.protocol !== 'https:' || `${parsed.protocol}//${parsed.host}` !== pinnedOrigin) {
    throw new ProfileEndpointError(`${label} credential binds to ${pinnedOrigin}; endpoint is ${parsed.protocol}//${parsed.host}`);
  }
  if (parsed.port !== '' && parsed.port !== '443') {
    throw new ProfileEndpointError(`${label} endpoint must use the default HTTPS port`);
  }
}

function requireSystemOnePath(parsed: URL): void {
  if (parsed.pathname !== SYSTEMONE_PATH && parsed.pathname !== `${SYSTEMONE_PATH}/`) {
    throw new ProfileEndpointError(`systemone endpoint path must be ${SYSTEMONE_PATH}`);
  }
}

/**
 * Validate a profile's endpoint against its protocol and credential slot.
 * `mode === 'resolved'` (env/file keys) enforces the slot's pinned origin;
 * `mode === 'explicit'` (an in-process injected key) enforces the protocol
 * shape only; keyless profiles must target loopback.
 */
export function assertProfileEndpoint(
  profile: Pick<DecisionProviderProfile, 'protocol' | 'endpoint' | 'credential'>,
  mode: 'resolved' | 'explicit' = 'resolved',
): URL {
  const parsed = parseEndpoint(profile.endpoint);
  if (profile.credential === KEYLESS_CREDENTIAL) {
    if (!isLoopbackHostname(parsed.hostname)) {
      throw new ProfileEndpointError('credential = "none" is allowed only for loopback hosts (127.0.0.1, ::1, localhost)');
    }
    if (profile.protocol === 'systemone') requireSystemOnePath(parsed);
    return parsed;
  }
  if (mode === 'resolved') {
    const origin = credentialOrigin(profile.credential);
    if (origin === null) {
      throw new ProfileEndpointError(
        `unknown credential slot ${JSON.stringify(profile.credential)} (valid: ${CREDENTIAL_SLOTS.join(', ')}, none)`,
      );
    }
    requireHttpsOrigin(parsed, origin, profile.credential);
    if (profile.protocol === 'systemone') requireSystemOnePath(parsed);
    return parsed;
  }
  // Explicit in-process key: the protocol shape still applies.
  if (parsed.protocol !== 'https:') {
    throw new ProfileEndpointError('credential-bearing endpoints must use https');
  }
  if (profile.protocol === 'systemone') requireSystemOnePath(parsed);
  return parsed;
}

/** Full config-time validation of one profile table (fail loud with a
 * stranger-actionable message). */
export function validateProviderProfile(profile: DecisionProviderProfile, label: string): void {
  if (!DECISION_PROTOCOLS.includes(profile.protocol)) {
    throw new ProfileEndpointError(`${label}.protocol must be one of: ${DECISION_PROTOCOLS.join(', ')}`);
  }
  if (profile.model.trim() === '') {
    throw new ProfileEndpointError(`${label}.model must be a non-empty string`);
  }
  if (profile.credential === KEYLESS_CREDENTIAL) {
    if (profile.protocol === 'openrouter-decisions') {
      throw new ProfileEndpointError(`${label}: the openrouter-decisions protocol requires a named credential slot (openrouter)`);
    }
  } else if (!CREDENTIAL_SLOTS.includes(profile.credential as CredentialSlot)) {
    throw new ProfileEndpointError(
      `${label}.credential must be one of: ${CREDENTIAL_SLOTS.join(', ')}, none`,
    );
  }
  if (!(Number.isFinite(profile.timeoutMs) && profile.timeoutMs > 0)) {
    throw new ProfileEndpointError(`${label}.timeout_ms must be a positive integer`);
  }
  if (!(Number.isFinite(profile.inputPricePerMtok) && profile.inputPricePerMtok >= 0)) {
    throw new ProfileEndpointError(`${label}.input_price_per_mtok must be a non-negative number`);
  }
  assertProfileEndpoint(profile, 'resolved');
}
