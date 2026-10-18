import { describe, expect, it } from 'vitest';
import { buildClaudeCodeAuthArgs, claudeReviewIsolationArgs } from '../src/runtime/claude-model.js';
import { claudeReviewProcessEnv } from '../src/runtime/claude-review-settings.js';
import { claudeTurnArgs } from '../src/runtime/claude-adapter.js';

// Flags that make the CLI ignore --mcp-config. The review lead can only submit
// through the gru_perkins bridge, so none of these may sit next to it.
const SUPPRESSES_MCP_CONFIG = ['--safe-mode', '--bare'];

describe('claude review isolation', () => {
  it('never passes a flag that suppresses the review MCP bridge', () => {
    const args = claudeReviewIsolationArgs('/tmp/settings.json');
    for (const flag of SUPPRESSES_MCP_CONFIG) expect(args).not.toContain(flag);
    expect(args).toEqual(expect.arrayContaining(['--strict-mcp-config', '--disable-slash-commands', '--no-chrome']));
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('');
  });

  it('keeps the auth probe and the real turn on the same isolation args', () => {
    const probe = buildClaudeCodeAuthArgs('claude-opus-5-5', '/tmp/settings.json');
    const turn = claudeTurnArgs({
      sessionId: 'sid', tools: ['Read'], systemPrompt: 'p', cwd: '/repo', isolatedReview: true,
      reviewSettingsFile: '/tmp/settings.json', mcpConfigFile: '/tmp/bridge/mcp-config.json',
    } as never, false);
    for (const arg of claudeReviewIsolationArgs('/tmp/settings.json')) {
      expect(probe).toContain(arg);
      expect(turn).toContain(arg);
    }
    for (const flag of SUPPRESSES_MCP_CONFIG) expect(turn).not.toContain(flag);
    expect(turn[turn.indexOf('--mcp-config') + 1]).toBe('/tmp/bridge/mcp-config.json');
  });

  it('disables auto-memory in the review process env, even if auth env tries to enable it', () => {
    const env = claudeReviewProcessEnv({ authEnv: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0' } } as never);
    expect(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('1');
  });
});
