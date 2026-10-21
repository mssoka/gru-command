#!/usr/bin/env node
/**
 * Stubbed `claude` CLI double for the claude-code adapter tests.
 *
 * Speaks the headless stream-json surface: reads ONE user frame on stdin
 * (then EOF), emits NDJSON frames on stdout, exits 0. Driven by prompt
 * sentinels and env knobs — never talks to a network.
 *
 * Sentinels (in the prompt text):
 *   "hold:<abs path>"  — emit init, then wait for that file to appear
 *   "held:<abs path>"  — anywhere in the prompt: the same wait (after the
 *                        echo of a directive turn), then an ordinary answer
 *                        before completing the turn (25s safety exit 4)
 *   "crash"            — stderr + exit 2, no result frame
 *   "die-after-echo"   — init, the prompt echo and a tool_use, then exit 2
 *                        with no result (an interrupted directive turn)
 *   "no-result-ok"     — exit 0 with no result frame (protocol violation)
 *   "api-error"        — the real CLI's synthetic API-error assistant
 *                        message (is_api_error_message) + is_error result
 *   "usage-limit"      — the same shape for a claude.ai usage-limit wall
 *                        (error "rate_limit", api_error_status 429)
 *   "error"            — result frame with is_error:true
 *   "garbage"          — blank/non-JSON lines + a torn final line at EOF
 *   "partial"          — assistant frame written in byte chunks, splitting
 *                        a multi-byte UTF-8 character across writes
 *   "no-init"          — assistant/result frames WITHOUT an init frame
 *                        (session identity never announced)
 *   "think"            — thinking deltas + thinking block before text
 *   "tool:<name>"      — a tool_use/tool_result loop before the answer
 *   "tool-error:<name>" — the same loop whose tool_result is an error
 *
 * With --replay-user-messages (a directive turn, #424) the double echoes the
 * prompt after init (`isReplay: true`, a uuid) and echoes every
 * control_response the host writes; with --permission-prompt-tool stdio and a
 * --settings `permissions.ask` naming the tool, every tool_use asks the host
 * (can_use_tool) after its assistant frame and honours the decision.
 *   otherwise          — echo turn: "echo: <prompt>"
 *
 * Env knobs:
 *   CLAUDE_DOUBLE_LOG=<file>    append one JSON record per invocation
 *                               {argv, cwd, prompt, images} at turn end
 *   CLAUDE_DOUBLE_NO_PARTIALS=1 suppress stream_event partials
 *   CLAUDE_DOUBLE_TOOL_HOLD_MS=<ms> hold the tool_use open this long before
 *                               emitting its tool_result (long-tool tests)
 *   CLAUDE_DOUBLE_MISMATCH=1    init frame carries a foreign session id
 *   CLAUDE_DOUBLE_MCP_SERVER_ERRORS=<json> init frame's mcp_server_errors
 *   CLAUDE_DOUBLE_MCP_SERVERS=<json> init frame's mcp_servers
 *   CLAUDE_DOUBLE_IGNORE_TERM=1 ignore SIGTERM (SIGKILL-path tests)
 *   CLAUDE_DOUBLE_COMPACT_ERROR=1 fail the native /compact control
 *   CLAUDE_DOUBLE_COMPACT_STATUS_FAIL=1 report native failure with a successful command result
 *   CLAUDE_DOUBLE_COMPACT_EXIT_ERROR=1 report native success, then exit non-zero
 *   CLAUDE_DOUBLE_COMPACT_NO_INIT=1 omit the compact init frame
 *   CLAUDE_DOUBLE_COMPACT_INIT_NO_ID=1 emit compact init without session_id
 *   CLAUDE_DOUBLE_COMPACT_NO_RESULT=1 omit the compact result frame
 *   CLAUDE_DOUBLE_COMPACT_CONTENT=1 emit command content/tool frames
 *   CLAUDE_DOUBLE_COMPACT_FORGED_RESULT=1 put compact_result on a non-status frame
 *   CLAUDE_DOUBLE_COMPACT_MALFORMED_RESULT=1 omit required result fields
 *   CLAUDE_DOUBLE_COMPACT_HOLD_FILE=/path wait during /compact until disposed
 *   CLAUDE_DOUBLE_WORKFLOW_CANDIDATE=1 emit one security finding plus verifier response
 *   CLAUDE_DOUBLE_GRU_ACT={baseUrl,token,detail} on a wake prompt, POST the
 *                               notification disposition itself (Gru-authored action)
 *   CLAUDE_DOUBLE_REPLAY=<file> after init, every non-/compact turn is that
 *                               file's recorded stream-json frames (session id
 *                               re-stamped), e.g. test/fixtures/claude-stream/
 *   CLAUDE_DOUBLE_ECHO=mutate|skip  the prompt echo carries other text, or never comes
 *   CLAUDE_DOUBLE_TOOL_INPUT_DRIFT=1 the permission request names other input than the tool_use
 *   CLAUDE_DOUBLE_TOOL_BACKGROUND=1  the tool_use asks for run_in_background
 *   CLAUDE_DOUBLE_TASK_NOTIFICATION=after-echo|before-echo|before-echo-tool|foreign
 *                               a background task's notification replay right
 *                               after the echo; two before it (a resumed
 *                               session's unanswered tail); one before it and
 *                               then a tool that asks the host before the echo;
 *                               or, after the echo, a replayed prompt that is
 *                               no notification
 */
