# Bundled blueprints

This package holds the blueprints that ship with this repo, the gadget libraries they import, and
the build that turns a blueprint directory into the archives the Workshop backend installs. A fresh
deployment installs the blueprints into BLUEPRINTS KV and BLUEPRINT_CONTENT R2 on its first `/api`
request, after which they are ordinary blueprints, and promotes them as its standard output formats.
"Bundled" is what this package holds; "format" is a curation state an admin controls at runtime --
a bundled blueprint can be taken out of the formats menu, and an unbundled one promoted into it.

Nothing here is deployed on its own. The Workshop backend's `scripts/build-bundled-blueprints.ts`
imports `src/` to generate the gitignored `src/generated/bundled-blueprints.ts` it compiles the
archives into, and `pnpm import:bundled-blueprint` (the same package) writes into `blueprints/`.

## Layout

```
blueprints/<name>/     one bundled blueprint, committed as reviewable source
  blueprint.json       install ID, presentation, provenance, bindings, version, revision
  files/               the gadget's code; may contain nested directories
    README.md
    client.ts          import { el } from "@gadgets/bundled-blueprints/libraries/ui/client"
    server.ts          import { MutationQueue } from ".../libraries/sync/server"
    lib/protocol.ts    the document, operation and RPC types both sides share
  __tests__/           vitest, repo-only; never part of the archive
libraries/<name>/      a gadget library: client.ts, server.ts, src/**, __tests__/** (see libraries/README.md)
src/                   the build: archive codec and source reader (files.ts), manifest parser
                       (manifest.ts), module generator (generate.ts); index.ts is what the backend imports
__tests__/             the build's own tests
```

`files/` is the gadget's code. `blueprint.json` contains its install ID, presentation, provenance,
bindings, blueprint `version`, and bundled `revision`. The build converts these files into the same
gzip-compressed Yjs `.gadget` representation used by uploaded blueprints and embeds it in the
generated Worker module. No binary archive is committed.

### Libraries

A blueprint may import the shared **gadget libraries** in `libraries/` (see [its
README](libraries/README.md)) by this package's name and the subpath its `package.json` exports:
`@gadgets/bundled-blueprints/libraries/<name>/client` from its client, `.../<name>/server` from its
server. The build resolves each to the library's entry and inlines what the entry uses into the
shipped `client.js` / `server.js`, as it does a `lib/` module, so the archive stays self-contained
and a gadget created from the blueprint carries its own copy of the library as of its
instantiation. A client may not import a library's server side (it would drag a Durable Object into
the iframe), and a library, reached by that subpath, is the one thing an import may reach outside
`files/` for. The importer has to be TypeScript: a JavaScript module ships as written, with nothing
at runtime to resolve the package name against, so it cannot import a library, and the build rejects
the attempt. The Docs, Sheets and Slides blueprints are built on the `ui` and `sync` libraries, with
their own domain code in `files/`.

### TypeScript sources

`files/` may be written in TypeScript: `client.ts` and `server.ts` are the entry points, and
`lib/**/*.ts` holds the modules they import (by on-disk name, `./lib/protocol.ts`). The build bundles
each entry with its imports into the `client.js` / `server.js` the archive ships -- readable rather
than minified -- so the installed gadget, and the agent that later edits it, see exactly one
JavaScript file per side, the same as for a blueprint written in plain JavaScript. Those `lib/`
modules are build input only and are not stored, and `.d.ts` files are dropped. The bundled Docs,
Sheets and Slides blueprints are written this way, each with a `lib/protocol.ts` holding the types
its client and server share (imported type-only, so nothing of it ships).

Everything else under `files/` (the README, assets) passes through unchanged, and may be imported
for its contents if the bundler has a loader for it: JSON is inlined, a stylesheet is not (a gadget
carries its CSS in the module that injects it). A file a bundle inlined is still shipped, because
only TypeScript is build input. A blueprint is written in TypeScript or in JavaScript, not both: a
`.js` module in a tree that holds `.ts` is rejected, since it would ship as written beside bundles
it cannot share code with. Non-module files pass through either way.

`cloudflare:workers` is the only import left for the runtime to resolve, and only on the server:
the client is loaded as an ES module in a sandboxed iframe with nothing to resolve a bare import
against, and the server as a Durable Object whose module map holds the gadget's own files and whose
loader supplies no other `cloudflare:` module. Everything else a blueprint imports must be a file it
owns or a library, so `import "yjs"` is a build error rather than a module that goes missing inside
the sandbox, and tree-shaking annotations are ignored, so a `"sideEffects": false` in an enclosing
package.json cannot drop a side-effect-only import from the bundle.

