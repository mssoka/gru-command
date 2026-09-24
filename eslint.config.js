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
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
);
