// Vite+ per-package settings. Tasks and scripts cannot share a name, so package.json declares
// neither `build` nor `test`.
import { withVitestTask } from "@gadgets/scripts/vitest-task";

export default withVitestTask({
  run: {
    tasks: {
      /**
       * The three tsconfigs type-check each library's client entry under the DOM lib, its server
       * entry under the Workers types, and its tests under Node's, with every `src/` module checked
       * under whichever of those imports it. Each is its own command so each reports on its own;
       * the reason there are three rather than one is that the three sets of globals must not see
       * each other, and is written out in the configs. Pure type checks: nothing here emits.
       */
      build: {
        command: [
          "tsc --project tsconfig.client.json",
          "tsc --project tsconfig.server.json",
          "tsc --project tsconfig.tests.json",
        ],
      },
    },
  },
}, ["vitest run"]);
