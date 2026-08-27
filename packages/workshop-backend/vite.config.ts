// Vite+ per-package settings. The `test` task definition is shared by every package whose tests run
// under vitest and lives beside the other shared task configs.
import { vitestTask, withTestTimeout } from '../../scripts/vitest-task-vite-config.js'

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
        command: 'node scripts/build-format-blueprints.mjs',
        cache: false,
      },
      'build:browser-runtime': {
        command: withTestTimeout('node build-browser-runtime.mjs'),
        cache: false,
      },
      /** Builds the validated entrypoint shared by integration-test file workers. */
      'build:integration-worker': {
        command: withTestTimeout('capnweb-validate build --out .wrangler/validate'),
        dependsOn: [
          '@gadgets/typed-storage#build', 'build:format-blueprints', 'build:browser-runtime',
        ],
        cache: false,
      },
      build: {
        command: ['tsc --project tsconfig.browser.json', 'tsc'],
        dependsOn: ['build:format-blueprints', 'build:browser-runtime'],
        cache: false,
      },
      test: {
        ...vitestTask([
          'vitest run',
          'vitest run --config vitest.integration.config.ts',
        ]),
        dependsOn: ['build:format-blueprints', 'build:browser-runtime'],
      },
    },
  },
}
