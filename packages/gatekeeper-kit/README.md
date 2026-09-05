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
