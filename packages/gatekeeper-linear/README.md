# Linear gatekeeper

Gives gadgets sandboxed access to a Linear workspace, team or issue through Linear's GraphQL API.

`src/linear-api.ts` sends every request through one upstream client, whose calls are counted as [subservice metrics](../observability/README.md#subservice-calls) under the source `gatekeeper.linear.api`: a GraphQL request under its name in `GRAPHQL_OPERATIONS`, a token request under `token.exchange`, `token.refresh` or `token.revoke`. A request whose data the client refuses inside a 200 is counted an error.
