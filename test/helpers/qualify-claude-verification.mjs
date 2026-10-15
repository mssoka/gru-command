// Owned component qualification only: real vendor permission engine, fake
// loopback upstream, no paid model and no native Perkins READY.
import process from 'node:process';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { ClaudeVerificationPermissionChannel, privateClaudeVerificationSettings } from '../../dist/runtime/claude-verification-settings.js';
import { workerVerificationPolicy } from '../../dist/runtime/worker-verification-policy.js';
import { nativeCorpus } from './verification-native-corpus.mjs';
import { loadConfig, configPathFor } from '../../dist/config.js';
import { claudeTurnArgs, claudePromptFrame } from '../../dist/runtime/claude-adapter.js';

const executable = process.argv[2];
if (!executable || !isAbsolute(executable)) throw new Error('Qualification requires the explicit installed absolute Claude executable path');
const root = mkdtempSync(join(tmpdir(), 'gru gh315 native-'));
const home = join(root, 'home'); const lane = join(root, 'lane'); const bin = join(root, 'bin');
for (const dir of [home, lane, bin, join(lane, 'web'), join(lane, '.gru-command')]) mkdirSync(dir, { recursive: true });
const starts = join(root, 'producer-starts');
for (const name of ['npm', 'npx', 'vitest', 'jest', 'tsc', 'eslint', 'vite', 'playwright']) writeFileSync(join(bin, name), `#!/bin/sh
case " $* " in
  *" --showConfig "*|*" --version "*|*" --help "*) printf '%s\\n' 'owned diagnostic'; exit 0;;
esac
if [ "${name}" = npm ] && [ "$1" = view ]; then printf '%s\\n' 'owned metadata'; exit 0; fi
printf '%s\\n' '${name}' >> '${starts}'
`, { mode: 0o700 });
writeFileSync(join(lane, '.gru-command/worktree.toml'), '[verify]\nfull = "npm test"\nquality = "CI=1 npm run quality"\n');
for (const base of [lane, join(lane, 'web')]) {
  mkdirSync(join(base, 'node_modules/.bin'), { recursive: true });
  for (const name of ['vitest', 'jest', 'tsc', 'eslint', 'vite', 'playwright']) writeFileSync(join(base, 'node_modules/.bin', name), `#!/bin/sh\nprintf '%s\\n' '${name}' >> '${starts}'\n`, { mode: 0o700 });
}
writeFileSync(join(lane, '.gru-command/worktree.toml'), `[verify]\nfull = "npm test"\nquality = "CI=1 npm run quality"\ncustom = 'npm run "check build"'\n`);
const instance = join(home, 'instance-$literal-`literal`'); mkdirSync(instance);
writeFileSync(join(instance, 'config.toml'), `data_dir = ${JSON.stringify(join(home, 'relocated-data'))}\n[auth]\ntoken = "owned-fake-status-token"\n`, { mode: 0o600 });
const config = loadConfig({ GRU_COMMAND_HOME: instance });
const policy = workerVerificationPolicy({ id: 'native-fixture', jobId: 'native-fixture', kind: 'job', status: 'active', path: lane }, configPathFor(config.instanceDir));
const settings = privateClaudeVerificationSettings(policy);
// Explicitly unavailable hook, so only the independent native deny can refuse.
const data = JSON.parse(readFileSync(settings.file, 'utf8')); delete data.hooks;
writeFileSync(settings.file, JSON.stringify(data));
const completeCorpus = [...nativeCorpus, { raw: 'npm run "check build"', refused: true }, { raw: `'${join(lane, 'node_modules/.bin/tsc')}' src/index.ts`, refused: true }];
const corpus = process.argv[3] === 'early' ? completeCorpus.filter(({ raw }) => ['npm test', 'npm run lint && npm run typecheck && npm run build && npm run build:web', 'tsc src/index.ts', "printf '%s' 'X=1 npm test -- --help'", 'tsc --pretty false --showConfig'].includes(raw)) : completeCorpus;
const cases = corpus.map(({ raw, refused }) => [raw, refused, false]);
if (process.argv[3] !== 'early') {
  cases.push(['npm test', true, true, false], ['npm test', true, false, true], ["printf '%s' 'X=1 npm test -- --help'", false, false, true]);
}
const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: home, CLAUDE_CONFIG_DIR: join(home, '.claude'),
  XDG_CONFIG_HOME: join(home, 'config'), XDG_CACHE_HOME: join(home, 'cache'), XDG_DATA_HOME: join(home, 'data'), XDG_STATE_HOME: join(home, 'state'),
  TMPDIR: root, ANTHROPIC_API_KEY: 'fake-owned-fixture-key', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1' };
const identity = { executable, realExecutable: realpathSync(executable), sha256: createHash('sha256').update(readFileSync(executable)).digest('hex'),
  version: execFileSync(executable, ['--version'], { env, cwd: lane, encoding: 'utf8' }).trim(),
  modelRef: 'openai-codex/gpt-6-luna', nativeModel: 'gpt-6-luna', effort: 'max' };
