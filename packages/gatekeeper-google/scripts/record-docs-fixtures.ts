// Records what Google Docs does with the batches the Docs gatekeeper's builders send into
// `__tests__/fixtures/docs-live/`, one file per scenario, which `__tests__/docs-live.test.ts`
// holds the model of `documents.batchUpdate` to. The scenarios, and what the hand-made template
// document must hold, are in `__tests__/docs-live-recorder.ts`.
//
//   pnpm --filter @gadgets/google-gatekeeper record:docs-fixtures <token-file> [--only name] [--check] [--template <docId>]
//
// The token file holds an OAuth access token that may create and edit Google Docs and, through
// Drive, copy the template and move a document to the trash (the `drive` scope covers all of
// it); it is never printed. Each scenario creates a document, or copies the template named by
// `--template`, sends its edits one batch at a time, each built by the production builders,
// reads the document after each, and moves the document to the trash. `--only` records one
// scenario. With `--check` nothing is written: each committed recording is made again and
// compared, exiting 1 if the builders send another batch or Google answers differently.
//
// The recorder imports the gatekeeper's sources, which name each other without file
// extensions, so it is loaded through Vite and not by Node itself.

import { fileURLToPath } from "node:url";
import { createViteServer } from "vitest/node";

let server = await createViteServer({
  root: fileURLToPath(new URL("..", import.meta.url)),
  configFile: false,
  appType: "custom",
  logLevel: "error",
  server: { middlewareMode: true, hmr: false, ws: false, watch: null },
  optimizeDeps: { noDiscovery: true },
  // As the Node tests do (`vitest.config.ts`): modules that read the Worker's bindings import a
  // module only workerd has.
  resolve: {
    alias: {
      "cloudflare:workers": fileURLToPath(new URL("../__tests__/stubs/cloudflare-workers.ts", import.meta.url)),
    },
  },
});
try {
  let recorder = await server.ssrLoadModule("/__tests__/docs-live-recorder.ts") as {
    main: (argv: readonly string[]) => Promise<number>;
  };
  process.exitCode = await recorder.main(process.argv.slice(2));
} finally {
  await server.close();
}
