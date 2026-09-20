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
 *                        before completing the turn (25s safety exit 4)
 *   "crash"            — stderr + exit 2, no result frame
 *   "no-result-ok"     — exit 0 with no result frame (protocol violation)
 *   "error"            — result frame with is_error:true
 *   "garbage"          — blank/non-JSON lines + a torn final line at EOF
 *   "partial"          — assistant frame written in byte chunks, splitting
 *                        a multi-byte UTF-8 character across writes
 *   "no-init"          — assistant/result frames WITHOUT an init frame
 *                        (session identity never announced)
 *   "think"            — thinking deltas + thinking block before text
 *   "tool:<name>"      — a tool_use/tool_result loop before the answer
 *   otherwise          — echo turn: "echo: <prompt>"
 *
 * Env knobs:
 *   CLAUDE_DOUBLE_LOG=<file>    append one JSON record per invocation
 *                               {argv, cwd, prompt, images} at turn end
 *   CLAUDE_DOUBLE_NO_PARTIALS=1 suppress stream_event partials
 *   CLAUDE_DOUBLE_MISMATCH=1    init frame carries a foreign session id
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
 */
import process from 'node:process';
import { Buffer } from 'node:buffer';
import { appendFileSync, existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
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
process.stdin.on('data', (chunk) => {
  stdinText += chunk;
});
process.stdin.on('end', () => {
  run().catch((error) => {
    process.stderr.write(`double failure: ${String(error)}\n`);
    process.exit(2);
  });
});

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
    `${JSON.stringify({ argv, cwd: process.cwd(), prompt, images, sessionId, stdin: stdinText })}\n`,
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
    mcp_servers: [],
  };
}

function resultFrame(text, isError) {
  return {
    type: 'result',
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

async function emitToolTurn(toolName) {
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
  // The COMPLETE assistant frame still arrives — the adapter must not
  // double-announce this tool call.
  out(
    assistantFrame([
      { type: 'tool_use', id: callId, name: toolName, input: { command: 'ls' } },
    ]),
  );
  out({
    type: 'user',
    session_id: sessionId,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: callId, content: 'ok', is_error: false }],
    },
  });
  await emitTextTurn('tool done');
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
  recordInvocation(prompt, images);

  if (prompt.includes('crash')) {
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

  if (prompt.startsWith('hold:')) {
    const releaseFile = prompt.slice('hold:'.length).trim();
    const deadline = Date.now() + 25_000;
    while (!existsSync(releaseFile)) {
      if (Date.now() > deadline) {
        process.stderr.write(`double hold timeout waiting for ${releaseFile}\n`);
        process.exit(4);
      }
      await delay(10);
    }
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
  if (prompt.includes('tool:')) {
    await emitToolTurn(prompt.split('tool:')[1].split(/\s/)[0] || 'Bash');
    out(resultFrame('tool done', false));
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
