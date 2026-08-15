import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      'apps/demo/.vite/**',
      '.smoke/**',
      'apps/spike/results/**',
      '.evidence/**',
    ],
  },
  ...tseslint.configs.recommended,
  {
    // Pragmatic repo-wide relaxations: `any` is used deliberately at engine
    // boundaries, and `_`-prefixed bindings are the intentional-unused idiom.
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
  {
    // Core must stay framework-free and headless: only the vanilla
    // zustand store, and no ambient browser globals. orbit-data shares the
    // purity bar (Node-import-safe, consumes supplied bytes/streams
    // and NEVER fetches — no DOM, no network).
    files: ['packages/core/src/**', 'packages/data/src/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'zustand',
              message: 'orbit-core may only use zustand/vanilla.',
            },
          ],
          patterns: [
            {
              group: ['zustand/*', '!zustand/vanilla'],
              message: 'orbit-core may only use zustand/vanilla.',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        'window',
        'document',
        'navigator',
        'fetch',
        'XMLHttpRequest',
        'WebSocket',
        // Frame-loop policy: core owns no requestAnimationFrame loop;
        // every per-frame consumer rides the engine's onFrame fan-out. The
        // testing rafAudit instrument wraps rAF without calling it and
        // passes this rule on its own.
        {
          name: 'requestAnimationFrame',
          message:
            'One frame loop per instance: ride the engine onFrame fan-out.',
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.property.name='requestAnimationFrame']",
          message:
            'One frame loop per instance: ride the engine onFrame fan-out.',
        },
      ],
    },
  },
  {
    // React binding & packaged components: label/announcement text
    // must reach the DOM as text nodes only — raw HTML injection is banned.
    files: ['packages/react/src/**'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message:
            'dangerouslySetInnerHTML is banned in orbit-react: render text nodes only.',
        },
        {
          selector: "AssignmentExpression[left.property.name='innerHTML']",
          message: 'innerHTML assignment is banned in orbit-react: render text nodes only.',
        },
        // Frame-loop policy: components ride the core onFrame
        // fan-out or subscription channels — never their own rAF loop.
        {
          selector: "CallExpression[callee.property.name='requestAnimationFrame']",
          message:
            'One frame loop per instance: ride the core onFrame fan-out.',
        },
      ],
      'no-restricted-globals': [
        'error',
        {
          name: 'requestAnimationFrame',
          message:
            'One frame loop per instance: ride the core onFrame fan-out.',
        },
      ],
    },
  },
  {
    // Sanctioned exception: Lasso's ONE-SHOT pointer-move coalescing during
    // an active drag gesture — not a loop; it exists only while the pointer
    // is captured and dies with the gesture.
    files: ['packages/react/src/Lasso.tsx'],
    rules: {
      'no-restricted-globals': 'off',
    },
  },
);
