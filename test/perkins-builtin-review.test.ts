import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertFrozenPromptBounds,
  baseMovedSinceFreeze,
  chunkUnifiedDiff,
  freezeReviewInputs,
  FROZEN_CHUNK_MAX_BYTES,
  FROZEN_DIFF_MAX_BYTES,
  FROZEN_SPEC_MAX_BYTES,
  resolveReviewBaseRef,
  reviewArtifactDirectory,
  writeReviewArtifact,
  type FrozenReview,
} from '../src/dispatch/perkins-review/artifacts.js';
import { loadPerkinsPolicy, PERKINS_LENSES, PERKINS_POLICY_SHA256 } from '../src/dispatch/perkins-review/policy.js';
import { finalAssistantText } from '../src/dispatch/perkins-review/session-output.js';
import {
  PerkinsHybridReview,
  PERKINS_REPORT_MAX_BYTES,
  type PerkinsHybridResult,
} from '../src/dispatch/perkins-review/hybrid.js';
import {
  dedupeVerifiedFindings,
  parseFindings,
  parseFindingsSubmission,
  parseFindingsWithRecovery,
  parseFixAuditResults,
  parseVerificationResults,
  verdictForFindings,
  type ReviewFinding,
  type VerifiedFinding,
} from '../src/dispatch/perkins-review/types.js';
import { makeFixtureRepo, type FixtureRepo } from './helpers/fixture-repo.js';
import { fakeHybridSpawner, type HybridSubmission, type LeadBrainOptions } from './helpers/perkins-hybrid-double.js';
import { ReviewMcpBridge } from '../src/runtime/review-mcp-bridge.js';
import { PiRuntime } from '../src/runtime/pi-adapter.js';
import { SessionStore } from '../src/sessions/store.js';
import { configPathFor, loadConfig } from '../src/config.js';
import type { NativeAgentTool } from '../src/runtime/types.js';

const repos: FixtureRepo[] = [];
const temporaryDirectories: string[] = [];
function temp(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}
afterEach(() => {
  while (repos.length > 0) repos.pop()!.cleanup();
  while (temporaryDirectories.length > 0) rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
});

function lensFrom(prompt: string): string {
  if (prompt.includes('source=blind')) return 'blind';
  return /"source": "(blind|edge|acceptance|security|architecture|codebase|tests)"/.exec(prompt)?.[1] ??
    /Your lens id is "(blind|edge|acceptance|security|architecture|codebase|tests)"/.exec(prompt)?.[1] ??
    'unknown';
}

function finding(source: string, severity: 'blocker' | 'warning' | 'note' = 'blocker', overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    source: source as ReviewFinding['source'],
    severity,
    category: 'correctness',
    title: `${source} grounded defect`,
    location: 'src/main.ts:1',
    evidence: 'export function answer(): number {',
    detail: 'The exact changed function demonstrates the defect.',
    recommended_fix: 'Correct the function and retain a regression test.',
    ...overrides,
  };
}

/** The blind prose-citation shape that killed three review rounds: verbatim
 * evidence, but a description where the contract demands "<path>:<line>". */
function proseCitation(): ReviewFinding {
  return finding('blind', 'warning', {
    location: 'src/main.ts (answer, return branch)',
    evidence: 'export function answer(): number {',
  });
}

interface ChildEnvelopeFile {
  readonly status: string;
  readonly outputSha256: string | null;
  readonly recovery?: string;
  readonly failureKind?: string;
  readonly error?: string;
  readonly findings: ReadonlyArray<{ readonly title: string; readonly source: string }>;
}

function childEnvelopePaths(directory: string, lens: string, attempt: 1 | 2): { readonly envelope: string; readonly raw: string } {
  const envelopeDir = join(directory, 'lenses', '001');
  const entries = readdirSync(envelopeDir);
  const envelope = entries.find((entry) => new RegExp(`^${lens}\\.attempt-${attempt}-[0-9a-f]+\\.envelope\\.json$`, 'u').test(entry));
  const raw = entries.find((entry) => new RegExp(`^${lens}\\.attempt-${attempt}-[0-9a-f]+\\.raw\\.json$`, 'u').test(entry));
  expect(envelope, `missing ${lens} attempt-${attempt} envelope`).toBeDefined();
  expect(raw, `missing ${lens} attempt-${attempt} raw output`).toBeDefined();
  return { envelope: join(envelopeDir, envelope!), raw: join(envelopeDir, raw!) };
}

function readChildEnvelope(directory: string, lens: string, attempt: 1 | 2): ChildEnvelopeFile {
  return JSON.parse(readFileSync(childEnvelopePaths(directory, lens, attempt).envelope, 'utf8')) as ChildEnvelopeFile;
}

function makeReviewRepo(name = 'perkins-hybrid'): { repo: FixtureRepo; base: string; target: string } {
  const repo = makeFixtureRepo(name);
  const base = repo.head();
  repo.git(['checkout', '-b', 'feature/review']);
  const target = repo.commitFile('src/main.ts', 'export function answer(): number {\n  return 43;\n}\n');
  return { repo, base, target };
}

interface HybridHarness {
  readonly repo: FixtureRepo;
  readonly base: string;
  readonly target: string;
  readonly root: string;
  readonly frozen: FrozenReview;
  readonly calls: ReturnType<typeof fakeHybridSpawner>['calls'];
  readonly leadCalls: ReturnType<typeof fakeHybridSpawner>['leadCalls'];
  readonly childCalls: ReturnType<typeof fakeHybridSpawner>['childCalls'];
  readonly toolErrors: ReturnType<typeof fakeHybridSpawner>['toolErrors'];
  readonly preflightResults: ReturnType<typeof fakeHybridSpawner>['preflightResults'];
  readonly recordResults: ReturnType<typeof fakeHybridSpawner>['recordResults'];
  run(input?: { noSpec?: boolean; priorConsolidatedFile?: string }): Promise<PerkinsHybridResult>;
}

function hybridHarness(brain: LeadBrainOptions, options?: { noSpec?: boolean; spec?: string; priorConsolidatedFile?: string; beforeFreeze?: (repo: FixtureRepo) => void }): HybridHarness {
  const fixture = makeReviewRepo();
  repos.push(fixture.repo);
  options?.beforeFreeze?.(fixture.repo);
  const base = fixture.repo.git(['rev-parse', 'main']);
  const target = fixture.repo.head();
  const root = temp('perkins-hybrid-test-');
  const frozen = freezeReviewInputs({
    roundId: 'hybrid-round',
    repoPath: fixture.repo.path,
    artifactRoot: root,
    baseRef: base,
    targetRef: target,
    movementRef: 'feature/review',
    ...(options?.noSpec === true
      ? { noSpec: true }
      : { spec: options?.spec ?? 'return 43' }),
  });
  const fake = fakeHybridSpawner(temp('perkins-hybrid-sessions-'), brain);
  const engine = new PerkinsHybridReview({ spawner: fake.spawner, policy: loadPerkinsPolicy() });
  return {
    ...fixture,
    base,
    target,
    root,
    frozen,
    calls: fake.calls,
    leadCalls: fake.leadCalls,
    childCalls: fake.childCalls,
    toolErrors: fake.toolErrors,
    preflightResults: fake.preflightResults,
    recordResults: fake.recordResults,
    run: (input = {}) => engine.run({
      roundId: 'hybrid-round',
      roundNumber: 1,
      frozenReview: frozen,
      movementRef: 'feature/review',
      noSpec: input.noSpec ?? options?.noSpec ?? false,
      ...(input.priorConsolidatedFile !== undefined || options?.priorConsolidatedFile !== undefined
        ? { priorConsolidatedFile: input.priorConsolidatedFile ?? options?.priorConsolidatedFile }
        : {}),
    }),
  };
}

function indirectFixHarness(options: {
  readonly audit?: Record<string, unknown> | (() => Record<string, unknown>);
  readonly priorCallerContent?: string;
  readonly priorHelperContent?: string;
  readonly priorHistoricalHunk?: boolean;
  readonly priorExtraSource?: string;
  readonly priorCallerBytes?: Buffer;
  readonly priorFinding?: Partial<ReviewFinding>;
  readonly priorDisposition?: 'confirmed' | 'unverifiable-speculative';
  readonly priorSha?: string;
  readonly afterPrior?: (repo: FixtureRepo) => void;
  readonly useBaseAsPrior?: boolean;
  readonly submitPayload?: LeadBrainOptions['submitPayload'];
  readonly preflight?: LeadBrainOptions['preflight'];
  readonly transformReport?: LeadBrainOptions['transformReport'];
  readonly onPriorDelta?: LeadBrainOptions['onPriorDelta'];
  readonly priorDeltaPath?: LeadBrainOptions['priorDeltaPath'];
} = {}) {
  const repo = makeFixtureRepo('indirect-audit');
  repos.push(repo);
  const base = repo.head();
  repo.git(['checkout', '-b', 'feature/review']);
  repo.commitFile('src/helper.ts', options.priorHelperContent ?? 'export function helper(ref: string): string { return ref.slice(ref.indexOf("/") + 1); }\n');
  const priorDiffBase = options.priorHistoricalHunk === true ? repo.head() : base;
  if (options.priorHistoricalHunk === true) repo.commitFile('src/helper.ts', 'export function helper(ref: string): string { return nativeRef; }\n');
  if (options.priorExtraSource !== undefined) repo.commitFile('src/secondary.ts', options.priorExtraSource);
  let priorTarget = repo.commitFile('src/caller.ts', options.priorCallerContent ?? 'const unchanged = true;\nconst selected = nativeRef;\n');
  if (options.priorCallerBytes !== undefined) {
    writeFileSync(join(repo.path, 'src/caller.ts'), options.priorCallerBytes);
    repo.git(['add', 'src/caller.ts']);
    repo.git(['-c', 'user.name=Fixture Tests', '-c', 'user.email=tests@example.invalid', 'commit', '-m', 'prior raw caller']);
    priorTarget = repo.head();
  }
  options.afterPrior?.(repo);
  if (options.afterPrior === undefined) repo.commitFile('src/caller.ts', 'const unchanged = true;\nconst selected = nativeSetting;\n');
  const root = temp('perkins-indirect-');
  const priorFile = join(root, 'prior.json');
  writeFileSync(priorFile, JSON.stringify({
    schemaVersion: 2,
    frozen: { targetSha: options.useBaseAsPrior === true ? base : options.priorSha ?? priorTarget,
      ...(options.priorHistoricalHunk === true ? { diffBaseSha: priorDiffBase } : {}) },
    findings: [{
      ...finding('security', 'warning', {
        title: 'Native settings token reaches the prefix stripper', location: 'src/helper.ts:1',
        evidence: 'return ref.slice(ref.indexOf("/") + 1);', ...options.priorFinding,
      }),
      sources: ['security'], chunks: ['001'], roundOrigin: 1,
      verification: { disposition: options.priorDisposition ?? 'confirmed', evidence: options.priorDisposition === 'unverifiable-speculative' ? 'N/A' : 'return ref.slice(ref.indexOf("/") + 1);', reason: 'verified in prior round' },
    }],
  }));
  const frozen = freezeReviewInputs({
    roundId: 'indirect-audit-round', repoPath: repo.path, artifactRoot: root,
    baseRef: base, targetRef: repo.head(), movementRef: 'feature/review', spec: 'preserve native settings selection',
  });
  const fake = fakeHybridSpawner(temp('perkins-indirect-sessions-'), {
    childAnswer: () => '[]', preflight: options.preflight ?? { calls: 1 },
    submitRetries: options.submitPayload === undefined ? 0 : 1,
    ...(options.submitPayload === undefined ? {} : { submitPayload: options.submitPayload }),
    ...(options.transformReport === undefined ? {} : { transformReport: options.transformReport }),
    ...(options.onPriorDelta === undefined ? {} : { onPriorDelta: options.onPriorDelta }),
    ...(options.priorDeltaPath === undefined ? {} : { priorDeltaPath: options.priorDeltaPath }),
    priorAudit: () => {
      const override = typeof options.audit === 'function' ? options.audit() : options.audit;
      const audit = {
        prior_index: 0, status: 'fixed', evidence: 'const selected = nativeSetting;',
        reason: 'The caller now supplies the native setting without passing it through the unchanged helper.',
        fix_location: { path: 'src/caller.ts', change: 'added' }, ...override,
      };
      if (override !== undefined && Object.hasOwn(override, 'fix_location') && override.fix_location === undefined) {
        const { fix_location: _omitted, ...legacy } = audit;
        return [legacy as HybridSubmission['prior_audit'][number]];
      }
      return [audit as HybridSubmission['prior_audit'][number]];
    },
  });
  const engine = new PerkinsHybridReview({ spawner: fake.spawner, policy: loadPerkinsPolicy() });
  return { repo, priorFile, frozen, fake, run: () => engine.run({
    roundId: 'indirect-audit-round', roundNumber: 2, frozenReview: frozen,
    movementRef: 'feature/review', noSpec: false, priorConsolidatedFile: priorFile,
  }) };
}

