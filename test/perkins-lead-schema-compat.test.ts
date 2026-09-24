import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { readStoredCredential } from '@earendil-works/pi-coding-agent';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { configPathFor, loadConfig } from '../src/config.js';
import { freezeReviewInputs } from '../src/dispatch/perkins-review/artifacts.js';
import { PerkinsHybridReview } from '../src/dispatch/perkins-review/hybrid.js';
import { loadPerkinsPolicy } from '../src/dispatch/perkins-review/policy.js';
import { PiRuntime } from '../src/runtime/pi-adapter.js';
import { ReviewMcpBridge } from '../src/runtime/review-mcp-bridge.js';
import type { NativeAgentTool, SpawnOptions } from '../src/runtime/types.js';
import { SessionStore } from '../src/sessions/store.js';
import { makeFixtureRepo, type FixtureRepo } from './helpers/fixture-repo.js';
import { fakeHybridSpawner } from './helpers/perkins-hybrid-double.js';

/**
 * Leader tool-schema provider compatibility (deepseek 400 regression).
 *
 * Round evidence (perkins-child-robustness-r1, 2026-09-23T01:00Z): the lead
 * died on its FIRST request with `Invalid schema for function
 * 'perkins_preflight_submission': schema must be a JSON Schema of
 * 'type: "object"', got 'type: null'.` The submission schema root was a bare
 * `oneOf` union with no object type, which OpenAI-compatible providers
 * (deepseek) reject before the first token. This file pins:
 *  1. every declared native tool's provider-facing schema root is a typed
 *     object — asserted both on the declaration and on the captured wire
 *     payload from the REAL pi adapter path (no network);
 *  2. (env-gated) a live deepseek registration round-trip does not 400.
 * The code validator remains the exhaustive authority; the schema is only the
 * provider-facing declaration.
 */

const LEAD_TOOL_NAMES = [
  'perkins_read_chunk',
  'perkins_run_lenses',
  'perkins_store_artifact',
  'perkins_record_decision',
  'perkins_preflight_submission',
  'perkins_submit_review',
] as const;

type LeadPolicy = NonNullable<SpawnOptions['reviewLead']>;
type ChildPolicy = NonNullable<SpawnOptions['isolatedReview']>;

