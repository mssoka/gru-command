import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

// Every deep comparison the inspection makes is counted (the real one runs).
const { compares } = vi.hoisted(() => ({ compares: { count: 0 } }));
vi.mock('node:util', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:util')>();
  return { ...actual, isDeepStrictEqual: (left: unknown, right: unknown) => { compares.count += 1; return actual.isDeepStrictEqual(left, right); } };
});
const { inspectDirectiveProducers } = await import('../src/runtime/directive-checkpoint.js');

const dirs: string[] = [];
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

const identity = { requestId: 'request-1', jobId: 'job-1', payloadHash: 'a'.repeat(64), contractSha256: 'b'.repeat(64), workRevision: 0, authorityEpoch: 0 };

describe('producer inspection cost (#363 S04-0-03)', () => {
  it('inspects a producer journal in one pass: comparisons grow linearly with its starts, and every start gets its exact evidence', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gru-producer-inspection-'));
    dirs.push(dir);
    const file = join(dir, 'session.jsonl');
    const pairs = 1_000;
    const starts: string[] = [];
    const cessations: string[] = [];
    for (let index = 0; index < pairs; index += 1) {
      const producer = { incarnation: `incarnation-${String(index)}`, pid: 4_000_000 + index, host: 'fixture-foreign-host', identity, agentId: 'minion-1', sessionId: 'session-1', sessionFile: file };
      starts.push(JSON.stringify({ state: 'started', producer }));
      // Every incarnation but the last ceased; the last, on a foreign host, stays unknown.
      if (index < pairs - 1) cessations.push(JSON.stringify({ state: 'ceased', producer }));
    }
    // Cessations in reverse order: a scan per start meets most of them.
    writeFileSync(`${file}.producers.jsonl`, `${[...starts, ...cessations.reverse()].join('\n')}\n`);
    compares.count = 0;
    const owners = inspectDirectiveProducers(file, identity);
    const inspectionCompares = compares.count;
    expect(owners).toHaveLength(pairs);
    expect(owners.filter((owner) => owner.evidence === 'ceased')).toHaveLength(pairs - 1);
    expect(owners.at(-1)).toMatchObject({ evidence: 'unknown', producer: { incarnation: `incarnation-${String(pairs - 1)}` } });
    // The journal read itself compares each receipt to its start, and the
    // identity filter compares each receipt once: a small multiple of the
    // receipts. A scan per start would be on the order of pairs².
    expect(inspectionCompares).toBeLessThan(4 * 2 * pairs);
  });

  it('an independent receipt keeps its start unknown, even on this host, and a ceased one still wins for its own incarnation', async () => {
    const { hostname } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'gru-producer-independent-'));
    dirs.push(dir);
    const file = join(dir, 'session.jsonl');
    const producer = (incarnation: string, pid: number) => ({ incarnation, pid, host: hostname(), identity, agentId: 'minion-1', sessionId: 'session-1', sessionFile: file });
    // A same-host pid that is surely gone: absent, unless an independent controller owns it.
    const gone = 2_147_483_000;
    const independent = producer('independent-incarnation', gone);
    const absent = producer('absent-incarnation', gone - 1);
    const both = producer('both-incarnation', gone - 2);
    writeFileSync(`${file}.producers.jsonl`, [
      { state: 'started', producer: independent }, { state: 'independent', producer: independent },
      { state: 'started', producer: absent },
      { state: 'started', producer: both }, { state: 'independent', producer: both }, { state: 'ceased', producer: both },
    ].map((row) => JSON.stringify(row)).join('\n') + '\n');
    const evidence = Object.fromEntries(inspectDirectiveProducers(file, identity).map((owner) => [owner.producer.incarnation, owner.evidence]));
    expect(evidence).toEqual({ 'independent-incarnation': 'unknown', 'absent-incarnation': 'host-absent', 'both-incarnation': 'ceased' });
  });
});
