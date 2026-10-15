import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      // Worktree bootstrap copies installed BMAD skills into these directories;
      // they are external generated framework code, not repository source.
      '.agents/skills/**',
      '.claude/skills/**',
      'web/dist/**',
      'web/playwright-report/**',
      'web/test-results/**',
      // Evidence-capture scripts under docs/evidence/ drive the real browser
      // through Playwright (browser globals inside page.evaluate) and Node
      // fetch/timers; they are archived verification artifacts, not
      // repository source, so they are not linted.
      'docs/evidence/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // This integrity-preserved workflow runs only in the governed sandbox,
    // which injects `runs`; it is not a Node/foreground executable.
    files: ['_bmad-output/implementation-artifacts/gh350-restage-wave1.mjs'],
    languageOptions: { globals: { runs: 'readonly' } },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
);
