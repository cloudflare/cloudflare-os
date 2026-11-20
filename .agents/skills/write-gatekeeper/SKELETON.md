# Gatekeeper Implementation Skeleton

A new gatekeeper starts from a command, not from copied code:

```bash
pnpm create-gatekeeper <name> --auth <oauth|api-key> [--hooks] --display "<Provider Name>"
```

`--auth oauth` is an authorization-code grant with PKCE; `--auth api-key` is a key the user pastes
into the connect page, for a provider with no OAuth. `--hooks` adds event hooks fed by a webhook
the provider delivers to. The command writes
`packages/gatekeeper-<name>`, adds it to the gatekeeper list in `README.md` and, for OAuth, to the
credential map in `scripts/run-dev-server.ts` (with hooks, also to that script's passed-through
variables and to the `restore` list in `scripts/generate-worker-types.ts`), and runs `pnpm install` and `pnpm types:generate`. It also writes the stand-in bundle the release manifest's test needs. The
package builds, lints and bundles as written, but its own tests fail by design (below), and the
release manifest's test fails until its golden file is updated
(`UPDATE_GOLDEN=1 node --test scripts/release/manifest-lib.test.ts`). A pasted-key gatekeeper takes
no deploy inputs, so that test also asks for it to be added to `SINGLETON` in
`scripts/release/manifest-lib.ts`: decide that deliberately.

`<name>` is 1-20 lowercase letters and digits, the release's install slug rule: it becomes a
`GATEKEEPER_<NAME>` binding and the `/gatekeeper/<name>` route. The template is
`packages/create-gatekeeper/template/`; a test generates a package from it and compiles that, so
read the template rather than an older gatekeeper for the current shape.

## What the command decides and what it leaves

The package is written for an invented provider with one resource type, an item at
`https://<name>.example/items/:itemId`, one read and one action. Everything the kit already has an
answer for is real: the connect handshake and its nonces, PKCE and the preview-deployment callback
relay (or the key form and its cross-site check), staged reconnects, credential refresh and rejection handling, the action journal and its
fence, per-read observer reporting, the observer verifier with its cache, and with `--hooks` the
hook registry, its delivery queue and retries, and dropping a disconnected connection's hooks.

Wherever only the provider's documentation or a design decision can say what is right, the
command wrote an invented answer and marked it `STOP(<id>)`. `__tests__/scaffold-stops.test.ts`
fails, listing the marks, until none is left: replace what a mark is on, then delete the mark.
Deleting a mark alone rarely passes, since the test also looks for the invented values it can
tell from real ones. It cannot tell an invented status classification or cache lifetime, so
those marks are the only record that the decision is open. The
command prints the marks in the skill's order: the session API, resource types and subresource
model come first and need the operator's review (Step 3) before the rest. A package that compiles
is not a reviewed design; nothing in it is approved until the operator has seen those three.

