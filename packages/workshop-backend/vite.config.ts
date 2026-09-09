// Vite+ per-package settings. The `test` task definition is shared by every package whose tests run
// under vitest and ships as `@gadgets/scripts/vitest-task`.
import {
  vitestTask, withTestTimeout,
} from '@gadgets/scripts/vitest-task'

/**
 * Codegen steps stay separate commands rather than one `&&` string so each caches on its own.
 */
export default {
  run: {
    tasks: {
      /**
       * Its own task because it is the one step here that reads an env var: `FORMAT_BLUEPRINTS_DIR`
       * points the generator at a blueprint set outside this workspace, and a cached `vp` run strips
       * undeclared vars, so a cached caller compiles the defaults in instead. Everything needing
       * `src/generated/format-blueprints.ts` depends on it -- `cache: false` is per-task, so running
       * the generator inside a cached task strips the override however its siblings are declared.
       *
       * `cache: false` rather than `env: ['FORMAT_BLUEPRINTS_DIR']`: `env` fingerprints the value,
       * not the contents of the directory it names, so edits inside it would replay a stale module.
       */
      'build:format-blueprints': {
        command: 'node scripts/build-format-blueprints.ts',
        dependsOn: ['build:gadget-libraries'],
        cache: false,
      },
      /**
       * Bundles `packages/gadget-libraries` into `src/generated/gadget-libraries.ts`, declarations
       * included. Uncached like its siblings: it reads a sibling package's whole tree, and the
       * generated module is what the dependents fingerprint. `build:format-blueprints` depends on
       * it because a blueprint's `gadget.json` pins are checked against the libraries that exist.
       */
      'build:gadget-libraries': {
        command: 'node scripts/build-gadget-libraries.ts',
        dependsOn: ['build:gadget-library-types'],
        cache: false,
      },
      /**
       * Emits every library's `.d.ts` into `dist/gadget-library-types/<side>/`, which
       * `build:gadget-libraries` reads into the generated module for the agent's
       * `describeGadgetLibrary`. Cached with the `build:app` shape: the emit writes into this
       * package, so its output tree leaves `input` (workspace-wide, since automatic tracking
       * reaches the libraries package the programs compile; `src/generated` goes with it, since
       * the sibling generators rewrite it and this emit reads none of it), and the explicit
       * `output` makes a cache hit restore the tree, because the consumer reads it rather than
       * rebuilding it. The two programs are the libraries' own tsconfigs, so a library type error
       * fails here first.
       */
      'build:gadget-library-types': {
        command: 'node scripts/build-gadget-library-types.ts',
        input: [
          { auto: true },
          { pattern: '!**/dist/**', base: 'workspace' },
          { pattern: '!**/src/generated/**', base: 'workspace' },
        ],
        output: ['dist/gadget-library-types/**'],
      },
      'build:browser-runtime': {
        command: withTestTimeout('node build-browser-runtime.mjs'),
        cache: false,
      },
      /**
       * Builds the validated entrypoint shared by integration-test file workers.
       *
       * Deliberately uncached, like `@gadgets/integration-tests#build:test-gatekeeper`: its
       * consumer reads `.wrangler/validate/` from disk while its own suite runs, so the tree has to
       * be written exactly once per run, in dependency order, and then left alone. A cached task
       * with a declared `output` is not left alone -- vp restores the tree on a hit and discards it
       * again when one of this task's uncached codegen prerequisites re-runs, so for a moment the
       * tree is absent or half-extracted, and a file worker booting from it at that moment fails on
       * a missing entrypoint. Caching also bought nothing: `src/generated/gadget-libraries.ts` is
       * rewritten by an uncached prerequisite every run, which reads as a changed input.
       *
       * Uncached means the full ambient environment reaches it, so no `env` declaration is needed
       * (`scripts/env-passthrough.test.ts` and `vitest-task.test.ts` both accept `cache: false`).
       */
      'build:integration-worker': {
        command: withTestTimeout('capnweb-validate build --out .wrangler/validate'),
        cache: false,
        dependsOn: [
          '@gadgets/typed-storage#build', 'build:gadget-libraries', 'build:format-blueprints',
          'build:browser-runtime',
        ],
      },
      /**
       * The three `tsconfig.blueprints-*` configs type-check the TypeScript under
       * `format-blueprints/<name>/`, so a type error in a bundled gadget fails the build the way
       * one in `src/` does: each `client.ts` under the DOM lib, each `server.ts` under the Workers
       * types, the blueprints' own tests under Node's, and every `lib/` module under whichever of
       * those imports it. Each is its own command so each reports on its own; the reason there are
       * three rather than one is that the three sets of globals must not see each other, and is
       * written out in the configs.
       *
       * `tsconfig.blueprints-server.json` stands in for the bare `tsc` rather than joining it: it
       * *is* this package's own program plus the blueprint servers, because the Workers types
       * available here drag `src/` into any program that loads them. Running both would type-check
       * `src/` twice for nothing.
       *
       * `build:format-blueprints` has already bundled the same sources by the time these run, so a
       * module esbuild cannot resolve fails there first.
       */
      build: {
        command: [
          'tsc --project tsconfig.browser.json',
          'tsc --project tsconfig.blueprints-server.json',
          'tsc --project tsconfig.blueprints-client.json',
          'tsc --project tsconfig.blueprints-tests.json',
        ],
        dependsOn: ['build:gadget-libraries', 'build:format-blueprints', 'build:browser-runtime'],
        cache: false,
      },
      /**
       * The unit suite needs a longer idle threshold than the watchdog's default. Import dominates
       * its runtime (`import 261s, tests 19s` on a 4-vCPU runner, alongside three other workerd
       * fleets), and vitest prints only as files complete, so a healthy run's silences stretch past
       * the default once the machine is contended. The wall-clock backstop still bounds a real hang.
       *
       * The integration config is one file and keeps the default, as does the blueprints config:
       * its two Node projects (the blueprints' own lib tests and the bundling tests of
       * `scripts/format-blueprint-files.ts`) are small and import nothing heavy.
       */
      test: {
        ...vitestTask([
          { command: 'vitest run', idleSeconds: 120 },
          'vitest run --config vitest.integration.config.ts',
          'vitest run --config vitest.blueprints.config.ts',
        ]),
        dependsOn: ['build:gadget-libraries', 'build:format-blueprints', 'build:browser-runtime'],
      },
    },
  },
}
