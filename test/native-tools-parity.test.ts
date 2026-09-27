import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { configPathFor, loadConfig } from '../src/config.js';
import { freezeReviewInputs } from '../src/dispatch/perkins-review/artifacts.js';
import { PerkinsWholeReview } from '../src/dispatch/perkins-review/whole.js';
import { loadPerkinsPolicy } from '../src/dispatch/perkins-review/policy.js';
import { ClaudeCodeRuntime } from '../src/runtime/claude-adapter.js';
import { PiRuntime } from '../src/runtime/pi-adapter.js';
import type { NativeAgentTool, SpawnOptions } from '../src/runtime/types.js';
import { SessionStore } from '../src/sessions/store.js';
import { makeFixtureRepo, type FixtureRepo } from './helpers/fixture-repo.js';
import { fakeWholeSpawner } from './helpers/perkins-whole-double.js';
import { makeStubModelRuntime, StubScript } from './helpers/stub-model.js';

/**
 * Native-tools runtime parity (SPEC ruling 4, owner ruling 2026-09-22):
 * above the adapter layer gru-command behaves identically regardless of
 * harness. This file runs the REAL Perkins whole-PR engine through its
 * offline double to capture the exact review policies it declares, then
 * replays every DISTINCT captured policy through BOTH real adapters
 * (pi: in-process custom tools; claude-code: the session-scoped MCP
 * bridge) and proves the semantic tool exposure is identical.
 */

/** Records the options the pi adapter hands to the SDK for exact inspection. */
const piCapture = vi.hoisted(() => ({ lastOptions: null as unknown }));
vi.mock('@earendil-works/pi-coding-agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@earendil-works/pi-coding-agent')>();
  return {
    ...actual,
    createAgentSession: async (opts: unknown) => {
      piCapture.lastOptions = opts;
      return actual.createAgentSession(opts as never);
    },
  };
});

const DOUBLE = join(import.meta.dirname, 'helpers', 'claude-double.mjs');
const DOUBLE_ENV_KEYS = ['CLAUDE_DOUBLE_LOG', 'CLAUDE_DOUBLE_WORKFLOW_CANDIDATE'] as const;

