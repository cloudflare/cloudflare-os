# Connection and creation discovery

Gatekeepers advertise two independent sets of resource **types**:

- `GatekeeperVendor.getSupportedResources()` describes existing resource types offered for
  connection. The account provides their selection UI through `startResourceConfigurator()`.
- `VendorDescription.creatableResources` describes types offered for creation through
  `createExternalResource` / `GatekeeperVendor.createResource()`. Omitted or empty means no creation.

A type may appear in either or both sets. Reuse its stable `urlPattern` when it appears in both:
admin policy applies to the type, not separately to creation and connection. These are discovery
advertisements, not inventories of individual instances and not grants of access.

For example, a document service can advertise documents in both sets. A per-chat execution
environment can advertise creation while returning `[]` from `getSupportedResources()`. Workshop
then offers creation but no existing-resource picker. Neither case needs a `connectable` flag.

## Existing bindings

Discovery is for adding resources. It does not replace or invalidate existing workspace/chat
bindings. A gatekeeper continues serving those bindings through its ordinary session API, including
restoring a suspended external resource if needed. Creating a new resource is not how an existing
binding is resumed. Ownership, revocation, and resource access remain enforced by the gatekeeper.

## Adapting creation-capable gatekeepers

The former `SupportedResource.creatable` boolean is removed. Move those types into
`describe().creatableResources`; keep them in `getSupportedResources()` only if an existing resource
can also be connected. Account `getSupportedResources()` likewise describes existing connection
types. Non-creating gatekeepers need no change.

`creationConfigurator`, when needed, belongs on the type in `creatableResources`. Its account UI,
approval, simulation, and `applyCreation()` behavior are unchanged. Creating something still needs
approval and a chosen account; advertising creation alone creates or connects nothing.

Workshop filters both advertisements through deployment policy, shows their union in the admin
resource settings, and checks creation's advertised type and policy before minting its gatekeeper.
There is no fallback from an empty connection list to the creation list. Existing-resource URL
resolution still uses only the connection list.