const cleanupDirs: string[] = [];
const repos: FixtureRepo[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const repo of repos.splice(0)) repo.cleanup();
  for (const dir of cleanupDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Capture the exact policies the REAL hybrid engine declares for its lead
 * and lens children by running it through its offline spawner double. */
async function capturedPolicies(): Promise<{ readonly lead: LeadPolicy; readonly child: ChildPolicy }> {
  const repo = makeFixtureRepo('schema-compat');
  repos.push(repo);
  const base = repo.head();
  repo.git(['checkout', '-b', 'feature/review']);
  const target = repo.commitFile('src/main.ts', 'export function answer(): number {\n  return 43;\n}\n');
  const artifactRoot = tempDir('gru-schema-artifacts-');
  const sessionsRoot = tempDir('gru-schema-sessions-');
  const frozen = freezeReviewInputs({
    roundId: 'schema-compat-round',
    repoPath: repo.path,
    artifactRoot,
    baseRef: base,
    targetRef: target,
    movementRef: 'feature/review',
    spec: 'Acceptance: answer returns 43.',
  });
  const fake = fakeHybridSpawner(sessionsRoot, { childAnswer: () => '[]' });
  const engine = new PerkinsHybridReview({ spawner: fake.spawner, policy: loadPerkinsPolicy() });
  const result = await engine.run({
    roundId: 'schema-compat-round',
    roundNumber: 1,
    frozenReview: frozen,
    movementRef: 'feature/review',
    noSpec: false,
  });
  expect(result.canonicalVerdict).toBe('READY TO MERGE');
  expect(fake.leadCalls).toHaveLength(1);
  expect(fake.childCalls.length).toBeGreaterThan(0);
  return {
    lead: fake.leadCalls[0]!.options.reviewLead!,
    child: fake.childCalls[0]!.options.isolatedReview!,
  };
}

/** Root-type guarantee every OpenAI-compatible provider validates first. */
function expectProofSchema(schema: Record<string, unknown>): void {
  const branches = schema['oneOf'] as Array<{ properties: { prior_audit: { items: { properties: Record<string, unknown>; required: string[] } } } }>;
  expect(branches).toHaveLength(2);
  for (const branch of branches) {
    const audit = branch.properties.prior_audit.items;
    expect(audit.required).toEqual(['prior_index', 'status', 'evidence', 'reason']);
    expect(audit.properties['fix_location']).toMatchObject({
      type: 'object', additionalProperties: false, required: ['path', 'change'],
      properties: { path: { type: 'string' }, change: { enum: ['added', 'removed'] } },
    });
  }
}

function expectObjectRoot(toolName: string, schema: unknown): Record<string, unknown> {
  expect(typeof schema, `${toolName}: schema present`).toBe('object');
  expect(schema, `${toolName}: schema not null`).not.toBeNull();
  const root = schema as Record<string, unknown>;
  expect(root['type'], `${toolName}: root type must be 'object'`).toBe('object');
  return root;
}

/** NativeAgentTool stubs for a real adapter spawn: the wire shape is built
 * from name/description/inputSchema; execute never runs in these tests. */
function asNativeTools(policy: { readonly nativeTools?: readonly NativeAgentTool[] }): NativeAgentTool[] {
  return (policy.nativeTools ?? []).map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    execute: async () => ({ text: JSON.stringify({ ok: true }) }),
  }));
}

interface WireRequest {
  readonly url: string;
  readonly body: Record<string, unknown>;
  status?: number;
  response?: string;
}

interface WireFunction {
  readonly name: string;
  readonly parameters: unknown;
}

function wireFunctions(body: Record<string, unknown>): WireFunction[] {
  const tools = body['tools'];
  expect(Array.isArray(tools), 'request must carry a tools array').toBe(true);
  return (tools as Array<{ function: WireFunction }>).map((entry) => entry.function);
}

/** Minimal accepted OpenAI streaming response so the adapter round-trip can
 * finish offline; nothing is ever forwarded to the network. */