const cleanupDirs: string[] = [];
const repos: FixtureRepo[] = [];
afterAll(() => {
  for (const repo of repos.splice(0)) repo.cleanup();
  for (const dir of cleanupDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
afterEach(() => {
  for (const key of DOUBLE_ENV_KEYS) delete process.env[key];
});

interface Harnesses {
  readonly pi: PiRuntime;
  readonly claude: ClaudeCodeRuntime;
  readonly workspace: string;
}

async function harnesses(): Promise<Harnesses> {
  const home = mkdtempSync(join(tmpdir(), 'gru-parity-'));
  const workspace = mkdtempSync(join(tmpdir(), 'gru-parity-ws-'));
  const agentDir = mkdtempSync(join(tmpdir(), 'gru-parity-agent-'));
  cleanupDirs.push(home, workspace, agentDir);
  writeFileSync(
    configPathFor(home),
    `workspace_root = "${workspace}"\n[models]\ndefault = "gru-stub/stub-model"\n`,
    'utf-8',
  );
  const config = loadConfig({ GRU_COMMAND_HOME: home }, '/home/tester');
  const store = new SessionStore(config.dataDir);
  const script = new StubScript([{ deltas: ['ok'] }]);
  const modelRuntime = await makeStubModelRuntime(script);
  const pi = new PiRuntime({ config, store, agentDir, modelRuntime });
  process.env['CLAUDE_DOUBLE_LOG'] = join(home, 'double-log.jsonl');
  const claude = new ClaudeCodeRuntime({ config, store, binary: DOUBLE, reviewSettingsFile: join(home, 'absent-review-settings.json') });
  return { pi, claude, workspace };
}

interface Exposure {
  /** Product tool ids the session can actually use (read/grep/find/ls). */
  readonly fileTools: readonly string[];
  /** Product native tools exposed, by declared name. */
  readonly nativeTools: readonly string[];
}

type ReviewSeam = Pick<SpawnOptions, 'isolatedReview' | 'reviewLead'>;

const CLAUDE_BUILTIN_PRODUCT: Readonly<Record<string, string>> = {
  Read: 'read',
  Grep: 'grep',
  Glob: 'find',
  LS: 'ls',
};

async function piExposure(rt: PiRuntime, workspace: string, seam: ReviewSeam): Promise<Exposure> {
  const handle = await rt.spawn('perkins', { ...seam, cwd: workspace });
  try {
    const options = piCapture.lastOptions as {
      tools?: string[];
      customTools?: Array<{ name: string }>;
    };
    const names = options.customTools?.map((tool) => tool.name) ?? [];
    return {
      fileTools: names.filter((name) => name.startsWith('review_')).map((name) => name.slice('review_'.length)),
      nativeTools: names.filter((name) => name.startsWith('perkins_')),
    };
  } finally {
    await handle.dispose();
  }
}

async function claudeExposure(rt: ClaudeCodeRuntime, workspace: string, seam: ReviewSeam): Promise<Exposure> {
  const handle = await rt.spawn('perkins', { ...seam, cwd: workspace });
  try {
    await handle.prompt('parity probe');
    const log = process.env['CLAUDE_DOUBLE_LOG']!;
    const records = readFileSync(log, 'utf8').trim().split('\n')
      .map((line) => JSON.parse(line) as { argv: string[] });
    const record = records[records.length - 1]!;
    const argv = record.argv;
    // `--tools` carries the enabled list including the bridged MCP names;
    // the built-in (file) surface is what remains after stripping those.
    const builtins = (argv[argv.indexOf('--tools') + 1] ?? '')
      .split(',')
      .filter((name) => name !== '' && !name.startsWith('mcp__'));
    const allowedIndex = argv.indexOf('--allowedTools');
    const allowed = allowedIndex === -1 ? [] : (argv[allowedIndex + 1] ?? '').split(',').filter(Boolean);
    return {
      fileTools: builtins.map((name) => CLAUDE_BUILTIN_PRODUCT[name] ?? name),
      nativeTools: allowed
        .filter((entry) => entry.startsWith('mcp__gru_perkins__'))
        .map((entry) => entry.slice('mcp__gru_perkins__'.length)),
    };
  } finally {
    await handle.dispose();
  }
}

function sorted(names: readonly string[]): string[] {
  return [...names].sort();
}

interface CapturedPolicy {
  readonly label: string;
  readonly seam: ReviewSeam;
  readonly fileTools: readonly string[];
  readonly nativeTools: readonly string[];
}

/**
 * One REAL whole-PR run through the offline double captures the policy the
 * engine declares for its lead and every specialist child. Returns the
 * distinct shapes only — the adapters must agree on each shape, not on
 * session count.
 */
async function capturedWholePolicies(): Promise<CapturedPolicy[]> {
  const repo = makeFixtureRepo('parity-native-tools');
  repos.push(repo);
  const base = repo.head();
  repo.git(['checkout', '-b', 'feature/review']);
  const target = repo.commitFile('src/main.ts', 'export function answer(): number {\n  return 43;\n}\n');
  const artifactRoot = mkdtempSync(join(tmpdir(), 'gru-parity-artifacts-'));
  const sessionsRoot = mkdtempSync(join(tmpdir(), 'gru-parity-sessions-'));
  cleanupDirs.push(artifactRoot, sessionsRoot);
  const frozen = freezeReviewInputs({
    roundId: 'parity-round',
    repoPath: repo.path,
    artifactRoot,
    baseRef: base,
    targetRef: target,
    movementRef: 'feature/review',
    spec: 'Acceptance: answer returns 43.',
  });
  const fake = fakeWholeSpawner(sessionsRoot, { childAnswer: () => '[]' });
  const engine = new PerkinsWholeReview({ spawner: fake.spawner, policy: loadPerkinsPolicy() });
  const result = await engine.run({
    roundId: 'parity-round',
    roundNumber: 1,
    frozenReview: frozen,
    movementRef: 'feature/review',
    noSpec: false,
  });
  expect(result.canonicalVerdict).toBe('READY TO MERGE');
  expect(fake.leadCalls).toHaveLength(1);
  expect(fake.childCalls).toHaveLength(7);

  const policies = new Map<string, CapturedPolicy>();
  const lead = fake.leadCalls[0]!.options.reviewLead!;
  policies.set('lead', {
    label: 'lead',
    seam: { reviewLead: lead },
    fileTools: lead.tools,
    nativeTools: lead.nativeTools.map((tool) => tool.name),
  });
  for (const call of fake.childCalls) {
    const policy = call.options.isolatedReview!;
    const nativeNames = (policy.nativeTools ?? []).map((tool) => tool.name);
    const key = `${policy.systemPrompt}\0${policy.tools.join(',')}\0${nativeNames.join(',')}`;
    if (policies.has(key)) continue;
    const lens = /"source": "(blind|edge|acceptance|security|architecture|codebase|tests)"/.exec(call.prompt ?? '')?.[1];
    policies.set(key, {
      label: lens ?? `child-${policies.size}`,
      seam: { isolatedReview: policy },
      fileTools: policy.tools,
      nativeTools: nativeNames,
    });
  }
  return [...policies.values()];
}

describe('native-tools harness parity (whole double → both real adapters)', () => {
  it('every policy the whole-PR engine declares maps to identical tool semantics on pi and claude', async () => {
    const policies = await capturedWholePolicies();
    expect(policies.length).toBeGreaterThanOrEqual(3); // lead + blind + lens children
    const h = await harnesses();
    try {
      for (const { label, seam, fileTools, nativeTools } of policies) {
        const pi = await piExposure(h.pi, h.workspace, seam);
        const claude = await claudeExposure(h.claude, h.workspace, seam);
        // The same declared policy exposes the same semantic surface on both
        // harnesses — and nothing beyond the declaration.
        expect(sorted(pi.fileTools), `${label}: pi file tools`).toEqual(sorted(fileTools));
        expect(sorted(claude.fileTools), `${label}: claude file tools`).toEqual(sorted(fileTools));
        expect(sorted(pi.nativeTools), `${label}: pi native tools`).toEqual(sorted(nativeTools));
        expect(sorted(claude.nativeTools), `${label}: claude native tools`).toEqual(sorted(nativeTools));
      }
      // The lead declares its whole-PR orchestration tools (a re-review
      // adds perkins_read_prior_revision through its own seam).
      const lead = policies.find((policy) => policy.label === 'lead')!;
      expect(sorted(lead.nativeTools)).toEqual(sorted([
        'perkins_run_specialists',
        'perkins_store_artifact',
        'perkins_preflight_submission',
        'perkins_submit_review',
      ]));
      // Children never see the lead's orchestration tools.
      for (const child of policies.filter((policy) => policy.label !== 'lead')) {
        for (const leadTool of lead.nativeTools) {
          expect(child.nativeTools, `${child.label} must not see ${leadTool}`).not.toContain(leadTool);
        }
      }
    } finally {
      await h.pi.dispose();
      await h.claude.dispose();
    }
  });

  it('a lens child declaring one native tool exposes exactly that tool on both harnesses', async () => {
    const executed: unknown[] = [];
    const submitFindings: NativeAgentTool = {
      name: 'perkins_submit_findings',
      description: 'submit structured lens findings',
      inputSchema: {
        type: 'object', additionalProperties: false, required: ['findings'],
        properties: { findings: { type: 'array' } },
      },
      execute: async (input: unknown) => {
        executed.push(input);
        return { text: JSON.stringify({ accepted: true }) };
      },
    };
    const seam: ReviewSeam = {
      isolatedReview: {
        systemPrompt: 'lens policy',
        tools: ['read', 'grep', 'find', 'ls'],
        nativeTools: [submitFindings],
      },
    };
    const h = await harnesses();
    try {
      const pi = await piExposure(h.pi, h.workspace, seam);
      const claude = await claudeExposure(h.claude, h.workspace, seam);
      expect(pi).toEqual({
        fileTools: ['read', 'grep', 'find', 'ls'],
        nativeTools: ['perkins_submit_findings'],
      });
      expect(claude).toEqual(pi);
      expect(pi.nativeTools).not.toContain('perkins_run_lenses');
      expect(pi.nativeTools).not.toContain('perkins_submit_review');
    } finally {
      await h.pi.dispose();
      await h.claude.dispose();
    }
  });
});
