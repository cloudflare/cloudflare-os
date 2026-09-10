// Vite+ per-package settings. Tasks and scripts cannot share a name, so package.json declares
// neither `build` nor `test`.
import { withVitestTask } from "@gadgets/scripts/vitest-task";

export default withVitestTask({
  run: {
    tasks: {
      /**
       * Five type-check programs, one per set of globals, because the sets must not see each other:
       * a Durable Object has no `document`, iframe code cannot import `cloudflare:workers`, and
       * neither has Node's `fs`. Each is its own command so each reports on its own; the configs
       * say why they are split the way they are. Pure type checks: nothing here emits.
       *
       * - `tsconfig.client.json`: every blueprint's and library's client entry under the DOM lib.
       * - `tsconfig.server.json`: every server entry under the Workers types.
       * - `tsconfig.tests.json`: the blueprints' and libraries' own tests under DOM and Node types.
       * - `tsconfig.server-tests.json`: the tests of a server side, under Workers and Node types.
       * - `tsconfig.node.json`: `src/` (the build) and its tests, as the Node programs they are.
       *
       * The backend's `build:bundled-blueprints` task bundles the same blueprint sources with esbuild,
       * so a module the bundler cannot resolve fails there, and a type error fails here.
       */
      build: {
        command: [
          "tsc --project tsconfig.client.json",
          "tsc --project tsconfig.server.json",
          "tsc --project tsconfig.tests.json",
          "tsc --project tsconfig.server-tests.json",
          "tsc --project tsconfig.node.json",
        ],
      },
    },
  },
}, ["vitest run"]);
