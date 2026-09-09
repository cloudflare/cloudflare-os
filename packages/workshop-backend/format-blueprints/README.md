# Bundled format blueprints

This directory contains the output-format blueprints that ship with this repo. A fresh deployment
installs them into BLUEPRINTS KV and BLUEPRINT_CONTENT R2 on its first `/api` request, after which
they are ordinary blueprints.

## Layout

Each blueprint is committed as reviewable source:

```
workspace-docs/
  blueprint.json
  files/
    README.md
    client.ts         import { el, iconBtn } from "gadgets:ui/client"
    server.ts         import { MutationQueue } from "gadgets:sync/server"
    lib/
      protocol.ts     the document, operation and RPC types both sides share
    gadget.json       {"libraries": {"sync": "latest", "ui": "latest"}}
```

`files/` is the gadget's code and may contain nested directories. `blueprint.json` contains its
install ID, presentation, provenance,
bindings, blueprint `version`, and bundled `revision`. The build converts these files into the same
gzip-compressed Yjs `.gadget` representation used by uploaded blueprints and embeds it in the
generated Worker module. No binary archive is committed.

### Libraries

A blueprint may import a **gadget library** -- shared code the deployment ships, `gadgets:<name>/client`
and `gadgets:<name>/server`, built from `packages/gadget-libraries/<name>/` (see that package's
README and `docs/blueprints.md`). Its `files/gadget.json` names each library it imports:

```json
{"libraries": {"sync": "latest", "ui": "latest"}}
```

A gadget pins every library it loads, *transitively*: a library that imports another makes the
gadget pin both, and the build says which pin is missing when it is not.

The build checks the two against each other: every `gadgets:` import reachable from `client.js` or
`server.js` must be pinned, must name the side it is imported from (a client may not import
`gadgets:x/server`), and must name a library that exists in `packages/gadget-libraries`; and every
pin must be imported by something. The import survives into the archive, and the Workshop resolves
it when it loads the gadget. The Docs, Sheets and Slides blueprints are built on the `ui` and `sync`
libraries, with their own domain code in `files/`; the agent learns a library's interface through its
`describeGadgetLibrary` tool.

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
only TypeScript is build input: one side of a blueprint may be `.ts` while the other is still plain
`.js`, and the un-migrated side keeps importing the `lib/*.js` module it always did.

`cloudflare:*` and `gadgets:*` are the only imports left for the runtime to resolve: the client is
loaded as an ES module in a sandboxed iframe whose import map holds exactly the libraries its
`gadget.json` pins, and the server as a Durable Object whose module map holds the same. Everything
else a blueprint imports must be a file it owns, so `import "yjs"` is a build error rather than a
module that goes missing inside the sandbox -- a *library* may bundle npm packages, a gadget may
not.

The build rejects a tree that would otherwise ship something other than what was written: an entry
present as both `.ts` and `.js`, a `.ts` file outside the entry/`lib/` layout, TypeScript spelled
`.tsx`/`.mts`/`.cts` (neither runtime has a loader for it), a `lib/` module no entry imports, an
import that reaches outside `files/`, or a library import that disagrees with `gadget.json`.

`pnpm build` type-checks all of it, through one config per set of globals -- the three must not see
each other's, since a Durable Object has no `document`, iframe code cannot import
`cloudflare:workers`, and neither has Node's `fs`:

| config | covers | globals |
| --- | --- | --- |
| `tsconfig.blueprints-client.json` | `client.ts` and what it imports | DOM |
| `tsconfig.blueprints-server.json` | `server.ts` and what it imports | Workers |
| `tsconfig.blueprints-tests.json` | `__tests__/` and what it imports | DOM + Node |

Each follows its entry's imports, so a `lib/` module is checked under the globals of whichever side
imports it, and a module both sides import under both -- which is what keeps a shared module honest
without forcing a server-only one to compile against the DOM. A `gadgets:<name>/<side>` import is
mapped by `paths` to the library's source entry in `packages/gadget-libraries`, so a blueprint is
checked against the real signatures it imports.

Unit tests of `lib/` modules live in the blueprint's `__tests__/` and run under `pnpm test` via
`vitest.blueprints.config.ts` (jsdom by default; a pure module's test can declare
`// @vitest-environment node`; the project passes when no blueprint has tests). They import the
module under test by on-disk name, e.g. `../files/lib/protocol.ts`, and load a fixture with
`readFileSync`. Only `blueprint.json` and `files/` are read by the build, so `__tests__/` (and
anything else beside them) is repo-only and never part of the archive.

`blueprintId` is the install key. Never change it after deployment: the new ID would install a
second format while the old one remained. `version` is the blueprint's published content version
and R2 key. The build fingerprints the generated archive, so direct edits under `files/` reinstall
automatically. `revision` remains an explicit reinstall trigger and is bumped by the importer.

## Editing presentation

Edit `blueprint.json` and rebuild. Changes to title, description, output, or author are included in
the install fingerprint and do not need a `revision` bump.

## Updating code

Build the blueprint in a Workshop, export it, then import the export:

```
pnpm import:format-blueprint ~/Downloads/Gadgets-Doc-v4.gadget format.document
```

The importer replaces `files/`, updates archive-owned metadata (`created`, `version`, `lastUpdated`,
and `bindings`), bumps `revision`, rebuilds `src/generated/format-blueprints.ts`, and reports changed
files and bindings. Review the resulting source diff normally.

An export contains the bundled JavaScript, so importing one over a TypeScript blueprint replaces its
sources with the built `client.js` / `server.js`. Edit a TypeScript blueprint in the repo instead,
and use the Workshop only to try the result.

## Adding a format

```
pnpm import:format-blueprint ~/Downloads/Brief.gadget --new acme-brief
```

This extracts the files and writes a valid scaffolded `blueprint.json`. Before deploying, replace
the scaffold description and review `output`. Prefer a generic `output.id` such as `document`; the
Outputs page uses it to group related formats.

## Shipping your own formats

`FORMAT_BLUEPRINTS_DIR` points the build at another directory in this same extracted layout:

```
FORMAT_BLUEPRINTS_DIR=../../acme-formats pnpm exec vp run build
```

The named directory replaces this set rather than extending it. It can be empty to ship no bundled
formats. The import command honors the same variable. Keeping deployment-owned formats outside this
repo avoids modifying it when it is consumed as a submodule.

A `FORMAT_BLUEPRINTS_DIR` tree may be written in TypeScript like the blueprints here, and the build
bundles it the same way: a syntax error or an import that does not resolve fails the build. It is
not type-checked, though. The repo's `tsconfig.blueprints-*.json` programs are static and cover only
`format-blueprints/`, so a tree elsewhere needs its own `tsc` run in the repository that owns it, or
can stay JavaScript.

Directories using the previous `<name>.gadget` plus `<name>.json` layout remain supported, so an
existing deployment can update this repo without coordinating a format conversion. Importing a new
export into one of those entries migrates that pair to the extracted layout automatically.

Administrators can also publish and promote ordinary blueprints at runtime instead of rebuilding a
deployment.
