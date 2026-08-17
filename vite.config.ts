import { defineConfig } from 'vite-plus'

/**
 * Repo-wide toolchain config. Today this is the lint ruleset, moved here from `.oxlintrc.json` so
 * there is one place to look: `vp lint` reads it, and `vp check` runs lint without the format step
 * because the tree is not oxfmt-clean.
 */
export default defineConfig({
  check: {
    // The repo has never been formatted with oxfmt, so `vp check` would report every file. Left off
    // until somebody wants to do that sweep; `vp fmt` still works if invoked directly.
    fmt: false,
  },
  lint: {
    categories: {
      correctness: 'error',
      suspicious: 'error',
    },
    plugins: ['typescript', 'unicorn', 'oxc', 'import'],
    jsPlugins: ['./scripts/oxlint-plugin.mjs'],
    options: {
      // Note: type-aware linting is intentionally not enabled yet.
      // Enabling them is its own change: triage the first run's findings, decide a `no-floating-promises` policy (RPC promise
      // pipelining deliberately leaves promises unawaited, so the default rule flags idiomatic
      // code), and budget for the tsgo pass every lint run would add on top of today's ~1s.
      // Full type safety is still enforced by `tsc` via the `build` script.
      typeAware: false,
    },
    env: {
      es2024: true,
    },
    rules: {
      // Exported API declaration documentation is surfaced by TypeScript in IDE
      // hovers only when it uses JSDoc syntax. Ordinary implementation comments stay `//`.
      'gadgets/prefer-jsdoc': 'error',

      // False positives: gatekeepers import `.txt` files as bundled text assets,
      // which the import resolver reports as "no default export".
      'import/default': 'off',

      // Side-effect imports are used deliberately: CSS (`./styles.css`) and the
      // Workers runtime registration import (`cloudflare:workers`).
      'import/no-unassigned-import': 'off',

      // Comment-only placeholder/reference modules are kept intentionally
      // (e.g. App.tsx, gatekeeper-cloudflare/src/types.d.ts).
      'unicorn/no-empty-file': 'off',

      // Conflicts with our convention of prefixing intentionally-unused bindings
      // with `_` (see no-unused-vars below).
      'no-underscore-dangle': 'off',

      // Do not require churny `_` prefixes on unused callback/interface parameters
      // or catch bindings, but still flag unused imports and local variables.
      'no-unused-vars': [
        'error',
        {
          args: 'none',
          caughtErrors: 'none',
          varsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],

      // TypeScript 7 (tsgo) type-checks only; it currently ships no JS compiler API. The build-time
      // transpilers that need one import the `typescript6` alias instead. Bare `typescript`
      // resolves to 7.x, where the missing API is a runtime failure on whichever code path
      // reaches it rather than anything the type check or the build would catch.
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'typescript',
              message:
                'TypeScript 7 (tsgo) currently ships no JS compiler API. Import the `typescript6` alias for transpileModule/createProgram. `import type` is fine.',
              allowTypeImports: true,
            },
          ],
        },
      ],

      // Genuine improvements, but churny/judgmental for an initial rollout. Kept
      // visible as warnings for incremental cleanup rather than blocking CI.
      'no-shadow': 'warn',
      'typescript/no-this-alias': 'warn',
      'typescript/no-extraneous-class': 'warn',
      'unicorn/consistent-function-scoping': 'warn',
    },
    ignorePatterns: [
      '**/dist/**',
      '**/generated/**',
      '**/*.gen.ts',
      '**/node_modules/**',
      '**/.wrangler/**',
      '**/worker-configuration.d.ts',
    ],
    overrides: [
      {
        files: ['packages/workshop-frontend/**/*.{ts,tsx}'],
        plugins: ['typescript', 'unicorn', 'oxc', 'import', 'react', 'jsx-a11y'],
        env: {
          browser: true,
          es2024: true,
        },
      },
      {
        // Gatekeeper configurator UIs use a classic JSX runtime with the `h`
        // pragma rather than the automatic react-jsx runtime.
        files: ['packages/gatekeeper-*/**/*.tsx'],
        plugins: ['typescript', 'unicorn', 'oxc', 'import', 'react'],
        env: {
          browser: true,
          es2024: true,
        },
      },
      {
        // Cloudflare Workers backends: worker/service-worker global scope.
        files: [
          'packages/workshop-backend/**/*.ts',
          'packages/router/**/*.ts',
          'packages/gatekeeper-*/src/**/*.ts',
          'packages/workshop-shared/**/*.ts',
          'packages/typed-storage/**/*.ts',
        ],
        env: {
          serviceworker: true,
          es2024: true,
        },
      },
      {
        files: ['**/*.test.ts', '**/*.test.tsx', '**/vitest.config.ts'],
        plugins: ['typescript', 'unicorn', 'oxc', 'import', 'vitest'],
        env: {
          vitest: true,
          es2024: true,
        },
      },
      {
        files: ['scripts/**/*.ts', 'scripts/**/*.mjs'],
        env: {
          node: true,
          es2024: true,
        },
      },
      {
        // `scripts/` tests run under `node --test`, not vitest, so they must not pick up the
        // vitest override above (which would supply vitest globals and drop `env: node`). Ordered
        // last so it wins over that entry.
        files: ['scripts/**/*.test.ts'],
        plugins: ['typescript', 'unicorn', 'oxc', 'import'],
        env: {
          node: true,
          es2024: true,
        },
      },
      {
        // The integration-test toolkit owns the capnweb boundary. A repo that vendors this one as a
        // submodule installs its own workspace and this repo's separately, so it ends up with two
        // copies of capnweb, and a stub minted by one copy is unserialisable by the other's session --
        // an error that only shows up once the installs are split, i.e. in CI. So value imports are
        // restricted to rpc-client.ts, which wraps stub minting in stubFor().
        files: ['packages/integration-tests/**/*.ts'],
        rules: {
          // Overrides replace this rule's options rather than merging them, so the repo-wide
          // `typescript` restriction has to be repeated alongside the capnweb one to survive here.
          'no-restricted-imports': [
            'error',
            {
              paths: [
                {
                  name: 'capnweb',
                  message:
                    'Mint stubs via stubFor() from rpc-client: a consumer repo can hold two capnweb copies, and a stub from the wrong one fails to serialise. `import type` is fine.',
                  allowTypeImports: true,
                },
                {
                  name: 'typescript',
                  message:
                    'TypeScript 7 (tsgo) currently ships no JS compiler API. Import the `typescript6` alias for transpileModule/createProgram. `import type` is fine.',
                  allowTypeImports: true,
                },
              ],
            },
          ],
        },
      },
      {
        files: ['packages/integration-tests/src/rpc-client.ts'],
        rules: {
          'no-restricted-imports': 'off',
        },
      },
    ],
  },
})