// Claude Code ships every few days and GC users run whatever is installed:
// qualify the installed CLI and RECORD its exact identity (version + sha256)
// as the evidence boundary — never refuse a newer release.
if (!/^\d+\.\d+\.\d+ \(Claude Code\)$/u.test(identity.version)) throw new Error(`Not a Claude Code executable: ${JSON.stringify(identity)}`);
let command = ''; let sent = false; const upstream = [];
const server = createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk;
  if (req.url === '/api/verify/status?request_id=existing-native') {
    if (req.headers.authorization !== 'Bearer owned-fake-status-token') { res.writeHead(403); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ state: 'unknown', requestId: 'existing-native' })); return;
  }
  if (req.url?.split('?')[0] !== '/v1/messages') { res.writeHead(404); res.end(); return; }
  const request = JSON.parse(body); upstream.push({ path: req.url, model: request.model });
  if (request.model !== identity.nativeModel) throw new Error(`Foreign model ${request.model}`);
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const event = (type, fields) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
  event('message_start', { message: { id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', model: request.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
  if (!sent) {
    sent = true;
    event('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'owned_bash', name: 'Bash', input: {} } });
    event('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ command, description: 'owned permission qualification' }) } });
  } else {
    event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Owned qualification settled.' } });
  }
  event('content_block_stop', { index: 0 });
  event('message_delta', { delta: { stop_reason: sent && request.messages.some((m) => Array.isArray(m.content) && m.content.some((c) => c.type === 'tool_result')) ? 'end_turn' : 'tool_use', stop_sequence: null }, usage: { output_tokens: 10 } });
  event('message_stop', {}); res.end();
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.address().port}`;
if (process.argv[3] !== 'early') {
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  const action = `${quote(process.execPath)} ${quote(policy.helper)} status --request-id existing-native --url ${env.ANTHROPIC_BASE_URL} --config ${quote(policy.configFile)}`;
  corpus.push({ raw: action, refused: false, output: 'existing-native' });
  cases.push([action, false, false]);
}
process.stdout.write(JSON.stringify({ identity, root, settings: data, boundary: 'actual vendor permission engine; deterministic fake upstream; no paid model/Perkins READY' }) + '\n');
try {
  for (const [raw, refused, hostUnavailable, hookFailed] of cases) {
    command = raw; sent = false;
    const caseSettings = hookFailed ? { ...data, hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'exit 1' }] }] } } : data;
    writeFileSync(settings.file, JSON.stringify(caseSettings));
    const before = existsSync(starts) ? readFileSync(starts, 'utf8') : '';
    const args = [...claudeTurnArgs({ sessionId: randomUUID(), tools: ['Bash'], systemPrompt: 'Owned deterministic component fixture.', cwd: lane, binary: executable, verificationSettingsFile: settings.file, workerVerification: policy, model: identity.nativeModel, thinkingLevel: identity.effort }, false), '--setting-sources', '', '--strict-mcp-config', '--no-chrome', '--disable-slash-commands', '--no-session-persistence'];
    const child = spawn(executable, args, { env, cwd: lane, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    let pending = ''; let protocolError;
    const channel = new ClaudeVerificationPermissionChannel(child, policy, (message) => {
      protocolError = message; child.stdin.end();
    }, () => child.stdin.write(JSON.stringify(claudePromptFrame('Exercise the supplied owned Bash tool frame.')) + '\n'));
    child.stdout.on('data', (chunk) => {
      stdout += chunk; pending += chunk;
      let at;
      while ((at = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, at); pending = pending.slice(at + 1);
        if (!line.trim()) continue;
        const frame = JSON.parse(line);
        if (hostUnavailable && frame.type === 'control_request') child.stdin.end();
        else channel.ingest(frame);
        if (frame.type === 'result') child.stdin.end();
      }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    channel.start();
    let spawnError;
    const code = await new Promise((resolve) => { child.once('error', (error) => { spawnError = error; }); child.once('close', resolve); });
    const after = existsSync(starts) ? readFileSync(starts, 'utf8') : '';
    process.stdout.write(JSON.stringify({ raw, expectedRefused: refused, hostUnavailable, hookFailed: !!hookFailed, settings: caseSettings, args, code, stdout, stderr, producerStarts: after.slice(before.length), upstream }) + '\n');
    if (protocolError || spawnError || (!hostUnavailable && code !== 0) || !sent) throw new Error('Native identity/wire qualification failed; stop for supervisor');
    const terminal = stdout.trim().split('\n').map((line) => JSON.parse(line)).findLast((frame) => frame.type === 'result');
    const denied = terminal?.permission_denials?.some((entry) => entry.tool_name === 'Bash' && entry.tool_input.command === raw) === true;
    if (!hostUnavailable && denied !== refused) throw new Error(`Native disposition mismatch: ${raw} expected refused=${refused} actual=${denied}`);
    if (refused && after !== before) throw new Error('Native deny failed: fake producer started');
    if (!refused && /permission.*denied|not allowed|denied.*permission/i.test(stdout)) throw new Error('Native deny incorrectly refused an ordinary read');
    if (!refused) {
      const results = stdout.trim().split('\n').map((line) => JSON.parse(line))
        .filter((frame) => frame.type === 'user').flatMap((frame) => frame.message?.content ?? [])
        .filter((block) => block.type === 'tool_result' && block.tool_use_id === 'owned_bash');
      if (results.length !== 1 || results[0].is_error === true) throw new Error(`Native allowed read did not execute successfully: ${raw}`);
      const text = typeof results[0].content === 'string' ? results[0].content : JSON.stringify(results[0].content);
      const expected = corpus.find((row) => row.raw === raw)?.output;
      if (!expected || !text.includes(expected)) throw new Error(`Native allowed read effect mismatch: ${raw}: ${text}`);
    }
  }
} finally { await new Promise((resolve) => server.close(resolve)); settings.dispose(); }
