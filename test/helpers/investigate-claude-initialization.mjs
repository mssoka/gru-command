// E9 investigation, not final qualification: actual runtime + pinned vendor,
// owned loopback upstream, fixture-only transport faults/hypothesis ordering.
// No per-case timers. Existing runtime disposal/escalation and the admitted
// scheduler process-group bounds own containment. Production ordering unchanged.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { ClaudeCodeRuntime, claudePromptFrame } from '../../dist/runtime/claude-adapter.js';
import { workerVerificationPolicy } from '../../dist/runtime/worker-verification-policy.js';
import { SessionStore } from '../../dist/sessions/store.js';
import { loadConfig, configPathFor } from '../../dist/config.js';

const executable = process.argv[2];
assert(executable && isAbsolute(executable), 'explicit installed absolute executable required');
const digest = createHash('sha256').update(readFileSync(executable)).digest('hex');
assert.equal(digest, 'c9b5341637becbd423ddffc5b254afb645682a3868cb708bbc6cc0e7bb419937');
const root = mkdtempSync(join(tmpdir(), 'gru-e9-native-'));
const home = join(root, 'home'); const lane = join(root, 'lane'); const bin = join(root, 'bin');
for (const dir of [home, lane, bin, join(lane, '.gru-command')]) mkdirSync(dir, { recursive: true });
const starts = join(root, 'producer-starts');
for (const name of ['npm', 'vite']) writeFileSync(join(bin, name), `#!/bin/sh\ncase " $* " in *" --help "*) printf '%s\\n' 'owned diagnostic'; exit 0;; esac\nprintf '%s\\n' '${name}' >> '${starts}'\n`, { mode: 0o700 });
writeFileSync(join(lane, '.gru-command/worktree.toml'), '[verify]\nfull="npm test"\n');
writeFileSync(configPathFor(home), `workspace_root = ${JSON.stringify(lane)}\n`, { mode: 0o600 });
const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: home, CLAUDE_CONFIG_DIR: join(home, '.claude'),
  XDG_CONFIG_HOME: join(home, 'config'), XDG_CACHE_HOME: join(home, 'cache'), XDG_DATA_HOME: join(home, 'data'), XDG_STATE_HOME: join(home, 'state'), TMPDIR: root,
  ANTHROPIC_API_KEY: 'fake-owned-fixture-key', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1' };
