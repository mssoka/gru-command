import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { bindWorkflowRuntime, loadBundledWorkflowRuntime, renderWorkflow, writeWorkflowManifest, type WorkflowContext } from '../workflows/runtime.js';
import { WorkflowResourceError, WORKFLOW_ENTRYPOINTS, type WorkflowRoute } from '../workflows/manifest.js';

const USAGE = 'usage: workflow-runtime verify|manifest [package-root] [--version <n>]\n' +
  '       workflow-runtime render --context <file.json> --store <dir> [--package-root <dir>] [--route normal|small-change|plan|review]';

export function runWorkflowRuntimeCli(args: readonly string[], write: (line: string) => void): number {
  const [command, ...argv] = args;
  if (command === 'verify' && argv.length <= 1 && !argv[0]?.startsWith('--')) {
    const runtime = loadBundledWorkflowRuntime(resolve(argv[0] ?? '.'));
    write(`GC workflow ${runtime.id} verified (content sha256 ${runtime.contentSha256})`);
    return 0;
  }
  if (command === 'manifest') {
    const root = argv[0]?.startsWith('--') === false ? argv.shift()! : '.';
    let version: number | undefined;
    if (argv.length === 2 && argv[0] === '--version' && /^[1-9][0-9]*$/u.test(argv[1]!)) version = Number(argv[1]);
    else if (argv.length > 0) throw new WorkflowResourceError(USAGE);
    const manifest = writeWorkflowManifest(resolve(root), version);
    write(`GC workflow ${manifest.id} manifest refreshed from owned local resources`);
    return 0;
  }
  if (command === 'render') {
    const options = new Map<string, string>();
    while (argv.length > 0) {
      const flag = argv.shift()!;
      const value = argv.shift();
      if (!['--context', '--store', '--package-root', '--route'].includes(flag) || options.has(flag) || value === undefined || value.startsWith('--')) {
        throw new WorkflowResourceError(USAGE);
      }
      options.set(flag, value);
    }
    const contextFile = options.get('--context');
    const store = options.get('--store');
    const route = options.get('--route') ?? 'normal';
    if (contextFile === undefined || store === undefined || !Object.hasOwn(WORKFLOW_ENTRYPOINTS, route)) throw new WorkflowResourceError(USAGE);
    const context = JSON.parse(readFileSync(resolve(contextFile), 'utf-8')) as WorkflowContext;
    if (typeof context.worktreeRoot !== 'string') throw new WorkflowResourceError('GC workflow context lacks worktreeRoot');
    const binding = bindWorkflowRuntime(context.worktreeRoot, {
      storeRoot: resolve(store), bundled: () => loadBundledWorkflowRuntime(resolve(options.get('--package-root') ?? '.')),
    });
    const result = renderWorkflow(binding, context, route as WorkflowRoute);
    write(JSON.stringify(result));
    return 0;
  }
  throw new WorkflowResourceError(USAGE);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.exitCode = runWorkflowRuntimeCli(process.argv.slice(2), (line) => process.stdout.write(`${line}\n`));
  } catch (error) {
    process.stderr.write(`workflow-runtime: ${(error as Error).name}: ${(error as Error).message}\n`);
    process.exitCode = 1;
  }
}
