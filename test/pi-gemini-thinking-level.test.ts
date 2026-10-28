import { expect, it } from 'vitest';
import { streamSimple } from '@earendil-works/pi-ai/api/google-vertex';
import { normalizeContext, type Model } from '@earendil-works/pi-ai';

/**
 * #521: Vertex rejects a Gemini 4 request that carries `thinkingBudget`
 * ("Thinking budget is not supported for this model. Use thinking level
 * instead."). pi-ai 0.85.x only knew Gemini 3 ids as thinking-level models;
 * 1.4 adds Gemini 4+. The request is built, handed to `onPayload`, and
 * aborted there with a sentinel error, so nothing reaches the network.
 */

const SENTINEL = 'offline: payload captured, request not sent';

const gemini4: Model<'google-vertex'> = {
  id: 'gemini-4-argon',
  name: 'Gemini 4 Argon (offline fixture)',
  api: 'google-vertex',
  provider: 'google-vertex',
  baseUrl: 'https://{location}-aiplatform.googleapis.com',
  reasoning: true,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_000_000,
  maxTokens: 65_536,
};

it('a Gemini 4 request with a requested reasoning level carries a thinking level and no thinkingBudget (#521)', async () => {
  let payload: unknown;
  const result = await streamSimple(
    gemini4,
    // pi-ai 1.x providers take a normalized transcript context, not a raw Context.
    normalizeContext({ messages: [{ role: 'user', content: 'hello', timestamp: 0 }] }),
    {
      reasoning: 'medium',
      // Top-level project/location options are dropped by streamSimple; the
      // Vertex client reads them from env.
      env: { GOOGLE_CLOUD_PROJECT: 'offline-project', GOOGLE_CLOUD_LOCATION: 'us-central1' },
      onPayload: (captured) => {
        payload = captured;
        throw new Error(SENTINEL);
      },
    },
  ).result();

  // The call ended at the sentinel, so the payload was built and never sent.
  expect(result.stopReason).toBe('error');
  expect(result.errorMessage).toContain(SENTINEL);
  const config = (payload as { config?: { thinkingConfig?: Record<string, unknown> } }).config;
  expect(config?.thinkingConfig).toBeDefined();
  const thinkingConfig = config!.thinkingConfig!;
  expect(thinkingConfig['includeThoughts']).toBe(true);
  expect(['MINIMAL', 'LOW', 'MEDIUM', 'HIGH']).toContain(thinkingConfig['thinkingLevel']);
  expect(Object.keys(thinkingConfig)).not.toContain('thinkingBudget');
});
