# Gadget libraries

Shared code the bundled blueprints import instead of carrying their own copies. A blueprint's
`client.ts` and `server.ts` import a library by this package's name and the subpath its
`package.json` exports, `@gadgets/bundled-blueprints/libraries/<name>/client` and
`.../<name>/server`; the blueprint build (`../src/files.ts`) resolves each to the library's entry
here and inlines what the entry uses into the `client.js` / `server.js` the blueprint ships, the way
it inlines a blueprint's own `lib/` modules. The archive stays self-contained, and a gadget created from the
blueprint carries its own copy of the library as of its creation; nothing resolves the package name
at runtime, and a gadget the agent writes cannot import one.

Nothing here is deployed on its own. The package name is how tsc, vitest and an editor resolve the
import, through `exports`, with no alias or `paths` block; the build resolves the same name to this
directory itself, so a blueprint tree with no `node_modules` above it builds too.

## Layout

```
<name>/
  client.ts        entry of .../libraries/<name>/client, inlined into a blueprint's client.js
  server.ts        entry of .../libraries/<name>/server, inlined into a blueprint's server.js
  src/**           the modules the two entries import; never shipped on their own
  __tests__/**     vitest, jsdom by default, `// @vitest-environment node` for a pure module;
                   `server.test.ts` / `<topic>.server.test.ts` for a test of the server side
  README.md        what the library does and how it is put together
```

A library may import another (`@gadgets/bundled-blueprints/libraries/ui/client` from a library built
on it, say); the blueprint build resolves that import the same way. A client entry may not import a
library's server side, and the build rejects a blueprint that does: it would drag a Durable Object
into the iframe. A blueprint imports its own files by relative path and a library by package
subpath; everything else the bundle inlines fails the build -- a relative or absolute path into
`libraries/` (`../../../libraries/ui/src/dom.ts`), a library's `src/` module by package path, the
package root, or a bare specifier some `node_modules` above the blueprint happens to satisfy -- so
the exported subpath is the only door.

## Rules for a library

- **es2022.** A blueprint's bundles target `es2022`, and the gadget loader's `compatibilityDate` is
  `"2026-02-01"` (`loadGadgetWorker` in overseer.ts). A library that needs a newer runtime feature
  bumps that date for every gadget, and says so in its README.
- **No npm.** What a library imports is inlined into a blueprint's archive, which nothing audits
  afterwards, so the blueprint build rejects an input from `node_modules`. A library is written
  against the platform alone, like a gadget.
- **Readable.** The inlined code is what the agent reads and edits in an instantiated gadget. The
  bundle is not minified, so a library's names and structure survive into it and should read well
  on their own; its comments do not survive, because esbuild drops ordinary comments whatever the
  minify settings, so the doc comments in `src/` are for this repository's readers.
- **Lint applies.** Unlike a blueprint's `files/`, which the repo's lint ignores as user-authored
  gadget source, this is platform code and is checked like the rest of the repo.

## Tests

```
pnpm --filter @gadgets/bundled-blueprints test:run   # the libraries' suites, with the blueprints'
vp run -F @gadgets/bundled-blueprints build          # the type-check programs
```

The package's `tsconfig.client.json` checks each client entry under the DOM lib,
`tsconfig.server.json` each server entry under the Workers types, `tsconfig.tests.json` the tests
under DOM and Node types and `tsconfig.server-tests.json` the server-side tests under Workers and
Node types; a `src/` module is checked under whichever of those imports it, which is what keeps a
Durable Object from seeing `document` and iframe code from importing `cloudflare:workers`. A server
test runs against a stub of `cloudflare:workers` that the package's vitest config aliases in.

## Libraries

- [`ui`](ui/README.md) -- DOM helpers for document-style gadgets: the `el` builder, SVG icons and
  toolbar controls, the in-page prompt, the save-status dot, relative time, and image reading and
  downscaling. Client-only.
- [`sync`](sync/README.md) -- collaboration plumbing: on the server a mutation queue, a subscriber
  registry with presence seeding and broadcast, and versioned upserts; on the client a save scheduler
  with retry backoff, a presence roster and a subscribe helper. The Docs, Sheets and Slides
  blueprints build on it.