// Only this isolated scheduled fixture process is changed; no parent/global state.
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, env);
const version = execFileSync(executable, ['--version'], { env, cwd: lane, encoding: 'utf8' }).trim();
assert(version.startsWith('2.1.296'));
const config = loadConfig({ GRU_COMMAND_HOME: home }, home);
const policy = workerVerificationPolicy({ id: 'e9-owned', jobId: 'e9-owned', kind: 'job', status: 'active', path: lane }, configPathFor(home));
let active; let sent = false;
const server = createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk;
  if (req.url?.split('?')[0] !== '/v1/messages') { res.writeHead(404); res.end(); return; }
  const input = JSON.parse(body); assert.equal(input.model, 'gpt-6-luna');
  active.upstream.push({ path: req.url, model: input.model });
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const event = (type, value) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
  event('message_start', { message: { id: 'owned-e9', type: 'message', role: 'assistant', model: 'gpt-6-luna', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
  if (!sent) {
    sent = true;
    event('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'owned_bash', name: 'Bash', input: {} } });
    event('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ command: active.command, description: 'owned E9 case' }) } });
  } else {
    event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Owned E9 settled.' } });
  }
  event('content_block_stop', { index: 0 });
  event('message_delta', { delta: { stop_reason: input.messages.some((m) => Array.isArray(m.content) && m.content.some((c) => c.type === 'tool_result')) ? 'end_turn' : 'tool_use', stop_sequence: null }, usage: { output_tokens: 10 } });
  event('message_stop', {}); res.end();
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.address().port}`;
process.env.ANTHROPIC_BASE_URL = env.ANTHROPIC_BASE_URL;
const prompt = 'Exercise the supplied owned Bash frame.';
const producer = 'npm --no-audit test'; const read = 'vite --clearScreen=false build --help';
const cases = [
  { name: 'normal-producer', command: producer }, { name: 'normal-diagnostic', command: read },
  { name: 'baseline-silent-init-cancel', command: producer, silent: true, cancel: true },
  { name: 'pipeline-normal-producer', command: producer, pipeline: true }, { name: 'pipeline-normal-diagnostic', command: read, pipeline: true },
  { name: 'pipeline-silent-producer', command: producer, pipeline: true, silent: true, error: true },
  { name: 'pipeline-silent-diagnostic', command: read, pipeline: true, silent: true, error: true },
  { name: 'pipeline-native-rejected-init', command: producer, pipeline: true, rejectInit: true, error: true },
  { name: 'pipeline-reply-after-tool-request', command: producer, pipeline: true, reorder: true, error: true },
  { name: 'silent-init-existing-escalation', command: producer, silent: true, cancel: true, resist: true },
];
process.stdout.write(JSON.stringify({ identity: { executable, realExecutable: realpathSync(executable), version, sha256: digest, model: 'gpt-6-luna', effort: 'max' }, root,
  boundary: 'Fixture-only pipelining hypothesis/fault injection; actual ClaudeCodeRuntime; no new timers; NOT final qualification/acceptance' }) + '\n');
try {
  for (const row of cases) {
    active = { ...row, upstream: [], wire: [], native: [], forwarded: [], signals: [], closed: null }; sent = false;
    const record = active; const before = existsSync(starts) ? readFileSync(starts, 'utf8') : '';
    const ack = Promise.withResolvers(); const close = Promise.withResolvers();
    let heldAck; let pipelineSent = false; let original;
    const runtime = new ClaudeCodeRuntime({ config, store: new SessionStore(config.dataDir), binary: executable,
      modelRuntime: { getModel: () => ({ input: ['text'] }) },
      spawnProcess: (binary, args, options) => {
        assert.equal(binary, executable); assert.equal(args[args.indexOf('--model') + 1], 'gpt-6-luna');
        assert.equal(args[args.indexOf('--effort') + 1], 'max');
        const file = args[args.indexOf('--settings') + 1]; const settings = JSON.parse(readFileSync(file, 'utf8'));
        assert.deepEqual(settings.permissions, { ask: ['Bash'] }); delete settings.hooks;
        writeFileSync(file, JSON.stringify(settings));
        record.policyBoundBeforeSpawn = { file, permissions: settings.permissions, jobId: policy.jobId, cwd: lane };
        const child = spawn(binary, [...args, '--setting-sources', '', '--strict-mcp-config', '--no-chrome', '--disable-slash-commands'], { ...options, env });
        original = child; record.pid = child.pid;
        const stdin = child.stdin; const stdout = child.stdout; const port = new PassThrough(); child.stdout = port;
        const write = stdin.write.bind(stdin); const kill = child.kill.bind(child);
        child.kill = (signal) => { record.signals.push(signal); return row.resist && signal === 'SIGTERM' ? true : kill(signal); };
        stdin.write = (chunk, ...rest) => {
          const frame = JSON.parse(String(chunk)); record.wire.push(frame);
          if (frame.type === 'user' && pipelineSent) {
            const callback = rest.find((value) => typeof value === 'function'); callback?.(null); return true;
          }
          if (frame.type === 'control_request' && frame.request?.subtype === 'initialize') {
            const input = row.rejectInit ? { ...frame, request: { ...frame.request, hooks: [] } } : frame;
            const ok = write(JSON.stringify(input) + '\n', ...rest);
            if (row.pipeline) { pipelineSent = true; const user = claudePromptFrame(prompt); record.wire.push({ fixturePipeline: true, ...user }); write(JSON.stringify(user) + '\n'); }
            return ok;
          }
          return write(chunk, ...rest);
        };
        let pending = '';
        const forward = (frame) => { record.forwarded.push(frame); port.write(JSON.stringify(frame) + '\n'); };
        stdout.on('data', (chunk) => {
          pending += chunk;
          let at;
          while ((at = pending.indexOf('\n')) >= 0) {
            const line = pending.slice(0, at); pending = pending.slice(at + 1); if (!line.trim()) continue;
            const frame = JSON.parse(line); record.native.push(frame);
            if (frame.type === 'control_response') {
              ack.resolve(frame);
              if (row.silent) continue;
              if (row.reorder) { heldAck = frame; continue; }
            }
            forward(frame);
            if (row.reorder && heldAck && frame.type === 'control_request') { forward(heldAck); heldAck = undefined; }
          }
        });
        stdout.on('end', () => port.end());
        child.once('close', (code, signal) => { record.closed = { code, signal }; close.resolve(); });
        return child;
      },
    });
    let handle;
    try {
      handle = await runtime.spawn('minion', { cwd: lane }, { model: 'openai-codex/gpt-6-luna', thinkingLevel: 'max', roleTools: ['bash'], workerVerification: policy });
      let settled = false;
      const turn = handle.prompt(prompt).then(() => ({ ok: true }), (error) => ({ ok: false, error: String(error) })).then((value) => { settled = true; return value; });
      if (row.cancel) {
        await ack.promise;
        await new Promise((resolve) => setImmediate(resolve)); // event-loop observation, not a timeout
        assert.equal(record.wire.filter((frame) => frame.type === 'user').length, 0);
        assert.equal(record.upstream.length, 0); assert.equal(settled, false);
        record.distinguishingRED = 'initialize response absent: original turn pending/user frame unsent before existing cancellation';
        record.beforeDispose = { state: handle.health().state, liveTool: handle.hasLiveProcess(), pendingTurn: handle.pendingTurn() };
        await handle.dispose(); await close.promise;
      }
      const outcome = await turn;
      record.outcome = outcome;
      assert.equal(existsSync(starts) ? readFileSync(starts, 'utf8') : '', before, 'zero fake producer starts');
      if (row.cancel || row.error) assert.equal(outcome.ok, false, 'silent/rejected/reordered initialization is not a successful turn');
      else {
        assert.equal(outcome.ok, true, outcome.error);
        const blocks = record.native.filter((frame) => frame.type === 'user').flatMap((frame) => frame.message?.content ?? []).filter((block) => block.type === 'tool_result' && block.tool_use_id === 'owned_bash');
        assert.equal(blocks.length, 1);
        if (row.command === read) { assert.notEqual(blocks[0].is_error, true); assert(String(blocks[0].content).includes('owned diagnostic')); }
        else assert.equal(blocks[0].is_error, true, 'recognized producer is refused');
      }
      await handle.dispose(); await close.promise;
      assert.equal(handle.cessationEvidence(), 'ceased');
      assert(!existsSync(record.policyBoundBeforeSpawn.file), 'cleanup only after original close');
      if (row.resist) { assert(record.signals.includes('SIGTERM')); assert(record.signals.includes('SIGKILL')); assert.equal(record.closed.signal, 'SIGKILL'); }
      record.cessation = handle.cessationEvidence(); record.producerStarts = '';
      process.stdout.write(JSON.stringify(record) + '\n');
    } finally { await handle?.dispose(); await runtime.dispose(); }
  }
} finally { await new Promise((resolve) => server.close(resolve)); }