The build rejects a tree that would otherwise ship something other than what was written: a
JavaScript module in a TypeScript blueprint, a `package.json` in a TypeScript blueprint (its `browser`
field or `imports` map would steer the bundler's resolution), a `.ts` file outside the entry/`lib/`
layout, TypeScript spelled `.tsx`/`.mts`/`.cts` (neither runtime has a loader for it), a `lib/` module
no entry imports, an import that reaches outside `files/` by any path other than a library's exported
subpath (a relative or absolute path into `libraries/`, a `src/` module, the package root, a bare
specifier some `node_modules` resolves), a library import of the wrong side or of a library that does
not exist, a
dynamic `import()` or `require()` of anything but a string literal, refused before the bundler runs
(it would leave a computed path unchecked, and expand a template literal or concatenation into every
file the pattern matches, wherever that reaches), a generated `client.js`/`server.js` that collides
with a file or directory already in the tree, or a shipped JavaScript module that imports a library,
which only the bundle can inline. Imports are read from each module's syntax tree with the
TypeScript compiler, so a comment or a string can neither masquerade as one nor hide one.

### Type checks and tests

```
pnpm exec vp run -F @gadgets/bundled-blueprints build   # the five type-check programs
pnpm --filter @gadgets/bundled-blueprints test:run      # the blueprints', libraries' and build's tests
pnpm --filter @gadgets/bundled-blueprints test:watch
```

`pnpm build` type-checks all of it, through one config per set of globals -- the sets must not see
each other, since a Durable Object has no `document`, iframe code cannot import
`cloudflare:workers`, and neither has Node's `fs`:

| config | covers | globals |
| --- | --- | --- |
| `tsconfig.client.json` | every `client.ts` (blueprints and libraries) and what it imports | DOM |
| `tsconfig.server.json` | every `server.ts` and what it imports | Workers |
| `tsconfig.tests.json` | the blueprints' and libraries' `__tests__/` and what they import | DOM + Node |
| `tsconfig.server-tests.json` | `__tests__/server.test.ts` and `__tests__/*.server.test.ts`, the tests of a server side | Workers + Node |
| `tsconfig.node.json` | `src/` and `__tests__/`, the build and its tests | Node |

Each follows its entries' imports, so a `lib/` or `src/` module is checked under the globals of
whichever side imports it, and a module both sides import under both -- which is what keeps a
shared module honest without forcing a server-only one to compile against the DOM. A library import
is this package referring to itself by name, which tsc resolves through the `exports` in
`package.json` with no `paths` block, so a blueprint is checked against the real signatures it
imports.

Unit tests of a blueprint's `lib/` modules, or of its server, live in the blueprint's `__tests__/`
and run under `pnpm test` (jsdom by default; a pure module's or a server's test declares
`// @vitest-environment node`). They import the module under test by on-disk name, e.g.
`../files/lib/protocol.ts`, and load a fixture with `readFileSync`. A test of the server side is
named `server.test.ts` or `<topic>.server.test.ts`, which is what puts it under the Workers types
rather than the DOM's; at run time it gets `cloudflare:workers` as a stub of its base classes
(`__tests__/stubs/cloudflare-workers.ts`), so a Durable Object can be constructed over in-memory
storage. The archives the build produces are still installed and inspected inside workerd by the
Workshop backend's suite. Only `blueprint.json` and `files/` are read by the build, so `__tests__/`
(and anything else beside them) is repo-only and never part of the archive.

`blueprintId` is the install key. Never change it after deployment: the new ID would install a
second blueprint while the old one remained. (TODO: the bundled IDs keep the historical `format.`
prefix -- `format.document`, `format.spreadsheet`, `format.slides` -- for that reason; renaming them
needs an install-time migration keyed on the old id.) `version` is the blueprint's published content version
and R2 key. The build fingerprints the generated archive, so direct edits under `files/` reinstall
automatically. `revision` remains an explicit reinstall trigger and is bumped by the importer.

## Editing presentation

Edit `blueprint.json` and rebuild. Changes to title, description, output, or author are included in
the install fingerprint and do not need a `revision` bump.

## Updating code

Build the blueprint in a Workshop, export it, then import the export, from `packages/workshop-backend`:

```
pnpm import:bundled-blueprint ~/Downloads/Gadgets-Doc-v4.gadget format.document
```

The importer replaces `files/`, updates archive-owned metadata (`created`, `version`, `lastUpdated`,
and `bindings`), bumps `revision`, rebuilds the backend's `src/generated/bundled-blueprints.ts`, and
reports changed files and bindings. An export the build rejects is refused before it replaces
anything. Review the resulting source diff normally.

An export contains the bundled JavaScript, so importing one over a TypeScript blueprint replaces its
sources with the built `client.js` / `server.js`. Edit a TypeScript blueprint in the repo instead,
and use the Workshop only to try the result.

## Adding a format

```
pnpm import:bundled-blueprint ~/Downloads/Brief.gadget --new acme-brief
```

This extracts the files and writes a valid scaffolded `blueprint.json`. Before deploying, replace
the scaffold description and review `output`. Prefer a generic `output.id` such as `document`; the
Outputs page uses it to group related formats.

## Shipping your own formats

`BUNDLED_BLUEPRINTS_DIR` points the build at another directory in this same extracted layout. It is
resolved against `packages/workshop-backend`, where the build runs (the variable used to be called
`FORMAT_BLUEPRINTS_DIR`; that name is no longer read, so a deployment setting it builds the bundled
set instead):

```
BUNDLED_BLUEPRINTS_DIR=../../acme-formats pnpm exec vp run build
```

The named directory replaces this set rather than extending it. It can be empty to ship no bundled
formats. The import command honors the same variable. Keeping deployment-owned formats outside this
repo avoids modifying it when it is consumed as a submodule.

A `BUNDLED_BLUEPRINTS_DIR` tree may be written in TypeScript like the blueprints here, and the build
bundles it the same way: a syntax error or an import that does not resolve fails the build, and it
imports the gadget libraries by the same package name, which the build resolves to this package's
`libraries/` without the tree having installed anything. It is not type-checked, though. This
package's `tsconfig.*.json` programs are static and cover only `blueprints/` and `libraries/`, so a
tree elsewhere needs its own `tsc` run in the repository that owns it, with
`@gadgets/bundled-blueprints` linked into that workspace the way `@gadgets/scripts` already must
be, so its editor and `tsc` resolve the same `exports`; or it can stay JavaScript.

Directories using the previous `<name>.gadget` plus `<name>.json` layout remain supported, so an
existing deployment can update this repo without coordinating a format conversion. Importing a new
export into one of those entries migrates that pair to the extracted layout automatically.

Administrators can also publish and promote ordinary blueprints at runtime instead of rebuilding a
deployment.
