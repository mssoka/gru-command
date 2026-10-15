#!/usr/bin/env node
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPropertyCampaignHost, PropertyPipelineError, type ReviewedPropertyCampaign } from '../property/pipeline.js';
import { parsePropertyProposal } from '../property/proposal.js';

const USAGE = 'usage: node dist/cli/property-check.js --approve-reviewed-campaign <json> --artifacts-dir <owned-dir> [--trigger pull-request|scheduled]';
export class PropertyCheckUsageError extends Error {
  constructor(message: string) { super(message); this.name = 'PropertyCheckUsageError'; }
}
export function parseReviewedCampaign(value: unknown): ReviewedPropertyCampaign {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new PropertyCheckUsageError('reviewed campaign must be an object');
  const record = value as Record<string, unknown>;
  const keys = ['proposal', 'overlayFiles', 'knownBadRoot', 'healthyRoot', 'candidateRoot', 'baselineRoot', ...(record.implementationPaths === undefined ? [] : ['implementationPaths'])];
  if (record.implementationPaths !== undefined && (!Array.isArray(record.implementationPaths) || record.implementationPaths.length > 128 || !record.implementationPaths.every((path) => typeof path === 'string' && path.length <= 4096))) throw new PropertyCheckUsageError('implementationPaths must be at most 128 exact reviewed file paths');
  if (Object.keys(record).sort().join('\0') !== keys.sort().join('\0')) throw new PropertyCheckUsageError(`reviewed campaign keys must be exactly ${keys.join(', ')}; commands/install requests are never accepted`);
  const path = (key: string): string => {
    const raw = record[key];
    if (typeof raw !== 'string' || raw.trim() === '' || raw.length > 4096) throw new PropertyCheckUsageError(`${key} must be a bounded nonempty repository path`);
    return resolve(raw);
  };
  if (!Array.isArray(record.overlayFiles) || record.overlayFiles.length !== 1) throw new PropertyCheckUsageError('reviewed campaign requires one exact test overlay');
  const overlayFiles = record.overlayFiles.map((entry: unknown) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new PropertyCheckUsageError('overlay file must be an object');
    const file = entry as Record<string, unknown>;
    if (Object.keys(file).sort().join('\0') !== ['content', 'path'].join('\0') || typeof file.path !== 'string' || typeof file.content !== 'string') throw new PropertyCheckUsageError('overlay file keys must be exactly string path/content');
    return { path: file.path, content: file.content };
  });
  return { proposal: parsePropertyProposal(record.proposal), ...(record.implementationPaths === undefined ? {} : { implementationPaths: record.implementationPaths as string[] }), overlayFiles, knownBadRoot: path('knownBadRoot'), healthyRoot: path('healthyRoot'), candidateRoot: path('candidateRoot'), baselineRoot: record.baselineRoot === null ? null : path('baselineRoot') };
}
/** Explicit operator/CI invocation is the artifact-review decision. Never
 * invoke this from a reviewer command string, proposal or repo config. */
export async function runPropertyCheck(argv: readonly string[]): Promise<{ readonly exitCode: number; readonly stdout: string }> {
  try {
    const options = new Map<string, string>();
    for (let index = 0; index < argv.length; index += 2) {
      const flag = argv[index]!; const value = argv[index + 1];
      if (!['--approve-reviewed-campaign', '--artifacts-dir', '--trigger'].includes(flag) || value === undefined || value.startsWith('--') || options.has(flag)) throw new PropertyCheckUsageError('unknown, duplicate or incomplete option');
      options.set(flag, value);
    }
    const file = options.get('--approve-reviewed-campaign'); const artifactsDir = options.get('--artifacts-dir'); const trigger = options.get('--trigger') ?? 'pull-request';
    if (!file || !artifactsDir || !['pull-request', 'scheduled'].includes(trigger)) throw new PropertyCheckUsageError(USAGE);
    if (statSync(file).size > 128 * 1024) throw new PropertyCheckUsageError('reviewed campaign exceeds 128KiB');
    const spec = parseReviewedCampaign(JSON.parse(readFileSync(file, 'utf8')));
    const host = createPropertyCampaignHost();
    const report = await host.execute(host.approveReviewedCampaign(spec), { artifactsDir: resolve(artifactsDir), trigger: trigger as 'pull-request' | 'scheduled' });
    const inconclusive = report.mode !== 'disabled' && (report.qualification?.verdict !== 'qualified' || !['pass', 'property-failure'].includes(report.candidateOutcome ?? ''));
    const exitCode = report.mode === 'observation' ? 0 : inconclusive ? 2 : report.blocking ? 1 : 0;
    return { exitCode, stdout: JSON.stringify(report, null, 2) };
  } catch (error) {
    return { exitCode: error instanceof PropertyCheckUsageError ? 2 : 1, stdout: `${error instanceof PropertyPipelineError ? error.name : 'property-check refused'}: ${String(error)}\n${USAGE}` };
  }
}
if (process.argv[1]?.endsWith('/property-check.js')) void runPropertyCheck(process.argv.slice(2)).then(({ stdout, exitCode }) => { process.stdout.write(`${stdout}\n`); process.exitCode = exitCode; });