import process from 'node:process';
import { Buffer } from 'node:buffer';
import { appendFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { spawnSync, spawn as childSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { clearTimeout as clearTimer, setTimeout as setTimer } from 'node:timers';
import { setInterval } from 'node:timers';

const argv = process.argv.slice(2);

if (argv[0] === '--version' || argv[0] === '-v') {
  process.stdout.write('9.9.9 (Claude Code double)\n');
  process.exit(0);
}

if (process.env['CLAUDE_DOUBLE_IGNORE_TERM'] === '1') {
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 60_000); // stay alive until SIGKILL
}

function flagValue(name) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

const sessionId =
  process.env['CLAUDE_DOUBLE_MISMATCH'] === '1'
    ? 'foreign-session-id'
    : (flagValue('--session-id') ?? flagValue('--resume') ?? 'double-session');
const partials = process.env['CLAUDE_DOUBLE_NO_PARTIALS'] !== '1';

const out = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const streamEvent = (event) => out({ type: 'stream_event', session_id: sessionId, event });

let stdinText = '';
process.stdin.setEncoding('utf8');
let pendingInput = ''; let running = false;
const responses = new Map();
const headlessHost = flagValue('--permission-prompt-tool') === 'stdio';
const replay = argv.includes('--replay-user-messages');
const launch = () => {
  if (running) return;
  running = true;
  run().catch((error) => { process.stderr.write(`double failure: ${String(error)}\n`); process.exit(2); });
};
process.stdin.on('data', (chunk) => {
  stdinText += chunk;
  if (!headlessHost) return;
  pendingInput += chunk;
  let at;
  while ((at = pendingInput.indexOf('\n')) >= 0) {
    const line = pendingInput.slice(0, at); pendingInput = pendingInput.slice(at + 1);
    if (!line.trim()) continue;
    const frame = JSON.parse(line);
    if (frame.type === 'control_request' && frame.request?.subtype === 'initialize') {
      out({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: {} } });
    } else if (frame.type === 'control_response') {
      if (replay) out(frame);
      responses.get(frame.response.request_id)?.(frame.response.response);
      responses.delete(frame.response.request_id);
    } else if (frame.type === 'user') launch();
  }
});
process.stdin.on('end', () => { if (!headlessHost) launch(); });

function promptFromStdin() {
  let prompt = '';
  let images = 0;
  for (const line of stdinText.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let frame;
    try {
      frame = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const content = frame?.message?.content;
    if (typeof content === 'string') {
      prompt = content;
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === 'text' && typeof block.text === 'string') prompt = block.text;
        if (block?.type === 'image') images += 1;
      }
    }
  }
  return { prompt, images };
}

function recordInvocation(prompt, images) {
  const logFile = process.env['CLAUDE_DOUBLE_LOG'];
  if (!logFile) return;
  appendFileSync(
    logFile,
    `${JSON.stringify({ argv, cwd: process.cwd(), prompt, images, sessionId, stdin: stdinText, backgroundTasks: process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS ?? null })}\n`,
    'utf8',
  );
}

function initFrame() {
  const toolsFlag = flagValue('--tools');
  return {
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
    cwd: process.cwd(),
    model: flagValue('--model') ?? 'double-default-model',
    permissionMode: flagValue('--permission-mode') ?? 'default',
    tools: toolsFlag !== undefined ? toolsFlag.split(',') : [],
    mcp_servers: process.env['CLAUDE_DOUBLE_MCP_SERVERS'] !== undefined ? JSON.parse(process.env['CLAUDE_DOUBLE_MCP_SERVERS']) : [],
    ...(process.env['CLAUDE_DOUBLE_MCP_SERVER_ERRORS'] !== undefined
      ? { mcp_server_errors: JSON.parse(process.env['CLAUDE_DOUBLE_MCP_SERVER_ERRORS']) }
      : {}),
  };
}

