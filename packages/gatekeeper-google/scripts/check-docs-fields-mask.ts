// Checks, against Google itself, that `documents.get` takes the field mask `getDocument` sends
// (`DOCUMENT_FIELDS`), that the copy of a document pruned from the masked answer is the copy
// pruned from the whole one, and that the read of a document's tab IDs (`getTopLevelTabIds`)
// gives the top-level tabs' IDs. Run it after any change to what the copy keeps, before the
// change ships, and on documents that hold what the recordings of `__tests__/fixtures/docs-live/`
// do not: child tabs, named ranges, chips, a horizontal rule, an equation, a table of contents,
// tables in tables.
//
//   pnpm --filter @gadgets/google-gatekeeper check:docs-fields-mask <token-file> <document-id>...
//
// The token file holds an OAuth access token that may read the documents (the
// `documents.readonly` scope is enough), alone and on one line. The check only reads, three
// reads a document: one with the mask, one without it and one of the tab IDs. It prints one
// line a document, numbered in the order given: sizes, statuses, whether the copies are equal,
// the first place they differ as a path of field names, and how many tab IDs came. It never
// prints the token, a document's id, a tab's id, a title or any text of a document. The client
// it reads through writes its own log lines to the same terminal; one for a mask Google refuses
// carries an error's stack, which names paths of the checkout. Google
// gives a document's revision only to an account that may edit it, and without one the check
// cannot tell that the two reads saw the same document, so it reports that the document changed.
//
// The check imports the gatekeeper's sources, which name each other without file extensions,
// so it is loaded through Vite and not by Node itself.

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
  let check = await server.ssrLoadModule("/__tests__/docs-fields-check.ts") as {
    main: (argv: readonly string[]) => Promise<number>;
  };
  process.exitCode = await check.main(process.argv.slice(2));
} finally {
  await server.close();
}
