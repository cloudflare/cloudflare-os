# Gatekeeper Implementation Skeleton

A new gatekeeper starts from a command, not from copied code:

```bash
pnpm create-gatekeeper <name> --auth <oauth|api-key> --display "<Provider Name>"
```

`--auth oauth` is an authorization-code grant with PKCE; `--auth api-key` is a key the user pastes
into the connect page, for a provider with no OAuth. The command writes
`packages/gatekeeper-<name>`, adds it to the gatekeeper list in `README.md` and, for OAuth, to the
credential map in `scripts/run-dev-server.ts`, and runs `pnpm install` and `pnpm types:generate`. The package builds, lints and bundles as written. The template is
`packages/create-gatekeeper/template/`; a test generates a package from it and compiles that, so
read the template rather than an older gatekeeper for the current shape.

## What the command decides and what it leaves

The package is written for an invented provider with one resource type, an item at
`https://<name>.example/items/:itemId`, one read and one action. Everything the kit already has an
answer for is real: the connect handshake and its nonces, PKCE and the preview-deployment callback
relay (or the key form and its cross-site check), staged reconnects, credential refresh and rejection handling, the action journal and its
fence, per-read observer reporting, and the observer verifier with its cache.

Wherever only the provider's documentation or a design decision can say what is right, the
command wrote an invented answer and marked it `STOP(<id>)`. `__tests__/scaffold-stops.test.ts`
fails, listing the marks, until none is left: replace what a mark is on, then delete the mark.
The command prints the same list. Take them in the skill's order: the session API, resource types
and subresource model come first and need the operator's review (Step 3) before the rest.

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
`verifyObserverAccess()`. The shared `subresources` field is currently optional, so the local typed
helper below makes it required for reads and hook deliveries. Implement
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

The command does not write hooks yet. For a gatekeeper that pushes events, add the following to
the generated package, with `hookTsType` in `describe()` and the hook interface in `types.d.ts`.
`gatekeeper-pagerduty/src/pagerduty-hooks.ts` is a complete one built on the kit's
`hook-registry` and `hook-delivery-queue`.

The hook interface from `types.d.ts` is implemented by the gadget as an `RpcTarget`. Intersect it
with `RpcTarget` so it satisfies the `HookController`/`HookInitiator` generic constraints. A plain
function also works as a hook type, e.g. `RpcStub<() => Promise<void>>`, and needs no merge.

```typescript
type MyHook = RpcTarget & MyHookIface;

// Bind-time details for a single hook registration, baked into the controller's props.
type MyHookProps = {
  // TODO: e.g. an event kind, a filter, a sub-resource id, etc. — whatever the registration
  // method received and the controller/event source will need later.
  filter?: string;
};

type MyHookControllerImplProps = MyGatekeeperImplProps & MyHookProps;

export class MyHookControllerImpl extends WorkerEntrypoint<Env, MyHookControllerImplProps>
    implements HookController<MyHook> {
  // Called when the user enables the hook. Store `initiator` somewhere it can be reached when an
  // event arrives — typically an event-source DO. Don't store other state until now; everything
  // else is already in `this.ctx.props`. If already enabled, replace the previous initiator.
  //
  // `target` identifies where the hook delivers (workspace, and gadget when pinned to one). Store
  // it too if you display or link to the target; otherwise ignore it, but keep the parameter
  // declared — RPC argument validation rejects arguments the receiver doesn't declare.
  async enable(initiator: Fetcher<HookInitiator<MyHook>>, target: HookTargetMetadata): Promise<void> {
    // TODO: persist `initiator` (e.g. forward it to an event-source DO keyed by props).
  }

  // Called when the hook is disabled or deleted. Forget the stored initiator and clean up all
  // related state. May never be called again, though the overseer may later call enable() afresh.
  async disable(): Promise<void> {
    // TODO: forget the stored initiator.
  }
}

// Event delivery (sketch). When the external event arrives — e.g. in the event-source DO that
// holds the `initiator` — invoke the hook like so. The resource ID comes from the enabled
// registration's props, never an untrusted event field; events reveal only that resource:
//
//   async onEvent(initiator: Fetcher<HookInitiator<MyHook>>, resourceId: string, event: MyEvent) {
//     // startHook() begins a fresh session and returns the callback (re-bound to it) plus an
//     // ApprovalQueue. Await the disposable result so `using` releases its stubs even on denial.
//     using result = await initiator.startHook();
//
//     // A hook event is almost always an observation. (Register actions too if invoking the
//     // callback can cause side effects.) Authorize before delivering any event data.
//     await result.approvalQueue.authorizeObservation({
//       title: "Resource event",
//       description: "Delivered an event from the bound resource.",
//       subresources: [itemSubresourceId(resourceId)],
//     });
//
//     // Deliver the event to the Gadget's callback.
//     await result.callback.onMyEvent(event);
//   }
```

Hook registration, on the session. `callback` is a persistent stub the gadget created with
`ctx.restore()`. Do not store it: it is bound to this session and is revoked when the session ends.

```typescript
  // Example: hook registration — remove if the gatekeeper doesn't push events.
  // `callback` is a persistent stub the Gadget created with ctx.restore(). Construct a controller
  // whose props capture the specifics of THIS registration (e.g. `filter`), then hand it, the
  // callback, and a user-facing description to the overseer via bindHook(). For multiple hook
  // kinds, pick the appropriate controller class here. Do NOT store the callback yourself — it is
  // bound to this session and would be revoked when the session ends.
  async subscribe(callback: RpcStub<MyHook>, filter?: string): Promise<void> {
    let controller = this.#ctx.exports.MyHookControllerImpl({
      props: { ...this.#ctx.props, filter },
    });
    await this.#approvalQueue.bindHook(controller, callback, {
      title: "TODO: short hook title",
      description: `TODO: what events this hook delivers${filter ? ` (filter: ${filter})` : ""}`,
    });
  }
```
