# `@gadgets/gatekeeper-kit`

Shared building blocks for gatekeeper connect flows, credentials, actions, observations, cursors,
caching, and simulation. These modules replace security-sensitive plumbing that gatekeepers had
implemented separately.

The kit provides a pragmatic baseline for common gatekeeper behavior. Provider-specific or esoteric
behavior can use the canonical TypeScript interfaces directly while retaining whichever leaf
modules still fit.

## Current scope

Only Layer 1 is shipped: independent leaf modules exposed through package subpaths. Import them à la
carte; none requires a gatekeeper assembly.

Layer 2, including `KitUserAccountBase`, `KitVendorBase`, and `KitGatekeeperBase`, remains a proposal
in [`plans/gatekeeper-kit.md`](../../plans/gatekeeper-kit.md). No gatekeeper consumes it.

The code and tests define the shipped behavior. The plan records the design and the unshipped
proposal.

## Responsibility boundary

The kit owns provider-independent mechanisms inside each imported module. The gatekeeper owns
provider facts, policy, and the assembly around those modules. Importing a leaf does not transfer
the duties in the right-hand column.

| Concern | Kit owns | Gatekeeper owns |
| --- | --- | --- |
| Assembly and lifetime | Independent leaf contracts; no Layer 2 assembly is shipped. | Worker, account, and resource-facet RPC surfaces; stub disposal; keeping stateful kit objects stable for one Durable Object activation. |
| Connect | Nonce generation and comparison, the two-stage handshake, hardened HTML, and browser mutation guards. | Routes, authorization parameters, provider exchange, completion ordering, persistence, rollback, and reconnect or revoke races. |
| Preview OAuth | Signed state, stable-to-preview callback relay, and return-host validation. | Deployment configuration, provider callback parameters, issuer checks, and retaining the exact redirect URI for code exchange. |
| Credentials | Atomic credential records, refresh coalescing, identity and connection generations, replay, and rejection adjudication. | Grant shape and projection, token exchange, provider error classification, refresh-field merging, revocation, and display-safe errors. |
| Credential expiry and simple auth retry | Durable deduplication of expiry notifications and one-refresh/one-replay helpers. | Deciding what proves grant expiry, provider refresh and revoke calls, and choosing the coordinator flow versus the standalone retry helper. |
| Actions | Durable submission and resolution, serialization, journaling, retention mechanics, connection fences, and dependency tracking. | Approval text, provider calls, idempotency and reconciliation, action-specific simulation, revert semantics, and retention policy. |
| Action files | Bounded chunk storage, integrity verification, aggregate accounting, deletion, and orphan-pruning mechanics. | Byte limits and key prefixes, keeping references in action records, describing the same bytes that will be applied, and releasing files with their records. |
| Simulation | Ordered pending-action views, pure replay with explicit incomplete results, and durable provisional-ID allocation and binding. | Target extraction, state transitions, unsupported-effect policy, provider ID syntax, and projecting pending effects onto every affected read. |
| Observations | Admission strategies, tracked-collection fencing, exclusion derivation, and the guarded authorization call. | Calling the gate for every read, truthful escaped descriptions, choosing the matching strategy and scope, ACL oracles, and collection canonicalization. |
| Cursors | Serialized walks, buffering, common page/offset/token continuation, filtering hooks, and per-page authorization callbacks. | Provider page adapters, page limits and termination semantics, resource lifetime, and the observation description for each returned page. |
| Cache | Authority partitioning, stale-fill fencing, TTL storage, single-flight loads, and invalidation. | Cache families, names and keys, authority dimensions, TTLs, value projection, and deciding which reads are safe to cache. |
| HTTP endpoints and responses | Operator-supplied endpoint normalization, common no-access probes, and byte-capped text decoding. | Host allowlists, redirect and header policy, response schemas, provider errors, and binary or streaming limits. |

When a provider does not fit a leaf, implement the canonical TypeScript interface directly and keep
the other leaves that still fit. Bypassing a leaf also means owning its guarantees for that concern;
do not call around a stateful module while relying on its journal, fence, or lifetime elsewhere.

## Start here

- For an OAuth-shaped provider, start with the
  [credentials guide](USAGE.md#credentials). It covers account-side storage, consumer-side RPC,
  refresh, replay, expiry, and action fences.
- For provider writes, use [`./actions`](#module-inventory) and read
  [Actions and files](USAGE.md#actions-and-files).
- For every gatekeeper's observer methods, select a strategy from `./observers` and read
  [Observations](USAGE.md#observations).
- For details attached to one class, function, option, or error, read that export's JSDoc.

Import from the narrow subpath:

```ts
import {
  CredentialCoordinator,
  CredentialSource,
} from "@gadgets/gatekeeper-kit/credentials";
```

## Module inventory

| Subpath | Purpose | Use it when |
| --- | --- | --- |
| `./connect-nonce` | Nonce generation, expiry, and constant-time comparison. | A connect flow mints or checks its own nonce. The handshake and credential modules already use it. |
| `./connect-handshake` | Two-stage `initiation` to `oauth` nonce storage. | A connect link or form redirects through an OAuth provider. |
| `./connect-pages` | Hardened connect HTML, escaping, and browser mutation guards. | A gatekeeper serves HTML from its own origin. |
| `./credentials` | Account-side `CredentialCoordinator` and consumer-side `CredentialSource`. | An OAuth-shaped provider stores, refreshes, or rejects credentials. |
| `./credential-expiry` | Durable, deduplicated `credentialsExpired()` notification. | An account has a Workshop connect callback to notify. |
| `./auth-retry` | One refresh and replay without account adjudication. | A token flow has no `CredentialSource`; otherwise use `CredentialSource.run()`. |
| `./cache` | Authority-partitioned Durable Object TTL caching. | Provider reads repeat and reconnects must fence stale fills. |
| `./cursors` | Array, page-number, offset, and continuation-token cursors. | A session returns more rows than one RPC reply should carry. |
| `./actions` | Action declaration, approval, application, retention, and journaling. | An operation has an externally visible side effect. |
| `./action-files` | Bounded, integrity-checked action-file storage. | A queued action carries file bytes. Store only its `ActionFileReference` in the action. |
| `./simulation` | Pending-action replay and provisional-ID mapping. | An action continues with simulation and later reads must include its projected effect. |
| `./observers` | Observer admission strategies and per-read authorization. | A gatekeeper implements its required observer methods. |
| `./preview-oauth` | Signed OAuth state and stable-to-preview callback relay. | Preview Workers share one callback registered with the OAuth provider. |
| `./endpoint` | User-supplied provider endpoint normalization. | A user enters a self-hosted provider URL. |
| `./http-errors` | HTTP access-error classification and ACL probes. | A verifier distinguishes no access from provider failure. |
| `./response-body` | Strict byte-capped response decoding. | A gatekeeper reads any provider response body. |

## Internal modules

The package does not export `kv`, `positive-int`, `per-storage`, `serial-queue`, `single-flight`,
`action-journal`, or `observer-tracker`. The last two are re-exported through `./actions` and
`./observers`.

## More documentation

- [`USAGE.md`](USAGE.md): integration sequencing, storage, bounds, and operational sharp edges.
- Exported-symbol JSDoc: exact API contracts and examples.
- [`plans/gatekeeper-kit.md`](../../plans/gatekeeper-kit.md): design record and Layer 2 proposal.
- [`AGENTS.md`](AGENTS.md): package-specific contributor constraints and verification commands.
