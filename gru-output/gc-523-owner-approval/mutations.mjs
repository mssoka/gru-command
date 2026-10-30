#!/usr/bin/env node
/**
 * #523 owner-approval mutation for the A1/A2 red evidence.
 *
 * Applied to a `git archive HEAD` snapshot of the candidate: the one place
 * the service carries the owner's Approve out is replaced by a no-op that
 * returns the request's current row. The tests must then fail behaviorally
 * on the request itself (still live, not abandoned) — never on an import or
 * collection error. Production code never carries this.
 *
 * usage: node gru-output/gc-523-owner-approval/mutations.mjs <snapshot-root>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const root = process.argv[2];
if (root === undefined) throw new Error('usage: mutations.mjs <snapshot-root>');
const file = join(root, 'src/dispatch/owner-approvals.ts');
const source = readFileSync(file, 'utf8');

const call = '      outcome = abandonLiveDirectiveFromRoute({';
if (!source.includes(call)) throw new Error(`mutation anchor missing: ${call}`);

const noop = [
  '  /** MUTATION (verification red baseline): a no-op instead of the native',
  '   * owner abandonment. It returns the request\'s current row unchanged. */',
  '  const mutatedNoop = (input: Parameters<typeof abandonLiveDirectiveFromRoute>[0]): ReturnType<typeof abandonLiveDirectiveFromRoute> => ({',
  '    record: input.ledger.getDirective(input.requestId) as never,',
  '    idempotent: false,',
  '    event: { seq: -1, payload: { reason: input.reason } } as never,',
  '  });',
  '',
  '',
].join('\n');
const anchor = '  /** Carry out the abandonment the record is bound to.';
if (!source.includes(anchor)) throw new Error(`mutation insertion anchor missing: ${anchor}`);

const mutated = source
  .replace(call, '      outcome = mutatedNoop({')
  .replace(anchor, `${noop}${anchor}`);
if (mutated === source) throw new Error('mutation changed nothing');
writeFileSync(file, mutated, 'utf8');
process.stdout.write(`mutated ${file}: abandonLiveDirectiveFromRoute call replaced by mutantNoop\n`);
