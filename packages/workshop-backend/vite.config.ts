// Vite+ per-package settings. The `test` task definition is shared by every package whose tests run
// under vitest and ships as `@gadgets/scripts/vitest-task`.
import {
  TESTS_WITH_TIMEOUT_ENV, vitestTask, withTestTimeout,
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
        cache: false,
      },
      'build:browser-runtime': {
        command: withTestTimeout('node build-browser-runtime.mjs'),
        cache: false,
      },
      /**
       * Builds the validated entrypoint shared by integration-test file workers.
       *
       * Cached with the `build:app` shape: the build writes `.wrangler/validate/` back into the
       * package automatic tracking treats as input, so without dropping that tree from `input`
       * nothing ever caches. Workspace-wide, since tracking reaches past this package and any
       * sibling that ran `wrangler dev` would otherwise guarantee a miss. The explicit `output`
       * matters as much: a cache hit has to leave the tree on disk, because
       * `@gadgets/integration-tests` reads it rather than rebuilding it.
       *
       * Its two codegen prerequisites stay uncached, which is what makes this safe: they always
       * run, so `src/generated/format-blueprints.ts` and the browser-runtime artifacts are current
       * when this task's fingerprint is taken. Fingerprinting those *generated* files rather than
       * `FORMAT_BLUEPRINTS_DIR` sidesteps the "env fingerprints the value, not what it points at"
       * hazard one level down -- an external blueprint edit rewrites the generated module, which is
       * a tracked input here.
       *
       * Caching means this now runs with a stripped environment. `scripts/env-passthrough.test.ts`
       * is the guard: if capnweb-validate ever starts reading an ambient var, it fails there rather
       * than replaying a stale tree. The watchdog's own off switch is the one variable declared.
       */
      'build:integration-worker': {
        command: withTestTimeout('capnweb-validate build --out .wrangler/validate'),
        env: TESTS_WITH_TIMEOUT_ENV,
        dependsOn: [
          '@gadgets/typed-storage#build', 'build:format-blueprints', 'build:browser-runtime',
        ],
        input: [{ auto: true }, { pattern: '!**/.wrangler/**', base: 'workspace' }],
        output: ['.wrangler/validate/**'],
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
       * The server config is its own program rather than this package's plus the blueprint servers,
       * and the bare `tsc` (this package's `src/`) runs beside it: the generated Workers types would
       * hand a gadget's Durable Object the backend's bindings, which it never receives at runtime.
       * The config says why.
       *
       * `build:format-blueprints` has already bundled the same sources by the time these run, so a
       * module esbuild cannot resolve fails there first.
       */
      build: {
        command: [
          'tsc',
          'tsc --project tsconfig.browser.json',
          'tsc --project tsconfig.blueprints-server.json',
          'tsc --project tsconfig.blueprints-client.json',
          'tsc --project tsconfig.blueprints-tests.json',
        ],
        dependsOn: ['build:format-blueprints', 'build:browser-runtime'],
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
        dependsOn: ['build:format-blueprints', 'build:browser-runtime'],
      },
    },
  },
}
