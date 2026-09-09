# Gadget libraries

Shared code a gadget imports instead of carrying its own copy. A gadget's `client.js` and
`server.js` may import `gadgets:<name>/client` and `gadgets:<name>/server`; the Workshop supplies
those modules when it loads the gadget -- in the sandboxed iframe through an import map, in the
Durable Object through workerd's dynamic loader -- so a gadget built on a library carries only its
own domain code, and every workspace running it shares one implementation.

Nothing in this package is deployed on its own. The Workshop backend's
`scripts/build-gadget-libraries.ts` bundles every library here into `src/generated/gadget-libraries.ts`
(a `build:gadget-libraries` task that `build`, `test` and the blueprint build all depend on), one
minified bundle per side plus the library's declarations (below), and the deployment ships exactly
that.

## Layout

```
<name>/
  library.json     {"name", "version", "notes"} -- the name is the directory's and the specifier's
  client.ts        entry of gadgets:<name>/client, bundled for the browser
  server.ts        entry of gadgets:<name>/server, bundled for workerd (cloudflare:* stays external)
  src/**           the modules the two entries import; never shipped on their own
  __tests__/**     vitest, jsdom by default, `// @vitest-environment node` for a pure module
  README.md        what the library does and how it is put together
```

A library may import another (`gadgets:ui/client` from a library built on it, say). The import
stays external in its bundle, the build records it as a dependency (rejecting a name that is not a
library, a wrong side, a self-import or a cycle), and it resolves through the pins of the gadget
that loads it: **a gadget pins every library it loads, transitively**. The blueprint build demands
those pins, and the kernel refuses a pin whose dependency is unpinned.

## How a gadget uses one

The gadget's own tree holds one file, `gadget.json`, naming each library it imports and a **pin**:

```json
{"libraries": {"sync": "latest", "ui": "latest"}}
```

`latest` resolves to the bundle shipped with the running deployment, with no I/O and no stored
version: every workspace pinned that way runs the current library, the way a hosted document
updates under its author. It is the only pin today; the pin file exists so that a copy a gadget
carries in its own files can become a second value later without changing the grammar.

The filename predates pins, so a `gadget.json` that is not an object or has no `libraries` key is
treated as somebody else's file: it declares no pins and is not checked. Once `libraries` is
present the file is a pin file, and every rule applies -- no other keys, an object of library name
to pin, lowercase names, `latest` pins.

The blueprint build (`scripts/format-blueprint-files.ts`) checks that a blueprint's imports and pins
agree: every `gadgets:` import pinned, on the right side, naming a library that exists; every pin
imported. The kernel reads the same file when it loads a gadget (`src/gadget-libraries.ts`), from
the committed files or a chat's proposed ones, so a chat can propose a pin change and preview it.
The agent learns what exists through its `listGadgetLibraries` tool and a library's interface
through `describeGadgetLibrary`, and may write `gadget.json` and the imports itself when it builds a
gadget.

## Rules for a library

- **Versions are for people.** `library.json`'s `version` and `notes` are shown by the agent's
  `listGadgetLibraries` and in review; nothing resolves a pin by version. Bump `version` when the
  behaviour changes and say what changed in `notes`.
- **Migrate on load.** Because gadgets float on `latest`, a change to what a library stores in a
  gadget's Durable Object reaches workspaces holding data written by the previous version with no
  upgrade step in between. The library has to read the old shape and write the new one itself, on
  load; there is no other hook.
- **es2022, on the loader's compatibility date.** Bundles target `es2022`, and the gadget loader's
  `compatibilityDate` is `"2026-02-01"` (`loadGadgetWorker` in overseer.ts). A library that needs a
  newer runtime feature bumps that date for every gadget, and says so in its notes.
- **npm here, never in a gadget.** A library may depend on npm packages and the build bundles them
  in (the metafile check rejects anything else from outside the library's directory). A gadget's own
  files may not import npm at all.
- **Minified, with identifiers kept.** What a `latest` pin runs is whitespace- and syntax-minified
  with identifiers kept, so a stack trace still names the library's functions; its source map is
  written beside the generated module (`src/generated/gadget-libraries/`) and served to nobody. The
  bundle carries no doc comment: esbuild keeps only legal comments whatever the minify settings, so
  the comments live in the declarations.
- **Declarations are the interface.** `build:gadget-library-types` runs `tsconfig.client.json` and
  `tsconfig.server.json` with `--declaration --emitDeclarationOnly` into the backend's
  `dist/gadget-library-types/<side>/`, and the bundler ships each library's `client.d.ts`,
  `server.d.ts` and the `src/*.d.ts` either side reached (a module both emitted identically once, as
  `both`). The agent's `describeGadgetLibrary(name)` shows them, with `version`, `notes` and the
  dependencies: that is how it learns the RPC methods of a gadget whose `server.js` is one re-export
  line. Write the doc comment on the declaration the agent will read -- an exported class, its
  methods, an exported type -- since the README stays here.
- **Lint applies.** Unlike a blueprint's `files/`, which the repo's lint ignores as user-authored
  gadget source, this is platform code and is checked like the rest of the repo.

## Tests

```
pnpm --filter @gadgets/gadget-libraries test:run   # every library's own suite
vp run -F @gadgets/gadget-libraries build          # the three type-check programs
```

`tsconfig.client.json` checks each client entry under the DOM lib, `tsconfig.server.json` each
server entry under the Workers types, `tsconfig.tests.json` the tests under Node's; a `src/` module
is checked under whichever of those imports it, which is what keeps a Durable Object from seeing
`document` and iframe code from importing `cloudflare:workers`.

## Libraries

- [`ui`](ui/README.md) -- DOM helpers for document-style gadgets: the `el` builder, SVG icons and
  toolbar controls, the in-page prompt, the save-status dot, relative time, and image reading and
  downscaling. Client-only.
- [`sync`](sync/README.md) -- collaboration plumbing: on the server a mutation queue, a subscriber
  registry with presence seeding and broadcast, and versioned upserts; on the client a save scheduler
  with retry backoff, a presence roster and a subscribe helper. The Docs, Sheets and Slides
  blueprints build on it.