function resultFrame(text, isError) {
  return {
    type: 'result',
    uuid: randomUUID(),
    subtype: isError ? 'error_during_execution' : 'success',
    is_error: isError,
    duration_ms: 1,
    duration_api_ms: 1,
    num_turns: 1,
    session_id: sessionId,
    total_cost_usd: 0,
    result: text,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

function assistantFrame(blocks) {
  return {
    type: 'assistant',
    uuid: randomUUID(),
    session_id: sessionId,
    message: {
      id: 'msg_double',
      type: 'message',
      role: 'assistant',
      content: blocks,
      model: 'double-default-model',
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  };
}

/** Emit a text answer, with stream_event partials unless suppressed. */
async function emitTextTurn(text) {
  if (partials) {
    streamEvent({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    });
    for (const piece of text.match(/.{1,4}/gs) ?? [text]) {
      streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } });
      await delay(1);
    }
    streamEvent({ type: 'content_block_stop', index: 0 });
  }
  out(assistantFrame([{ type: 'text', text }]));
}

async function emitThinkingTurn(text) {
  if (partials) {
    streamEvent({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: '' },
    });
    streamEvent({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'pondering' },
    });
    streamEvent({ type: 'content_block_stop', index: 0 });
  }
  out(assistantFrame([{ type: 'thinking', thinking: 'pondering', signature: 'sig' }]));
  await emitTextTurn(text);
}

/** The host's decision on one tool, when the settings ask it (stdio prompt). */
async function askHost(toolName, callId, input) {
  const settingsFile = flagValue('--settings');
  const settings = settingsFile ? JSON.parse(readFileSync(settingsFile, 'utf8')) : {};
  if (!headlessHost || !settings.permissions?.ask?.includes(toolName)) return { behavior: 'allow' };
  const requestId = `perm-${randomUUID()}`;
  const asked = process.env.CLAUDE_DOUBLE_TOOL_INPUT_DRIFT === '1' ? { ...input, drifted: true } : input;
  return await new Promise((resolve) => {
    responses.set(requestId, resolve);
    out({ type: 'control_request', request_id: requestId, request: { subtype: 'can_use_tool', tool_name: toolName, tool_use_id: callId, input: asked } });
  });
}

async function emitToolTurn(toolName, toolError = false) {
  const callId = 'toolu_double_1';
  if (partials) {
    streamEvent({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: callId, name: toolName, input: {} },
    });
    streamEvent({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"command":' },
    });
    streamEvent({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '"ls"}' },
    });
    streamEvent({ type: 'content_block_stop', index: 0 });
  }
  const input = process.env.CLAUDE_DOUBLE_TOOL_BACKGROUND === '1' ? { command: 'ls', run_in_background: true } : { command: 'ls' };
  // The COMPLETE assistant frame still arrives — the adapter must not
  // double-announce this tool call.
  out(
    assistantFrame([
      { type: 'tool_use', id: callId, name: toolName, input },
    ]),
  );
  const decision = await askHost(toolName, callId, input);
  const holdMs = Number(process.env['CLAUDE_DOUBLE_TOOL_HOLD_MS'] ?? '0');
  if (Number.isFinite(holdMs) && holdMs > 0) await delay(holdMs);
  const denied = decision?.behavior !== 'allow';
  out({
    type: 'user',
    uuid: randomUUID(),
    session_id: sessionId,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: callId, content: denied ? (decision?.message ?? 'denied') : toolError ? 'tool failed' : 'ok', is_error: denied || toolError }],
    },
  });
  await emitTextTurn(denied ? 'tool refused' : 'tool done');
}

/** The CLI's own echo of the prompt it accepted (--replay-user-messages). */
function echoPrompt() {
  if (!replay || process.env.CLAUDE_DOUBLE_ECHO === 'skip') return;
  const frame = stdinText.split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line)).find((entry) => entry.type === 'user');
  if (frame === undefined) return;
  const message = process.env.CLAUDE_DOUBLE_ECHO === 'mutate'
    ? { ...frame.message, content: [{ type: 'text', text: 'not what the host sent' }] }
    : frame.message;
  out({ type: 'user', message, session_id: sessionId, parent_tool_use_id: null, uuid: randomUUID(), timestamp: new Date().toISOString(), isReplay: true });
}

