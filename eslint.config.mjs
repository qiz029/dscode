import js from '@eslint/js';
import globals from 'globals';

// Correctness lint for the plain-ESM harness code. Style stays out: the codebase's
// dense one-line style is deliberate, so only real problems fail the build.
export default [
  {
    // `*-panel.mjs` files are serialized into the pinned TUI; `import_react` and
    // friends are bound by the patcher, not by the module loader.
    ignores: ['**/node_modules/', '.runtime/', 'artifacts/', 'eval/', '.research/', '**/fixtures/',
      // Compiled for distribution only; the repository runs packages/tui/src directly.
      'packages/tui/lib/'],
  },
  {
    files: ['**/*.mjs'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: { ...globals.node } },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      // Deliberate empty catches are the codebase's documented idiom.
      'no-empty': ['error', { allowEmptyCatch: true }],
      // Control characters in regexes are the point here (subject sanitation, path filters).
      'no-control-regex': 'off',
    },
  },
  {
    // Test fixtures stub streams and services; unused locals and generator-less
    // async stubs are part of the shape, not defects.
    files: ['tests/**/*.mjs'],
    rules: { 'no-unused-vars': 'off', 'require-yield': 'off', 'no-empty': 'off' },
  },
];
