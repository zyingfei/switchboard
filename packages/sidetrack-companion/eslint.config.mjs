import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(
  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    ignores: [
      'dist/**',
      'build/**',
      'coverage/**',
      'generated/**',
      '*.config.js',
      '*.config.cjs',
      '*.config.mjs',
      'eslint.config.mjs',
    ],
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/consistent-type-imports': ['warn', { prefer: 'type-imports' }],
      '@typescript-eslint/no-redundant-type-constituents': 'warn',
      '@typescript-eslint/no-unnecessary-type-assertion': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          ignoreRestSiblings: true,
          varsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/prefer-promise-reject-errors': 'warn',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/await-thenable': 'warn',
      '@typescript-eslint/no-base-to-string': 'warn',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/prefer-readonly': 'warn',
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: false }],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'no-empty': 'warn',
      'no-useless-escape': 'warn',
    },
  },
  {
    files: ['**/*.test.ts', '**/*.test.tsx', '**/*.spec.ts', '**/*.spec.tsx', '**/test/**'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/unbound-method': 'off',
    },
  },
);