describe('bundled Perkins policy and deterministic contracts', () => {
  it('loads the integrity-pinned canonical seven-lens resource with the hybrid lead workflow', () => {
    const policy = loadPerkinsPolicy();
    expect(policy.identity).toBe('perkins-code-review');
    expect(policy.portableContract.rules.fullLenses).toEqual(PERKINS_LENSES);
    expect(policy.provenance.sourceSha256).toHaveLength(64);
    expect(PERKINS_POLICY_SHA256).toHaveLength(64);
    expect(policy.hostReplacements.join(' ')).toContain('Herdr');
    expect(policy.portableContract.outputContracts.blindText).toContain('"recommended_fix": "the concrete change');
    expect(policy.portableContract.outputContracts.nativeTool).toContain('perkins_submit_findings');
    expect(policy.portableContract.outputContracts.blindNativeTool).toContain('perkins_submit_findings');
    expect(policy.portableContract.sharedPrompt).toContain('{{OUTPUT_CONTRACT}}');
    expect(policy.portableContract.leadWorkflow).toContain('perkins_submit_review');
    expect(policy.portableContract.leadWorkflow).toContain('INCOMPLETE never approves');
  });

  it('verifies installed-root containment and rejects a policy symlink that escapes the product', () => {
    const root = temp('perkins-installed-root-');
    const policyDir = join(root, 'resources', 'perkins-code-review');
    const moduleDir = join(root, 'dist', 'dispatch', 'perkins-review');
    mkdirSync(policyDir, { recursive: true });
    mkdirSync(moduleDir, { recursive: true });
    mkdirSync(join(root, 'dist', 'runtime'), { recursive: true });
    const serverBytes = readFileSync(join(import.meta.dirname, '..', 'src', 'runtime', 'review-mcp-server.mjs'));
    writeFileSync(join(root, 'dist', 'runtime', 'review-mcp-server.mjs'), serverBytes);
    const serverHash = createHash('sha256').update(serverBytes).digest('hex');
    writeFileSync(
      join(root, 'dist', 'runtime', 'review-mcp-bridge.js'),
      `export const PERKINS_MCP_SERVER_SHA256 = '${serverHash}';\n`,
      'utf8',
    );
    writeFileSync(join(root, 'package.json'), '{"type":"module"}\n', 'utf8');
    const source = readFileSync(join(import.meta.dirname, '..', 'resources', 'perkins-code-review', 'policy.json'));
    const hash = createHash('sha256').update(source).digest('hex');
    const policy = JSON.parse(source.toString('utf8')) as { provenance: { sourceSha256: string } };
    const policyFile = join(policyDir, 'policy.json');
    writeFileSync(policyFile, source);
    const loaderFile = join(moduleDir, 'policy.js');
    const loader = (expectedHash: string) => `
      import { readFileSync } from 'node:fs';
      import { fileURLToPath } from 'node:url';
      export const PERKINS_POLICY_FILE = fileURLToPath(new URL('../../../resources/perkins-code-review/policy.json', import.meta.url));
      export const PERKINS_POLICY_SHA256 = '${expectedHash}';
      export const PERKINS_CANONICAL_SOURCE_SHA256 = '${policy.provenance.sourceSha256}';
      export function loadPerkinsPolicy() { return JSON.parse(readFileSync(PERKINS_POLICY_FILE, 'utf8')); }
    `;
    writeFileSync(loaderFile, loader(hash), 'utf8');
    const verifier = join(import.meta.dirname, '..', 'tools', 'verify-perkins-resource.mjs');
    for (const args of [[verifier], [verifier, '   ']]) {
      const usage = spawnSync(process.execPath, args, { encoding: 'utf8' });
      expect(usage.status).toBe(2);
      expect(usage.stdout).toBe('');
      expect(usage.stderr).toBe('usage: node tools/verify-perkins-resource.mjs <installed-product-root>\n');
    }
    expect(() => execFileSync(process.execPath, [verifier, root], { encoding: 'utf8' })).not.toThrow();
    const productRoot = join(import.meta.dirname, '..');
    expect(() => execFileSync(process.execPath, [verifier, productRoot], {
      encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: temp('perkins-empty-home-') },
    })).not.toThrow();

    const excludedMarkers = [
      ['j', 'ev'],
      ['open', 'router'],
      ['decision', 'service'],
      ['api', 'alpha', 'decisions'],
      ['open', 'router', 'api', 'key'],
    ].map((parts) => parts.join(''));
    const roles = join(root, 'roles');
    mkdirSync(roles, { recursive: true });
    const contentResidue = join(roles, 'residue.md');
    for (const marker of excludedMarkers) {
      writeFileSync(contentResidue, `excluded ${marker} product byte`, 'utf8');
      expect(() => execFileSync(process.execPath, [verifier, root], { encoding: 'utf8', stdio: 'pipe' }))
        .toThrow(/excluded product residue found in file/);
    }
    rmSync(contentResidue);
    const pathResidue = join(roles, `${excludedMarkers[0]}-pilot.md`);
    writeFileSync(pathResidue, 'path-only residue', 'utf8');
    expect(() => execFileSync(process.execPath, [verifier, root], { encoding: 'utf8', stdio: 'pipe' }))
      .toThrow(/excluded product residue found in path/);
    rmSync(pathResidue);

    // Separator/case variants of the vendor identifiers must also fail.
    for (const variant of [
      `${['OPEN', 'ROUTER', '_API_KEY=redacted'].join('')}`,
      `${['decision', '-service residue'].join('')}`,
      `endpoint https://x.example/${['api', '/', 'alpha', '/', 'decisions'].join('')}`,
      `${['Decision', ' Service prose'].join('')}`,
    ]) {
      writeFileSync(contentResidue, variant, 'utf8');
      expect(() => execFileSync(process.execPath, [verifier, root], { encoding: 'utf8', stdio: 'pipe' }))
        .toThrow(/excluded product residue found in file/);
    }
    rmSync(contentResidue);

    // A symlink planted inside a scanned entry must be refused outright.
    const symlinkResidue = join(roles, 'link.md');
    symlinkSync(join(root, 'package.json'), symlinkResidue);
    expect(() => execFileSync(process.execPath, [verifier, root], { encoding: 'utf8', stdio: 'pipe' }))
      .toThrow(/residue scan refuses symlink/u);
    unlinkSync(symlinkResidue);

    // Missing TOP-LEVEL entries are tolerated (optional shipped paths); the
    // walker rethrows any nested ENOENT so a mid-walk disappearance fails
    // verification loudly (structural guarantee in scanFile/visit).
    rmSync(join(root, 'web'), { recursive: true, force: true });
    expect(() => execFileSync(process.execPath, [verifier, root], { encoding: 'utf8', stdio: 'pipe' })).not.toThrow();
    mkdirSync(join(root, 'web'), { recursive: true });

    // A shipped file over the per-file scan bound fails closed.
    writeFileSync(join(roles, 'oversize.md'), 'x'.repeat(17 * 1024 * 1024), 'utf8');
    expect(() => execFileSync(process.execPath, [verifier, root], { encoding: 'utf8', stdio: 'pipe' }))
      .toThrow(/byte bound exceeded/u);
    rmSync(join(roles, 'oversize.md'));

    writeFileSync(policyFile, `${source.toString('utf8')}corrupt`, 'utf8');
    expect(() => execFileSync(process.execPath, [verifier, root], { encoding: 'utf8', stdio: 'pipe' })).toThrow();
    writeFileSync(policyFile, source);

    const serverFile = join(root, 'dist', 'runtime', 'review-mcp-server.mjs');
    writeFileSync(serverFile, Buffer.concat([serverBytes, Buffer.from('\n// corrupt\n')]));
    expect(() => execFileSync(process.execPath, [verifier, root], { encoding: 'utf8', stdio: 'pipe' })).toThrow();
    writeFileSync(serverFile, serverBytes);
    const externalServer = join(temp('perkins-external-server-'), 'review-mcp-server.mjs');
    writeFileSync(externalServer, serverBytes);
    unlinkSync(serverFile);
    symlinkSync(externalServer, serverFile);
    expect(() => execFileSync(process.execPath, [verifier, root], { encoding: 'utf8', stdio: 'pipe' })).toThrow();
    unlinkSync(serverFile);
    writeFileSync(serverFile, serverBytes);

    const wrongProvenance = structuredClone(policy);
    wrongProvenance.provenance.sourceSha256 = '0'.repeat(64);
    const wrongBytes = `${JSON.stringify(wrongProvenance, null, 2)}\n`;
    writeFileSync(policyFile, wrongBytes, 'utf8');
    writeFileSync(loaderFile, loader(createHash('sha256').update(wrongBytes).digest('hex')), 'utf8');
    expect(() => execFileSync(process.execPath, [verifier, root], { encoding: 'utf8', stdio: 'pipe' })).toThrow();
    writeFileSync(policyFile, source);
    writeFileSync(loaderFile, loader(hash), 'utf8');

    const outside = join(temp('perkins-external-policy-'), 'policy.json');
    writeFileSync(outside, source);
    unlinkSync(policyFile);
    symlinkSync(outside, policyFile);
    expect(() => execFileSync(process.execPath, [verifier, root], { encoding: 'utf8', stdio: 'pipe' })).toThrow();
  });

  // The packed product is rebuilt end-to-end (`npm pack` runs prepack:
  // build:web + backend build + verifier). Under a loaded shared machine the
  // subprocess has been observed past 120s, so it gets 300s and the test 360s:
  // the subprocess bound fires cleanly before the test bound, instead of
  // vitest killing npm and orphaning a half-finished build tree.
  it('packs, extracts, verifies, and MCP-smokes the rebuilt source-free product under an empty home', async () => {
    const productRoot = join(import.meta.dirname, '..');
    const packRoot = temp('perkins-pack-source-');
    const tarRoot = temp('perkins-pack-tar-');
    const extractRoot = temp('perkins-pack-extract-');
    const emptyHome = temp('perkins-source-free-home-');
    mkdirSync(join(emptyHome, '.pi', 'agent', 'skills'), { recursive: true });
    for (const entry of [
      'package.json', 'package-lock.json', 'tsconfig.json', 'README.md', 'LICENSE', 'install.sh',
      'src', 'resources', 'roles', 'tools', 'install',
    ]) cpSync(join(productRoot, entry), join(packRoot, entry), { recursive: true });
    // web's tsc typechecks its e2e specs, which import the shared real-service
    // helper from the parent tree — the pack staging needs it for build:web.
    mkdirSync(join(packRoot, 'test', 'helpers'), { recursive: true });
    for (const entry of ['real-service.mjs', 'real-service.d.mts']) {
      cpSync(
        join(productRoot, 'test', 'helpers', entry),
        join(packRoot, 'test', 'helpers', entry),
      );
    }
    mkdirSync(join(packRoot, 'web'), { recursive: true });
    for (const entry of [
      'package.json', 'tsconfig.json', 'vite.config.ts', 'vitest.config.ts', 'playwright.config.ts',
      'index.html', 'src', 'mock', 'e2e',
    ]) {
      cpSync(join(productRoot, 'web', entry), join(packRoot, 'web', entry), { recursive: true });
    }
    symlinkSync(join(productRoot, 'node_modules'), join(packRoot, 'node_modules'), 'dir');
    mkdirSync(join(packRoot, 'dist'), { recursive: true });
    mkdirSync(join(packRoot, 'web', 'dist'), { recursive: true });
    writeFileSync(join(packRoot, 'dist', 'stale-before-prepack.txt'), 'must be cleaned', 'utf8');
    writeFileSync(join(packRoot, 'web', 'dist', 'stale-before-prepack.txt'), 'must be cleaned', 'utf8');

    const packOutput = execFileSync('npm', ['pack', '--json', '--pack-destination', tarRoot], {
      cwd: packRoot,
      encoding: 'utf8',
      timeout: 300_000,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, HOME: emptyHome, PI_CODING_AGENT_DIR: join(emptyHome, '.pi', 'agent') },
    });
    const jsonStart = packOutput.lastIndexOf('\n[\n  {');
    const packed = JSON.parse(packOutput.slice(jsonStart === -1 ? packOutput.indexOf('[') : jsonStart + 1)) as
      Array<{ filename: string; files: Array<{ path: string }> }>;
    const packedFiles = packed[0]?.files.map((entry) => entry.path).sort() ?? [];
    expect(packedFiles).toEqual(expect.arrayContaining([
      'dist/runtime/review-mcp-bridge.js',
      'dist/runtime/review-mcp-server.mjs',
      'resources/perkins-code-review/policy.json',
      'tools/verify-perkins-resource.mjs',
      'install.sh',
      'install/launchd/com.gru-command.service.plist.template',
      'install/systemd/gru-command.service.template',
      'roles/perkins.md',
      'web/dist/index.html',
    ]));
    const excludedMarker = ['j', 'ev'].join('');
    expect(packedFiles.some((file) =>
      file.startsWith('src/') || file.startsWith('_bmad/') || file.toLowerCase().includes(excludedMarker),
    )).toBe(false);
    expect(packedFiles).not.toContain('dist/stale-before-prepack.txt');
    expect(packedFiles).not.toContain('web/dist/stale-before-prepack.txt');

    execFileSync('tar', ['-xzf', join(tarRoot, packed[0]!.filename), '-C', extractRoot]);
    const stage = join(extractRoot, 'package');
    expect(existsSync(join(stage, 'src'))).toBe(false);
    expect(() => execFileSync(process.execPath, [join(stage, 'tools', 'verify-perkins-resource.mjs'), stage], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', HOME: emptyHome, PI_CODING_AGENT_DIR: join(emptyHome, '.pi', 'agent') },
    })).not.toThrow();

    const smokeFile = join(stage, 'source-free-smoke.mjs');
    writeFileSync(smokeFile, `
      import { readFileSync, realpathSync } from 'node:fs';
      import { spawn } from 'node:child_process';
      import { loadPerkinsPolicy } from './dist/dispatch/perkins-review/policy.js';
      import { loadSilasSkills } from './dist/dispatch/silas-driver.js';
      import { ReviewMcpBridge } from './dist/runtime/review-mcp-bridge.js';
      const bridge = await ReviewMcpBridge.start([{
        name: 'perkins_probe', description: 'staged probe', inputSchema: { type: 'object' },
        execute: async () => ({ text: 'stage-ok' }),
      }]);
      const config = JSON.parse(readFileSync(bridge.configFile, 'utf8'));
      const server = config.mcpServers.gru_perkins;
      if (realpathSync(server.args[0]) !== realpathSync('./dist/runtime/review-mcp-server.mjs')) {
        throw new Error('MCP server escaped the staged product');
      }
      const child = spawn(server.command, server.args, {
        env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...server.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let buffered = '';
      const waiters = new Map();
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        buffered += chunk;
        for (;;) {
          const newline = buffered.indexOf('\\n');
          if (newline === -1) break;
          const line = buffered.slice(0, newline);
          buffered = buffered.slice(newline + 1);
          if (line.trim() === '') continue;
          const message = JSON.parse(line);
          if (message.id !== undefined && waiters.has(message.id)) {
            waiters.get(message.id)(message);
            waiters.delete(message.id);
          }
        }
      });
      const call = (id, method, params) => {
        const response = new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('staged MCP timeout: ' + method)), 5000);
          waiters.set(id, (message) => { clearTimeout(timer); resolve(message); });
        });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\\n');
        return response;
      };
      try {
        const initialized = await call(1, 'initialize', { protocolVersion: '2099-arbitrary', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
        const listed = await call(2, 'tools/list', {});
        const called = await call(3, 'tools/call', { name: 'perkins_probe', arguments: {} });
        process.stdout.write(JSON.stringify({
          identity: loadPerkinsPolicy().identity,
          protocolVersion: initialized.result.protocolVersion,
          listed: JSON.stringify(listed).includes('perkins_probe'),
          called: JSON.stringify(called).includes('stage-ok'),
          silasSkills: loadSilasSkills().map((skill) => skill.name),
        }));
      } finally {
        child.kill('SIGTERM');
        await bridge.close();
      }
    `, 'utf8');
    const smoke = JSON.parse(execFileSync(process.execPath, [smokeFile], {
      cwd: stage,
      encoding: 'utf8',
      timeout: 10_000,
      env: { PATH: process.env.PATH ?? '', HOME: emptyHome, PI_CODING_AGENT_DIR: join(emptyHome, '.pi', 'agent') },
    })) as { identity: string; protocolVersion: string; listed: boolean; called: boolean; silasSkills: string[] };
    expect(smoke).toEqual({
      identity: 'perkins-code-review', protocolVersion: '2024-11-05', listed: true, called: true,
      silasSkills: ['ops-dispatch', 'ledger-closeout'],
    });
  }, 360_000);

  it('fails loud for missing, malformed, and identity-corrupt policy resources', () => {
    const root = temp('perkins-policy-failure-');
    expect(() => loadPerkinsPolicy(join(root, 'missing.json'))).toThrow(/unreadable/);
    // The integrity pin applies to EVERY resolved path, so alternate-path
    // fixtures fail closed on the digest before any content parsing.
    const malformed = join(root, 'malformed.json');
    writeFileSync(malformed, '{', 'utf8');
    expect(() => loadPerkinsPolicy(malformed)).toThrow(/integrity mismatch/);
    const corrupt = join(root, 'corrupt.json');
    writeFileSync(corrupt, '{"identity":"wrong"}', 'utf8');
    expect(() => loadPerkinsPolicy(corrupt)).toThrow(/integrity mismatch/);
  });

  it('rejects non-string enum fields and assistant JSON from a failed model turn', () => {
    expect(() => parseFindings(JSON.stringify([{ ...finding('security'), severity: true }]), 'security')).toThrow(/severity/);
    expect(() => parseFixAuditResults(JSON.stringify([{ prior_index: 0, status: true, evidence: 'x', reason: 'x' }]), 1)).toThrow(/status/);
    expect(() => parseVerificationResults(JSON.stringify([{ candidate: 0, disposition: 1, evidence: 'x', reason: 'x' }]), 1)).toThrow(/disposition/);
    const file = join(temp('perkins-failed-session-'), 'session.jsonl');
    writeFileSync(file, `${JSON.stringify({
      type: 'message',
      message: { role: 'assistant', content: [{ type: 'text', text: '[]' }], stopReason: 'error' },
    })}\n`, 'utf8');
    expect(() => finalAssistantText(file)).toThrow(/did not complete successfully/);
    const claudeFile = join(dirname(file), 'claude-session.jsonl');
    writeFileSync(claudeFile, [
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '[]' }] } }),
      JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, result: 'turn limit reached' }),
      '',
    ].join('\n'), 'utf8');
    expect(() => finalAssistantText(claudeFile)).toThrow(/Claude result: turn limit reached/);
    const unterminated = join(dirname(file), 'unterminated-session.jsonl');
    writeFileSync(unterminated, `${JSON.stringify({ role: 'assistant', text: '[]' })}\n`, 'utf8');
    expect(() => finalAssistantText(unterminated)).toThrow(/no successful terminal completion frame/);
  });

  it('rejects symlinked convention files instead of reading outside the frozen tree', () => {
    const fixture = makeReviewRepo();
    repos.push(fixture.repo);
    const outside = join(temp('perkins-convention-secret-'), 'secret');
    writeFileSync(outside, 'SECRET_TOKEN=must-not-leak', 'utf8');
    symlinkSync(outside, join(fixture.repo.path, 'AGENTS.md'));
    expect(() => freezeReviewInputs({
      roundId: 'symlink-conventions',
      repoPath: fixture.repo.path,
      baseRef: fixture.base,
      targetRef: fixture.target,
      artifactRoot: temp('perkins-symlink-artifacts-'),
      spec: 'review spec',
    })).toThrow(/not pristine|must be a regular file/);
  });

  it('rejects traversal round ids before resolving an artifact directory', () => {
    const root = temp('perkins-artifact-containment-');
    for (const id of ['../outside', 'nested/round', '..', '.']) {
      expect(() => reviewArtifactDirectory(root, id)).toThrow(/safe artifact path component/);
    }
    expect(reviewArtifactDirectory(root, 'job-safe-r1')).toBe(join(root, 'job-safe-r1'));
    const linkParent = temp('perkins-artifact-link-parent-');
    const linkedRoot = join(linkParent, 'linked-root');
    symlinkSync(root, linkedRoot);
    expect(() => reviewArtifactDirectory(linkedRoot, 'job-safe-r2')).toThrow(/artifact root must be a real directory/);
  });

  it('coalesces small cross-directory diffs into one chunk and never truncates an oversized file', () => {
    const huge = `diff --git a/src/huge.ts b/src/huge.ts\n${Array.from({ length: 3_010 }, (_, i) => `+line ${i}`).join('\n')}\n`;
    const chunks = chunkUnifiedDiff(huge, 3_000);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.oversizeSingleFile).toBe(true);
    expect(chunks[0]?.diff).toContain('+line 3009');
    const quoted = chunkUnifiedDiff('diff --git "a/src/file name.ts" "b/src/file name.ts"\n--- "a/src/file name.ts"\n+++ "b/src/file name.ts"\n@@ -0,0 +1 @@\n+ok\n');
    expect(quoted[0]?.files).toEqual(['src/file name.ts']);
    const smallAcrossDirectories = chunkUnifiedDiff([
      'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -0,0 +1 @@\n+export {};\n',
      'diff --git a/test/a.test.ts b/test/a.test.ts\n--- a/test/a.test.ts\n+++ b/test/a.test.ts\n@@ -0,0 +1 @@\n+test.todo();\n',
      'diff --git a/docs/a.md b/docs/a.md\n--- a/docs/a.md\n+++ b/docs/a.md\n@@ -0,0 +1 @@\n+note\n',
    ].join(''));
    expect(smallAcrossDirectories).toHaveLength(1);
    expect(smallAcrossDirectories[0]?.files).toEqual(['src/a.ts', 'test/a.test.ts', 'docs/a.md']);
  });

  it('fails closed on UTF-8 byte bounds for frozen diff, spec, and transport-safe chunks', () => {
    const base = { diff: '', specContext: 'ok', projectConventions: 'ok', chunks: [] as const };
    expect(() => assertFrozenPromptBounds({
      ...base, diff: 'x'.repeat(FROZEN_DIFF_MAX_BYTES + 1),
    })).toThrow(/frozen diff exceeds/);
    expect(() => assertFrozenPromptBounds({
      ...base, specContext: '界'.repeat(Math.floor(FROZEN_SPEC_MAX_BYTES / 3) + 1),
    })).toThrow(/frozen spec context exceeds/);
    // An oversize single-hunk chunk is allowed past the per-chunk prompt
    // target but must still fit the tool transport bound.
    expect(() => assertFrozenPromptBounds({
      ...base,
      chunks: [{ id: '001', files: ['src/huge.ts'], lineCount: 1, oversizeSingleFile: true, diff: 'x'.repeat(FROZEN_CHUNK_MAX_BYTES + 1) }],
    })).not.toThrow();
    expect(() => assertFrozenPromptBounds({
      ...base,
      chunks: [{ id: '001', files: ['src/huge.ts'], lineCount: 1, oversizeSingleFile: false, diff: 'x'.repeat(FROZEN_CHUNK_MAX_BYTES + 1) }],
    })).toThrow(/frozen chunk 001 exceeds/);
    expect(() => assertFrozenPromptBounds({
      ...base,
      chunks: [{ id: '001', files: ['src/huge.ts'], lineCount: 1, oversizeSingleFile: true, diff: 'x'.repeat(900 * 1024 + 1) }],
    })).toThrow(/frozen chunk 001 exceeds/);
  });

  it('pins canonical schema/accuracy paragraphs and explicit host replacements against drift', () => {
    const policy = loadPerkinsPolicy();
    expect(policy.portableContract.outputContracts.text).toContain('Return ONE valid JSON array');
    expect(policy.portableContract.outputContracts.text).toContain('No prose, markdown fence, preamble');
    expect(policy.portableContract.outputContracts.nativeTool).toContain('perkins_submit_findings');
    expect(policy.portableContract.outputContracts.nativeTool).toContain('no JSON array, markdown fence, preamble, or findings in assistant text');
    expect(policy.portableContract.sharedPrompt).toContain('independently re-verified');
    expect(policy.portableContract.blindPrompt).toContain('no repository, spec, project/global context, skill, or sibling-worktree access');
    expect(policy.portableContract.lenses.edge).toContain('pure path tracer');
    expect(policy.portableContract.lenses.acceptance).toContain('scope drift');
    expect(policy.portableContract.lenses.security).toContain('SSRF');
    expect(policy.portableContract.lenses.architecture).toContain('module boundaries');
    expect(policy.portableContract.lenses.codebase).toContain('orphaned exports');
    expect(policy.portableContract.lenses.tests).toContain('P0 100%');
    expect(policy.portableContract.leadWorkflow).toContain('deduplicate by normalized title and location');
    // The verification and re-review prompts are pinned provenance: they
    // document the evidence/audit discipline the host enforces in code.
    expect(policy.portableContract.verificationPrompt).toContain('independent verification phase');
    expect(policy.portableContract.verificationPrompt).toContain('N/A');
    expect(policy.portableContract.reReviewPrompt).toContain('Fix-audit every prior consolidated finding');
    expect(policy.portableContract.reReviewPrompt).toContain('PATH ABSENT: <cited-path>');
    expect(policy.portableContract.rules.chunkLineThreshold).toBe(3_000);
    expect(policy.portableContract.rules.incompleteNeverApproves).toBe(true);
    expect(policy.hostReplacements).toEqual(expect.arrayContaining([
      expect.stringContaining('native AgentSpawner'),
      expect.stringContaining('Herdr'),
      expect.stringContaining('INCOMPLETE'),
      expect.stringContaining('superseded'),
    ]));
  });

  it('threads the policy-pinned chunk threshold through freezeReviewInputs', () => {
    const policy = loadPerkinsPolicy();
    // Freeze-time chunking must use the pinned threshold, not an independent
    // code default: a smaller policy value splits the same diff into more chunks.
    const repo = makeFixtureRepo('perkins-threshold-threading');
    const lines = Array.from({ length: 120 }, (_, i) => `export const line${i} = ${i};`).join('\n');
    const base = repo.head();
    repo.commitFile('src/a.ts', `${lines}\n`);
    repo.commitFile('src/b.ts', `${lines}\n`);
    const dir = temp('perkins-threshold-artifacts-');
    const frozen = freezeReviewInputs({
      roundId: 'threshold-3000', repoPath: repo.path, artifactRoot: dir,
      baseRef: base, targetRef: repo.head(), spec: 'threshold check', chunkLineThreshold: policy.portableContract.rules.chunkLineThreshold,
    });
    const pinned = freezeReviewInputs({
      roundId: 'threshold-1', repoPath: repo.path, artifactRoot: dir,
      baseRef: base, targetRef: repo.head(), spec: 'threshold check', chunkLineThreshold: 1,
    });
    expect(frozen.chunks.length).toBe(1);
    expect(pinned.chunks.length).toBe(2);
  });

  it('strictly rejects malformed, overlong, cross-lens, and missing tests-gate output', () => {
    expect(() => parseFindings('```json\n[]\n```', 'blind')).toThrow(/bare JSON array/);
    expect(() => parseFindings(JSON.stringify([finding('security')]), 'blind')).toThrow(/source must be blind/);
    expect(() => parseFindings(JSON.stringify([{ ...finding('blind'), extra: true }]), 'blind')).toThrow(/keys/);
    expect(() => parseFindings(JSON.stringify([{ ...finding('blind'), detail: 'word '.repeat(41) }]), 'blind'))
      .toThrow(/exceeds 40 words/);
    expect(() => parseFindings(JSON.stringify([{ ...finding('blind'), evidence: '界'.repeat(1_334) }]), 'blind'))
      .toThrow(/exceeds 4000 UTF-8 bytes/);
    expect(() => parseFindings('[]', 'tests')).toThrow(/exactly one coverage-gate/);
    expect(() => parseFindings(JSON.stringify([{
      ...finding('tests', 'warning'), category: 'coverage-gate', title: 'Coverage gate: PASS',
    }]), 'tests')).toThrow(/matching note\|warning\|blocker severity/);
  });

  it('keeps four-key text audits and validates optional structured fix locations strictly', () => {
    const legacy = { prior_index: 0, status: 'fixed', evidence: 'old line', reason: 'removed' };
    expect(parseFixAuditResults(JSON.stringify([legacy]), 1)).toEqual([legacy]);
    const indirect = { ...legacy, fix_location: { path: 'src/caller.ts', change: 'added' } };
    expect(parseFixAuditResults(JSON.stringify([indirect]), 1)).toEqual([indirect]);
    for (const bad of [
      { ...indirect, fix_location: { path: 'src/caller.ts' } },
      { ...indirect, fix_location: { path: 'src/caller.ts', change: 'added', extra: true } },
      { ...indirect, fix_location: { path: '../caller.ts', change: 'added' } },
      { ...indirect, evidence: 'old\nline' },
      { ...indirect, evidence: 'N/A' },
      { ...indirect, status: 'still-present' },
    ]) expect(() => parseFixAuditResults(JSON.stringify([bad]), 1)).toThrow();
  });

  it('deduplicates by normalized title/location and applies exact blocker thresholds', () => {
    const verified = (source: ReviewFinding['source'], title: string): VerifiedFinding => ({
      ...finding(source, 'blocker', { title }),
      chunks: ['001'],
      sources: [source],
      roundOrigin: 1,
      verification: { disposition: 'confirmed', evidence: 'exact', reason: 'read' },
    });
    const deduped = dedupeVerifiedFindings([verified('blind', 'Same Defect'), verified('edge', ' same   defect ')]);
    expect(deduped).toHaveLength(1);
    expect(deduped[0]?.sources).toEqual(['blind', 'edge']);
    const complete = { complete: true, requiredLensRuns: 7, validLensRuns: 7, failedRuns: [], verificationComplete: true };
    expect(verdictForFindings([], complete)).toBe('READY TO MERGE');
    expect(verdictForFindings([{ ...verified('blind', 'warning only'), severity: 'warning' }], complete)).toBe('READY TO MERGE');
    expect(verdictForFindings([verified('blind', 'one')], complete)).toBe('NEEDS CHANGES');
    expect(verdictForFindings(Array.from({ length: 3 }, (_, i) => verified('blind', `b${i}`)), complete)).toBe('NEEDS CHANGES');
    expect(verdictForFindings(Array.from({ length: 4 }, (_, i) => verified('blind', `b${i}`)), complete)).toBe('MAJOR REWORK NEEDED');
    expect(verdictForFindings([], { ...complete, complete: false })).toBe('INCOMPLETE');
  });
});