function syntheticCompletionStream(): Response {
  const chunk = (payload: Record<string, unknown>): string => `data: ${JSON.stringify(payload)}\n\n`;
  const body = [
    chunk({
      id: 'chatcmpl-schema-compat', object: 'chat.completion.chunk', created: 0, model: 'deepseek-v4-flash',
      choices: [{ index: 0, delta: { role: 'assistant', content: 'ready' }, finish_reason: null }],
    }),
    chunk({
      id: 'chatcmpl-schema-compat', object: 'chat.completion.chunk', created: 0, model: 'deepseek-v4-flash',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    }),
    chunk({
      id: 'chatcmpl-schema-compat', object: 'chat.completion.chunk', created: 0, model: 'deepseek-v4-flash',
      choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    'data: [DONE]\n\n',
  ].join('');
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function makeRuntime(agentDir: string): { readonly runtime: PiRuntime; readonly workspace: string } {
  const home = tempDir('gru-schema-home-');
  const workspace = tempDir('gru-schema-ws-');
  writeFileSync(configPathFor(home), `workspace_root = "${workspace}"\n`, 'utf-8');
  const config = loadConfig({ GRU_COMMAND_HOME: home });
  return { runtime: new PiRuntime({ config, store: new SessionStore(config.dataDir), agentDir }), workspace };
}

/** Run one real adapter spawn with a fake deepseek key and an intercepted
 * fetch, returning every captured request; no bytes leave the machine. */
async function capturedSpawn(
  policy: { readonly systemPrompt: string; readonly tools: readonly ('read' | 'grep' | 'find' | 'ls')[]; readonly nativeTools?: readonly NativeAgentTool[] },
  mode: 'lead' | 'child',
): Promise<readonly WireRequest[]> {
  const { runtime, workspace } = makeRuntime(tempDir('gru-schema-agent-'));
  const requests: WireRequest[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (!url.includes('api.deepseek.com')) return originalFetch(input, init);
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    const response = syntheticCompletionStream();
    requests.push({
      url,
      body,
      status: response.status,
      response: await response.clone().text(),
    });
    return response;
  }) as typeof fetch;
  const previousKey = process.env['DEEPSEEK_API_KEY'];
  process.env['DEEPSEEK_API_KEY'] = 'schema-compat-offline-key';
  try {
    const nativeTools = asNativeTools(policy);
    const handle = await runtime.spawn('perkins', mode === 'lead'
      ? {
          cwd: workspace,
          model: 'deepseek/deepseek-v4-flash',
          reviewLead: { systemPrompt: policy.systemPrompt, tools: [...policy.tools], nativeTools },
        }
      : {
          cwd: workspace,
          model: 'deepseek/deepseek-v4-flash',
          isolatedReview: { systemPrompt: policy.systemPrompt, tools: [...policy.tools], nativeTools },
        });
    try {
      await handle.prompt('Reply with exactly the word: ready');
    } finally {
      await handle.dispose();
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (previousKey === undefined) delete process.env['DEEPSEEK_API_KEY'];
    else process.env['DEEPSEEK_API_KEY'] = previousKey;
    await runtime.dispose();
  }
  return requests;
}

describe('declared native tool schemas are provider-compatible', () => {
  let lead: LeadPolicy;
  let child: ChildPolicy;

  beforeAll(async () => {
    const captured = await capturedPolicies();
    lead = captured.lead;
    child = captured.child;
  }, 120_000);

  it('declares the expected lead and child tool surfaces', () => {
    expect(lead.nativeTools.map((tool) => tool.name)).toEqual([...LEAD_TOOL_NAMES]);
    expect(child.nativeTools?.map((tool) => tool.name)).toEqual(['perkins_submit_findings']);
  });

  it('every declared schema root is a typed object (the precondition providers validate first)', () => {
    for (const tool of [...lead.nativeTools, ...(child.nativeTools ?? [])]) {
      expectObjectRoot(tool.name, tool.inputSchema);
    }
    // The submission-shaped tools share one declaration: root stays a typed
    // object while both payload shapes stay declared beneath it.
    for (const name of ['perkins_preflight_submission', 'perkins_submit_review']) {
      const tool = lead.nativeTools.find((entry) => entry.name === name)!;
      const root = expectObjectRoot(tool.name, tool.inputSchema);
      expect(Array.isArray(root['oneOf']), `${name}: both payload shapes retained`).toBe(true);
      expectProofSchema(root);
    }
  });

  it('serializes the same nested proof schema through the Claude MCP bridge', async () => {
    const bridge = await ReviewMcpBridge.start(lead.nativeTools);
    try {
      const tools = await new Promise<Array<{ name: string; inputSchema: unknown }>>((resolve, reject) => {
        const socket = createConnection(bridge.socketPath);
        let body = '';
        socket.setEncoding('utf8');
        socket.once('connect', () => socket.end(`${JSON.stringify({ id: 'proof-schema', name: '__list__', input: {} })}\n`));
        socket.on('data', (data: string) => { body += data; });
        socket.once('error', reject);
        socket.once('end', () => {
          try { resolve((JSON.parse(body) as { result: Array<{ name: string; inputSchema: unknown }> }).result); }
          catch (error) { reject(error); }
        });
      });
      for (const name of ['perkins_preflight_submission', 'perkins_submit_review']) {
        const declared = lead.nativeTools.find((tool) => tool.name === name)!;
        const bridged = tools.find((tool) => tool.name === name)!;
        expect(bridged.inputSchema).toEqual(declared.inputSchema);
        expectProofSchema(expectObjectRoot(name, bridged.inputSchema));
      }
    } finally { await bridge.close(); }
  });

  it('the exact lead wire payload carries an object root for every declared function', async () => {
    const requests = await capturedSpawn(lead, 'lead');
    expect(requests.length).toBeGreaterThan(0);
    expect(requests[0]!.status).toBe(200);
    const perkins = wireFunctions(requests[0]!.body).filter((entry) => entry.name.startsWith('perkins_'));
    expect([...perkins.map((entry) => entry.name)].sort()).toEqual([...LEAD_TOOL_NAMES].sort());
    for (const entry of perkins) {
      const root = expectObjectRoot(entry.name, entry.parameters);
      if (entry.name === 'perkins_preflight_submission' || entry.name === 'perkins_submit_review') {
        expect(Array.isArray(root['oneOf']), `${entry.name}: both payload shapes retained on the wire`).toBe(true);
        expectProofSchema(root);
      }
    }
  });

  it('the exact child wire payload carries an object root for the findings tool', async () => {
    const requests = await capturedSpawn(child, 'child');
    expect(requests.length).toBeGreaterThan(0);
    expect(requests[0]!.status).toBe(200);
    const findings = wireFunctions(requests[0]!.body).filter((entry) => entry.name === 'perkins_submit_findings');
    expect(findings).toHaveLength(1);
    expectObjectRoot(findings[0]!.name, findings[0]!.parameters);
  });
});

/**
 * Live registration gate: skipped unless the operator opts in AND a deepseek
 * credential exists (env var or stored pi credential). The round-trip costs a
 * trivial completion; the assertion is only that registration is accepted.
 */
const LIVE = process.env['GRU_PERKINS_SCHEMA_LIVE'] === '1';
function hasDeepseekCredential(): boolean {
  if (process.env['DEEPSEEK_API_KEY'] !== undefined) return true;
  try {
    return readStoredCredential('deepseek') !== undefined;
  } catch {
    return false;
  }
}

describe.skipIf(!LIVE || !hasDeepseekCredential())('live deepseek lead registration', () => {
  it('accepts the declared lead tool schemas without a 400', async () => {
    const captured = await capturedPolicies();
    const home = tempDir('gru-schema-live-home-');
    const workspace = tempDir('gru-schema-live-ws-');
    writeFileSync(configPathFor(home), `workspace_root = "${workspace}"\n`, 'utf-8');
    const config = loadConfig({ GRU_COMMAND_HOME: home });
    // Real agent dir: this test's whole point is the live registration path.
    const runtime = new PiRuntime({ config, store: new SessionStore(config.dataDir) });
    const requests: WireRequest[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (!url.includes('api.deepseek.com')) return originalFetch(input, init);
      const response = await originalFetch(input, init);
      requests.push({
        url,
        body: typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {},
        status: response.status,
        response: (await response.clone().text()).slice(0, 20_000),
      });
      return response;
    }) as typeof fetch;
    try {
      const handle = await runtime.spawn('perkins', {
        cwd: workspace,
        model: 'deepseek/deepseek-v4-flash',
        thinkingLevel: 'max',
        reviewLead: {
          systemPrompt: captured.lead.systemPrompt,
          tools: [...captured.lead.tools],
          nativeTools: asNativeTools(captured.lead),
        },
      });
      try {
        await handle.prompt('Reply with exactly the word: ready');
      } finally {
        await handle.dispose();
      }
    } finally {
      globalThis.fetch = originalFetch;
      await runtime.dispose();
    }
    expect(requests.length).toBeGreaterThan(0);
    expect(requests[0]!.status, `deepseek registration response: ${requests[0]!.response ?? ''}`).toBe(200);
    expect(requests[0]!.response ?? '').not.toContain('Invalid schema');
  }, 180_000);
});
