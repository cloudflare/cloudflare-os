# Bundled format blueprints

This directory contains the output-format blueprints that ship with this repo, so a fresh deployment
can write a doc or build a deck without anyone having to build one first. A *format* is an ordinary
blueprint the deployment has promoted (see `AdminConfig.formats`); these are the ones it promotes out
of the box.

Each `.gadget` file here is committed **as data**. The first `/api` request a deployment serves
installs them into the BLUEPRINTS KV namespace and BLUEPRINT_CONTENT R2 bucket (see
`src/format-blueprints.ts`), after which they are ordinary blueprints. Nothing wakes on deploy, so a
fresh deployment is provisioned by its first visitor.

## Who owns what

A blueprint is two files with the same stem:

| | lives in | why |
| --- | --- | --- |
| the code, and the `bindings` it needs | `<name>.gadget` | what the blueprint *does* |
| `blueprintId`, title, description, `output` (noun/plural/icon), author, `revision` | `<name>.json` | what a human *curates*, so it's text in a reviewable file rather than fields inside a binary |

The installer writes the sidecar's values over whatever the archive happens to carry,
so an archive's own title and author are inert. The import script normalizes them anyway,
so the committed bytes don't contradict the sidecar.

## Changing a title, description or author

Edit the sidecar and rebuild. That's all — no archive rewrite, no `revision` bump: everything that
ends up in the installed metadata is part of the installed-version fingerprint (see
`formatBlueprintsManifestVersion`), so a reinstall follows on the next deploy.

## Updating a blueprint's code

Build it in a real Workshop, export it, and import the export:

```
pnpm import:format-blueprint ~/Downloads/Gadgets-Doc-v4.gadget format.document
```

That rewrites the archive, bumps `revision` in the sidecar, rebuilds
`src/generated/format-blueprints.ts`, and reports what it did:

```
Updated workspace-docs.gadget (format.document)
  code         23668 -> 24489 bytes (7c5413e5a482)
  bindings     (none)
  version      3 -> 4
  revision     2 -> 3  (workspace-docs.json)

  presented as "Workspace Docs" by Cloudflare, from workspace-docs.json
               [export called it "Gadgets Doc"]
```

The line worth reading is **`bindings`**, flagged `[CHANGED]` when the export needs something the old
copy didn't — an instantiating user will now be asked for it. `revision` is the reinstall trigger for
the one input the fingerprint can't see, the archive bytes; it's automated because forgetting it is
invisible (everything builds and deploys, and the old blueprint quietly stays put).

The script also round-trips the bytes it just wrote and checks the metadata and a content hash,
because these are committed as data and a corrupt archive would otherwise first surface when a
deployment tried to install it.

## Adding a new format

`--new` writes the sidecar for you, filling in what it can from the export:

```
pnpm import:format-blueprint ~/Downloads/Brief.gadget --new acme-brief
```

It then prints the handful of fields worth editing before you deploy — chiefly `output`, the noun,
plural and icon the sidecar owns rather than the archive, and `output.id`, the grouping key on the
Outputs page.
Make that one **generic** (`document`, not `acme-brief`): the Outputs page groups by it, so a
"Contract" blueprint declaring `document` is listed with the rest of the documents instead of
adding a filter chip of its own.

`blueprintId` defaults to the name you passed. It is the install key: reimporting the same id
updates that blueprint in place, and **changing it after a deployment has installed it** promotes
the new id as a *second* format while the old one stays in the New menu, updated by nothing.
Rename files freely; the id is the load-bearing part.


## Shipping your own formats

This directory is only the **default**. `FORMAT_BLUEPRINTS_DIR` points the build somewhere else:

```
FORMAT_BLUEPRINTS_DIR=../../acme-formats pnpm exec vp run build
```

`vp run`, not `pnpm build`: this package's `build` is a Vite+ task rather than a package.json
script, so pnpm cannot see it. `../vite.config.ts` explains why it has to be one.

Whatever directory it names *is* the deployment's format set — it replaces this one rather than
adding to it. Keep it in your own tree, in the same `<name>.gadget` + `<name>.json` layout; nothing
in it refers back to this repo. If you want one of ours too, copy the pair across once and own it
from then on.

This matters because this repo is usually a submodule: adding or deleting files *here* would
conflict on every update. Pointing the build at your own directory touches nothing, so the submodule
stays pristine forever. The import script honours the same variable, so you get the same workflow.

Two lighter options need no build change at all:

1. **Promote your own blueprints.** These are ordinary blueprints, and the standard set is admin
   curation (`AdminConfig.formats`). Publish a blueprint in your deployment and promote it in the
   admin Formats panel; disable the bundled ones you don't want. Nothing needs rebuilding, and this
   is the mechanism the bundled set is a convenience on top of, not a special case beside.
2. **Ship no formats.** Point `FORMAT_BLUEPRINTS_DIR` at an empty directory, and the deployment
   simply has none until an admin promotes something.
