/** Only these published CLI model names and provider spellings may enter a
 * Claude recovery manifest. The CLI discards the provider prefix, so lexical
 * validity alone cannot prove that prefix is not a user-supplied credential. */
const PUBLIC_CLAUDE_MODELS: ReadonlySet<string> = new Set([
  'sonnet', 'opus', 'haiku',
  'claude-fable-5', 'claude-fable-5-1', 'claude-haiku-4-5', 'claude-haiku-4-5-20251001',
  'claude-opus-4-5', 'claude-opus-4-5-20251101', 'claude-opus-4-6', 'claude-opus-4-7',
  'claude-opus-4-8', 'claude-opus-5', 'claude-sonnet-4-5', 'claude-sonnet-4-5-20250929',
  'claude-sonnet-4-6', 'claude-sonnet-5',
]);
const PUBLIC_CLAUDE_EFFORT: ReadonlySet<string> = new Set([
  'default', 'low', 'medium', 'high', 'xhigh', 'max', 'ultracode',
]);
const PUBLIC_PI_THINKING: ReadonlySet<string> = new Set([
  'default', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max',
]);

export function publicRecoveryModelIdentity(input: {
  readonly runtimeId: string;
  readonly modelRef: string;
  readonly settingsModel?: string;
  readonly thinkingLevel?: string;
  readonly routingSha256?: string;
}): boolean {
  const thinking = input.thinkingLevel ?? 'default';
  if (input.runtimeId === 'pi') {
    // Pi's adapter validates its resolved public provider/model/API/catalog
    // fields before it issues a routing digest. No custom route is reusable.
    return PUBLIC_PI_THINKING.has(thinking) && input.routingSha256 !== undefined;
  }
  if (input.runtimeId !== 'claude-code' || !PUBLIC_CLAUDE_EFFORT.has(thinking) ||
    input.routingSha256 !== undefined) return false;
  const parts = input.modelRef.split('/');
  const model = parts.length === 1 ? parts[0] :
    parts.length === 2 && parts[0] === 'anthropic' ? parts[1] : undefined;
  return model !== undefined && PUBLIC_CLAUDE_MODELS.has(model) &&
    (input.settingsModel === undefined || PUBLIC_CLAUDE_MODELS.has(input.settingsModel));
}