The invented provider is the **B — One access-controlled unit** example: one atomic resource per
link, whose own read endpoint answers for its hook events too, with `403` or `404` a definite "no
access" and `401`, network failures and other errors indeterminate, so they propagate. That is
not a requirement that a binding have one resource kind or one permission level. Account discovery
can be private while item reads are shareable; a broad binding can report several independently
checked resources; one provider object can have different audiences for metadata, content and
availability. Choose the strategy for each disclosure before adapting the template; see
[Choosing a strategy](SKILL.md#choosing-a-strategy-per-resource-type--binding) and the kit's
[worked Google patterns](../../../packages/gatekeeper-kit/USAGE.md#worked-patterns-from-the-google-migrations).
The template also pins a connection to one `userId` and reports `item/<id>` with no tenant; both
are marked, and a provider with organizations or workspaces needs the tenant in each.

| File | Holds | Marks |
|---|---|---|
| `src/types.d.ts` | the interface gadgets are given | `session-api` |
| `src/<name>-env.ts` | origins, resource types and URL patterns | `origins`, `resources` |
| `src/<name>-urls.ts` | parsing and building resource links | |
| `src/<name>-api.ts` | the typed client and error classification | `api`, `api-auth`, `api-errors` |
| `src/<name>-auth.ts` | how a user connects: OAuth endpoints, scopes and client, or the key form's text | `oauth-endpoints`, `oauth-scopes`, `oauth-token-lifetime`, `oauth-client-auth`; or `key-help`, `key-format` |
| `src/<name>-account.ts` | the `UserAccount` Durable Object and connect routes | `identity`, `observer-probe`, `observer-cache` |
| `src/<name>-credentials.ts` | identity, subresource IDs, the verifier's interface | `subresources` |
| `src/<name>-gatekeeper.ts` | the per-binding Durable Object | |
| `src/<name>-session.ts` | the capability a gadget holds | |
| `src/<name>-actions.ts`, `action-table.json` | actions and their committed table | `actions` |
| `src/<name>-hooks.ts` (`--hooks`) | webhook route, hook driver, controller and delivery | `webhook-signature`, `webhook-payload`, `webhook-limits` |
| `src/<name>.ts` | HTTP entrypoint, vendor, account entrypoint, verifier | `vendor-description` |
| `src/configurator/` | the resource configurator frame | `configurator` |

Still by hand afterwards: the gatekeeper's row in `docs/observers.md`, its README, its
`deploy-inputs.json` setup steps, and tests against a fake of the provider (`gatekeeper-pagerduty`'s
`__tests__/workerd/` is the model).

Do not run the command to try it out in a checkout you will commit from: a package with a
`wrangler.jsonc` is deployable, so the release manifest and the deploy wizard pick it up.

## Observer safety: new gatekeepers versus migrations

This template is for a **new gatekeeper with no historical observations**. Explicitly report **all
access dependencies** on every observation and authorize observers only in
`verifyObserverAccess()`. The shared `subresources` field is currently optional; the
`new-gatekeeper-observer-contract` lint rule refuses an `authorizeObservation({...})` that names
none, and a gatekeeper with many reads should route them through one helper that takes
`ObservationDescription & { subresources: string[] }`. Implement
`getHistoricalSubresources()` returning `[]`: it is required even though the current `Gatekeeper`
interface does not declare it, so type-checking will not catch its absence. Implement
`addObserver(id, verifier)` / `removeObserver(id)`, which the current interface requires, as
compatibility-only no-ops.

**Do not copy the empty history export or no-op admission methods into an existing gatekeeper.**
An existing migration must export its actual historical access requirements through
`getHistoricalSubresources()`, not a blind `[]`, and preserve its old checks until all affected reads
report complete requirements and a shipped kernel importer has committed the history to the
observer ledger. The current kernel does not consume the export yet. This template needs no
observer roster, observed-set log, `excludeObservers`, or legacy tracker.

`subresources: []` means **no observer-access restriction**, never "the binding already checked".
Private-only reads must still report a real resource ID and deny collaborators in
`verifyObserverAccess()`. If tenant/workspace membership is required in addition to resource ACLs,
report that membership resource on every affected observation and verify it explicitly too.

## Configuration notes

Only Durable Object classes go in `new_sqlite_classes` in `cloudflare.config.ts`. A verifier or
hook controller is a `WorkerEntrypoint`, so it needs no `migrations` entry, but like every
entrypoint it must be exported from the Worker's main module so `ctx.exports.<Class>(...)`
resolves. Run `pnpm configs:generate` after changing `cloudflare.config.ts`; the generated
`wrangler.jsonc` is committed and never edited by hand.

`build` and `build:configurator` are shared Vite+ tasks the package's `vite.config.ts` re-exports,
not package.json scripts, so `VITE_FRONTEND_ERROR_REPORTING` is passed through and
cache-fingerprinted. Do not add either as a script. Build one package with
`pnpm exec vp run -F <package-name> build`.

Keep tokens and broad API clients out of public `RpcTarget` properties; use closures or `#private`
state and expose only narrow read-only helper methods.

## Hooks

`--hooks` writes `src/<name>-hooks.ts`, modelled on `gatekeeper-pagerduty`: one webhook for the
deployment, delivering to `POST {BASE_URL}/webhook` and signed with the `<NAME>_WEBHOOK_SECRET`
secret, which is set outside the deploy wizard; while it is unset, subscribing is refused and the
route answers 404. The session's `subscribe()` binds a controller whose props carry a persistent
stub back to the binding's facet; the driver queues each verified event for the hooks that may
watch it; and the facet re-reads what the event names as the hook's owner, authorizes the
observation with its subresources, and only then calls the hook. Keep that order when you replace
the invented event: take identifiers from the webhook and nothing else.

A provider that has no deployment-wide webhook (one that needs a subscription per resource, or
polling) needs a different event source; keep the controller, registry and delivery, and replace
`handleWebhook`.
