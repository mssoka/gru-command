import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import type { Api, AssistantMessage, Context, Model, Provider, SimpleStreamOptions } from '@earendil-works/pi-ai';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Stub model provider for offline SDK round-trips.
 *
 * Registers a fake provider into a REAL offline ModelRuntime, so tests
 * exercise the genuine createAgentSession → prompt → stream path with
 * zero network and zero ~/.pi reads (auth/models point at tmp paths).
 */

export const STUB_PROVIDER_ID = 'gru-stub';
export const STUB_MODEL_ID = 'stub-model';

export interface StubTurn {
  /** Text deltas emitted in order. */
  readonly deltas: readonly string[];
  /** Thinking deltas emitted before text. */
  readonly thinking?: readonly string[];
  /** Keep the turn open until this resolves (single-writer tests). */
  readonly hold?: Promise<void>;
  /** Fail the turn with an error after the deltas. */
  readonly error?: string;
}

export interface StubCall {
  readonly prompt: string;
}

function makeStubModel(): Model<Api> {
  return {
    id: STUB_MODEL_ID,
    name: 'Stub Model',
    api: 'gru-stub' as Api,
    provider: STUB_PROVIDER_ID,
    baseUrl: 'stub://local',
    reasoning: true,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 4_096,
  };
}

function zeroUsage() {
  return {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function makeMessage(
  text: string,
  stopReason: 'stop' | 'error',
  errorMessage?: string,
): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'gru-stub',
    provider: STUB_PROVIDER_ID,
    model: STUB_MODEL_ID,
    usage: zeroUsage(),
    stopReason,
    ...(errorMessage !== undefined ? { errorMessage } : {}),
    timestamp: Date.now(),
  } as AssistantMessage;
}

function lastUserPrompt(context: Context): string {
  for (let i = context.messages.length - 1; i >= 0; i -= 1) {
    const message = context.messages[i];
    if (message !== undefined && message.role === 'user') {
      const content = message.content;
      if (typeof content === 'string') return content;
      // Content blocks: join the text blocks (images ignored for logging).
      return content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('');
    }
  }
  return '(no user message)';
}

export class StubScript {
  private turns: StubTurn[];
  readonly calls: StubCall[] = [];

  constructor(turns: readonly StubTurn[]) {
    this.turns = [...turns];
  }

  next(prompt: string): StubTurn {
    this.calls.push({ prompt });
    return this.turns.shift() ?? { deltas: ['stub: ', 'ok'] };
  }
}

function isolatedPaths(): { authPath: string; modelsPath: string } {
  const home = mkdtempSync(join(tmpdir(), 'gru-command-stub-'));
  return { authPath: join(home, 'auth.json'), modelsPath: join(home, 'models.json') };
}

/** An offline runtime with NO usable provider — for fail-loud paths. */
export async function makeIsolatedModelRuntime(): Promise<ModelRuntime> {
  const { authPath, modelsPath } = isolatedPaths();
  return ModelRuntime.create({
    refreshOnCreate: false,
    authPath,
    modelsPath,
  });
}

export async function makeStubModelRuntime(script: StubScript): Promise<ModelRuntime> {
  const { authPath, modelsPath } = isolatedPaths();
  const runtime = await ModelRuntime.create({
    refreshOnCreate: false,
    authPath,
    modelsPath,
  });
  const model = makeStubModel();
  const streamTurn = (prompt: string): AssistantMessageEventStream => {
    const turn = script.next(prompt);
    const stream = new AssistantMessageEventStream();
    const text = turn.deltas.join('');
    void (async () => {
      const final = makeMessage(text, turn.error !== undefined ? 'error' : 'stop', turn.error);
      stream.push({ type: 'start', partial: final });
      let index = 0;
      for (const delta of turn.thinking ?? []) {
        stream.push({ type: 'thinking_start', contentIndex: index, partial: final });
        stream.push({ type: 'thinking_delta', contentIndex: index, delta, partial: final });
        stream.push({ type: 'thinking_end', contentIndex: index, content: delta, partial: final });
        index += 1;
      }
      stream.push({ type: 'text_start', contentIndex: index, partial: final });
      for (const delta of turn.deltas) {
        stream.push({ type: 'text_delta', contentIndex: index, delta, partial: final });
      }
      stream.push({ type: 'text_end', contentIndex: index, content: text, partial: final });
      if (turn.hold !== undefined) await turn.hold;
      if (turn.error !== undefined) {
        stream.push({ type: 'error', reason: 'error', error: final });
        stream.end(final);
        return;
      }
      stream.push({ type: 'done', reason: 'stop', message: final });
      stream.end(final);
    })();
    return stream;
  };
  const provider: Provider = {
    id: STUB_PROVIDER_ID,
    name: 'Gru Stub',
    auth: {
      apiKey: {
        name: 'stub key',
        resolve: async () => ({ auth: { apiKey: 'stub-key' }, source: 'stub' }),
      },
    },
    getModels: () => [model],
    stream: (m: Model<Api>, context: Context) => streamTurn(lastUserPrompt(context)),
    streamSimple: (m: Model<Api>, context: Context, _options?: SimpleStreamOptions) =>
      streamTurn(lastUserPrompt(context)),
  };
  runtime.registerNativeProvider(provider);
  // registerNativeProvider does not refresh the synchronous auth-status
  // cache; a targeted offline refresh makes hasConfiguredAuth() coherent
  // (the real boot path does the equivalent in its services layer).
  await runtime.refresh({ allowNetwork: false, providers: [STUB_PROVIDER_ID] });
  return runtime;
}
