/** A Claude recovery manifest persists the configured model reference. The
 * CLI discards a provider prefix, so an arbitrary prefix is unverifiable (it
 * could be pasted credential material that the CLI silently ignores): only a
 * bare CLI model or the `anthropic/` spelling may enter the manifest. The
 * model itself is checked by SHAPE only — never against a list of published
 * names, which every model release would make stale (owner ruling
 * 2026-10-15). Published model ids are lowercase (`claude-opus-5-5`,
 * `us.anthropic.claude-…-v1:0`, `claude-…@20251001`, `opus[1m]`) while API
 * keys and tokens are long mixed-case strings, so the lowercase rule keeps
 * credential material out of the persisted manifest without naming models. */
const PUBLIC_MODEL_TOKEN = /^[a-z0-9][a-z0-9._:@[\]-]{0,127}$/u;

/** Shape-only public model id check (shared by the Claude manifest and pi's
 * review-routing reuse): never a list of published names. */
export function isPublicModelToken(id: string): boolean {
  return PUBLIC_MODEL_TOKEN.test(id);
}
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
  return model !== undefined && isPublicModelToken(model) &&
    (input.settingsModel === undefined || isPublicModelToken(input.settingsModel));
}
