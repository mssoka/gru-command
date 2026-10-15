// Test-only transport seams in an isolated archive of the reviewed candidate.
// No classifier, deny rule, child registration, close/capacity/kill behavior is
// changed. This makes controlled start-path injections and its shipped hook
// available when Vitest loads TypeScript source rather than installed JS.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
const root = process.argv[2];
if (!root) throw new Error('require owned reviewed-candidate archive path');
const adapter = join(root, 'src/runtime/claude-adapter.ts');
let text = readFileSync(adapter, 'utf8');
for (const [before, after] of [
  ['  readonly binary?: string;', '  readonly binary?: string;\n  readonly spawnProcess?: typeof spawn;'],
  ['  private readonly binary: string;', '  private readonly binary: string;\n  private readonly spawnProcess: typeof spawn;'],
  ["    this.binary = opts.binary ?? 'claude';", "    this.binary = opts.binary ?? 'claude';\n    this.spawnProcess = opts.spawnProcess ?? spawn;"],
  ['          binary: this.binary,', '          binary: this.binary,\n          spawnProcess: this.spawnProcess,'],
  ['  readonly binary: string;', '  readonly binary: string;\n  readonly spawnProcess?: typeof spawn;'],
  ['child = spawn(params.binary,', 'child = (params.spawnProcess ?? spawn)(params.binary,'],
]) {
  if (!text.includes(before)) throw new Error(`Reviewed archive seam is absent: ${before}`);
  text = text.replaceAll(before, after);
}
writeFileSync(adapter, text);
const settings = join(root, 'src/runtime/claude-verification-settings.ts');
text = readFileSync(settings, 'utf8');
const before = "new URL('./worker-verification-hook.js', import.meta.url)";
if (!text.includes(before)) throw new Error('Reviewed archive hook-location seam is absent');
writeFileSync(settings, text.replace(before, "new URL('../../dist/runtime/worker-verification-hook.js', import.meta.url)"));
process.stdout.write('Reviewed archive: start-process injection and compiled-hook-location seams only; policy/registration/cessation/kill/capacity bytes unchanged\n');