/** A background task's completion as the real CLI replays it (#471, Claude
 * Code 2.1.306): a system task_notification, then an isReplay user frame
 * tagged origin.kind task-notification whose content is one string block. */
function taskNotification(taskId) {
  const runId = `run-${taskId}`;
  const summary = `Background command "${taskId}" completed (exit code 0)`;
  out({ type: 'system', subtype: 'task_notification', task_id: taskId, run_id: runId, tool_use_id: `toolu_${taskId}`, status: 'completed',
    output_file: `/tmp/${taskId}.output`, summary, uuid: randomUUID(), session_id: sessionId });
  out({ type: 'user', message: { role: 'user', content: `<task-notification>\n<task-id>${taskId}</task-id>\n<tool-use-id>toolu_${taskId}</tool-use-id>\n<output-file>/tmp/${taskId}.output</output-file>\n<status>completed</status>\n<summary>${summary}</summary>\n</task-notification>` },
    session_id: sessionId, parent_tool_use_id: null, uuid: randomUUID(), timestamp: new Date().toISOString(), isReplay: true,
    origin: { kind: 'task-notification', producer: 'session-task', runId } });
}

/** Minimal MCP stdio client: newline-delimited JSON-RPC to the bridge
 * server named in --mcp-config (what the real claude CLI does). */
