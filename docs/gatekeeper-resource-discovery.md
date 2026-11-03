# Connection and creation discovery

Gatekeepers advertise one list of resource **types** through
`GatekeeperVendor.getSupportedResources()`. Each `SupportedResource` has two independent flags:

- `connectable?: boolean` — offer an existing-resource picker and `requestConnection`. Defaults to
  **true** when omitted, so existing gatekeepers need no changes.
- `creatable?: boolean` — offer `createExternalResource` / `GatekeeperVendor.createResource()`.
  Defaults to **false** when omitted.

These are resource-type advertisements, not inventories of individual instances or grants of
access. Admin policy is keyed by the type's stable `urlPattern` and applies to both flows.

A document service can mark the same type `creatable: true` and leave `connectable` at its default.
A per-chat execution environment uses `connectable: false, creatable: true` to offer creation
without an existing-resource picker. Types with both flows disabled are hidden from discovery.
The account's `getSupportedResources()` may narrow the types it offers.

## Existing bindings

Discovery is for adding resources. It does not replace or invalidate existing workspace/chat
bindings. A gatekeeper continues serving those bindings through its ordinary session API, including
restoring a suspended external resource if needed. Creating a new resource is not how an existing
binding is resumed. Ownership, revocation, and resource access remain enforced by the gatekeeper.
Account consent, grant management, and observer verification still include creation-only types:
`connectable: false` does not remove the authorization needed to create or verify a resource.

## Creation

`creationConfigurator`, when needed, belongs on the resource type alongside `creatable`. Its
account UI, approval, simulation, and `applyCreation()` behavior are unchanged. Creating something
still needs approval and a chosen account; advertising creation creates or connects nothing.

Workshop filters resource types through deployment policy and checks the advertised creation type
and policy before minting its simulated gatekeeper. Existing-resource pickers and connection
request resolution exclude types marked `connectable: false`.
