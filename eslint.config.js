'use strict';

const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  {
    ignores: [
      'node_modules/**',
      'data/**',
      'coverage/**',
      'test-results/**',
      'e2e-artifacts/**',
      'playwright-report/**',
      'docs/mocks/vendor/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'commonjs', globals: { ...globals.node } },
    rules: { 'no-unused-vars': ['error', { argsIgnorePattern: '^_' }] },
  },
  {
    files: ['public/**/*.js'],
    languageOptions: { sourceType: 'module', globals: { ...globals.browser } },
  },
  {
    // Mock stage scripts: classic browser scripts, not modules.
    files: ['docs/mocks/**/*.js'],
    languageOptions: { sourceType: 'script', globals: { ...globals.browser, THREE: 'readonly' } },
  },
  {
    // Playwright specs: node (commonjs) plus browser globals for page.evaluate() callbacks.
    files: ['e2e/**/*.js'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    files: ['eslint.config.js'],
    languageOptions: { sourceType: 'commonjs' },
  },
];
