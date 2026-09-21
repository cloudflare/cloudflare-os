// Vite+ per-package settings. The `test` task definition is shared by every package whose tests run
// under vitest and ships as `@gadgets/scripts/vitest-task`.
import { withVitestTask } from '@gadgets/scripts/vitest-task'

export default withVitestTask(
  {
    run: {
      tasks: {
        /**
         * `build` is a task rather than a package.json script so it can declare `output`, and this
         * is the one package where that is load-bearing rather than tidy: every other package is
         * `noEmit`, but this one's `exports` resolves to `dist/index.js`, so its consumers *read*
         * the build output instead of rebuilding it. `workshop-backend` and `gatekeeper-context`
         * type-check against `src` through a tsconfig `paths` entry, but wrangler bundles the real
         * `dist/index.js` -- which is why `workshop-backend`'s `build:integration-worker` and
         * `run-local.ts` both name `@gadgets/typed-storage#build` as an explicit prerequisite.
         *
         * `dist/**` is excluded from `input` because vp declines to cache a task that reads a path
         * it also writes. Package-relative, not workspace-wide: this package's output is a real
         * input to the packages that bundle it.
         */
        build: {
          command: 'tsc',
          input: [{ auto: true }, { pattern: '!dist/**', base: 'package' } as const],
          output: ['dist/**'],
        },
      },
    },
  },
  'vitest run',
)
