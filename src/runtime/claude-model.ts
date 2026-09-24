/** The Claude CLI owns model discovery. Explicit provider/model references
 * retain the adapter's existing first-segment stripping; native bare CLI
 * aliases and IDs are passed through without consulting pi's catalog. */
export function claudeCliModel(ref: string): string | undefined {
  if (ref === '' || ref === 'default') return undefined;
  const slash = ref.indexOf('/');
  if (slash === -1) return ref;
  if (slash === 0 || slash === ref.length - 1) {
    throw new Error(`model reference must be "provider/model", a CLI model id, or "default", got: ${ref}`);
  }
  return ref.slice(slash + 1);
}

/** Cheap authenticated CLI call; this never submits review findings. */
export function buildClaudeCodeAuthArgs(modelRef: string): string[] {
  const model = claudeCliModel(modelRef);
  return ['-p', 'reply with exactly: ok', '--max-turns', '1', '--no-session-persistence',
    ...(model === undefined ? [] : ['--model', model])];
}