async function mcpSession(configFile) {
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  const server = config.mcpServers['gru_perkins'];
  if (server === undefined) throw new Error(`no gru_perkins server in ${configFile}`);
  const proc = childSpawn(server.command, server.args, {
    env: { ...process.env, ...server.env },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  let nextId = 1;
  const pending = new Map();
  const lines = createInterface({ input: proc.stdout });
  lines.on('line', (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.id !== undefined && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  });
  const call = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimer(() => {
        pending.delete(id);
        reject(new Error(`mcp ${method} timeout`));
      }, 60_000);
      timer.unref?.();
      pending.set(id, (message) => {
        clearTimer(timer);
        if (message.error !== undefined) reject(new Error(message.error.message ?? 'mcp error'));
        else resolve(message);
      });
      proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  return {
    call,
    close: () => {
      try {
        proc.stdin.end();
        proc.kill('SIGTERM');
      } catch {
        /* already gone */
      }
    },
  };
}

function mcpToolText(response) {
  const text = response.result?.content?.[0]?.text;
  if (typeof text !== 'string') throw new Error('mcp tool returned no text');
  return text;
}

/** Write a frame in tiny byte chunks, splitting multi-byte characters. */
async function writeChunked(obj) {
  const buf = Buffer.from(`${JSON.stringify(obj)}\n`, 'utf8');
  for (let i = 0; i < buf.length; i += 7) {
    process.stdout.write(buf.subarray(i, i + 7));
    await delay(1);
  }
}

async function run() {
  const { prompt, images } = promptFromStdin();
  // A test-only fail-closed stand-in for Claude's review settings resolution.
  // Never log the settings content (it may hold actual credentials).
  const expectedModel = process.env['CLAUDE_DOUBLE_EXPECT_REVIEW_MODEL'];
  const expectedAuth = process.env['CLAUDE_DOUBLE_EXPECT_REVIEW_AUTH'];
  if (expectedModel !== undefined || expectedAuth !== undefined) {
    const file = flagValue('--settings');
    const settings = file === undefined ? {} : JSON.parse(readFileSync(file, 'utf8'));
    if (file !== undefined && (statSync(file).mode & 0o077) !== 0) {
      process.stderr.write('review settings are not private\n');
      process.exit(19);
    }
    const selected = flagValue('--model') ?? process.env.ANTHROPIC_MODEL ?? settings.model;
    if (argv.includes('--safe-mode') || argv.includes('--bare') || process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY !== '1' || flagValue('--setting-sources') !== '' ||
        !argv.includes('--strict-mcp-config') || !argv.includes('--disable-slash-commands') ||
        !argv.includes('--no-chrome') || !argv.includes('--tools') ||
        settings.hooks !== undefined || settings.plugins !== undefined || settings.env?.NODE_OPTIONS !== undefined ||
        (expectedModel !== undefined && selected !== expectedModel) ||
        (expectedAuth === 'env' && (settings.env?.ANTHROPIC_API_KEY !== 'test-key' || process.env.ANTHROPIC_API_KEY !== 'test-key')) ||
        (expectedAuth === 'helper' && (settings.apiKeyHelper !== undefined || process.env.ANTHROPIC_API_KEY !== 'helper-key')) ||
        (expectedAuth === 'oauth' && (settings.env?.CLAUDE_CODE_OAUTH_TOKEN !== 'oauth-test-token' ||
          process.env.CLAUDE_CODE_OAUTH_TOKEN !== 'oauth-test-token'))) {
      process.stderr.write('review model/auth isolation mismatch\n');
      process.exit(19);
    }
  }
  recordInvocation(prompt, images);

  // The real fallback brief names the release-safety category "crash"; that
  // structured task is not the test double's deliberate crash sentinel.
  if (prompt.includes('crash') && !prompt.includes('gc_submit_fallback_findings({ findings: [...] })')) {
    process.stderr.write('double crash requested\n');
    process.exit(2);
  }

  if (prompt.includes('no-init')) {
    // Frames without the init frame: the session identity never arrives.
    await emitTextTurn('no init here');
    out(resultFrame('no init here', false));
    return;
  }

  if (prompt === '/compact' && process.env['CLAUDE_DOUBLE_COMPACT_NO_INIT'] === '1') {
    // Deliberately omit identity initialization.
  } else if (prompt === '/compact' && process.env['CLAUDE_DOUBLE_COMPACT_INIT_NO_ID'] === '1') {
    const init = initFrame();
    delete init.session_id;
    out(init);
  } else {
    out(initFrame());
    const notified = process.env.CLAUDE_DOUBLE_TASK_NOTIFICATION;
    if (notified === 'before-echo') { taskNotification('bgdouble1'); taskNotification('bgdouble2'); }
    if (notified === 'before-echo-tool') {
      taskNotification('bgdouble1');
      out(assistantFrame([{ type: 'tool_use', id: 'toolu_early', name: 'Read', input: { file_path: '/early' } }]));
      await askHost('Read', 'toolu_early', { file_path: '/early' });
    }
    echoPrompt();
    if (notified === 'after-echo') taskNotification('bgdouble1');
    if (notified === 'foreign') {
      out({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'do something else' }] }, session_id: sessionId, parent_tool_use_id: null, uuid: randomUUID(), timestamp: new Date().toISOString(), isReplay: true });
    }
  }

  if (prompt.includes('die-after-echo')) {
    out(assistantFrame([{ type: 'tool_use', id: 'toolu_interrupted', name: 'Bash', input: { command: 'make' } }]));
    process.stderr.write('double died mid-turn\n');
    process.exit(2);
  }

  const recorded = process.env['CLAUDE_DOUBLE_REPLAY'];
  if (recorded !== undefined && recorded !== '' && prompt !== '/compact') {
    // The real CLI's recorded machine frames, verbatim but for the session id.
    for (const line of readFileSync(recorded, 'utf8').split('\n')) {
      if (line.trim() !== '') out({ ...JSON.parse(line), session_id: sessionId });
    }
    return;
  }

  const gruAct = process.env['CLAUDE_DOUBLE_GRU_ACT'];
  if (gruAct !== undefined && prompt.includes('[gru awareness · service context') &&
      prompt.includes('started by the service wake policy')) {
    // GH-124: the MODEL's turn performs the authorized disposition itself,
    // through the live HTTP API, exactly as a tool-capable Gru would.
    const spec = JSON.parse(gruAct);
    // Mailbox-delivered wakes carry the real notification ids inside the item
    // JSON; legacy notes carry `- <icon> [<id>]`.
    const mailboxItem = /^- \[mailbox:[^\]]+\] (\{.*\})$/m.exec(prompt)?.[1];
    const id = mailboxItem !== undefined
      ? JSON.parse(mailboxItem).notificationIds?.[0]
      : /^- \S+ \[([^\]]+)\]/m.exec(prompt)?.[1];
    if (id === undefined) throw new Error('wake prompt carried no notification id to disposition');
    const response = await globalThis.fetch(`${spec.baseUrl}/api/notifications/${id}/disposition`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${spec.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ detail: spec.detail }),
    });
    if (response.status !== 200) throw new Error(`disposition failed: ${response.status} ${await response.text()}`);
    await emitToolTurn('Bash');
    out(resultFrame(`dispositioned ${id}`, false));
    return;
  }

  if (prompt.startsWith('verification-bash:') || (prompt === '/compact' && process.env.CLAUDE_DOUBLE_COMPACT_VERIFICATION !== undefined)) {
    const command = prompt === '/compact' ? process.env.CLAUDE_DOUBLE_COMPACT_VERIFICATION : prompt.slice('verification-bash:'.length);
    const settingsFile = flagValue('--settings');
    const settings = settingsFile ? JSON.parse(readFileSync(settingsFile, 'utf8')) : {};
    let reason = '';
    // The real CLI announces the tool_use before its hook and permission ask.
    out(assistantFrame([{ type: 'tool_use', id: 'verification-call', name: 'Bash', input: { command } }]));
    const hook = settings.hooks?.PreToolUse?.[0]?.hooks?.[0]?.command;
    if (hook && process.env.CLAUDE_DOUBLE_VERIFICATION_HOOK_FAIL !== '1') {
      const result = spawnSync('/bin/sh', ['-c', hook], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }), encoding: 'utf8' });
      if (result.status === 0) reason = JSON.parse(result.stdout).hookSpecificOutput?.permissionDecisionReason ?? '';
    }
    if (settings.permissions?.ask?.includes('Bash')) {
      if (!headlessHost) reason = 'native ask has no host';
      else {
        const requestId = 'owned-permission';
        const decision = await new Promise((resolve) => {
          responses.set(requestId, resolve);
          out({ type: 'control_request', request_id: requestId, request: { subtype: 'can_use_tool', tool_name: 'Bash', tool_use_id: 'verification-call', input: process.env.CLAUDE_DOUBLE_PERMISSION_MALFORMED === '1' ? {} : { command } } });
        });
        if (decision?.behavior !== 'allow') reason = decision?.message ?? 'native host denied';
        else if (decision.updatedInput.command !== command) throw new Error('host rewrote command');
      }
    } else {
      const { simulatedNativeDenial } = await import('./verification-native-corpus.mjs');
      if (simulatedNativeDenial(command, settings.permissions?.deny ?? [])) reason ||= 'native deny';
    }
    let answer = reason;
    if (!reason) {
      const execution = spawnSync('/bin/bash', ['-c', command], { cwd: process.cwd(), encoding: 'utf8', env: process.env });
      answer = execution.stdout + execution.stderr;
      if (execution.status !== 0) reason = answer;
    }
    out({ type: 'user', uuid: randomUUID(), session_id: sessionId, message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'verification-call', content: answer, is_error: !!reason },
    ] } });
    if (prompt !== '/compact') { await emitTextTurn('verification attempt settled'); out(resultFrame('verification attempt settled', false)); return; }
  }
  if (prompt === '/compact') {
    if (process.env['CLAUDE_DOUBLE_COMPACT_CONTENT'] === '1') {
      await emitThinkingTurn('compact command chatter');
      await emitToolTurn('CompactTool');
    }
    const compactHold = process.env['CLAUDE_DOUBLE_COMPACT_HOLD_FILE'];
    if (compactHold !== undefined && compactHold !== '') {
      const deadline = Date.now() + 25_000;
      while (!existsSync(compactHold)) {
        if (Date.now() > deadline) {
          process.stderr.write(`double compact hold timeout waiting for ${compactHold}\n`);
          process.exit(4);
        }
        await delay(10);
      }
    }
    if (process.env['CLAUDE_DOUBLE_COMPACT_ERROR'] === '1') {
      out(resultFrame('native compact failed', true));
    } else if (process.env['CLAUDE_DOUBLE_COMPACT_STATUS_FAIL'] === '1') {
      out({
        type: 'system',
        subtype: 'status',
        status: null,
        compact_result: 'failed',
        compact_error: 'native compact status failed',
        session_id: sessionId,
      });
      // Claude can report slash-command success even when compaction itself
      // failed. The adapter must key completion from compact_result/boundary.
      out(resultFrame('Command completed', false));
    } else {
      if (process.env['CLAUDE_DOUBLE_COMPACT_FORGED_RESULT'] === '1') {
        out({ type: 'assistant_status', compact_result: 'success', session_id: sessionId });
      } else {
        out({
          type: 'system',
          subtype: 'status',
          status: null,
          compact_result: 'success',
          session_id: sessionId,
        });
        out({
          type: 'system',
          subtype: 'compact_boundary',
          session_id: sessionId,
        });
      }
      if (process.env['CLAUDE_DOUBLE_COMPACT_NO_RESULT'] !== '1') {
        const result = resultFrame('Compacted conversation', false);
        if (process.env['CLAUDE_DOUBLE_COMPACT_MALFORMED_RESULT'] === '1') {
          delete result.is_error;
          delete result.subtype;
        }
        out(result);
      }
      if (process.env['CLAUDE_DOUBLE_COMPACT_EXIT_ERROR'] === '1') process.exitCode = 7;
    }
    return;
  }

  if (prompt.includes('gc_submit_fallback_findings({ findings: [...] })')) {
    const configFile = flagValue('--mcp-config');
    if (configFile === undefined) throw new Error('fallback prompt requires its scoped MCP report tool');
    const session = await mcpSession(configFile);
    try {
      const listed = await session.call('tools/list', {});
      const names = listed.result.tools.map((tool) => tool.name);
      if (names.length !== 1 || names[0] !== 'gc_submit_fallback_findings') throw new Error('fallback exposes unexpected native authority');
      const response = await session.call('tools/call', { name: names[0], arguments: { findings: [] } });
      if (!mcpToolText(response).includes('captured by the host')) throw new Error('fallback submission failed');
      await emitTextTurn('DONE');
      out(resultFrame('DONE', false));
    } finally { session.close(); }
    return;
  }

  if (prompt.includes('COMPLETE FROZEN DIFF (the whole change under review)')) {
    const configFile = flagValue('--mcp-config');
    if (configFile === undefined) {
      process.stderr.write('whole-PR lead prompt without --mcp-config\n');
      process.exit(2);
    }
    const session = await mcpSession(configFile);
    try {
      const listed = await session.call('tools/list', {});
      const names = listed.result.tools.map((tool) => tool.name).sort().join(',');
      const run = (lenses) =>
        session.call('tools/call', {
          name: 'perkins_run_specialists',
          arguments: { runs: lenses.map((lens) => ({ lens })) },
        });
      const first = await run(['blind', 'edge', 'acceptance', 'security']);
      const second = await run(['architecture', 'codebase', 'tests', 'performance']);
      const third = await run(['operations']);
      const findings = [];
      for (const response of [first, second, third]) {
        const payload = JSON.parse(mcpToolText(response));
        for (const result of payload.results) {
          if (result.status !== 'valid') continue;
          for (const finding of result.findings) findings.push(finding);
        }
      }
      const submission = await session.call('tools/call', {
        name: 'perkins_submit_review',
        arguments: {
          verdict: 'READY TO MERGE',
          findings,
          prior_dispositions: [],
          report_markdown: [
            '# Perkins Code Review',
            '',
            '**Verdict: READY TO MERGE**',
            `Target: ${/^Frozen target SHA: (.+)$/m.exec(prompt)?.[1] ?? ''}`,
            `Base: ${/^Frozen diff base SHA: (.+)$/m.exec(prompt)?.[1] ?? ''}`,
            'Specialists: blind edge acceptance security architecture codebase tests performance operations',
            'warning Verified adapter finding src/main.ts:2',
            'warning Changed behavior lacks test tracing src/main.ts:2 — add an assertion for the changed return value.',
            'Retain verification coverage for this path.',
          ].join('\n'),
        },
      });
      const final = `whole-PR lead complete; tools=${names}; submit=${mcpToolText(submission)}`;
      await emitTextTurn(final);
      out(resultFrame(final, false));
    } finally {
      session.close();
    }
    return;
  }

  if (prompt.startsWith('hold:') || prompt.includes('held:')) {
    const releaseFile = prompt.startsWith('hold:') ? prompt.slice('hold:'.length).trim() : prompt.split('held:')[1].split(/\s/)[0];
    const deadline = Date.now() + 25_000;
    while (!existsSync(releaseFile)) {
      if (Date.now() > deadline) {
        process.stderr.write(`double hold timeout waiting for ${releaseFile}\n`);
        process.exit(4);
      }
      await delay(10);
    }
  }

  if (process.env['CLAUDE_DOUBLE_WORKFLOW_CANDIDATE'] === '1') {
    const configFile = flagValue('--mcp-config');
    const lens = /Your lens id is "(blind|edge|acceptance|security|architecture|codebase|tests|performance|operations)"/.exec(prompt)?.[1];
    if (lens !== undefined && configFile !== undefined) {
      // Native-tool child (the host wired perkins_submit_findings through a
      // scoped bridge): submit findings through the product tool exactly as
      // the real model would. The host owns the lens id, so the input omits
      // `source` — the same shape the prompt demands.
      const findings = lens === 'security'
        ? [{ severity: 'warning', category: 'coverage', title: 'Verified adapter finding', location: 'src/main.ts:2', evidence: '  return 43;', detail: 'The changed line is independently reviewable.', recommended_fix: 'Retain verification coverage for this path.' }]
        : lens === 'tests'
          ? [{ severity: 'warning', category: 'coverage', title: 'Changed behavior lacks test tracing', location: 'src/main.ts:2', evidence: '  return 43;', detail: 'The changed return value has no direct assertion.', recommended_fix: 'Add an assertion for the changed return value.' }]
          : [];
      const session = await mcpSession(configFile);
      try {
        const response = await session.call('tools/call', {
          name: 'perkins_submit_findings',
          arguments: { findings },
        });
        const accepted = JSON.parse(mcpToolText(response));
        if (accepted.accepted !== true) throw new Error('child submission was not accepted');
      } finally {
        session.close();
      }
      const summary = 'findings submitted via perkins_submit_findings';
      await emitTextTurn(summary);
      out(resultFrame(summary, false));
      return;
    }
    // Text-path child (no native tool wired): the strict JSON envelope.
    let answer = '[]';
    if (prompt.includes('"source": "security"')) {
      answer = '[{"source":"security","severity":"warning","category":"coverage","title":"Verified adapter finding","location":"src/main.ts:2","evidence":"  return 43;","detail":"The changed line is independently reviewable.","recommended_fix":"Retain verification coverage for this path."}]';
    } else if (prompt.includes('"source": "tests"')) {
      answer = '[{"source":"tests","severity":"warning","category":"coverage","title":"Changed behavior lacks test tracing","location":"src/main.ts:2","evidence":"  return 43;","detail":"The changed return value has no direct assertion.","recommended_fix":"Add an assertion for the changed return value."}]';
    }
    await emitTextTurn(answer);
    out(resultFrame(answer, false));
    return;
  }

  if (prompt.includes('no-result-ok')) {
    await emitTextTurn('no result coming');
    process.exit(0);
  }

  if (prompt.includes('garbage')) {
    process.stdout.write('\n');
    process.stdout.write('this is not json\n');
    await emitTextTurn('through the noise');
    out(resultFrame('through the noise', false));
    // Torn tail: a partial frame with NO trailing newline at EOF.
    process.stdout.write('{"type":"resul');
    return;
  }

  if (prompt.includes('partial')) {
    // Chunked writes; the text carries multi-byte characters whose byte
    // sequences are split across chunks by the fixed 7-byte stride.
    await writeChunked(assistantFrame([{ type: 'text', text: 'héllo ★ partial world ☃' }]));
    await writeChunked(resultFrame('héllo ★ partial world ☃', false));
    return;
  }

  if (prompt.includes('think')) {
    await emitThinkingTurn('thought about it');
    out(resultFrame('thought about it', false));
    return;
  }
  if (prompt.includes('tool-error:')) {
    await emitToolTurn(prompt.split('tool-error:')[1].split(/\s/)[0] || 'Bash', true);
    out(resultFrame('tool failed', false));
    return;
  }
  if (prompt.includes('tool:')) {
    await emitToolTurn(prompt.split('tool:')[1].split(/\s/)[0] || 'Bash');
    out(resultFrame('tool done', false));
    return;
  }
  if (prompt.includes('api-error')) {
    // Real CLI shape (2.1.x): the API failure arrives as a synthetic
    // assistant message, then an is_error result carrying the same text.
    const text = "There's an issue with the selected model (double-model). It may not exist or you may not have access to it.";
    out({ ...assistantFrame([{ type: 'text', text }]), error: 'model_not_found', is_api_error_message: true, api_error_status: 404 });
    out({ ...resultFrame(text, true), subtype: 'success', api_error_status: 404 });
    return;
  }
  if (prompt.includes('usage-limit')) {
    const text = "You've hit your limit · resets 3pm (UTC)";
    out({ ...assistantFrame([{ type: 'text', text }]), error: 'rate_limit', is_api_error_message: true, api_error_status: 429 });
    out({ ...resultFrame(text, true), subtype: 'success', api_error_status: 429 });
    return;
  }
  if (prompt.includes('error')) {
    await emitTextTurn('about to fail');
    out(resultFrame('double exploded', true));
    return;
  }
  const answer = images > 0 ? `echo: ${prompt} (+${images} image)` : `echo: ${prompt}`;
  await emitTextTurn(answer);
  out(resultFrame(answer, false));
}