describe('Perkins hybrid lead engine', () => {
  it('one lead schedules all seven isolated lens children through native tools and produces a durable READY report', async () => {
    const h = hybridHarness({ childAnswer: () => '[]' }, {
      spec: 'SPEC-CONTEXT-CANARY: return 43.',
      beforeFreeze: (repo) => {
        repo.git(['checkout', 'main']);
        writeFileSync(join(repo.path, 'AGENTS.md'), 'PROJECT-CONTEXT-CANARY', 'utf8');
        writeFileSync(join(repo.path, 'repository-only-canary.txt'), 'REPOSITORY-READ-CANARY', 'utf8');
        repo.git(['add', 'AGENTS.md']);
        repo.git(['add', 'repository-only-canary.txt']);
        repo.git(['-c', 'user.name=Fixture Tests', '-c', 'user.email=tests@example.invalid', 'commit', '-m', 'test: add tracked review context']);
        repo.git(['checkout', 'feature/review']);
        repo.git(['-c', 'user.name=Fixture Tests', '-c', 'user.email=tests@example.invalid', 'rebase', 'main']);
      },
    });
    const result = await h.run();
    expect(result.canonicalVerdict).toBe('READY TO MERGE');
    expect(result.completeness).toMatchObject({ complete: true, requiredLensRuns: 7, validLensRuns: 7 });
    expect(h.leadCalls).toHaveLength(1);
    const lead = h.leadCalls[0]!;
    expect(lead.options.reviewLead?.nativeTools.map((tool) => tool.name)).toEqual([
      'perkins_read_chunk', 'perkins_run_lenses', 'perkins_store_artifact', 'perkins_record_decision', 'perkins_preflight_submission', 'perkins_submit_review',
    ]);
    expect(lead.options.reviewLead?.systemPrompt).toContain('perkins_submit_review');
    expect(lead.options.reviewLead?.tools).toEqual(['read', 'grep', 'find', 'ls']);
    expect(lead.prompt).toContain('SPEC-CONTEXT-CANARY');
    expect(lead.prompt).toContain('PROJECT-CONTEXT-CANARY');
    expect(lead.prompt).toContain('REQUIRED CHILD COVERAGE');
    expect(h.childCalls).toHaveLength(7);
    const blind = h.childCalls.find((call) => lensFrom(call.prompt ?? '') === 'blind')!;
    expect(blind.options.isolatedReview?.tools).toEqual([]);
    expect(blind.options.cwd).toBe(result.artifactDirectory);
    expect(blind.prompt).not.toContain('PROJECT-CONTEXT-CANARY');
    expect(blind.prompt).not.toContain('SPEC-CONTEXT-CANARY');
    expect(blind.prompt).not.toContain('REPOSITORY-READ-CANARY');
    expect(h.childCalls.find((call) => lensFrom(call.prompt ?? '') === 'acceptance')?.prompt).toContain('SPEC-CONTEXT-CANARY');
    expect(h.childCalls.find((call) => lensFrom(call.prompt ?? '') === 'codebase')?.prompt).toContain('PROJECT-CONTEXT-CANARY');
    for (const call of h.childCalls) {
      expect(call.prompt).toContain('"recommended_fix"');
      expect(call.prompt).toContain('at most 40 words');
    }
    for (const call of h.childCalls.filter((candidate) => candidate !== blind)) {
      expect(call.options.isolatedReview?.tools).toEqual(['read', 'grep', 'find', 'ls']);
      expect(call.options.cwd).toBe(h.repo.path);
    }
    const promptHashes = Object.fromEntries(h.childCalls.map((call) => [
      lensFrom(call.prompt ?? ''),
      createHash('sha256').update(call.prompt ?? '').digest('hex'),
    ]));
    // Independently pinned delivered child bytes: shortening a lens
    // brief/schema, dropping the accuracy mandate, or changing host
    // interpolation fails even if the bundled-resource hash is refreshed.
    expect(promptHashes).toEqual({
      acceptance: '1c5d4e92b1636b792a25bcc52b8c0876109ae859b16d3f89250e7334ba53aed6',
      architecture: '3df902f91ae88bdae56cc5f55991834fa1d7e54aefcc1eccd66f04d688704eab',
      blind: '30df1577d0ccea26a608c97a5a2d0e986f2d0042f10b3981b8177097a058f599',
      codebase: '4102b98a8ec64484bd44f3f0fd708a350b1384c2b7cb55e121eec41c8f3cfccb',
      edge: '55d7ef8eea062e7d846a32a2673f5154a00c0c23ae269bc813079c1b003bb8e3',
      security: '7fbf3d7ed29ea2e3211264d397c5e3fa2c0da7828ba86c8eb0b278dc011347b8',
      tests: 'ddada35af0bffc5bae20ade67a2a20ba7d0029691332fc19767d1400a0a99a35',
    });
    expect(readFileSync(result.reportFile, 'utf8')).toContain('READY TO MERGE');
    expect(readFileSync(join(result.artifactDirectory, 'manifest.json'), 'utf8')).toContain(h.target);
    const consolidated = JSON.parse(readFileSync(join(result.artifactDirectory, 'consolidated.json'), 'utf8')) as {
      architecture: string; childResults: Array<{ agentId: string }>; frozen: { targetSha: string };
    };
    expect(consolidated.architecture).toBe('perkins-hybrid');
    expect(consolidated.childResults).toHaveLength(7);
    expect(consolidated.childResults.every((entry) => typeof entry.agentId === 'string')).toBe(true);
    const receipt = JSON.parse(readFileSync(join(result.artifactDirectory, 'lead', 'receipt.json'), 'utf8')) as {
      nativeTools: string[]; leadAgentId: string; preflightCalls: number;
    };
    expect(receipt.nativeTools).toEqual(['perkins_read_chunk', 'perkins_run_lenses', 'perkins_store_artifact', 'perkins_record_decision', 'perkins_preflight_submission', 'perkins_submit_review']);
    expect(receipt.preflightCalls).toBe(0);
    expect(receipt.leadAgentId).toBe('lead-0');
  });

  it('preserves replacement metacharacters byte-for-byte in delivered frozen diff prompts', async () => {
    const fixture = makeFixtureRepo('perkins-replacement-metacharacters');
    repos.push(fixture);
    const base = fixture.head();
    fixture.git(['checkout', '-b', 'feature/replacement']);
    const line = "export const replacement = '$&-$`-$\\'';";
    const placeholderLine = "export const opaque = '{{SPEC_CONTEXT}}::{{LENS}}';";
    const target = fixture.commitFile('src/replacement.ts', `${line}\n${placeholderLine}\n`);
    const root = temp('perkins-replacement-artifacts-');
    const frozen = freezeReviewInputs({
      roundId: 'hybrid-replacement', repoPath: fixture.path, artifactRoot: root,
      baseRef: base, targetRef: target, movementRef: 'feature/replacement', spec: 'review exact diff bytes',
    });
    const fake = fakeHybridSpawner(temp('perkins-replacement-sessions-'), { childAnswer: () => '[]' });
    const engine = new PerkinsHybridReview({ spawner: fake.spawner, policy: loadPerkinsPolicy() });
    await engine.run({ roundId: 'hybrid-replacement', roundNumber: 1, frozenReview: frozen, movementRef: 'feature/replacement', noSpec: false });
    for (const call of fake.childCalls) {
      expect(call.prompt).toContain(line);
      expect(call.prompt).toContain(placeholderLine);
      expect(call.prompt).not.toContain('{{DIFF}}');
    }
  });

  it('uses exactly six lenses only in explicit no-spec mode', async () => {
    const h = hybridHarness({ childAnswer: () => '[]' }, { noSpec: true });
    const result = await h.run({ noSpec: true });
    expect(result.completeness.requiredLensRuns).toBe(6);
    expect(h.childCalls.some((call) => lensFrom(call.prompt ?? '') === 'acceptance')).toBe(false);
  });

  it('retries one malformed child once through the lead, then accepts its valid empty array', async () => {
    let blindCalls = 0;
    const h = hybridHarness({ childAnswer: (prompt) => {
      if (lensFrom(prompt) === 'blind' && blindCalls++ === 0) return 'not json';
      return '[]';
    } });
    const result = await h.run();
    expect(result.canonicalVerdict).toBe('READY TO MERGE');
    expect(blindCalls).toBe(2);
    expect(h.childCalls).toHaveLength(8);
    expect(h.toolErrors).toHaveLength(0);
  });

  it('delivers the host rejection as a corrective instruction on the text retry', async () => {
    let blindCalls = 0;
    const h = hybridHarness({ childAnswer: (prompt) => {
      if (lensFrom(prompt) === 'blind' && blindCalls++ === 0) return 'not json';
      return '[]';
    } });
    const result = await h.run();
    expect(result.canonicalVerdict).toBe('READY TO MERGE');
    const blind = h.childCalls.filter((call) => lensFrom(call.prompt ?? '') === 'blind');
    expect(blind).toHaveLength(2);
    expect(blind[0]!.prompt).not.toContain('RETRY CORRECTION');
    expect(blind[1]!.prompt).toContain('--- RETRY CORRECTION (attempt 2) ---');
    expect(blind[1]!.prompt).toContain(
      'Previous output rejected (output): lens output must be a bare JSON array with no preamble or markdown fence; output ONLY the bare JSON array.',
    );
  });

  it('rejects a prose citation in location and serves the exact reason on the text retry', async () => {
    let blindCalls = 0;
    const h = hybridHarness({ childAnswer: (prompt) => {
      if (lensFrom(prompt) !== 'blind') return '[]';
      blindCalls += 1;
      return blindCalls === 1 ? JSON.stringify([proseCitation()]) : '[]';
    } });
    const result = await h.run();
    expect(result.canonicalVerdict).toBe('READY TO MERGE');
    const first = readChildEnvelope(h.frozen.directory, 'blind', 1);
    expect(first).toMatchObject({ status: 'invalid', failureKind: 'output' });
    // The snippet is verbatim; only the prose in location fails the host's
    // cited-file/hunk check, exactly as in the recurring round.
    expect(first.error).toBe(
      'lens finding 0 evidence is not locatable at its cited file/hunk: src/main.ts (answer, return branch)',
    );
    const blind = h.childCalls.filter((call) => lensFrom(call.prompt ?? '') === 'blind');
    expect(blind).toHaveLength(2);
    expect(blind[0]!.prompt).not.toContain('RETRY CORRECTION');
    expect(blind[1]!.prompt).toContain('--- RETRY CORRECTION (attempt 2) ---');
    expect(blind[1]!.prompt).toContain(
      'Previous output rejected (output): lens finding 0 evidence is not locatable at its cited file/hunk: src/main.ts (answer, return branch); output ONLY the bare JSON array.',
    );
    // The blind retry answers the exact rejection instead of repeating the task.
    expect(blind[1]!.prompt).toContain(
      'Your previous submission was rejected because lens finding 0 evidence is not locatable at its cited file/hunk: src/main.ts (answer, return branch).',
    );
    expect(blind[1]!.prompt).toContain('Re-cite every finding with "location" as "<path>:<line>"');
    expect(readChildEnvelope(h.frozen.directory, 'blind', 2)).toMatchObject({ status: 'valid' });
  });

  it('serves the exact reason and blind evidence correction on the native-tool retry', async () => {
    let blindCalls = 0;
    const h = hybridHarness({
      childAnswer: (prompt) => {
        if (lensFrom(prompt) !== 'blind') return '[]';
        blindCalls += 1;
        return blindCalls === 1 ? JSON.stringify([proseCitation()]) : '[]';
      },
      childNativeTools: 'tool',
    });
    const result = await h.run();
    expect(result.canonicalVerdict).toBe('READY TO MERGE');
    expect(readChildEnvelope(h.frozen.directory, 'blind', 1)).toMatchObject({ status: 'invalid', failureKind: 'output' });
    const blind = h.childCalls.filter((call) => lensFrom(call.prompt ?? '') === 'blind');
    expect(blind).toHaveLength(2);
    expect(blind[1]!.prompt).toContain(
      'Previous attempt rejected (output): lens finding 0 evidence is not locatable at its cited file/hunk: src/main.ts (answer, return branch).',
    );
    expect(blind[1]!.prompt).toContain('call perkins_submit_findings exactly once with the full corrected');
    expect(blind[1]!.prompt).toContain(
      'Your previous submission was rejected because lens finding 0 evidence is not locatable at its cited file/hunk: src/main.ts (answer, return branch).',
    );
    expect(readChildEnvelope(h.frozen.directory, 'blind', 2)).toMatchObject({ status: 'valid' });
  });

  it('demands the locatable-evidence contract with the chunk-file inventory in every blind prompt', async () => {
    const h = hybridHarness({ childAnswer: () => '[]' });
    await h.run();
    const blind = h.childCalls.find((call) => lensFrom(call.prompt ?? '') === 'blind')!;
    const prompt = blind.prompt ?? '';
    expect(prompt).toContain('--- FILES IN THIS CHUNK ---');
    expect(prompt).toContain('- src/main.ts');
    expect(prompt).not.toContain('{{CHUNK_FILES}}');
    expect(prompt).toContain('location MUST start with one exact file path from FILES IN THIS CHUNK');
    expect(prompt).toContain('"<path>:<line>" or "<path>:<startLine>-<endLine>"');
    expect(prompt).toContain('Never put a function name, symbol, branch description, or any other prose inside location');
    expect(prompt).toContain('ONE contiguous snippet recited verbatim');
    const policy = loadPerkinsPolicy();
    for (const contract of [
      policy.portableContract.outputContracts.blindText,
      policy.portableContract.outputContracts.blindNativeTool,
    ]) {
      expect(contract).toContain('Never put a function name');
      expect(contract).toContain('recited verbatim');
    }
  });

  it('pins the rebrief-restart-safety blind prose-citation fixtures that killed both attempts', () => {
    const fixtureDir = join(import.meta.dirname, 'fixtures', 'perkins-blind-evidence');
    const load = <T>(name: string): T => JSON.parse(readFileSync(join(fixtureDir, name), 'utf8')) as T;
    const expectedError = 'lens finding 0 evidence is not locatable at its cited file/hunk: ' +
      'src/dispatch/rebrief-recovery.ts (reconcilePendingRebriefs, delivery-only branch)';
    for (const attempt of [1, 2] as const) {
      const envelope = load<{ lens: string; chunk: string; attempt: number; status: string; failureKind: string; error: string }>(
        `rebrief-restart-safety-r1.blind.attempt-${attempt}.envelope.json`,
      );
      expect(envelope).toMatchObject({ lens: 'blind', chunk: '001', attempt, status: 'invalid', failureKind: 'output' });
      expect(envelope.error).toBe(expectedError);
      const raw = load<{ findings: Array<{ location: string; evidence: string }> }>(
        `rebrief-restart-safety-r1.blind.attempt-${attempt}.raw.json`,
      );
      expect(raw.findings.length).toBeGreaterThan(0);
      // The cited file and snippet were real; only the citation format was
      // not locatable. The envelope names exactly the location the child wrote.
      expect(raw.findings[0]!.location).toBe(
        'src/dispatch/rebrief-recovery.ts (reconcilePendingRebriefs, delivery-only branch)',
      );
      expect(envelope.error).toContain(raw.findings[0]!.location);
      expect(raw.findings[0]!.evidence).toBe("if (missing.every((marker) => marker.kind === 'job.delivered')) {");
    }
  });

  it('aborts immediately when a child exhausts coverage instead of letting the lead submit', async () => {
    const h = hybridHarness({ childAnswer: (prompt) => lensFrom(prompt) === 'security' ? 'malformed' : '[]' });
    await expect(h.run()).rejects.toThrow(
      /round cannot complete: coverage exhausted \(round hybrid-round\): security\/001 \(attempt 1 invalid \(output\): .*attempt 2 invalid \(output\): /,
    );
    expect(h.frozen.directory).toBeDefined();
    const envelopeDir = join(h.frozen.directory, 'lenses', '001');
    const envelopeName = readdirSync(envelopeDir).find((entry) => /^security\.attempt-2-[0-9a-f]+\.envelope\.json$/u.test(entry));
    expect(envelopeName).toBeDefined();
    const envelope = JSON.parse(readFileSync(join(envelopeDir, envelopeName!), 'utf8')) as {
      attempt: number; status: string; failureKind: string; error: string;
    };
    expect(envelope).toMatchObject({ attempt: 2, status: 'invalid', failureKind: 'output' });
    // The dead gate is durable and exhaustive: every attempt's failureKind and
    // error survives in the host artifact, not only in the error message.
    const exhausted = JSON.parse(readFileSync(join(h.frozen.directory, 'coverage-exhausted.json'), 'utf8')) as {
      roundId: string;
      reason: string;
      exhausted: Array<{
        lens: string;
        chunk: string;
        attempts: Array<{ attempt: number; status: string; failureKind: string; error: string }>;
      }>;
    };
    expect(exhausted).toMatchObject({ roundId: 'hybrid-round', reason: 'coverage_exhausted' });
    expect(exhausted.exhausted).toHaveLength(1);
    expect(exhausted.exhausted[0]).toMatchObject({ lens: 'security', chunk: '001' });
    expect(exhausted.exhausted[0]!.attempts.map((entry) => [entry.attempt, entry.status, entry.failureKind])).toEqual([
      [1, 'invalid', 'output'], [2, 'invalid', 'output'],
    ]);
    expect(exhausted.exhausted[0]!.attempts.every((entry) => entry.error.includes('bare JSON array'))).toBe(true);
    // The lead never consumed a terminal submission against the dead gate.
    expect(() => readFileSync(join(h.frozen.directory, 'lead', 'submission-attempt-1.error.json'))).toThrow();
    expect(() => readFileSync(join(h.frozen.directory, 'lead', 'submission-attempt-1.json'))).toThrow();
    expect(h.toolErrors.some((entry) => /coverage exhausted/.test(entry.error))).toBe(true);
    expect(h.childCalls.filter((call) => lensFrom(call.prompt ?? '') === 'security')).toHaveLength(2);
    expect(h.leadCalls.every((call) => call.disposed === true)).toBe(true);
    expect(() => readFileSync(join(h.frozen.directory, 'perkins-report.md'))).toThrow();
  });

  it('records a double timeout as the abort reason when coverage dies to load', async () => {
    vi.useFakeTimers();
    try {
      const h = hybridHarness({
        childAnswer: (prompt) => lensFrom(prompt) === 'security' ? new Promise<string>(() => {}) : '[]',
      });
      const running = h.run();
      const settled = running.then(() => null, (error: unknown) => error);
      for (let tick = 0; tick < 6; tick += 1) await vi.advanceTimersByTimeAsync(600_000);
      const error = await settled;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(
        /security\/001 \(attempt 1 failed \(timeout\): review turn timed out after 600000ms; attempt 2 failed \(timeout\): review turn timed out after 600000ms\)/u,
      );
      const envelopeDir = join(h.frozen.directory, 'lenses', '001');
      const envelopeFor = (attempt: number) => {
        const name = readdirSync(envelopeDir)
          .find((entry) => entry.startsWith(`security.attempt-${attempt}-`) && entry.endsWith('.envelope.json'));
        expect(name).toBeDefined();
        return JSON.parse(readFileSync(join(envelopeDir, name!), 'utf8')) as {
          attempt: number; status: string; failureKind?: string; error?: string;
        };
      };
      // Both attempts spent the full 600s turn budget under load: each
      // envelope records the timeout class instead of blaming the output.
      const first = envelopeFor(1);
      expect(first).toMatchObject({ attempt: 1, status: 'failed', failureKind: 'timeout' });
      expect(first.error).toContain('review turn timed out after 600000ms');
      const second = envelopeFor(2);
      expect(second).toMatchObject({ attempt: 2, status: 'failed', failureKind: 'timeout' });
      // The retry is corrective about the timeout, not a blind repeat.
      const security = h.childCalls.filter((call) => lensFrom(call.prompt ?? '') === 'security');
      expect(security).toHaveLength(2);
      expect(security[1]!.prompt).toContain('--- RETRY CORRECTION (attempt 2) ---');
      expect(security[1]!.prompt).toContain('Previous output rejected (timeout): review turn timed out after 600000ms');
      const exhausted = JSON.parse(readFileSync(join(h.frozen.directory, 'coverage-exhausted.json'), 'utf8')) as {
        exhausted: Array<{ attempts: Array<{ attempt: number; status: string; failureKind: string }> }>;
      };
      expect(exhausted.exhausted[0]!.attempts.map((entry) => [entry.attempt, entry.status, entry.failureKind])).toEqual([
        [1, 'failed', 'timeout'], [2, 'failed', 'timeout'],
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('runs a complete child wave for every deterministic diff chunk', async () => {
    const fixture = makeFixtureRepo('perkins-chunk-wave');
    repos.push(fixture);
    const base = fixture.head();
    fixture.git(['checkout', '-b', 'feature/chunks']);
    const a = Array.from({ length: 1_600 }, (_, index) => `export const a${index} = ${index};`).join('\n');
    fixture.commitFile('alpha/a.ts', `${a}\n`);
    const b = Array.from({ length: 1_600 }, (_, index) => `export const b${index} = ${index};`).join('\n');
    const target = fixture.commitFile('beta/b.ts', `${b}\n`);
    const root = temp('perkins-chunk-artifacts-');
    const frozen = freezeReviewInputs({
      roundId: 'hybrid-chunks', repoPath: fixture.path, artifactRoot: root,
      baseRef: base, targetRef: target, movementRef: 'feature/chunks', spec: 'review every changed file',
    });
    const fake = fakeHybridSpawner(temp('perkins-chunk-sessions-'), { childAnswer: () => '[]' });
    const engine = new PerkinsHybridReview({ spawner: fake.spawner, policy: loadPerkinsPolicy() });
    const result = await engine.run({ roundId: 'hybrid-chunks', roundNumber: 1, frozenReview: frozen, movementRef: 'feature/chunks', noSpec: false });
    expect(result.completeness).toMatchObject({ requiredLensRuns: 14, validLensRuns: 14 });
    expect(fake.childCalls).toHaveLength(14);
    expect(readFileSync(join(result.artifactDirectory, 'chunks', '001.patch'), 'utf8')).toContain('alpha/a.ts');
    expect(readFileSync(join(result.artifactDirectory, 'chunks', '002.patch'), 'utf8')).toContain('beta/b.ts');
  });

  it('holds the round-wide child concurrency at four and cleans unique tracked sessions', async () => {
    let active = 0;
    let maximum = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let reachedFour!: () => void;
    const fourActive = new Promise<void>((resolve) => { reachedFour = resolve; });
    const h = hybridHarness({
      childAnswer: async () => {
        active += 1;
        maximum = Math.max(maximum, active);
        if (active === 4) reachedFour();
        await gate;
        active -= 1;
        return '[]';
      },
    });
    const running = h.run();
    await fourActive;
    expect(maximum).toBe(4);
    expect(h.childCalls).toHaveLength(4);
    release();
    await expect(running).resolves.toMatchObject({ canonicalVerdict: 'READY TO MERGE' });
    expect(maximum).toBe(4);
    expect(new Set(h.childCalls.map((call) => call.agentId)).size).toBe(7);
    expect(new Set(h.childCalls.map((call) => call.sessionFile)).size).toBe(7);
    expect(h.childCalls.every((call) => call.disposed === true)).toBe(true);
  });

  it('lead-verified candidates enforce 4+ blocker major rework and force N/A demotion', async () => {
    const blockers = new Set(['blind', 'edge', 'acceptance', 'security']);
    const h = hybridHarness({
      childAnswer: (prompt) => {
        const lens = lensFrom(prompt);
        if (blockers.has(lens)) return JSON.stringify([finding(lens)]);
        if (lens === 'tests') return JSON.stringify([finding('tests', 'blocker', { title: 'unanchored', location: 'N/A', evidence: 'N/A' })]);
        return '[]';
      },
      decide: (candidate) => ({
        disposition: 'confirmed',
        evidence: candidate.evidence === 'N/A' ? 'N/A' : 'export function answer(): number {',
        reason: 'lead re-read the frozen tree',
      }),
    });
    const result = await h.run();
    expect(result.canonicalVerdict).toBe('MAJOR REWORK NEEDED');
    expect(result.findings.filter((entry) => entry.severity === 'blocker')).toHaveLength(4);
    expect(result.findings.find((entry) => entry.title === 'unanchored')).toMatchObject({
      severity: 'warning', verification: { disposition: 'unverifiable-speculative' },
    });
    expect(result.verificationSummary).toMatchObject({ candidates: 5, confirmed: 4, speculative: 1, deduplicated: 5 });
  });

  it('decides 201 candidates in one terminal submission without truncating coverage', async () => {
    const many = (source: 'blind' | 'security', count: number, offset: number) =>
      Array.from({ length: count }, (_, index) => finding(source, 'warning', { title: `grounded candidate ${offset + index}` }));
    const h = hybridHarness({
      childAnswer: (prompt) => {
        const lens = lensFrom(prompt);
        if (lens === 'blind') return JSON.stringify(many('blind', 100, 0));
        if (lens === 'security') return JSON.stringify(many('security', 101, 100));
        return '[]';
      },
    });
    const result = await h.run();
    expect(result.verificationSummary).toMatchObject({ candidates: 201, confirmed: 201 });
    expect(result.completeness.verificationComplete).toBe(true);
    expect(result.findings).toHaveLength(201);
  });

  it('accepts independently located cross-file lead evidence from the frozen tracked tree', async () => {
    const h = hybridHarness({
      childAnswer: (prompt) => lensFrom(prompt) === 'security' ? JSON.stringify([finding('security')]) : '[]',
      decide: () => ({
        disposition: 'confirmed',
        evidence: 'Fixture repository for dispatch-flow tests.',
        reason: 'cross-file dependency verified in README.md',
      }),
    });
    const result = await h.run();
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.verification).toMatchObject({
      disposition: 'confirmed',
      evidence: 'Fixture repository for dispatch-flow tests.',
    });
  });

  it('rejects fabricated lead verification evidence fail-closed', async () => {
    const h = hybridHarness({
      childAnswer: (prompt) => lensFrom(prompt) === 'security' ? JSON.stringify([finding('security')]) : '[]',
      decide: () => ({ disposition: 'confirmed', evidence: 'FABRICATED-QUOTE-NOT-IN-TREE', reason: 'untrusted lead claimed it read this' }),
    });
    await expect(h.run()).rejects.toThrow(/not one contiguous locatable substring|not locatable/);
  });

  it('requires contradictory frozen evidence at the cited path for every rejected candidate', async () => {
    const fabricated = hybridHarness({
      childAnswer: (prompt) => lensFrom(prompt) === 'security' ? JSON.stringify([finding('security')]) : '[]',
      decide: () => ({
        disposition: 'rejected', evidence: 'FABRICATED-CONTRADICTION', reason: 'lead rejects without reading',
      }),
    });
    await expect(fabricated.run()).rejects.toThrow(/lacks contradictory frozen evidence/);

    const grounded = hybridHarness({
      childAnswer: (prompt) => lensFrom(prompt) === 'security' ? JSON.stringify([finding('security')]) : '[]',
      decide: () => ({
        disposition: 'rejected', evidence: '  return 43;', reason: 'the cited implementation contradicts the candidate claim',
      }),
    });
    const result = await grounded.run();
    expect(result.canonicalVerdict).toBe('READY TO MERGE');
    expect(result.verificationSummary).toMatchObject({ candidates: 1, rejected: 1, confirmed: 0 });
    expect(result.findings).toEqual([]);
  });

  it('rejects unresolved speculative decisions for code-anchored candidates', async () => {
    const h = hybridHarness({
      childAnswer: (prompt) => lensFrom(prompt) === 'security' ? JSON.stringify([finding('security')]) : '[]',
      decide: () => ({
        disposition: 'unverifiable-speculative',
        evidence: 'export function answer(): number {',
        reason: 'lead declined to decide an anchored candidate',
      }),
    });
    await expect(h.run()).rejects.toThrow(/anchored candidate must be confirmed or rejected/);
    expect(() => readFileSync(join(h.frozen.directory, 'consolidated.json'))).toThrow();
  });

  it('rejects candidate evidence quoted through a parent symlink outside the frozen tree', async () => {
    const outsideDir = temp('perkins-evidence-outside-');
    writeFileSync(join(outsideDir, 'secret.ts'), 'OUTSIDE-EVIDENCE-CANARY\n', 'utf8');
    const h = hybridHarness({
      childAnswer: (prompt) => lensFrom(prompt) === 'security'
        ? JSON.stringify([finding('security', 'warning', { location: 'linked/secret.ts:1', evidence: 'OUTSIDE-EVIDENCE-CANARY' })])
        : '[]',
    });
    symlinkSync(outsideDir, join(h.repo.path, 'linked'));
    // The mispaired evidence is rejected at child envelope construction (the
    // attempt is invalid and retryable), and when the retry cannot validate
    // either, the host aborts the round instead of consuming submissions.
    await expect(h.run()).rejects.toThrow(/coverage exhausted/);
    const envelopeName = readdirSync(join(h.frozen.directory, 'lenses', '001'))
      .find((name) => name.startsWith('security.attempt-1-') && name.endsWith('.envelope.json'));
    const envelope = JSON.parse(readFileSync(join(h.frozen.directory, 'lenses', '001', envelopeName!), 'utf8')) as {
      status: string; error?: string;
    };
    expect(envelope.status).toBe('invalid');
    expect(envelope.error).toMatch(/evidence is not locatable at its cited file\/hunk: linked\/secret\.ts/u);
  });

  it('audits prior findings: fixed findings are not carried and history is immutable', async () => {
    const first = hybridHarness({
      childAnswer: (prompt) => lensFrom(prompt) === 'security' ? JSON.stringify([finding('security')]) : '[]',
    });
    const firstResult = await first.run();
    expect(firstResult.canonicalVerdict).toBe('NEEDS CHANGES');
    const historical = readFileSync(join(firstResult.artifactDirectory, 'consolidated.json'), 'utf8');

    const secondTarget = first.repo.commitFile('src/main.ts', 'export function answer(): number {\n  return 44;\n}\n');
    const frozen = freezeReviewInputs({
      roundId: 'hybrid-round-two', repoPath: first.repo.path, artifactRoot: first.root,
      baseRef: first.base, targetRef: secondTarget, movementRef: 'feature/review', spec: 'return 44',
    });
    const fake = fakeHybridSpawner(temp('perkins-rereview-sessions-'), {
      childAnswer: () => '[]',
      priorAudit: () => [{ prior_index: 0, status: 'fixed', evidence: '  return 43;', reason: 'the frozen diff deletes the defective return value' }],
    });
    const engine = new PerkinsHybridReview({ spawner: fake.spawner, policy: loadPerkinsPolicy() });
    const result = await engine.run({
      roundId: 'hybrid-round-two', roundNumber: 2, frozenReview: frozen, movementRef: 'feature/review', noSpec: false,
      priorConsolidatedFile: join(firstResult.artifactDirectory, 'consolidated.json'),
    });
    expect(result.priorAudit).toEqual([expect.objectContaining({ status: 'fixed' })]);
    expect(result.findings).toEqual([]);
    expect(result.canonicalVerdict).toBe('READY TO MERGE');
    expect(readFileSync(join(firstResult.artifactDirectory, 'consolidated.json'), 'utf8')).toBe(historical);
  });

  it('accepts an explicit changed-caller proof while preserving the original helper citation', async () => {
    const h = indirectFixHarness();
    const result = await h.run();
    expect(result.canonicalVerdict).toBe('READY TO MERGE');
    expect(result.priorAudit).toEqual([expect.objectContaining({
      status: 'fixed', fix_location: { path: 'src/caller.ts', change: 'added' },
    })]);
    expect(result.findings).toEqual([]);
    expect(h.fake.preflightResults[0]?.text).toContain('"ok":true');
    expect(readFileSync(h.priorFile, 'utf8')).toContain('src/helper.ts:1');
  });

  const rejectIndirect = async (audit: Record<string, unknown>, message: RegExp): Promise<void> => {
    const h = indirectFixHarness({ audit });
    await expect(h.run()).rejects.toThrow(message);
    expect(h.fake.preflightResults[0]?.text).toContain('"ok":false');
    expect(existsSync(join(h.frozen.directory, 'consolidated.json'))).toBe(false);
  };
  it('rejects invented caller evidence', async () => {
    await rejectIndirect({ evidence: 'const selected = invented;' }, /changed.*line|locatable/u);
  });
  it('rejects unchanged caller context', async () => {
    await rejectIndirect({ evidence: 'const unchanged = true;' }, /changed.*line|locatable/u);
  });
  it('rejects a proof line on the wrong side of the hunk', async () => {
    await rejectIndirect({ fix_location: { path: 'src/caller.ts', change: 'removed' }, evidence: 'const selected = nativeSetting;' }, /changed.*line|locatable/u);
  });
  it('rejects missing explicit location for an unchanged cited helper', async () => {
    await rejectIndirect({ fix_location: undefined }, /cited frozen file|locatable/u);
  });
  it('rejects absolute fix paths', async () => {
    await rejectIndirect({ fix_location: { path: '/src/caller.ts', change: 'added' } }, /fix_location.*path|relative/u);
  });
  it('rejects traversal fix paths', async () => {
    await rejectIndirect({ fix_location: { path: '../caller.ts', change: 'added' } }, /fix_location.*path|relative/u);
  });
  it('rejects a path declaration with fabricated evidence', async () => {
    await rejectIndirect({ evidence: 'made-up' }, /changed.*line|locatable/u);
  });
  it('rejects an explicit location on still-present status', async () => {
    await rejectIndirect({ status: 'still-present' }, /fix_location.*fixed|unsupported/u);
  });

  it('preserves legacy original-path absence proof when the cited file is deleted', async () => {
    const h = indirectFixHarness({
      afterPrior: (repo) => {
        repo.git(['rm', 'src/helper.ts']);
        repo.git(['-c', 'user.name=Fixture Tests', '-c', 'user.email=tests@example.invalid', 'commit', '-m', 'remove cited helper']);
      },
      audit: { evidence: 'PATH ABSENT: src/helper.ts', fix_location: undefined },
    });
    expect((await h.run()).canonicalVerdict).toBe('READY TO MERGE');
    expect(h.fake.preflightResults[0]?.text).toContain('"ok":true');
  });

  it('rejects legacy absence proof when the original cited path still exists', async () => {
    await rejectIndirect({ evidence: 'PATH ABSENT: src/helper.ts', fix_location: undefined }, /cited frozen file|locatable/u);
  });

  it('retains speculative prior N/A proof without inventing a location', async () => {
    const h = indirectFixHarness({
      priorFinding: { location: 'N/A', evidence: 'N/A' }, priorDisposition: 'unverifiable-speculative',
      audit: { evidence: 'N/A', fix_location: undefined },
    });
    expect((await h.run()).canonicalVerdict).toBe('READY TO MERGE');
    expect(h.fake.preflightResults[0]?.text).toContain('"ok":true');
  });

  it('rejects N/A audit evidence for a confirmed prior finding', async () => {
    await rejectIndirect({ evidence: 'N/A', fix_location: undefined }, /cited frozen file|locatable/u);
  });

  const malformedLocations: ReadonlyArray<{ readonly label: string; readonly location: unknown;
    readonly auditPatch?: Readonly<Record<string, unknown>>; readonly rule: RegExp }> = [
    { label: 'missing path', location: { change: 'added' }, rule: /prior-audit-fix-location/u },
    { label: 'extra key', location: { path: 'src/caller.ts', change: 'added', extra: true }, rule: /prior-audit-fix-location/u },
    { label: 'null', location: null, rule: /prior-audit-fix-location/u },
    { label: 'array', location: [], rule: /prior-audit-fix-location/u },
    { label: 'invalid change', location: { path: 'src/caller.ts', change: 'moved' }, rule: /prior-audit-fix-location/u },
    { label: 'newline path', location: { path: 'src/caller.ts\n', change: 'added' }, rule: /prior-audit-fix-location/u },
    { label: 'newline evidence', location: { path: 'src/caller.ts', change: 'added' },
      auditPatch: { evidence: 'const selected = nativeSetting;\n' }, rule: /prior-audit-fix-location/u },
    { label: 'extra audit key', location: { path: 'src/caller.ts', change: 'added' },
      auditPatch: { unexpected: true }, rule: /prior-audit-schema/u },
  ];
  const checkMalformedLocation = async (mode: 'full' | 'delta', caseIndex: number): Promise<void> => {
    const { location, auditPatch, rule } = malformedLocations[caseIndex]!;
    const malformed = (audit: HybridSubmission['prior_audit'][number]) => ({ ...audit, fix_location: location, ...auditPatch });
    const h = indirectFixHarness(mode === 'full' ? { audit: { fix_location: location, ...auditPatch } } : {
      submitPayload: (attempt, submission) => attempt === 1
        ? { ...submission, prior_audit: [] }
        : { mode: 'delta', prior_audit: submission.prior_audit.map(malformed) },
      preflight: { beforeAttempt: 2, calls: 1, payload: (submission) => ({ mode: 'delta',
        prior_audit: submission.prior_audit.map(malformed) }) },
    });
    await expect(h.run()).rejects.toThrow(rule);
    expect(h.fake.preflightResults[0]?.text).toMatch(rule);
    expect(h.fake.toolErrors.some(({ tool, error }) => tool === 'perkins_submit_review' && rule.test(error))).toBe(true);
    expect(existsSync(join(h.frozen.directory, 'consolidated.json'))).toBe(false);
  };
  it('rejects native full malformed fix_location: missing path', () => checkMalformedLocation('full', 0));
  it('rejects native full malformed fix_location: extra key', () => checkMalformedLocation('full', 1));
  it('rejects native full malformed fix_location: null', () => checkMalformedLocation('full', 2));
  it('rejects native full malformed fix_location: array', () => checkMalformedLocation('full', 3));
  it('rejects native full malformed fix_location: invalid change', () => checkMalformedLocation('full', 4));
  it('rejects native full malformed fix_location: newline path', () => checkMalformedLocation('full', 5));
  it('rejects native full malformed fix_location: newline evidence', () => checkMalformedLocation('full', 6));
  it('rejects native full malformed fix_location: extra audit key', () => checkMalformedLocation('full', 7));
  it('rejects native delta malformed fix_location: missing path', () => checkMalformedLocation('delta', 0));
  it('rejects native delta malformed fix_location: extra key', () => checkMalformedLocation('delta', 1));
  it('rejects native delta malformed fix_location: null', () => checkMalformedLocation('delta', 2));
  it('rejects native delta malformed fix_location: array', () => checkMalformedLocation('delta', 3));
  it('rejects native delta malformed fix_location: invalid change', () => checkMalformedLocation('delta', 4));
  it('rejects native delta malformed fix_location: newline path', () => checkMalformedLocation('delta', 5));
  it('rejects native delta malformed fix_location: newline evidence', () => checkMalformedLocation('delta', 6));
  it('rejects native delta malformed fix_location: extra audit key', () => checkMalformedLocation('delta', 7));

  it('rejects an omitted prior audit in a full submission and preflight', async () => {
    const h = indirectFixHarness({
      submitPayload: (_attempt, submission) => ({ ...submission, prior_audit: [] }),
      preflight: { calls: 1, mutate: (submission) => ({ ...submission, prior_audit: [] }) },
    });
    await expect(h.run()).rejects.toThrow(/prior finding 0 has no audit entry|prior audit must contain/u);
    expect(h.fake.preflightResults[0]?.text).toContain('"ok":false');
  });

  it('rejects a duplicated prior audit in a full submission and preflight', async () => {
    const h = indirectFixHarness({
      submitPayload: (_attempt, submission) => ({ ...submission, prior_audit: [...submission.prior_audit, ...submission.prior_audit] }),
      preflight: { calls: 1, mutate: (submission) => ({ ...submission, prior_audit: [...submission.prior_audit, ...submission.prior_audit] }) },
    });
    await expect(h.run()).rejects.toThrow(/prior finding 0 is audited more than once|prior audit must contain/u);
    expect(h.fake.preflightResults[0]?.text).toContain('"ok":false');
  });

  it('rejects a delta that leaves an omitted prior audit incomplete', async () => {
    const h = indirectFixHarness({
      submitPayload: (attempt, submission) => attempt === 1
        ? { ...submission, prior_audit: [] }
        : { mode: 'delta', prior_audit: [] },
      preflight: { beforeAttempt: 2, calls: 1, payload: () => ({ mode: 'delta', prior_audit: [] }) },
    });
    await expect(h.run()).rejects.toThrow(/prior finding 0 has no audit entry|prior audit must contain/u);
    expect(h.fake.preflightResults[0]?.text).toContain('"ok":false');
  });

  it('rejects duplicate prior indices inside a delta over an incomplete audit', async () => {
    const h = indirectFixHarness({
      submitPayload: (attempt, submission) => attempt === 1
        ? { ...submission, prior_audit: [] }
        : { mode: 'delta', prior_audit: [...submission.prior_audit, ...submission.prior_audit] },
      preflight: { beforeAttempt: 2, calls: 1, payload: (submission) => ({ mode: 'delta', prior_audit: [...submission.prior_audit, ...submission.prior_audit] }) },
    });
    await expect(h.run()).rejects.toThrow(/delta audits prior finding 0 more than once/u);
    expect(h.fake.preflightResults[0]?.text).toContain('"ok":false');
  });

  it('requires both fix and original citation in an indirect-fix report', async () => {
    const h = indirectFixHarness({ transformReport: (report) => report.replaceAll('src/caller.ts', 'redacted') });
    await expect(h.run()).rejects.toThrow(/report must identify both the original citation and fix_location/u);
  });

  it('rejects a wrong prior revision instead of falling back to the PR base', async () => {
    const missing = indirectFixHarness({ priorSha: 'f'.repeat(40) });
    await expect(missing.run()).rejects.toThrow(/prior target revision/u);
    const wrongCommit = indirectFixHarness({ useBaseAsPrior: true });
    await expect(wrongCommit.run()).rejects.toThrow(/prior accepted frozen file\/hunk does not contain the original cited finding/u);
  });

  it('revalidates an indirect proof in a delta over a rejected full submission', async () => {
    const h = indirectFixHarness({
      submitPayload: (attempt, submission) => attempt === 1
        ? { ...submission, prior_audit: submission.prior_audit.map(({ fix_location: _location, ...rest }) => rest) }
        : { mode: 'delta', prior_audit: submission.prior_audit },
      preflight: { beforeAttempt: 2, calls: 1, payload: (submission) => ({ mode: 'delta', prior_audit: submission.prior_audit }) },
    });
    expect((await h.run()).canonicalVerdict).toBe('READY TO MERGE');
    expect(h.fake.preflightResults[0]?.text).toContain('"ok":true');
  });

  it('accepts an added CRLF caller line without trimming meaningful whitespace', async () => {
    const added = indirectFixHarness({
      afterPrior: (repo) => { repo.commitFile('src/caller.ts', 'const unchanged = true;\r\nconst selected = nativeSetting;  \r\n'); },
      audit: { evidence: 'const selected = nativeSetting;  ' },
    });
    expect((await added.run()).canonicalVerdict).toBe('READY TO MERGE');
    expect(added.fake.preflightResults[0]?.text).toContain('"ok":true');
  });

  it('accepts a removed CRLF caller line without trimming meaningful whitespace', async () => {
    const removed = indirectFixHarness({
      priorCallerContent: 'const unchanged = true;\r\nconst selected = nativeRef;  \r\n',
      afterPrior: (repo) => { repo.commitFile('src/caller.ts', 'const unchanged = true;\r\nconst selected = nativeSetting;\r\n'); },
      audit: { evidence: 'const selected = nativeRef;  ', fix_location: { path: 'src/caller.ts', change: 'removed' } },
    });
    expect((await removed.run()).canonicalVerdict).toBe('READY TO MERGE');
    expect(removed.fake.preflightResults[0]?.text).toContain('"ok":true');
  });

  it('does not strip a final bare CR as though it terminated a CRLF line', async () => {
    const h = indirectFixHarness({
      afterPrior: (repo) => { repo.commitFile('src/caller.ts', 'const selected = nativeSetting;\r'); },
    });
    await expect(h.run()).rejects.toThrow(/not an actual added changed hunk line/u);
    expect(h.fake.preflightResults[0]?.text).toContain('"ok":false');
    expect(existsSync(join(h.frozen.directory, 'consolidated.json'))).toBe(false);
  });

  it('preserves a BOM in the accepted prior cited blob and its unchanged citation', async () => {
    const cited = '\uFEFFexport function helper(ref: string): string { return ref.slice(ref.indexOf("/") + 1); }';
    const h = indirectFixHarness({ priorHelperContent: cited + '\n', priorFinding: { evidence: cited } });
    expect((await h.run()).canonicalVerdict).toBe('READY TO MERGE');
    expect(h.fake.preflightResults[0]?.text).toContain('"ok":true');
  });

  it('locates a prefixed original citation in its actual accepted prior base-target hunk', async () => {
    const h = indirectFixHarness({ priorHistoricalHunk: true,
      priorFinding: { evidence: '-export function helper(ref: string): string { return ref.slice(ref.indexOf("/") + 1); }' } });
    expect((await h.run()).canonicalVerdict).toBe('READY TO MERGE');
    expect(h.fake.preflightResults[0]?.text).toContain('"ok":true');
    const prior = JSON.parse(readFileSync(h.priorFile, 'utf8')) as { frozen: { targetSha: string; diffBaseSha: string } };
    expect(prior.frozen.diffBaseSha).not.toBe(prior.frozen.targetSha);
  });

  it('locates a multiline accepted prior quote only in the exact prefixed historical hunk', async () => {
    const h = indirectFixHarness({
      priorHistoricalHunk: true,
      priorHelperContent: 'export function helper(ref: string): string {\n  return ref.slice(ref.indexOf("/") + 1);\n}\n',
      priorFinding: { evidence: '-  return ref.slice(ref.indexOf("/") + 1);\n-}' },
    });
    expect((await h.run()).canonicalVerdict).toBe('READY TO MERGE');
    expect(h.fake.preflightResults[0]?.text).toContain('"ok":true');
  });

  it('rejects a missing prior base when the original citation exists only in its hunk', async () => {
    const h = indirectFixHarness({ priorHistoricalHunk: true });
    const prior = JSON.parse(readFileSync(h.priorFile, 'utf8')) as { frozen: { diffBaseSha?: string } };
    delete prior.frozen.diffBaseSha;
    writeFileSync(h.priorFile, JSON.stringify(prior));
    await expect(h.run()).rejects.toThrow(/prior accepted frozen file\/hunk/u);
  });

  it('rejects a CR in an audit evidence payload even for a CRLF caller', async () => {
    const embedded = indirectFixHarness({
      afterPrior: (repo) => { repo.commitFile('src/caller.ts', 'const selected = nativeSetting;\r\n'); },
      audit: { evidence: 'const selected = nativeSetting;\r' },
    });
    await expect(embedded.run()).rejects.toThrow(/line|evidence/u);
    expect(embedded.fake.preflightResults[0]?.text).toContain('"ok":false');
  });

  const renameCaller = (changed: boolean, change: 'added' | 'removed') => {
    const stable = 'const unchanged = true;\nconst contextOne = 1;\nconst contextTwo = 2;\nconst contextThree = 3;\n';
    const h = indirectFixHarness({
      priorCallerContent: `${stable}const selected = nativeRef;\n`,
      afterPrior: (repo) => {
        repo.git(['mv', 'src/caller.ts', 'src/renamed.ts']);
        if (changed) writeFileSync(join(repo.path, 'src/renamed.ts'), `${stable}const selected = nativeSetting;\n`);
        repo.git(['-c', 'user.name=Fixture Tests', '-c', 'user.email=tests@example.invalid', 'commit', '-am', 'rename caller']);
      },
      audit: {
        fix_location: { path: change === 'removed' ? 'src/caller.ts' : 'src/renamed.ts', change },
        evidence: change === 'removed' || !changed ? 'const selected = nativeRef;' : 'const selected = nativeSetting;',
      },
    });
    expect(h.repo.git(['diff', '--no-ext-diff', '--no-textconv', '--find-renames', '--name-status', 'HEAD^', 'HEAD']))
      .toMatch(/^R[0-9]+\tsrc\/caller\.ts\tsrc\/renamed\.ts$/u);
    return h;
  };

  it('rejects a quoted unchanged line in a Git-recognized rename-only caller', async () => {
    const h = renameCaller(false, 'added');
    await expect(h.run()).rejects.toThrow(/not an actual added changed hunk line/u);
    expect(h.fake.preflightResults[0]?.text).toContain('not an actual added changed hunk line');
  });

  it('accepts added-line proof in a Git-recognized edited caller rename', async () => {
    const h = renameCaller(true, 'added');
    expect((await h.run()).canonicalVerdict).toBe('READY TO MERGE');
    expect(h.fake.preflightResults[0]?.text).toContain('"ok":true');
  });

  it('accepts removed-line proof in a Git-recognized edited caller rename', async () => {
    const h = renameCaller(true, 'removed');
    expect((await h.run()).canonicalVerdict).toBe('READY TO MERGE');
    expect(h.fake.preflightResults[0]?.text).toContain('"ok":true');
  });

  const renamedCallerWithReplacedDirectory = (edited: boolean) => {
    const stable = 'const unchanged = true;\nconst contextOne = 1;\nconst contextTwo = 2;\nconst contextThree = 3;\n';
    const h = indirectFixHarness({
      priorCallerContent: `${stable}const selected = nativeRef;\n`,
      afterPrior: (repo) => {
        repo.git(['mv', 'src/caller.ts', 'src/renamed.ts']);
        if (edited) {
          writeFileSync(join(repo.path, 'src/renamed.ts'), `${stable}const selected = nativeSetting;\n`);
          repo.git(['add', 'src/renamed.ts']);
        }
        repo.commitFile('src/caller.ts/unrelated.ts', 'const selected = nativeSetting;\n');
      },
      audit: { fix_location: { path: 'src/renamed.ts', change: 'added' }, evidence: 'const selected = nativeSetting;' },
    });
    const status = h.repo.git(['diff', '--no-ext-diff', '--no-textconv', '--find-renames', '--name-status', 'HEAD^', 'HEAD']);
    expect(status).toMatch(/^R[0-9]+\tsrc\/caller\.ts\tsrc\/renamed\.ts$/mu);
    expect(status).toMatch(/^A\tsrc\/caller\.ts\/unrelated\.ts$/mu);
    return h;
  };

  it('rejects an unrelated descendant hunk after an unchanged caller is renamed', async () => {
    const h = renamedCallerWithReplacedDirectory(false);
    await expect(h.run()).rejects.toThrow(/not an actual added changed hunk line|overlaps another changed path/u);
    expect(h.fake.preflightResults[0]?.text).toContain('"ok":false');
    expect(existsSync(join(h.frozen.directory, 'consolidated.json'))).toBe(false);
  });

  it('accepts only the caller hunk when an edited rename also replaces its old path with a directory', async () => {
    const h = renamedCallerWithReplacedDirectory(true);
    writeFileSync(join(h.repo.path, '.git', 'info', 'attributes'), 'src/renamed.ts -diff\nsrc/caller.ts/** diff\n');
    expect(h.repo.git(['status', '--porcelain'])).toBe('');
    expect((await h.run()).canonicalVerdict).toBe('READY TO MERGE');
    expect(h.fake.preflightResults[0]?.text).toContain('"ok":true');
  });

  it('rejects a real unchanged caller line copied from a rewritten source classified M+A', async () => {
    const h = indirectFixHarness({
      afterPrior: (repo) => {
        repo.git(['mv', 'src/caller.ts', 'src/renamed.ts']);
        repo.commitFile('src/caller.ts', 'const selected = nativeSetting;\n');
      },
      audit: { fix_location: { path: 'src/renamed.ts', change: 'added' }, evidence: 'const selected = nativeRef;' },
    });
    const status = h.repo.git(['diff', '--no-ext-diff', '--no-textconv', '--find-renames', '--name-status', 'HEAD^', 'HEAD']);
    expect(status).toMatch(/^M\tsrc\/caller\.ts$/mu);
    expect(status).toMatch(/^A\tsrc\/renamed\.ts$/mu);
    await expect(h.run()).rejects.toThrow(/unchanged.*source|ambiguous.*source/u);
    expect(h.fake.preflightResults[0]?.text).toContain('"ok":false');
    expect(existsSync(join(h.frozen.directory, 'consolidated.json'))).toBe(false);
  });

  it('accepts a genuinely new caller with tool-derived added evidence', async () => {
    let selectedEvidence: string | undefined;
    const h = indirectFixHarness({
      afterPrior: (repo) => { repo.commitFile('src/new-caller.ts', 'const selected = nativeSetting;\n'); },
      audit: () => ({ fix_location: { path: 'src/new-caller.ts', change: 'added' }, evidence: selectedEvidence ?? 'UNAVAILABLE' }),
      priorDeltaPath: 'src/new-caller.ts',
      onPriorDelta: (list, selected) => {
        expect((list as { changes: Array<{ oldPath: string | null; newPath: string | null }> }).changes)
          .toContainEqual({ oldPath: null, newPath: 'src/new-caller.ts' });
        const patch = (selected as { diff: string }).diff;
        selectedEvidence = patch.split('\n').find((line) => line.startsWith('+const selected = '))?.slice(1);
        expect(selectedEvidence).toBe('const selected = nativeSetting;');
      },
    });
    expect((await h.run()).canonicalVerdict).toBe('READY TO MERGE');
    expect(h.fake.preflightResults[0]?.text).toContain('"ok":true');
  });

  it('accepts a novel line in an edited copy of a rewritten caller', async () => {
    const h = indirectFixHarness({
      afterPrior: (repo) => {
        repo.commitFile('src/copied.ts', 'const unchanged = true;\nconst selected = nativeRef;\nconst selected = nativeSetting;\n');
        repo.commitFile('src/caller.ts', 'const selected = differentSetting;\n');
      },
      audit: { fix_location: { path: 'src/copied.ts', change: 'added' } },
    });
    expect((await h.run()).canonicalVerdict).toBe('READY TO MERGE');
    expect(h.fake.preflightResults[0]?.text).toContain('"ok":true');
  });

  it('reads only the deleted regular caller, not invalid descendants of its replacement directory', async () => {
    let selectedEvidence: string | undefined;
    const h = indirectFixHarness({
      afterPrior: (repo) => {
        repo.git(['rm', 'src/caller.ts']);
        mkdirSync(join(repo.path, 'src/caller.ts'), { recursive: true });
        writeFileSync(join(repo.path, 'src/caller.ts', 'invalid.ts'), Buffer.from([0xc3, 0x28]));
        repo.git(['add', 'src/caller.ts/invalid.ts']);
        repo.git(['-c', 'user.name=Fixture Tests', '-c', 'user.email=tests@example.invalid', 'commit', '-m', 'replace caller with directory']);
      },
      audit: () => ({ evidence: selectedEvidence ?? 'UNAVAILABLE', fix_location: { path: 'src/caller.ts', change: 'removed' } }),
      onPriorDelta: (_list, selected) => {
        const patch = (selected as { diff: string }).diff;
        expect(patch).not.toContain('invalid.ts');
        selectedEvidence = patch.split('\n').find((line) => line.startsWith('-const selected = '))?.slice(1);
        expect(selectedEvidence).toBe('const selected = nativeRef;');
      },
    });
    expect((await h.run()).canonicalVerdict).toBe('READY TO MERGE');
    expect(h.fake.preflightResults[0]?.text).toContain('"ok":true');
  });

  it('fails closed on two matching changed sources without reclassifying an added path', async () => {
    const prior = 'const unchanged = true;\nconst selected = nativeRef;\n';
    const h = indirectFixHarness({
      priorExtraSource: prior,
      afterPrior: (repo) => {
        repo.commitFile('src/secondary.ts', 'const selected = anotherSetting;\n');
        repo.commitFile('src/caller.ts', 'const selected = nativeSetting;\n');
        repo.commitFile('src/ambiguous.ts', prior);
      },
      audit: { evidence: 'const selected = nativeRef;', fix_location: { path: 'src/ambiguous.ts', change: 'added' } },
    });
    await expect(h.run()).rejects.toThrow(/ambiguous changed source blobs/u);
    expect(h.fake.preflightResults[0]?.text).toContain('"ok":false');
  });

  const renamedSourceSibling = (evidence: string) => {
    const prior = 'const unchanged = true;\nconst selected = nativeRef;\n';
    const h = indirectFixHarness({
      afterPrior: (repo) => {
        repo.git(['mv', 'src/caller.ts', 'src/renamed.ts']);
        repo.commitFile('src/sibling.ts', `${prior}const novel = genuineChange;\n`);
      },
      audit: { evidence, fix_location: { path: 'src/sibling.ts', change: 'added' } },
    });
    const status = h.repo.git(['diff', '--no-ext-diff', '--no-textconv', '--find-renames', '--name-status', 'HEAD^', 'HEAD']);
    expect(status).toMatch(/^R[0-9]+\tsrc\/caller\.ts\tsrc\/renamed\.ts$/mu);
    expect(status).toMatch(/^A\tsrc\/sibling\.ts$/mu);
    return h;
  };

  it('rejects an unchanged line reused from a renamed source in a separate added caller', async () => {
    const h = renamedSourceSibling('const selected = nativeRef;');
    await expect(h.run()).rejects.toThrow(/unchanged line in changed source src\/caller\.ts/u);
    expect(h.fake.preflightResults[0]?.text).toContain('"ok":false');
    expect(existsSync(join(h.frozen.directory, 'consolidated.json'))).toBe(false);
  });

  it('accepts a genuinely novel line in a caller beside a renamed source', async () => {
    const h = renamedSourceSibling('const novel = genuineChange;');
    expect((await h.run()).canonicalVerdict).toBe('READY TO MERGE');
    expect(h.fake.preflightResults[0]?.text).toContain('"ok":true');
  });

  it('does not let an unrelated binary changed source poison a new caller', async () => {
    const h = indirectFixHarness({
      priorCallerBytes: Buffer.from([0, 0xc3, 0x28]),
      afterPrior: (repo) => {
        repo.commitFile('src/caller.ts', 'const unrelated = true;\n');
        repo.commitFile('src/fresh.ts', 'const selected = nativeSetting;\n');
      },
      audit: { fix_location: { path: 'src/fresh.ts', change: 'added' } },
    });
    expect((await h.run()).canonicalVerdict).toBe('READY TO MERGE');
  });

  it('does not read an unrelated oversized changed source to attribute a small new caller', async () => {
    const h = indirectFixHarness({
      priorCallerContent: `const selected = nativeRef;\n${'x'.repeat(8 * 1024 * 1024 + 1)}\n`,
      afterPrior: (repo) => {
        repo.commitFile('src/caller.ts', 'const unrelated = true;\n');
        repo.commitFile('src/fresh.ts', 'const selected = nativeSetting;\n');
      },
      audit: { fix_location: { path: 'src/fresh.ts', change: 'added' } },
    });
    expect((await h.run()).canonicalVerdict).toBe('READY TO MERGE');
  });

  it('accepts removed-line evidence in a deleted caller and rejects binary proof', async () => {
    const deleted = indirectFixHarness({
      afterPrior: (repo) => { repo.git(['rm', 'src/caller.ts']); repo.git(['-c', 'user.name=Fixture Tests', '-c', 'user.email=tests@example.invalid', 'commit', '-m', 'remove caller']); },
      audit: { evidence: 'const selected = nativeRef;', fix_location: { path: 'src/caller.ts', change: 'removed' } },
    });
    expect((await deleted.run()).canonicalVerdict).toBe('READY TO MERGE');
    const binary = indirectFixHarness({
      afterPrior: (repo) => { repo.commitFile('src/caller.ts', '\u0000const selected = nativeSetting;\n'); },
    });
    await expect(binary.run()).rejects.toThrow(/binary|text|changed.*line/u);
  });

  const rejectPriorBinary = async (priorCallerBytes: Buffer): Promise<void> => {
    const options = {
      priorCallerBytes,
      afterPrior: (repo: FixtureRepo) => {
        repo.commitFile('.gitattributes', 'src/caller.ts diff text\n');
        repo.git(['rm', 'src/caller.ts']);
        repo.git(['-c', 'user.name=Fixture Tests', '-c', 'user.email=tests@example.invalid', 'commit', '-m', 'delete raw caller']);
      },
      audit: { evidence: 'const selected = nativeRef;', fix_location: { path: 'src/caller.ts', change: 'removed' } },
    } as const;
    const h = indirectFixHarness(options);
    await expect(h.run()).rejects.toThrow(/binary caller|canonical text/u);
    expect(h.fake.preflightResults[0]?.text).toContain('"ok":false');
    expect(h.fake.toolErrors.some(({ tool, error }) => tool === 'perkins_submit_review' && /binary caller/u.test(error))).toBe(true);
    expect(existsSync(join(h.frozen.directory, 'consolidated.json'))).toBe(false);

    const reader = indirectFixHarness({ ...options, onPriorDelta: () => { throw new Error('binary caller was exposed to lead'); } });
    await expect(reader.run()).rejects.toThrow(/binary caller/u);
    expect(reader.fake.preflightResults).toHaveLength(0);
  };
  it('rejects a NUL prior-only caller in preflight, terminal and lead reader', () =>
    rejectPriorBinary(Buffer.concat([Buffer.from('const selected = nativeRef;\n'), Buffer.from([0])])));
  it('rejects an invalid UTF-8 prior-only caller in preflight, terminal and lead reader', () =>
    rejectPriorBinary(Buffer.concat([Buffer.from('const selected = nativeRef;\n'), Buffer.from([0xc3, 0x28])])));

  it('gives the isolated rereview lead frozen prior-target deleted-caller hunks on demand', async () => {
    let observed = false;
    let evidenceFromLeadTool: string | undefined;
    const h = indirectFixHarness({
      afterPrior: (repo) => {
        repo.git(['rm', 'src/caller.ts']);
        repo.git(['-c', 'user.name=Fixture Tests', '-c', 'user.email=tests@example.invalid', 'commit', '-m', 'remove caller']);
      },
      audit: () => ({ evidence: evidenceFromLeadTool ?? 'UNAVAILABLE', fix_location: { path: 'src/caller.ts', change: 'removed' } }),
      onPriorDelta: (list, selected, prompt) => {
        const inventory = list as { priorTargetSha: string; targetSha: string; changes: Array<{ oldPath: string; newPath: string | null }> };
        const proof = selected as { priorTargetSha: string; targetSha: string; oldPath: string; newPath: string | null; diff: string };
        expect(prompt).toContain('perkins_read_prior_delta');
        expect(prompt).toContain(`Frozen prior target SHA: ${inventory.priorTargetSha}`);
        expect(inventory.targetSha).toBe(h.frozen.manifest.targetSha);
        expect(inventory.changes).toContainEqual({ oldPath: 'src/caller.ts', newPath: null });
        expect(proof).toMatchObject({ priorTargetSha: inventory.priorTargetSha, targetSha: inventory.targetSha, oldPath: 'src/caller.ts', newPath: null });
        const removed = proof.diff.split('\n').find((line) => line.startsWith('-const selected = '));
        expect(removed).toBe('-const selected = nativeRef;');
        evidenceFromLeadTool = removed?.slice(1);
        observed = true;
      },
    });
    expect((await h.run()).canonicalVerdict).toBe('READY TO MERGE');
    expect(observed).toBe(true);
    expect(h.fake.leadCalls[0]?.options.reviewLead?.nativeTools.some((tool) => tool.name === 'perkins_read_prior_delta')).toBe(true);
    expect(h.fake.childCalls.every((call) => call.options.isolatedReview?.nativeTools?.every((tool) => tool.name !== 'perkins_read_prior_delta') ?? true)).toBe(true);
  });

  it('caps the serialized prior-delta envelope consistently for native Pi and the real MCP adapter', async () => {
    const makeLargeDeletion = (backslashes: number) => indirectFixHarness({
      priorCallerContent: `const escaped = "${'\\'.repeat(backslashes)}";\nconst selected = nativeRef;\n`,
      afterPrior: (repo) => {
        repo.git(['rm', 'src/caller.ts']);
        repo.git(['-c', 'user.name=Fixture Tests', '-c', 'user.email=tests@example.invalid', 'commit', '-m', 'delete caller']);
      },
      audit: { evidence: 'const selected = nativeRef;', fix_location: { path: 'src/caller.ts', change: 'removed' } },
    });
    const mcpCall = async (tool: NativeAgentTool): Promise<{ readonly result?: { readonly content: Array<{ readonly text: string }> }; readonly error?: { readonly message: string } }> => {
      const bridge = await ReviewMcpBridge.start([tool]);
      try {
        const child = spawn(process.execPath, [join(import.meta.dirname, '..', 'src/runtime/review-mcp-server.mjs')], {
          env: { ...process.env, GRU_REVIEW_BRIDGE_SOCKET: bridge.socketPath }, stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (part: string) => { stdout += part; });
        child.stderr.on('data', (part: string) => { stderr += part; });
        child.stdin.end(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
          params: { name: 'perkins_read_prior_delta', arguments: { path: 'src/caller.ts' } } })}\n`);
        const exit = await new Promise<number | null>((resolve, reject) => {
          child.once('error', reject);
          child.once('close', resolve);
        });
        expect(exit, stderr).toBe(0);
        return JSON.parse(stdout.trim()) as { result?: { content: Array<{ text: string }> }; error?: { message: string } };
      } finally {
        await bridge.close();
      }
    };
    const small = makeLargeDeletion(100_000);
    expect((await small.run()).canonicalVerdict).toBe('READY TO MERGE');
    const smallTool = small.fake.leadCalls[0]!.options.reviewLead!.nativeTools.find((tool) => tool.name === 'perkins_read_prior_delta')!;
    const piResult = await smallTool.execute({ path: 'src/caller.ts' });
    expect(JSON.parse(piResult.text)).toMatchObject({ oldPath: 'src/caller.ts', newPath: null });
    // Exercise the real Pi adapter's native-tool invocation with an offline
    // intercepted streaming model response; no provider request is sent.
    const home = temp('perkins-r4-pi-home-');
    const workspace = temp('perkins-r4-pi-workspace-');
    writeFileSync(configPathFor(home), `workspace_root = ${JSON.stringify(workspace)}\n`);
    const config = loadConfig({ GRU_COMMAND_HOME: home });
    const runtime = new PiRuntime({ config, store: new SessionStore(config.dataDir), agentDir: temp('perkins-r4-pi-agent-') });
    const originalFetch = globalThis.fetch;
    const previousKey = process.env['DEEPSEEK_API_KEY'];
    process.env['DEEPSEEK_API_KEY'] = 'offline-prior-delta-fixture-key';
    let calls = 0;
    let toolResponseObserved = false;
    try {
      globalThis.fetch = (async (request: string | URL | Request, init?: RequestInit) => {
        if (!String(request).includes('api.deepseek.com')) return originalFetch(request, init);
        calls += 1;
        const body = typeof init?.body === 'string' ? init.body : '';
        if (calls === 2) toolResponseObserved = body.includes('const selected = nativeRef;') && body.includes('const escaped =');
        const chunk = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`;
        const stream = calls === 1 ? [
          chunk({ id: 'call-1', object: 'chat.completion.chunk', created: 0, model: 'deepseek-v4-flash', choices: [{ index: 0,
            delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call-prior', type: 'function',
              function: { name: 'perkins_read_prior_delta', arguments: '{"path":"src/caller.ts"}' } }] }, finish_reason: null }] }),
          chunk({ id: 'call-1', object: 'chat.completion.chunk', created: 0, model: 'deepseek-v4-flash',
            choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
        ] : [chunk({ id: 'call-2', object: 'chat.completion.chunk', created: 0, model: 'deepseek-v4-flash',
          choices: [{ index: 0, delta: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }] })];
        return new Response([...stream, 'data: [DONE]\n\n'].join(''), {
          status: 200, headers: { 'content-type': 'text/event-stream' },
        });
      }) as typeof fetch;
      const handle = await runtime.spawn('perkins', { cwd: workspace, model: 'deepseek/deepseek-v4-flash',
        reviewLead: { systemPrompt: 'Read the frozen prior delta.', tools: ['read'], nativeTools: [smallTool] } });
      try { await handle.prompt('Read the prior caller and say done'); }
      finally { await handle.dispose(); }
      expect(calls).toBe(2);
      expect(toolResponseObserved).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
      if (previousKey === undefined) delete process.env['DEEPSEEK_API_KEY'];
      else process.env['DEEPSEEK_API_KEY'] = previousKey;
      await runtime.dispose();
    }
    const throughMcp = await mcpCall(smallTool);
    expect(throughMcp.error).toBeUndefined();
    expect(throughMcp.result?.content[0]?.text).toBe(piResult.text);

    const large = makeLargeDeletion(270_000);
    expect((await large.run()).canonicalVerdict).toBe('READY TO MERGE');
    const largeTool = large.fake.leadCalls[0]!.options.reviewLead!.nativeTools.find((tool) => tool.name === 'perkins_read_prior_delta')!;
    await expect(largeTool.execute({ path: 'src/caller.ts' })).rejects.toThrow(/bounded serialized tool transport/u);
    expect((await mcpCall(largeTool)).error?.message).toMatch(/bounded serialized tool transport/u);
  });

  it('accepts canonical text caller hunks even when Git attributes suppress diffs', async () => {
    const h = indirectFixHarness({
      afterPrior: (repo) => {
        repo.commitFile('.gitattributes', 'src/caller.ts -diff\n');
        repo.commitFile('src/caller.ts', 'const unchanged = true;\nconst selected = nativeSetting;\n');
      },
    });
    expect((await h.run()).canonicalVerdict).toBe('READY TO MERGE');
  });

  it('keeps frozen caller proof independent of checkout-local Git attributes', async () => {
    const h = indirectFixHarness();
    writeFileSync(join(h.repo.path, '.git', 'info', 'attributes'), 'src/caller.ts -diff\n');
    expect(h.repo.git(['status', '--porcelain'])).toBe('');
    expect((await h.run()).canonicalVerdict).toBe('READY TO MERGE');
    expect(h.fake.preflightResults[0]?.text).toContain('"ok":true');
  });

  it('ignores a configured textconv driver when proving a canonical caller line', async () => {
    const converter = join(temp('perkins-textconv-'), 'converter.mjs');
    const marker = `${converter}.executed`;
    writeFileSync(converter, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'executed');\n`);
    const h = indirectFixHarness({
      afterPrior: (repo) => {
        repo.git(['config', 'diff.poison.textconv', `node ${converter}`]);
        repo.commitFile('.gitattributes', 'src/caller.ts diff=poison\n');
        repo.commitFile('src/caller.ts', 'const unchanged = true;\nconst selected = nativeSetting;\n');
      },
    });
    // Freeze's pre-existing general PR diff may run a configured converter;
    // the new prior-target proof must not invoke it during the review run.
    if (existsSync(marker)) unlinkSync(marker);
    expect((await h.run()).canonicalVerdict).toBe('READY TO MERGE');
    expect(existsSync(marker)).toBe(false);
  });

  it('rejects a binary caller despite forced-text Git attributes', async () => {
    const h = indirectFixHarness({
      afterPrior: (repo) => {
        repo.commitFile('.gitattributes', 'src/caller.ts text diff\n');
        repo.commitFile('src/caller.ts', 'const selected = nativeSetting;\n\u0000BINARY\n');
      },
    });
    await expect(h.run()).rejects.toThrow(/binary|canonical text/u);
    expect(h.fake.preflightResults[0]?.text).toContain('"ok":false');
  });

  it('rejects a forced-text caller with invalid UTF-8 even when a printable changed line exists', async () => {
    const h = indirectFixHarness({
      afterPrior: (repo) => {
        repo.commitFile('.gitattributes', 'src/caller.ts diff\n');
        writeFileSync(join(repo.path, 'src/caller.ts'), Buffer.concat([
          Buffer.from('const selected = nativeSetting;\n'), Buffer.from([0xc3, 0x28]),
        ]));
        repo.git(['add', 'src/caller.ts']);
        repo.git(['-c', 'user.name=Fixture Tests', '-c', 'user.email=tests@example.invalid', 'commit', '-m', 'invalid utf8 caller']);
      },
    });
    await expect(h.run()).rejects.toThrow(/binary|canonical text/u);
    expect(h.fake.preflightResults[0]?.text).toContain('"ok":false');
    expect(h.fake.toolErrors.some(({ tool, error }) => tool === 'perkins_submit_review' && /binary caller blob/u.test(error))).toBe(true);
  });

  it('carries still-present findings with original round markers and dedupes fresh rediscovery', async () => {
    const first = hybridHarness({
      childAnswer: (prompt) => lensFrom(prompt) === 'security' ? JSON.stringify([finding('security')]) : '[]',
    });
    const firstResult = await first.run();
    const fake = fakeHybridSpawner(temp('perkins-carry-sessions-'), {
      childAnswer: (prompt) => lensFrom(prompt) === 'security' ? JSON.stringify([finding('security')]) : '[]',
      priorAudit: () => [{ prior_index: 0, status: 'still-present', evidence: '  return 43;', reason: 'exact defect remains' }],
    });
    const secondFrozen = freezeReviewInputs({
      roundId: 'hybrid-carry-two', repoPath: first.repo.path, artifactRoot: first.root,
      baseRef: first.base, targetRef: first.target, movementRef: 'feature/review', spec: 'return 43',
    });
    const engine = new PerkinsHybridReview({ spawner: fake.spawner, policy: loadPerkinsPolicy() });
    const result = await engine.run({
      roundId: 'hybrid-carry-two', roundNumber: 2, frozenReview: secondFrozen, movementRef: 'feature/review', noSpec: false,
      priorConsolidatedFile: join(firstResult.artifactDirectory, 'consolidated.json'),
    });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      roundOrigin: 1,
      sources: ['security'],
      evidence: '  return 43;',
      verification: { evidence: '  return 43;', reason: 'exact defect remains' },
    });
    expect(result.verificationSummary.deduplicated).toBe(1);
    expect(result.canonicalVerdict).toBe('NEEDS CHANGES');
  });

  it('rejects a prior durable finding missing report-required chunks before any model session', async () => {
    const h = hybridHarness({ childAnswer: () => '[]' });
    const prior = join(h.root, 'malformed-prior.json');
    writeFileSync(prior, JSON.stringify({ schemaVersion: 2, frozen: { targetSha: h.target }, findings: [{
      ...finding('security'),
      sources: ['security'],
      roundOrigin: 1,
      verification: { disposition: 'confirmed', evidence: 'return 43;', reason: 'verified' },
    }] }), 'utf8');
    await expect(h.run({ priorConsolidatedFile: prior })).rejects.toThrow(/failed the durable schema/);
    expect(h.calls).toHaveLength(0);
  });

  it('guard discriminators: foreign refs, dropped candidates, verdict mismatch, and missing report titles all fail closed', async () => {
    const child = (prompt: string) => lensFrom(prompt) === 'security' ? JSON.stringify([finding('security')]) : '[]';
    const foreign = hybridHarness({ childAnswer: child, foreignCandidate: true });
    await expect(foreign.run()).rejects.toThrow(/exactly once|unowned candidate references/);

    const dropped = hybridHarness({ childAnswer: child, dropCandidate: true });
    await expect(dropped.run()).rejects.toThrow(/exactly once/);

    const mismatch = hybridHarness({ childAnswer: child, verdictOverride: 'READY TO MERGE' });
    await expect(mismatch.run()).rejects.toThrow(/conflicts with canonical/);

    const missingTitle = hybridHarness({ childAnswer: child, omitTitle: 'security grounded defect' });
    await expect(missingTitle.run()).rejects.toThrow(/omits required finding proof/);
  });

  it('rejects array-coerced terminal enum values', async () => {
    const child = (prompt: string) => lensFrom(prompt) === 'security' ? JSON.stringify([finding('security')]) : '[]';
    const badDisposition = hybridHarness({
      childAnswer: child,
      decide: () => ({
        disposition: ['confirmed'] as unknown as 'confirmed',
        evidence: 'export function answer(): number {',
        reason: 'array must not pass enum validation',
      }),
    });
    await expect(badDisposition.run()).rejects.toThrow(/disposition is invalid/);

    const badVerdict = hybridHarness({
      childAnswer: () => '[]',
      verdictOverride: ['READY TO MERGE'] as unknown as string,
    });
    await expect(badVerdict.run()).rejects.toThrow(/canonical_verdict is invalid/);
  });

  it('accepts a near-limit report by UTF-8 bytes and rejects a smaller-character multibyte overflow', async () => {
    let nearBytes = 0;
    const near = hybridHarness({
      childAnswer: () => '[]',
      transformReport: (report) => {
        const prefix = `${report}\n`;
        const padding = 'x'.repeat(PERKINS_REPORT_MAX_BYTES - Buffer.byteLength(prefix, 'utf8'));
        const value = `${prefix}${padding}`;
        nearBytes = Buffer.byteLength(value, 'utf8');
        return value;
      },
    });
    await expect(near.run()).resolves.toMatchObject({ canonicalVerdict: 'READY TO MERGE' });
    expect(nearBytes).toBe(PERKINS_REPORT_MAX_BYTES);

    let multibyteCharacters = 0;
    const overflow = hybridHarness({
      childAnswer: () => '[]',
      transformReport: (report) => {
        const value = `${report}\n${'界'.repeat(Math.floor(PERKINS_REPORT_MAX_BYTES / 3) + 1)}`;
        multibyteCharacters = value.length;
        return value;
      },
    });
    expect(multibyteCharacters).toBe(0);
    await expect(overflow.run()).rejects.toThrow(/report_markdown exceeds .* UTF-8 bytes/);
    expect(multibyteCharacters).toBeLessThan(PERKINS_REPORT_MAX_BYTES);
  });

  it('a lead that never submits fails the review without approval', async () => {
    const h = hybridHarness({ childAnswer: () => '[]', neverSubmit: true });
    await expect(h.run()).rejects.toThrow(/without an accepted terminal submission/);
    expect(() => readFileSync(join(h.frozen.directory, 'consolidated.json'))).toThrow();
  });

  it('reports every simultaneous submission violation in one exhaustive rejection', async () => {
    const h = hybridHarness({
      childAnswer: (prompt) => lensFrom(prompt) === 'security'
        ? JSON.stringify([
            finding('security', 'blocker', { title: 'security defect zero' }),
            finding('security', 'blocker', { title: 'security defect one' }),
          ])
        : '[]',
      decide: () => ({
        disposition: 'rejected', evidence: 'FABRICATED-CONTRADICTION', reason: 'lead rejects without reading',
      }),
      transformReport: (report) => report
        .replace(/^Frozen target: .+$/m, 'Frozen target: redacted')
        .replace(/^Frozen base: .+$/m, 'Frozen base: redacted'),
    });
    await expect(h.run()).rejects.toThrow(/terminal submission rejected with 3 error\(s\)/);
    const rejection = h.toolErrors.at(-1)!.error;
    // Both rejected-candidate pairing errors AND the report identity error
    // arrive in ONE response instead of one per attempt.
    expect(rejection).toMatch(/security-\S+#0\b/);
    expect(rejection).toMatch(/security-\S+#1\b/);
    expect(rejection.match(/lacks contradictory frozen evidence/g)).toHaveLength(2);
    expect(rejection).toContain('lead report omits the frozen target/base identity');
    expect(h.toolErrors.filter((entry) => entry.tool === 'perkins_submit_review')).toHaveLength(2);
    expect(() => readFileSync(join(h.frozen.directory, 'consolidated.json'))).toThrow();
  });

  it('preflights a broken submission for free, reporting every error, then accepts the corrected real submission', async () => {
    const h = hybridHarness({
      childAnswer: (prompt) => lensFrom(prompt) === 'security' ? JSON.stringify([finding('security')]) : '[]',
      preflight: {
        calls: 1,
        mutate: (submission) => ({
          ...submission,
          candidate_decisions: submission.candidate_decisions.map((decision) => ({
            ...decision, evidence: 'FABRICATED-PREFLIGHT-EVIDENCE',
          })),
          report_markdown: submission.report_markdown.replace(/^Frozen base: .+$/m, 'Frozen base: gone'),
        }),
      },
    });
    const result = await h.run();
    expect(result.canonicalVerdict).toBe('NEEDS CHANGES');
    expect(h.preflightResults).toHaveLength(1);
    expect(h.preflightResults[0]!.terminate).toBeUndefined();
    const preflight = JSON.parse(h.preflightResults[0]!.text) as {
      preflight: boolean; ok: boolean; errorCount: number;
      errors: Array<{ subject: string; rule: string; message: string }>;
    };
    expect(preflight).toMatchObject({ preflight: true, ok: false, errorCount: 2 });
    expect(preflight.errors.some((error) => /verification evidence is not locatable/.test(error.message))).toBe(true);
    expect(preflight.errors.some((error) => error.message.includes('omits the frozen target/base identity'))).toBe(true);
    // The preflight was free: the following real submission was attempt 1 and sealed.
    expect(existsSync(join(h.frozen.directory, 'lead', 'preflight-attempt-1.json'))).toBe(true);
    expect(existsSync(join(h.frozen.directory, 'lead', 'submission-attempt-1.json'))).toBe(true);
    expect(existsSync(join(h.frozen.directory, 'lead', 'submission-attempt-1.error.json'))).toBe(false);
    expect(readFileSync(join(h.frozen.directory, 'consolidated.json'), 'utf8')).toContain('NEEDS CHANGES');
  });

  it('preflight never seals or terminates: a clean preflight accepts nothing', async () => {
    const h = hybridHarness({
      childAnswer: () => '[]',
      preflight: { calls: 2, withhold: true },
    });
    await expect(h.run()).rejects.toThrow(/without an accepted terminal submission/);
    expect(h.preflightResults).toHaveLength(2);
    for (const entry of h.preflightResults) {
      expect(entry.terminate).toBeUndefined();
      expect(JSON.parse(entry.text)).toMatchObject({ preflight: true, ok: true, errorCount: 0, errors: [] });
    }
    expect(existsSync(join(h.frozen.directory, 'lead', 'preflight-attempt-1.json'))).toBe(true);
    expect(existsSync(join(h.frozen.directory, 'lead', 'preflight-attempt-2.json'))).toBe(true);
    expect(() => readFileSync(join(h.frozen.directory, 'perkins-report.md'))).toThrow();
    expect(() => readFileSync(join(h.frozen.directory, 'consolidated.json'))).toThrow();
  });

  it('preflight is free while the two real attempts stay bound: the third real submit is refused', async () => {
    const h = hybridHarness({
      childAnswer: (prompt) => lensFrom(prompt) === 'security' ? JSON.stringify([finding('security')]) : '[]',
      decide: () => ({
        disposition: 'rejected', evidence: 'FABRICATED-CONTRADICTION', reason: 'lead rejects without reading',
      }),
      preflight: { calls: 2 },
      submitRetries: 2,
    });
    await expect(h.run()).rejects.toThrow(/terminal submission attempts exhausted/);
    expect(h.preflightResults).toHaveLength(2);
    for (const entry of h.preflightResults) {
      expect(JSON.parse(entry.text)).toMatchObject({ preflight: true, ok: false });
    }
    const submitErrors = h.toolErrors.filter((entry) => entry.tool === 'perkins_submit_review');
    expect(submitErrors).toHaveLength(3);
    expect(submitErrors[0]!.error).toMatch(/lacks contradictory frozen evidence/);
    expect(submitErrors[1]!.error).toMatch(/lacks contradictory frozen evidence/);
    expect(submitErrors[2]!.error).toMatch(/terminal submission attempts exhausted/);
    // Two real attempts were spent (and recorded); the third consumed nothing.
    expect(existsSync(join(h.frozen.directory, 'lead', 'submission-attempt-2.json'))).toBe(true);
    expect(existsSync(join(h.frozen.directory, 'lead', 'submission-attempt-3.json'))).toBe(false);
    expect(() => readFileSync(join(h.frozen.directory, 'consolidated.json'))).toThrow();
  });

  it('an amend-delta resubmission merges over the rejected submission and equals a full resubmission of the same content', async () => {
    const fixture = makeReviewRepo();
    repos.push(fixture.repo);
    const base = fixture.repo.git(['rev-parse', 'main']);
    const root = temp('perkins-delta-equivalence-');
    const fixedDecisions = (submission: HybridSubmission) => submission.candidate_decisions.map((entry) => ({
      ...entry, evidence: '  return 43;', reason: 'the frozen line contradicts the candidate',
    }));
    const run = async (
      roundId: string,
      submitPayload: LeadBrainOptions['submitPayload'],
    ): Promise<{ result: PerkinsHybridResult; directory: string; toolErrors: ReturnType<typeof fakeHybridSpawner>['toolErrors'] }> => {
      const frozen = freezeReviewInputs({
        roundId, repoPath: fixture.repo.path, artifactRoot: root,
        baseRef: base, targetRef: fixture.target, movementRef: 'feature/review', spec: 'return 43',
      });
      const fake = fakeHybridSpawner(temp(`perkins-delta-${roundId}-sessions-`), {
        childAnswer: (prompt) => lensFrom(prompt) === 'security' ? JSON.stringify([finding('security')]) : '[]',
        decide: () => ({ disposition: 'rejected', evidence: 'FABRICATED-CONTRADICTION', reason: 'lead rejects without reading' }),
        submitPayload,
      });
      const engine = new PerkinsHybridReview({ spawner: fake.spawner, policy: loadPerkinsPolicy() });
      const result = await engine.run({
        roundId, roundNumber: 1, frozenReview: frozen, movementRef: 'feature/review', noSpec: false,
      });
      return { result, directory: frozen.directory, toolErrors: fake.toolErrors };
    };

    const delta = await run('delta-equivalence', (attempt, submission) =>
      attempt === 1 ? submission : { mode: 'delta', candidate_decisions: fixedDecisions(submission) });
    const full = await run('full-equivalence', (attempt, submission) =>
      attempt === 1 ? submission : { ...submission, candidate_decisions: fixedDecisions(submission) });

    expect(delta.result.canonicalVerdict).toBe('READY TO MERGE');
    expect(full.result.canonicalVerdict).toBe('READY TO MERGE');
    expect(delta.toolErrors).toHaveLength(1);
    expect(full.toolErrors).toHaveLength(1);
    expect(delta.result.verificationSummary).toEqual(full.result.verificationSummary);
    const deltaArtifact = JSON.parse(readFileSync(join(delta.directory, 'lead', 'submission-attempt-2.delta.json'), 'utf8')) as {
      delta: { mode: string; candidate_decisions?: ReadonlyArray<{ evidence: string }> };
    };
    expect(deltaArtifact.delta.mode).toBe('delta');
    expect(deltaArtifact.delta.candidate_decisions?.map((entry) => entry.evidence)).toEqual(['  return 43;']);
    // Merge + validate + seal produced the byte-identical accepted submission
    // a full resubmission of the same content would have produced.
    expect(readFileSync(join(delta.directory, 'lead', 'submission-attempt-2.json'), 'utf8'))
      .toBe(readFileSync(join(full.directory, 'lead', 'submission-attempt-2.json'), 'utf8'));
  });

  it('record validates one decision at store time with the same exhaustive rules as the terminal submission', async () => {
    const h = hybridHarness({
      childAnswer: (prompt) => lensFrom(prompt) === 'security' ? JSON.stringify([finding('security')]) : '[]',
      decide: () => ({ disposition: 'confirmed', evidence: 'FABRICATED-LEAD-EVIDENCE', reason: 'lead never read this' }),
      recordDecisions: { only: [0] },
    });
    await expect(h.run()).rejects.toThrow(/terminal submission rejected/);
    expect(h.recordResults).toHaveLength(1);
    const record = JSON.parse(h.recordResults[0]!.text) as {
      recorded: boolean; ok: boolean; errorCount: number;
      errors: ReadonlyArray<{ subject: string; rule: string; message: string }>;
    };
    expect(record).toMatchObject({ recorded: false, ok: false, errorCount: 1 });
    const rejection = JSON.parse(readFileSync(join(h.frozen.directory, 'lead', 'submission-attempt-1.error.json'), 'utf8')) as {
      issues: ReadonlyArray<{ subject: string; rule: string; message: string }>;
    };
    const ref = record.errors[0]!.subject;
    expect(rejection.issues.filter((issue) => issue.subject === ref)).toEqual(record.errors);
    expect(existsSync(join(h.frozen.directory, 'lead', 'record-attempt-1.json'))).toBe(true);
  });

  it('seals a pre-rejection decision record through a delta carrying only the report, verdict, and prior audit', async () => {
    const h = hybridHarness({
      childAnswer: (prompt) => lensFrom(prompt) === 'security' ? JSON.stringify([finding('security')]) : '[]',
      recordDecisions: {},
      submitPayload: (attempt, submission) => attempt === 1
        ? {
            mode: 'delta',
            canonical_verdict: submission.canonical_verdict,
            prior_audit: submission.prior_audit,
            report_markdown: submission.report_markdown,
          }
        : submission,
    });
    const result = await h.run();
    expect(result.canonicalVerdict).toBe('NEEDS CHANGES');
    expect(h.recordResults).toHaveLength(1);
    expect(JSON.parse(h.recordResults[0]!.text)).toMatchObject({ recorded: true, ok: true, recordedCount: 1 });
    const merged = JSON.parse(readFileSync(join(h.frozen.directory, 'lead', 'submission-attempt-1.json'), 'utf8')) as {
      candidate_decisions: ReadonlyArray<{ candidate_ref: string }>;
    };
    expect(merged.candidate_decisions).toHaveLength(1);
    const deltaArtifact = JSON.parse(readFileSync(join(h.frozen.directory, 'lead', 'submission-attempt-1.delta.json'), 'utf8')) as {
      delta: { mode: string; candidate_decisions?: unknown };
    };
    expect(deltaArtifact.delta.mode).toBe('delta');
    expect(deltaArtifact.delta.candidate_decisions).toBeUndefined();
    expect(existsSync(join(h.frozen.directory, 'lead', 'submission-attempt-1.error.json'))).toBe(false);
  });

  it('record and a delta preflight spend no terminal attempt while a delta resubmission consumes one real attempt', async () => {
    const fixed = (submission: HybridSubmission) => submission.candidate_decisions.map((entry) => ({
      ...entry, evidence: '  return 43;', reason: 'the frozen line contradicts the candidate',
    }));
    const delta = (submission: HybridSubmission) => ({
      mode: 'delta' as const,
      candidate_decisions: fixed(submission),
    });
    const h = hybridHarness({
      childAnswer: (prompt) => lensFrom(prompt) === 'security' ? JSON.stringify([finding('security')]) : '[]',
      decide: () => ({ disposition: 'rejected', evidence: 'FABRICATED-CONTRADICTION', reason: 'lead rejects without reading' }),
      recordDecisions: { decide: () => ({ disposition: 'rejected', evidence: '  return 43;', reason: 'recorded after re-reading' }) },
      preflight: { beforeAttempt: 2, payload: (submission) => delta(submission) },
      submitPayload: (attempt, submission) => attempt === 1 ? submission : delta(submission),
    });
    const result = await h.run();
    expect(result.canonicalVerdict).toBe('READY TO MERGE');
    expect(JSON.parse(h.recordResults[0]!.text)).toMatchObject({ recorded: true, ok: true });
    expect(JSON.parse(h.preflightResults[0]!.text)).toMatchObject({ preflight: true, mode: 'delta', ok: true, errorCount: 0 });
    // Attempt 1 was the rejected full submission; the free calls never moved
    // the counter, so the delta sealed as attempt 2 and a third never existed.
    expect(existsSync(join(h.frozen.directory, 'lead', 'submission-attempt-1.error.json'))).toBe(true);
    expect(existsSync(join(h.frozen.directory, 'lead', 'submission-attempt-2.json'))).toBe(true);
    expect(existsSync(join(h.frozen.directory, 'lead', 'submission-attempt-2.error.json'))).toBe(false);
    expect(existsSync(join(h.frozen.directory, 'lead', 'submission-attempt-3.json'))).toBe(false);
    const receipt = JSON.parse(readFileSync(join(h.frozen.directory, 'lead', 'receipt.json'), 'utf8')) as {
      preflightCalls: number; decisionRecords: number; deltaSubmissions: number;
    };
    expect(receipt).toMatchObject({ preflightCalls: 1, decisionRecords: 1, deltaSubmissions: 1 });
  });

  it('fails a child attempt at construction when cited evidence belongs to another file and retries within the lens bound', async () => {
    let securityCalls = 0;
    const h = hybridHarness({
      childAnswer: (prompt) => {
        if (lensFrom(prompt) !== 'security') return '[]';
        securityCalls += 1;
        return securityCalls === 1
          ? JSON.stringify([finding('security', 'blocker', {
              location: 'src/main.ts:1',
              evidence: 'Fixture repository for dispatch-flow tests.',
            })])
          : '[]';
      },
    });
    const result = await h.run();
    expect(result.canonicalVerdict).toBe('READY TO MERGE');
    expect(result.verificationSummary.candidates).toBe(0);
    expect(securityCalls).toBe(2);
    const lensDir = join(h.frozen.directory, 'lenses', '001');
    const envelopeFor = (attempt: string) => JSON.parse(readFileSync(
      join(lensDir, readdirSync(lensDir).find((name) => name.startsWith(`security.attempt-${attempt}-`) && name.endsWith('.envelope.json'))!),
      'utf8',
    )) as { status: string; failureKind?: string; findings: readonly unknown[]; error?: string };
    const firstAttempt = envelopeFor('1');
    expect(firstAttempt.status).toBe('invalid');
    expect(firstAttempt.failureKind).toBe('output');
    expect(firstAttempt.error).toMatch(/lens finding 0 evidence is not locatable at its cited file\/hunk: src\/main\.ts:1/u);
    const secondAttempt = envelopeFor('2');
    expect(secondAttempt.status).toBe('valid');
    expect(secondAttempt.findings).toEqual([]);
    // The lead never inherited the mispaired candidate: nothing to decide.
    expect(h.toolErrors).toEqual([]);
  });

  it('rejects an unamendable or malformed delta envelope without advancing the stored base', async () => {
    const h = hybridHarness({
      childAnswer: (prompt) => lensFrom(prompt) === 'security' ? JSON.stringify([finding('security')]) : '[]',
      submitPayload: (attempt, submission) => attempt === 1
        ? { mode: 'delta', extra_field: true, candidate_decisions: submission.candidate_decisions }
        : submission,
      submitRetries: 0,
    });
    await expect(h.run()).rejects.toThrow(/delta submission contains unsupported keys: extra_field/);
    const rejection = JSON.parse(readFileSync(join(h.frozen.directory, 'lead', 'submission-attempt-1.error.json'), 'utf8')) as {
      issues: ReadonlyArray<{ subject: string; rule: string; message: string }>;
    };
    expect(rejection.issues.some((issue) => issue.rule === 'delta-shape')).toBe(true);
    expect(rejection.issues.some((issue) => issue.rule === 'delta-base')).toBe(true);
    // The broken envelope resolved to no coherent submission: nothing stored.
    expect(existsSync(join(h.frozen.directory, 'lead', 'submission-attempt-1.json'))).toBe(false);
    expect(existsSync(join(h.frozen.directory, 'lead', 'submission-attempt-1.delta.json'))).toBe(true);
  });

  it('refuses to amend a rejected submission past the stored-base byte bound', async () => {
    // 400 shape-valid decisions with ~3.9 KB of fabricated verification
    // evidence serialize past the 1 MiB delta-base bound: the rejected whole
    // is neither stored nor amendable, and the delta tells the lead to
    // resubmit it whole.
    const fabricated = 'F'.repeat(3_950);
    const many = (lens: 'blind' | 'security'): string =>
      JSON.stringify(Array.from({ length: 200 }, (_, index) =>
        finding(lens, 'warning', { title: `${lens} grounded candidate ${index}` })));
    const h = hybridHarness({
      childAnswer: (prompt) => {
        const lens = lensFrom(prompt);
        return lens === 'security' || lens === 'blind' ? many(lens) : '[]';
      },
      decide: () => ({ disposition: 'confirmed', evidence: fabricated, reason: 'lead claims verification' }),
      // The first attempt must stay a shape-clean submission so the host has
      // something to weigh against the delta-base bound; its defects are
      // semantic, so the report body itself is irrelevant here.
      transformReport: () => '# rejected draft report\n',
      submitPayload: (attempt, submission) => attempt === 1
        ? submission
        : { mode: 'delta', report_markdown: '# amended report\n' },
    });
    await expect(h.run()).rejects.toThrow(/exceeded the delta base byte bound; resubmit the full submission/u);
    const stored = join(h.frozen.directory, 'lead', 'submission-attempt-1.json');
    expect(Buffer.byteLength(readFileSync(stored, 'utf8'), 'utf8')).toBeGreaterThan(1024 * 1024);
    expect(existsSync(join(h.frozen.directory, 'lead', 'submission-attempt-2.delta.json'))).toBe(true);
    expect(existsSync(join(h.frozen.directory, 'lead', 'submission-attempt-2.json'))).toBe(false);
    const rejection = JSON.parse(readFileSync(join(h.frozen.directory, 'lead', 'submission-attempt-2.error.json'), 'utf8')) as {
      issues: ReadonlyArray<{ rule: string; message: string }>;
    };
    expect(rejection.issues.some((issue) =>
      issue.rule === 'delta-base' && issue.message.includes('exceeded the delta base byte bound'))).toBe(true);
  });

  it('reports every invalid prior-audit entry in one rejection', async () => {
    const prior = (index: number): Record<string, unknown> => ({
      ...finding('security', 'blocker', { title: `prior defect ${index}` }),
      sources: ['security'],
      chunks: ['001'],
      roundOrigin: 1,
      verification: { disposition: 'confirmed', evidence: 'export function answer(): number {', reason: 'verified in round 1' },
    });
    const h = hybridHarness({
      childAnswer: () => '[]',
      priorAudit: (entries) => entries.map((_entry, index) => ({
        prior_index: index, status: 'still-present', evidence: `FABRICATED-PRIOR-PROOF-${index}`, reason: 'fabricated',
      })),
    });
    const priorFile = join(h.root, 'prior-two.json');
    writeFileSync(priorFile, JSON.stringify({
      schemaVersion: 2, frozen: { targetSha: h.target }, findings: [prior(0), prior(1)],
    }), 'utf8');
    await expect(h.run({ priorConsolidatedFile: priorFile })).rejects.toThrow(/prior audit 0 evidence is not locatable/);
    const rejection = h.toolErrors.at(-1)!.error;
    expect(rejection).toContain("prior audit 0 evidence is not locatable at the finding's cited frozen file/hunk");
    expect(rejection).toContain("prior audit 1 evidence is not locatable at the finding's cited frozen file/hunk");
  });

  it('exposes bounded read-chunk and store-artifact tools to the lead', async () => {
    const h = hybridHarness({
      childAnswer: () => '[]',
      readChunks: true,
      storeArtifact: { name: 'note-1.md', content: 'Lead investigation note.' },
    });
    const result = await h.run();
    expect(readFileSync(join(result.artifactDirectory, 'lead', 'notes', 'note-1.md'), 'utf8')).toContain('Lead investigation note.');
  });

  it('rejects out-of-contract tool usage: non-required lenses, duplicate runs, and duplicate artifacts', async () => {
    const badLens = hybridHarness({
      childAnswer: () => '[]',
      badRuns: [{ lens: 'acceptance', chunk: '001' }],
    }, { noSpec: true });
    await expect(badLens.run({ noSpec: true })).rejects.toThrow(/not required/);

    const duplicate = hybridHarness({ childAnswer: () => '[]', duplicateRun: true });
    await expect(duplicate.run()).rejects.toThrow(/cannot duplicate/);

    const duplicateArtifact = hybridHarness({
      childAnswer: () => '[]',
      storeArtifact: { name: 'note-1.md', content: 'first' },
      duplicateArtifact: true,
    });
    await expect(duplicateArtifact.run()).rejects.toThrow(/limit or duplicate/u);

    const h = hybridHarness({
      childAnswer: () => '[]',
      storeArtifact: { name: 'note-1.md', content: 'first' },
    });
    await h.run();
  });

  it('rejects terminal submission when the lead never read a frozen chunk', async () => {
    const h = hybridHarness({ childAnswer: () => '[]', readChunks: false });
    await expect(h.run()).rejects.toThrow(/lead has not read every frozen chunk/u);
    expect(() => readFileSync(join(h.frozen.directory, 'consolidated.json'))).toThrow();
  });

  it('treats a CONCERNS coverage gate as a warning that never blocks', async () => {
    const h = hybridHarness({
      childAnswer: (prompt) => {
        const lens = lensFrom(prompt);
        if (lens === 'tests') {
          return JSON.stringify([{ ...finding('tests', 'warning'), category: 'coverage-gate', title: 'Coverage gate: CONCERNS', location: 'N/A', evidence: 'N/A', detail: 'live smoke not executed', recommended_fix: 'run the smoke' }]);
        }
        return '[]';
      },
    });
    const result = await h.run();
    expect(result.canonicalVerdict).toBe('READY TO MERGE');
    expect(result.findings.some((f) => f.category === 'coverage-gate')).toBe(false);
  });

  it('blocks READY when the tests lens reports a FAIL coverage gate', async () => {
    const h = hybridHarness({
      childAnswer: (prompt) => {
        const lens = lensFrom(prompt);
        if (lens === 'tests') {
          return JSON.stringify([{ ...finding('tests', 'blocker'), category: 'coverage-gate', title: 'Coverage gate: FAIL', location: 'N/A', evidence: 'N/A', detail: 'changed behavior is untested', recommended_fix: 'add tests' }]);
        }
        return '[]';
      },
    });
    const result = await h.run();
    expect(result.canonicalVerdict).toBe('NEEDS CHANGES');
    expect(result.findings.some((f) => f.category === 'coverage-gate' && f.severity === 'blocker')).toBe(true);
  });

  it('forces INCOMPLETE when the target ref moves and rejects a conclusive proposal', async () => {
    const rejected = hybridHarness({
      childAnswer: () => '[]',
      beforeSubmit: () => {
        rejected.repo.git(['checkout', '-B', 'feature/review', rejected.repo.head()]);
        rejected.repo.commitFile('src/moved.ts', 'export const moved = true;\n');
      },
    });
    await expect(rejected.run()).rejects.toThrow(/conflicts with canonical INCOMPLETE/);
    expect(() => readFileSync(join(rejected.frozen.directory, 'consolidated.json'))).toThrow();

    const accepted = hybridHarness({
      childAnswer: () => '[]',
      verdictOverride: 'INCOMPLETE',
      beforeSubmit: () => {
        accepted.repo.git(['checkout', '-B', 'feature/review', accepted.repo.head()]);
        accepted.repo.commitFile('src/moved.ts', 'export const moved = true;\n');
      },
    });
    const result = await accepted.run();
    expect(result.headMoved).toBe(true);
    expect(result.targetSha).toBe(accepted.target);
    expect(result.completeness.complete).toBe(false);
    expect(result.canonicalVerdict).toBe('INCOMPLETE');
    expect(readFileSync(result.reportFile, 'utf8')).toContain('**Verdict: INCOMPLETE**');
  });

  it('freezes exact SHAs, hashes and full diff artifacts before model work without overwriting a round', () => {
    const h = makeReviewRepo();
    repos.push(h.repo);
    const root = temp('perkins-freeze-');
    const input = {
      roundId: 'freeze', repoPath: h.repo.path, artifactRoot: root,
      baseRef: h.base, targetRef: h.target, movementRef: 'feature/review', spec: 'spec',
    } as const;
    const frozen = freezeReviewInputs(input);
    expect(frozen.manifest).toMatchObject({ targetSha: h.target, diffBaseSha: h.base, specMode: 'supplied' });
    expect(frozen.diff).toContain('return 43');
    const originalManifest = readFileSync(join(frozen.directory, 'manifest.json'), 'utf8');
    expect(readFileSync(join(frozen.directory, 'diff.patch'), 'utf8')).toBe(frozen.diff);
    expect(() => freezeReviewInputs(input)).toThrow(/EEXIST/);
    expect(readFileSync(join(frozen.directory, 'manifest.json'), 'utf8')).toBe(originalManifest);
  });
});

describe('Perkins child structured findings (perkins_submit_findings)', () => {
  it('validates the perkins_submit_findings input exactly, with source host-owned', () => {
    const entry = { ...finding('security') } as Record<string, unknown>;
    delete entry.source;
    expect(parseFindingsSubmission({ findings: [entry] }, 'security')).toEqual([finding('security')]);
    expect(() => parseFindingsSubmission({ findings: [{ ...entry, source: 'security' }] }, 'security'))
      .toThrow(/keys do not match the required schema/u);
    expect(() => parseFindingsSubmission({ findings: [{ ...entry, severity: 'oops' }] }, 'security'))
      .toThrow(/severity is invalid/u);
    expect(() => parseFindingsSubmission({ findings: '[]' }, 'security')).toThrow(/must be an array/u);
    expect(() => parseFindingsSubmission({ findings: [], extra: true }, 'security')).toThrow(/keys do not match/u);
    expect(() => parseFindingsSubmission(entry, 'security')).toThrow(/keys do not match/u);
  });

  it('recovers whitespace, fence, preamble, and embedded arrays but never loosens the schema', () => {
    const bare = JSON.stringify([finding('blind')]);
    expect(parseFindingsWithRecovery(bare, 'blind').recovery).toBeUndefined();
    expect(parseFindingsWithRecovery(`\n\n${bare}\n`, 'blind').recovery).toBe('parsed-from-whitespace');
    expect(parseFindingsWithRecovery(`\`\`\`json\n${bare}\n\`\`\``, 'blind').recovery).toBe('parsed-from-fence');
    expect(parseFindingsWithRecovery(`Summary follows.\n${bare}`, 'blind').recovery).toBe('parsed-from-preamble');
    expect(parseFindingsWithRecovery(`Here [see below] is the review:\n${bare}\nDone.`, 'blind').recovery)
      .toBe('parsed-from-embedded-array');
    const bad = JSON.stringify([{ ...finding('blind'), severity: 'oops' }]);
    expect(() => parseFindingsWithRecovery(`\`\`\`json\n${bad}\n\`\`\``, 'blind')).toThrow(/severity is invalid/u);
    expect(() => parseFindingsWithRecovery('no array anywhere', 'blind')).toThrow(/bare JSON array/u);
  });

  it('records a schema-valid perkins_submit_findings call as a valid child envelope', async () => {
    const h = hybridHarness({
      childAnswer: (prompt) => lensFrom(prompt) === 'security' ? JSON.stringify([finding('security', 'warning')]) : '[]',
      childNativeTools: 'tool',
    });
    const result = await h.run();
    expect(result.canonicalVerdict).toBe('READY TO MERGE');
    expect(result.completeness).toMatchObject({ complete: true, validLensRuns: 7 });
    expect(h.childCalls).toHaveLength(7);
    const security = h.childCalls.find((call) => lensFrom(call.prompt ?? '') === 'security')!;
    expect(security.options.isolatedReview?.nativeTools?.map((tool) => tool.name)).toEqual(['perkins_submit_findings']);
    expect(security.prompt).toContain('Findings leave this run ONLY through perkins_submit_findings');
    expect(security.prompt).toContain('Your lens id is "security"');
    expect(security.prompt).not.toContain('Return ONE valid JSON array');
    const blind = h.childCalls.find((call) => lensFrom(call.prompt ?? '') === 'blind')!;
    expect(blind.prompt).toContain('perkins_submit_findings');
    expect(blind.prompt).toContain('Do not use tools other than perkins_submit_findings');
    const envelope = readChildEnvelope(h.frozen.directory, 'security', 1);
    expect(envelope.status).toBe('valid');
    expect(envelope.outputSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(envelope.findings).toHaveLength(1);
    // The durable raw artifact is the exact validated submission: the host
    // injected source; the child never supplied it.
    const rawSubmission = JSON.parse(readFileSync(childEnvelopePaths(h.frozen.directory, 'security', 1).raw, 'utf8')) as {
      findings: Array<Record<string, unknown>>;
    };
    expect(rawSubmission.findings).toHaveLength(1);
    expect(rawSubmission.findings[0]).toMatchObject({ title: 'security grounded defect' });
    expect(rawSubmission.findings[0]).not.toHaveProperty('source');
  });

  it('rejects a schema-invalid tool call as an invalid envelope naming the precise reason', async () => {
    const h = hybridHarness({
      childAnswer: (prompt) => lensFrom(prompt) === 'security'
        ? JSON.stringify([{ ...finding('security', 'warning'), severity: 'oops' }])
        : '[]',
      childNativeTools: 'tool',
    });
    await expect(h.run()).rejects.toThrow(/coverage exhausted/u);
    const envelope = readChildEnvelope(h.frozen.directory, 'security', 2);
    expect(envelope.status).toBe('invalid');
    expect(envelope.failureKind).toBe('output');
    expect(envelope.error).toContain('severity is invalid');
    expect(envelope.findings).toEqual([]);
    expect(readFileSync(join(h.frozen.directory, 'coverage-exhausted.json'), 'utf8')).toContain('severity is invalid');
  });

  it('marks a tool-capable child that never calls the tool invalid and retries it through the lead', async () => {
    let securityCalls = 0;
    const h = hybridHarness({
      childAnswer: (prompt) => {
        if (lensFrom(prompt) !== 'security') return '[]';
        securityCalls += 1;
        return securityCalls === 1 ? 'I reviewed the diff but never submitted anything.' : JSON.stringify([finding('security', 'warning')]);
      },
      childNativeTools: 'tool',
    });
    const result = await h.run();
    expect(result.canonicalVerdict).toBe('READY TO MERGE');
    expect(securityCalls).toBe(2);
    expect(h.childCalls).toHaveLength(8);
    const first = readChildEnvelope(h.frozen.directory, 'security', 1);
    expect(first.status).toBe('invalid');
    expect(first.error).toContain('did not submit findings');
    expect(readChildEnvelope(h.frozen.directory, 'security', 2).status).toBe('valid');
  });

  it('delivers the host rejection as native-tool corrective context on the submission retry', async () => {
    let securityCalls = 0;
    const h = hybridHarness({
      childAnswer: (prompt) => {
        if (lensFrom(prompt) !== 'security') return '[]';
        securityCalls += 1;
        return securityCalls === 1
          ? 'I reviewed the diff but never submitted anything.'
          : JSON.stringify([finding('security', 'warning')]);
      },
      childNativeTools: 'tool',
    });
    const result = await h.run();
    expect(result.canonicalVerdict).toBe('READY TO MERGE');
    const security = h.childCalls.filter((call) => lensFrom(call.prompt ?? '') === 'security');
    expect(security).toHaveLength(2);
    expect(security[0]!.prompt).not.toContain('RETRY CORRECTION');
    expect(security[1]!.prompt).toContain('--- RETRY CORRECTION (attempt 2) ---');
    expect(security[1]!.prompt).toContain('Previous attempt rejected (output):');
    expect(security[1]!.prompt).toContain('did not submit findings via perkins_submit_findings');
    expect(security[1]!.prompt).toContain('call perkins_submit_findings exactly once');
    expect(readChildEnvelope(h.frozen.directory, 'security', 1)).toMatchObject({
      status: 'invalid', failureKind: 'output',
    });
  });

  it('never parses assistant JSON back on a tool-capable child: text-only output is invalid', async () => {
    const h = hybridHarness({
      childAnswer: (prompt) => lensFrom(prompt) === 'security' ? JSON.stringify([finding('security', 'warning')]) : '[]',
      childNativeTools: 'text-only',
    });
    await expect(h.run()).rejects.toThrow(/coverage exhausted/u);
    // The blind lens answers a valid JSON array as assistant text, yet the
    // tool-capable contract rejects it: only perkins_submit_findings counts.
    const envelope = readChildEnvelope(h.frozen.directory, 'blind', 2);
    expect(envelope.status).toBe('invalid');
    expect(envelope.error).toContain('did not submit findings');
    expect(envelope.findings).toEqual([]);
  });

  it('recovers fenced and preamble-wrapped output for non-tool (text-path) children', async () => {
    const h = hybridHarness({
      childAnswer: (prompt) => {
        const lens = lensFrom(prompt);
        if (lens === 'security') return `\`\`\`json\n${JSON.stringify([finding('security', 'warning')])}\n\`\`\``;
        if (lens === 'edge') return `Here are my findings:\n[]\nEnd of review.`;
        return '[]';
      },
    });
    const result = await h.run();
    expect(result.canonicalVerdict).toBe('READY TO MERGE');
    const security = readChildEnvelope(h.frozen.directory, 'security', 1);
    expect(security.status).toBe('valid');
    expect(security.recovery).toBe('parsed-from-fence');
    expect(security.findings).toHaveLength(1);
    const edge = readChildEnvelope(h.frozen.directory, 'edge', 1);
    expect(edge.status).toBe('valid');
    expect(edge.recovery).toBe('parsed-from-embedded-array');
  });

  it('keeps the policy pin, the compiler pin, and the verifier pin consistent', () => {
    const productRoot = join(import.meta.dirname, '..');
    const policyBytes = readFileSync(join(productRoot, 'resources', 'perkins-code-review', 'policy.json'));
    const actual = createHash('sha256').update(policyBytes).digest('hex');
    expect(PERKINS_POLICY_SHA256).toBe(actual);
    expect(readFileSync(join(productRoot, 'src', 'dispatch', 'perkins-review', 'policy.ts'), 'utf8')).toContain(actual);
    expect(readFileSync(join(productRoot, 'tools', 'verify-perkins-resource.mjs'), 'utf8')).toContain(actual);
    // Children are tool-only where the runtime provides the tool; the lead
    // workflow is unchanged and never sees the child submission tool.
    const policy = loadPerkinsPolicy();
    expect(policy.portableContract.outputContracts.nativeTool).toContain('perkins_submit_findings');
    expect(policy.portableContract.leadWorkflow).not.toContain('perkins_submit_findings');
  });
});

describe('review base resolution and remote base drift', () => {
  it('resolves explicit base, origin/HEAD, main fallback, and fails closed with no base', () => {
    const repo = makeFixtureRepo('perkins-base-resolution'); // starts on main
    repos.push(repo);
    repo.commitFile('src/base.ts', 'export const base = 1;\n');
    expect(resolveReviewBaseRef(repo.path, 'main')).toBe('main');
    expect(resolveReviewBaseRef(repo.path, '')).toBe('main');
    expect(resolveReviewBaseRef(repo.path, null)).toBe('main');
    // A bare repo with no resolvable base fails closed, named.
    const bare = makeFixtureRepo('perkins-base-resolution-none');
    repos.push(bare);
    execFileSync('git', ['-C', bare.path, 'checkout', '--orphan', 'empty'], { stdio: 'ignore' });
    execFileSync('git', ['-C', bare.path, 'branch', '-D', 'main'], { stdio: 'ignore' });
    expect(() => resolveReviewBaseRef(bare.path, null)).toThrow(/requires job.baseBranch or a resolvable/u);
  });

  it('freezes with a local slash-bearing baseRef and sees no drift', () => {
    const repo = makeFixtureRepo('perkins-base-local-slash');
    const base = repo.commitFile('src/one.ts', 'export const one = 1;\n');
    repo.commitFile('src/two.ts', 'export const two = 2;\n');
    const frozen = freezeReviewInputs({
      roundId: 'local-slash', repoPath: repo.path, artifactRoot: temp('perkins-local-slash-'),
      baseRef: base, targetRef: repo.head(), spec: 's',
    });
    // A 40-hex base cannot drift remotely; the local check alone applies.
    expect(frozen.manifest.baseRef).toBe(base);
    expect(baseMovedSinceFreeze(frozen)).toBe(false);
  });

  it('detects remote base drift, tolerates missing remotes, and fails closed on ls-remote errors', () => {
    const repo = makeFixtureRepo('perkins-base-drift');
    repos.push(repo);
    repo.commitFile('src/base.ts', 'export const base = 1;\n');
    const remoteBare = temp('perkins-drift-remote-');
    execFileSync('git', ['init', '--bare', remoteBare], { stdio: 'ignore' });
    execFileSync('git', ['-C', repo.path, 'remote', 'add', 'origin', remoteBare]);
    execFileSync('git', ['-C', repo.path, 'push', 'origin', 'main'], { stdio: 'ignore' });
    // A local commit AHEAD of the remote base gives the frozen diff content.
    repo.commitFile('src/reviewed.ts', 'export const reviewed = 1;\n');
    const frozen = freezeReviewInputs({
      roundId: 'drift-check', repoPath: repo.path, artifactRoot: temp('perkins-drift-artifacts-'),
      baseRef: 'origin/main', targetRef: repo.head(), spec: 'drift check',
    });
    expect(baseMovedSinceFreeze(frozen)).toBe(false);
    // Remote-only movement: the local branch still matches, the remote moved.
    const advance = temp('perkins-drift-clone-');
    // Bare git init may leave HEAD pointing at master; explicitly check out
    // the remote's main before committing or pushing remote-only drift.
    execFileSync('git', ['clone', '--quiet', '--branch', 'main', remoteBare, advance], { stdio: 'ignore' });
    writeFileSync(join(advance, 'drift.ts'), 'export const drift = true;\n', 'utf8');
    execFileSync('git', ['-C', advance, 'add', 'drift.ts'], { stdio: 'ignore' });
    execFileSync('git', ['-C', advance, '-c', 'user.name=Fixture Tests', '-c', 'user.email=tests@example.invalid', 'commit', '-m', 'drift'], { stdio: 'ignore' });
    execFileSync('git', ['-C', advance, 'push', 'origin', 'main'], { stdio: 'ignore' });
    expect(baseMovedSinceFreeze(frozen)).toBe(true);
    rmSync(advance, { recursive: true, force: true });

    // A slash-bearing LOCAL branch (feature/x) is not a remote: local check
    // passes and the absent remote is not misparsed as a drift source.
    const localBranch = freezeReviewInputs({
      roundId: 'drift-local', repoPath: repo.path, artifactRoot: temp('perkins-drift-artifacts-'),
      baseRef: 'origin/main', targetRef: repo.head(), spec: 'drift check',
    });
    expect(localBranch.manifest.baseRef).toBe('origin/main');
    // Frozen after the remote moved: the same remote/branch drift applies.
    expect(baseMovedSinceFreeze(localBranch)).toBe(true);
    // ls-remote against a vanished remote fails closed as drift.
    rmSync(remoteBare, { recursive: true, force: true });
    expect(baseMovedSinceFreeze(localBranch)).toBe(true);
  });
});

describe('review chunking and artifact guards (third-review fixes)', () => {
  it('splits an oversized multi-hunk file at hunk boundaries within both bounds', () => {
    const hunk = Array.from({ length: 2500 }, (_, i) => `+export const thing${i} = ${i};`).join('\n'); // ~72 KiB per hunk
    const fileBlock = (name: string): string => `diff --git a/${name} b/${name}
index 1111111..2222222 100644
--- a/${name}
+++ b/${name}
@@ -1,3 +1,703 @@
 context
${hunk}
@@ -200,3 +900,703 @@
 more context
${hunk}
@@ -400,3 +1500,703 @@
 more context
${hunk}
@@ -600,3 +2100,703 @@
 more context
${hunk}
`;
    const diff = `${fileBlock('src/big.ts')}${fileBlock('src/other.ts')}`;
    const chunks = chunkUnifiedDiff(diff, 3000);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (const chunk of chunks) {
      expect(Buffer.byteLength(chunk.diff, 'utf8')).toBeLessThanOrEqual(FROZEN_CHUNK_MAX_BYTES);
      expect(chunk.oversizeSingleFile).toBe(false);
      expect(chunk.diff).toMatch(/^@@/m);
    }
    expect(chunks.flatMap((chunk) => chunk.files)).toContain('src/big.ts');
    expect(chunks.flatMap((chunk) => chunk.files)).toContain('src/other.ts');
  });

  it('splits a file whose path contains @@ at the true hunk boundary', () => {
    const body = 'diff --git a/src/we@@ird.ts b/src/we@@ird.ts\nindex 1111111..2222222 100644\n--- a/src/we@@ird.ts\n+++ b/src/we@@ird.ts\n@@ -1,2 +1,3 @@\n context\n+added line\n';
    const chunks = chunkUnifiedDiff(body, 1);
    const weird = chunks.filter((chunk) => chunk.files[0] === 'src/we@@ird.ts');
    expect(weird.length).toBeGreaterThanOrEqual(1);
    for (const chunk of weird) {
      expect(chunk.diff.startsWith('diff --git a/src/we@@ird.ts b/src/we@@ird.ts')).toBe(true);
      expect(chunk.diff).toContain('@@ -1,2 +1,3 @@');
    }
  });

  it('rejects writeReviewArtifact traversal, absolute, and backslash paths', () => {
    const repo = makeFixtureRepo('perkins-artifact-traversal');
    const base = repo.commitFile('src/one.ts', 'export const one = 1;\n');
    repo.commitFile('src/two.ts', 'export const two = 2;\n');
    const dir = temp('perkins-artifact-traversal-');
    const frozen = freezeReviewInputs({
      roundId: 'traversal', repoPath: repo.path, artifactRoot: dir, baseRef: base, targetRef: repo.head(), spec: 's',
    });
    for (const bad of ['../escape', '/abs', 'a\\b', 'a/../b', '']) {
      expect(() => writeReviewArtifact(frozen, bad, 'x')).toThrow(/escapes round directory/u);
    }
  });

  it('rejects freezeReviewInputs ingress conflicts (spec+noSpec, neither)', () => {
    const repo = makeFixtureRepo('perkins-freeze-ingress');
    expect(() => freezeReviewInputs({
      roundId: 'ingress', repoPath: repo.path, artifactRoot: temp('perkins-ingress-'),
      baseRef: repo.head(), targetRef: repo.head(), spec: 's', noSpec: true,
    })).toThrow(/cannot supply both spec and explicit no-spec/u);
    expect(() => freezeReviewInputs({
      roundId: 'ingress2', repoPath: repo.path, artifactRoot: temp('perkins-ingress-'),
      baseRef: repo.head(), targetRef: repo.head(),
    })).toThrow(/requires frozen spec\/context or explicit noSpec/u);
  });

  it('rejects cross-lens coverage-gate findings', () => {
    expect(() => parseFindings(JSON.stringify([finding('blind', 'warning', { category: 'coverage-gate', title: 'Coverage gate: PASS' })]), 'blind'))
      .toThrow(/owned only by the tests lens/u);
  });

  it('rejects a committed symlink in the frozen target tree', () => {
    const repo = makeFixtureRepo('perkins-frozen-symlink');
    const base = repo.commitFile('src/one.ts', 'export const one = 1;\n');
    repo.git(['checkout', '-b', 'feature/symlink']);
    symlinkSync('target', join(repo.path, 'src', 'link.ts'));
    repo.git(['add', 'src/link.ts']);
    repo.git(['-c', 'user.name=Fixture Tests', '-c', 'user.email=tests@example.invalid', 'commit', '-m', 'symlink']);
    expect(() => freezeReviewInputs({
      roundId: 'frozen-symlink', repoPath: repo.path, artifactRoot: temp('perkins-frozen-symlink-'),
      baseRef: base, targetRef: repo.head(), spec: 's',
    })).toThrow(/frozen target contains a symlink/u);
  });
});

describe('error-path EEXIST guards (V5 revert-mutation pin)', () => {
  it('completes a retry after a malformed attempt without any EEXIST error escaping', async () => {
    let securityCalls = 0;
    const h = hybridHarness({
      childAnswer: (prompt) => lensFrom(prompt) === 'security' ? (++securityCalls === 1 ? 'malformed' : '[]') : '[]',
    });
    const result = await h.run();
    expect(result.canonicalVerdict).toBe('READY TO MERGE');
    for (const entry of h.toolErrors) {
      expect(entry.error).not.toContain('EEXIST');
      expect(entry.error).not.toContain('already exists');
    }
    const envelopeDir = join(h.frozen.directory, 'lenses', '001');
    const errorFiles = readdirSync(envelopeDir).filter((f) => f.includes('.error.json'));
    expect(errorFiles.length).toBeGreaterThanOrEqual(1);
    const envelopeFiles = readdirSync(envelopeDir).filter((f) => f.includes('.envelope.json'));
    expect(envelopeFiles.length).toBeGreaterThanOrEqual(2);
  });
});
describe('EEXIST guards: write-once collision in catch path (Blocker 3: mutation-killing pin)', () => {
  it('catch path tolerates EEXIST when onProgress throws after artifacts are already written', async () => {
    // Trigger: the try block writes raw.json + envelope.json, then
    // onProgress throws (registered callback). The catch fires and must
    // tolerate EEXIST on raw.json and envelope.json re-writes.
    const fixture = makeReviewRepo();
    repos.push(fixture.repo);
    const base = fixture.repo.git(['rev-parse', 'main']);
    const target = fixture.repo.head();
    const root = temp('perkins-eexist-');
    const frozen = freezeReviewInputs({
      roundId: 'eexist-round', repoPath: fixture.repo.path, artifactRoot: root,
      baseRef: base, targetRef: target, spec: 'eexist test',
    });
    const fake = fakeHybridSpawner(temp('perkins-eexist-sessions-'), { childAnswer: () => '[]' });
    let doneCalls = 0;
    const engine = new PerkinsHybridReview({
      spawner: fake.spawner,
      policy: loadPerkinsPolicy(),
      onProgress: (progress) => {
        if (progress.state === 'done') {
          doneCalls += 1;
          if (doneCalls === 1) {
            // Throw on the FIRST done — after the try block has already
            // written raw.json and envelope.json for this lens/chunk.
            throw new Error('progress listener exploded');
          }
        }
      },
    });
    // Run the full review; the first lens/chunk triggers the EEXIST path
    const result = await engine.run({
      roundId: 'eexist-test', roundNumber: 1, frozenReview: frozen,
      movementRef: 'feature/review', noSpec: false,
    });
    // Without EEXIST guards, the EEXIST from raw.json/envelope.json in the
    // catch path would cascade and fail the entire lens batch → INCOMPLETE.
    // With guards, the review completes normally.
    expect(result.canonicalVerdict).toBe('READY TO MERGE');
    expect(result.completeness).toMatchObject({ complete: true, requiredLensRuns: 7, validLensRuns: 7 });
    // doneCalls: first lens/chunk throws, the remaining 6 succeed normally
    expect(doneCalls).toBeGreaterThanOrEqual(7);
    // A post-parse host error is not a child output rejection: it records
    // failureKind 'error', never 'output'.
    const exploded = result.lensEnvelopes.find((envelope) => envelope.error?.includes('progress listener exploded'));
    expect(exploded).toBeDefined();
    expect(exploded).toMatchObject({ status: 'invalid', failureKind: 'error' });
  });
});
