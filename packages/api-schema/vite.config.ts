// Vite+ per-package settings. The `test` task definition is shared by every package whose tests run
// under vitest and ships as `@gadgets/scripts/vitest-task`.
import { withVitestTask } from '@gadgets/scripts/vitest-task'

export default withVitestTask({
  run: {
    tasks: {
      /**
       * Writes `generated/` and `packages/api-cli/generated/` from api.ts when they are stale, for
       * the tasks that read them (`@gadgets/api-cli`'s `build` and `test`, the integration tests).
       * Uncached, as the backend's `build:bundled-blueprints` is: the script keeps its own record of
       * what it read (`generated/.inputs.json`) and returns at once when nothing changed, and its
       * inputs reach into other packages and the lockfile, which a task fingerprint would have to
       * list and keep in step.
       */
      generate: {
        command: 'node scripts/generate.ts --if-stale',
        cache: false,
      },
    },
  },
}, 'vitest run')
