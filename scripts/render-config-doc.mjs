#!/usr/bin/env node
/**
 * Regenerate the managed config-reference block in docs/CONFIG.md from
 * src/config-reference.ts — the SAME module that renders the wizard's
 * ~/.gru-command/config.toml. This is the drift guard: the emitted
 * config and the documented schema come from one source of truth.
 * A test (config-generate.test.ts) asserts the committed block matches.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { renderConfigDocBlock } from '../dist/config-reference.js';

const docPath = join(import.meta.dirname, '..', 'docs', 'CONFIG.md');
const text = readFileSync(docPath, 'utf-8');
const begin = text.indexOf('<!-- BEGIN GENERATED CONFIG REFERENCE');
const end = text.indexOf('<!-- END GENERATED CONFIG REFERENCE -->');
if (begin === -1 || end === -1 || end < begin) {
  process.stderr.write(
    'render-config-doc: docs/CONFIG.md is missing the generated reference block markers\n',
  );
  process.exit(1);
}
const next = `${text.slice(0, begin)}${renderConfigDocBlock()}${text.slice(end + '<!-- END GENERATED CONFIG REFERENCE -->'.length)}`;
writeFileSync(docPath, next);
process.stdout.write('render-config-doc: regenerated the docs/CONFIG.md reference block\n');
