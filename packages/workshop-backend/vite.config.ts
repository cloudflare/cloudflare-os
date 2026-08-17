// Vite+ per-package settings. The `test` task definition is shared by every package whose tests run
// under vitest and lives beside the other shared task configs.
import { vitestTask } from '../../scripts/vitest-task-vite-config.js'

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
      /**
       * A task rather than a package.json script so it can depend on the codegen above; a script
       * would run it in vp's clean environment. `cache: false` because `build-browser-runtime.mjs`
       * writes into the same package tracking hashes as its input, which vp declines to cache.
       */
      build: {
        command: ['node build-browser-runtime.mjs', 'tsc --project tsconfig.browser.json', 'tsc'],
        dependsOn: ['build:format-blueprints'],
        cache: false,
      },
      /**
       * The browser-runtime codegen is repeated here rather than shared because tasks are
       * independent -- `vp run test` never triggers `build` -- and `src/generated/` is gitignored but
       * imported by `src/`. It caches, unlike the blueprint codegen, because it reads no environment.
       */
      test: {
        ...vitestTask([
          'node build-browser-runtime.mjs',
          'vitest run',
          'vitest run --config vitest.integration.config.ts',
        ]),
        dependsOn: ['build:format-blueprints'],
      },
    },
  },
}
