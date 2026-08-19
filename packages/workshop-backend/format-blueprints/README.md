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
    client.js
    server.js
```

`files/` is the gadget's code. `blueprint.json` contains its install ID, presentation, provenance,
bindings, blueprint `version`, and bundled `revision`. The build converts these files into the same
gzip-compressed Yjs `.gadget` representation used by uploaded blueprints and embeds it in the
generated Worker module. No binary archive is committed.

`blueprintId` is the install key. Never change it after deployment: the new ID would install a
second format while the old one remained. `version` is the blueprint's published content version
and R2 key. `revision` is the bundled reinstall trigger and is bumped automatically by the importer.

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

Administrators can also publish and promote ordinary blueprints at runtime instead of rebuilding a
deployment.
