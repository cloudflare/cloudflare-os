# Workshop App

The reworked Workshop frontend, built beside `workshop-frontend` (which stays the shipped app until
cutover). Scope is deliberately small: chat, chat settings, and the Library and Workspaces pages.
Follow `../../AGENTS.md` and the `frontend-conventions` skill in addition to this file.

Dev server: `pnpm --filter @gadgets/workshop-app dev` (port 3001; the old frontend uses 3000).
`src/routeTree.gen.ts` is generated and committed, like the old app's; do not edit it.

## Layers

```text
src/
  components/   Kumo wrappers and primitives; no product knowledge, no data
  blocks/       Compositions of components for one purpose (a message, a composer, a list row)
  layouts/      Page structure: shell, sidebar, aside, toolbar pages. Arrange slots, know no content
  routes/       Route declarations: the only layer that fetches data or touches RPC and auth
```

Imports point down only: components, then blocks, then layouts, then routes. Lint enforces this
(`vite.config.ts` at the repo root). Blocks and layouts take plain typed props and callbacks.

Build UI by looking at the component gallery (`/gallery`) first: add each new component or block
there so its states can be reviewed in isolation.

## Promoting to `@gadgets/ui`

Components start here. Move one to `packages/ui` once a second frontend (e.g. a gatekeeper app) needs
it, as `packages/ui/AGENTS.md` describes. Shell and layout code is expected to stay here.
