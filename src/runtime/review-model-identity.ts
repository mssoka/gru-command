/** A Claude recovery manifest persists the configured model reference. The
 * CLI discards a provider prefix, so an arbitrary prefix is unverifiable (it
 * could be pasted credential material that the CLI silently ignores): only a
 * bare CLI model or the `anthropic/` spelling may enter the manifest. The
 * model itself is checked by SHAPE only — never against a list of published
 * names, which every model release would make stale (owner ruling
 * 2026-10-15). A credential in the model position is not silent: the CLI
 * sends it as the model name and the turn fails at once. */
const CLAUDE_MODEL_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@[\]-]{0,127}$/u;
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
  return model !== undefined && CLAUDE_MODEL_TOKEN.test(model) &&
    (input.settingsModel === undefined || CLAUDE_MODEL_TOKEN.test(input.settingsModel));
}
