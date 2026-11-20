# Fetching from the web under the workspace's policy

A workspace's untrusted code can read public web pages in four ways: the agent's `webFetch` tool,
`fetch()` in `executeCode`, `fetch()` in a gadget's server code, and the traffic of code a
gatekeeper hosts for the workspace, such as a container. All four send their requests through one
loopback entrypoint, `FetchLoopback` (`packages/workshop-backend/src/fetch-loopback.ts`), so there
is one fetch policy and one place that applies it.

The design record, with the reasoning and decisions behind it, is
[`plans/unified-fetch.md`](../plans/unified-fetch.md). This document describes the design as
built, for anyone changing the policy or writing a gatekeeper that uses the `Fetcher`. The
gatekeeper's side of the contract is also in the `write-gatekeeper` skill
(`.agents/skills/write-gatekeeper/SKILL.md`) and in the `ApprovalQueue.getFetcher()` doc comment
in `packages/workshop-shared/src/gatekeeper.ts`.

## Who can fetch

| Caller | Its fetcher | Caller identity | Mode |
|---|---|---|---|
| The `webFetch` tool | `OverseerImpl.getWebFetchEnv(chatId)` | `{from: "agent", chatId}`, no execution | Asks the workspace |
| `executeCode` | `globalOutbound` in `executeCodeMode()` | `{from: "agent", chatId}` and the call's `executionId` | Asks the workspace |
| A gadget's server code | `globalOutbound` in `loadGadgetWorker()` | `{from: "gadget", chatId, gadgetId}` | Asks the workspace |
| Code a gatekeeper hosts | `ApprovalQueue.getFetcher()` | The session's caller and execution | Snapshot |

All four are minted by `OverseerImpl.makeFetchLoopback()`. Nothing else can fetch:

- A gadget's client code and views run in the browser's sandboxed frame and still have no network.
- The restore forger keeps `globalOutbound: null`.
- A shared gadget snapshot's worker (`#loadSnapshotWorker()`, see `docs/sharing.md`) keeps
  `globalOutbound: null`: it runs for a viewer, not as the gadget.
- `connect()` from a sandbox stays blocked, because `FetchLoopback` has no `connect` handler.
- A gatekeeper's own calls to its vendor are not subject to this policy; they use the
  gatekeeper's own `fetch()`.

## What every request gets

`sendFetch()` applies these rules to every request, whoever sent it and whichever mode decides it:

- **Method.** Only GET and HEAD. Anything else is refused with a 405 that carries
  `allow: GET, HEAD`.
- **URL.** It must pass `validateWebFetchUrl()` in `web-fetch.ts` with no host list: `https:`, with
  no credentials embedded in it.
- **Headers.** The request sent is built anew from the method, the URL and an allowlist of the
  caller's headers: `accept`, `accept-language`, `range`, `if-range`, `if-none-match` and
  `if-modified-since`. Nothing else is copied, so `authorization`, `cookie` and `upgrade` are
  dropped (no credentials, no WebSockets), and so are the request's `cf` options. Once the
  workspace is restricted (below), none of the caller's headers are forwarded: the request carries
  only the fixed `user-agent` and the `accept` value `webFetch` sends (`WEB_FETCH_ACCEPT`). A
  header's value can carry the data the policy is holding back, and a user's approval names a URL,
  not what travels with it.
- **User-agent.** Always `Cloudflare-OS/1.0`.
- **Content signals.** A response with `Content-Signal: ai-input=no` is refused, for every caller,
  since any of them may be feeding an AI agent.
- **SSRF.** `FetchLoopback` runs in `workshop-backend`, so its `fetch()` keeps
  `global_fetch_strictly_public`, which rejects non-public addresses after DNS resolution.
  `wrangler dev` permits private addresses, so locally that protection is absent.

A network failure on the way to the origin reaches the caller as a thrown error, as it would from
an ordinary `fetch()`. The exception is a failure while the loopback follows an approved URL's
redirects (below), which comes back as a `denied` refusal.

## The policy

```ts
type FetchPolicy = {
  allowedHosts?: string[];  // The only hosts reachable, or undefined for any public host.
  approvals: boolean;       // Whether a user may approve a URL the policy refuses.
};
```

`OverseerImpl.fetchPolicy()` computes it:

- **Unrestricted.** A workspace that has not observed restricted data
  (`storage.containsRestrictedData`, which latches and is never cleared) may fetch any public host.
  This path reads no admin config, so the common case costs no KV read.
- **Restricted.** A workspace that has may fetch only the hosts an admin trusts with that data,
  `AdminConfig.restrictedWebFetchHosts` (none by default), and on those hosts only URLs with no
  query string and no `/cdn-cgi/` path segment.
- **Approvals.** Where `AdminConfig.restrictedWebFetchApprovals` is on, a user may approve a URL
  the trusted hosts refuse. Only an agent can ask (see below).

`fetchPolicyRefusal(policy, href)` in `fetch-loopback.ts` turns a policy into a refusal message, or
none. The workspace and a snapshot both call it, so they refuse with the same words. The host,
query-string and `/cdn-cgi/` checks themselves are `validateWebFetchUrl()`'s, given the host list.

To change the policy, change `fetchPolicy()`, `fetchPolicyRefusal()` and, for a new URL rule,
`validateWebFetchUrl()`. Callers only ever see a `Fetcher`, so none of them change. A field added
to `FetchPolicy` travels in a snapshot's props, so it must stay serializable.

## Two modes

### Asking the workspace about each request

With no snapshot, `FetchLoopback` calls `OverseerImpl.authorizeFetch(caller, executionId, method,
url)` on the workspace's Durable Object for every request. It:

1. reads the policy with `fetchPolicy()`;
2. refuses an agent caller whose `executionId` is no longer live or whose turn the user stopped, as
   that execution's gatekeeper sessions are refused. This check comes after the policy read, so it
   sees the state after that await;
3. applies `fetchPolicyRefusal()`, and on a refusal either refuses or, for an agent where approvals
   are on, takes the approval path (below);
4. records the allowed request in the action log, and answers whether the workspace is restricted
   (so the request carries no caller headers) and whether an approval is what allowed it.

The kernel's own sandboxes use this mode because a policy captured when the sandbox was made would
be wrong exactly when it matters. Code in one `executeCode` call can read restricted data through a
binding and call `fetch()` on the next line, and a gadget's worker is cached across calls, some of
which read restricted data. The `webFetch` tool uses it too, since it is one more request in the
agent's turn.

### A snapshot, for gatekeepers

`ApprovalQueueImpl.getFetcher()` reads `fetchPolicy()` and mints a `FetchLoopback` that carries it
as `snapshot`, with the queue's caller and execution. `snapshotAuthorizer()` decides each request
from the snapshot alone, with no round trip, so a long-running container keeps working at the cost
of nothing per request. A URL the snapshot refuses goes to the workspace only when the snapshot
allows approvals and the caller is an agent; `authorizeFetch()` then decides it as above.
Otherwise it is refused locally.

`getFetcher()` throws once the session has ended, as `requireLive()` does, and a hook firing's
queue also re-checks that its hook is still enabled. A Fetcher it returned keeps applying its
snapshot after the session ends; only a request it sends on to the workspace is refused once the
agent's execution has ended.

A snapshot never expires. A policy becomes too permissive only when the workspace observes
restricted data, and that data can reach what a Fetcher filters only through a call to the
gatekeeper. So the gatekeeper takes a new Fetcher before new data from the workspace reaches the
code it hosts, and installs it in place of the old one. A long-running container that has received
nothing new needs no update. An admin's change to the trusted hosts likewise reaches a gatekeeper's
hosted code at the gatekeeper's next call. The full contract, including serializing overlapping
calls, is in the `write-gatekeeper` skill.

## Redirects

Requests are sent with `redirect: "manual"`, and a 3xx goes back to the caller. Its next hop comes
back through the fetcher and is checked like any other request: the `webFetch` tool follows
redirects in its own loop (`fetchFollowingRedirects()`, at most 20), and a sandbox's `fetch()` is
followed by the runtime, whose hops re-enter `globalOutbound`. A redirect to a URL the policy
refuses therefore asks for approval where an approval could be asked for, and is refused otherwise.

The exception is a URL that a user's approval allowed. The site picked its redirects knowing only
the URL the user approved, so the approval covers them, and the loopback follows them itself. Each
hop still has to pass `validateWebFetchUrl()` with no host list. The response then carries
`Cloudflare-OS-Fetch-Url`, naming the URL it came from. The `webFetch` tool reports that as its
`finalUrl` and resolves converted HTML's links against it.

## Refusals

A refusal is an ordinary response, not a thrown error, so a container's HTTP client and JavaScript
see the same thing:

- status 403, or 405 for the method;
- a `text/plain` body giving the reason, which is meant to be shown to the agent;
- a `Cloudflare-OS-Fetch-Refused` header, whose value is `denied`, or `approval-requested` when the
  user has been asked to approve the URL and the agent's turn is ending.

Every `Cloudflare-OS-Fetch-*` header is removed from origin responses, so a site can neither forge
a refusal nor name a final URL.

The `webFetch` tool turns a `denied` refusal into its error (naming the redirect, if a redirect led
there) and an `approval-requested` one into its ordinary result, the body's message.

## Approvals and the agent's turn

A user can approve a URL only for an agent caller, the only one with a turn to end while the card
waits. A gadget, a hook firing or a user's session is refused where an agent would be asked.

When the policy refuses an agent's URL and approvals are on, `authorizeFetch()` checks whether the
user has already approved exactly that URL in the current turn (`#webFetchApproved()`: an approved
`webFetchRequest` since the turn's prompt or agent callback). If so, the request is allowed, and
its redirects with it. If not, it captures a `webFetchRequest` card with
`#captureDecisionRequest()` and refuses with `approval-requested`. Because an agent's execution is
checked for liveness first, the capture happens only while the agent's turn runs, so the card
always attaches to a step.

The turn ends in `finishTurn`, which pi calls before `turn_end`: it takes the step's captured
decision requests (`consumeCapturedDecisionRequests()`) and ends the turn when there are any, and
`turn_end` persists them after the assistant message. The latch is the same whether the request
came from the `webFetch` tool, from `fetch()` in `executeCode`, or from code a gatekeeper ran during
that `executeCode` call, so none of them latch it themselves. A connection request ends the turn
the same way.

When the user approves (`approveWebFetchRequest()`), `resumeAgentAfterDecision()` resumes the turn
with a note telling the agent the fetches were approved. The agent runs its fetch, its code or its
command again, and the same URL now passes `#webFetchApproved()`. A denial leaves the turn ended.
An approval lasts until the next prompt or callback.

## The action log

Every request the workspace decides and allows is recorded, attributed to its caller, as an
observation under `BUILTIN_TOOL_GATEKEEPER_ID` (`#recordBuiltinObservation()`): resource
`Web fetch: <host>`, titled `Fetched <host>`, described as `` <METHOD> `<url>` ``. Each hop the
caller sends is its own request, so a redirect chain followed by the caller gives one record per
hop; an approved URL's redirects, which the loopback follows, give one record.

The record is written when the workspace allows the request, before the origin is contacted. So it
says the request was allowed, not that it succeeded: a request refused afterwards, for
`Content-Signal: ai-input=no` or while following an approved URL's redirects, or one that fails on
the network, keeps its record.

Not recorded:

- requests the policy refuses, including those that ask for approval;
- the response's status, content type or length;
- requests a gatekeeper's snapshot allows. The workspace never sees them. The gatekeeper's own
  `authorizeObservation()` for the call that ran the code (the command, for a container) is the
  record. A request the snapshot refuses that the workspace then allows, by an approval, is
  recorded.

## Known limitations

- **No rate limit.** A gadget can loop requests from the deployment's addresses.
- **`wrangler dev` reaches private addresses**, for gadget code and `executeCode` as for `webFetch`.
- **A polling gadget fills the action log**, one observation per request.
- **A fixed `user-agent`** may be refused by sites or registries a container wants to reach.
- **No authenticated APIs.** With no credentials forwarded, a key-authenticated API belongs behind
  a gatekeeper.
- **No approvals without a chat turn.** A gadget, a hook or a user's session cannot ask the user
  to approve a URL.
- **A gatekeeper's Fetcher is only as current as the gatekeeper keeps it.** The kernel cannot
  check that a gatekeeper took a new one before delivering new data.

## Code map

- `packages/workshop-backend/src/fetch-loopback.ts`: `FetchLoopback`, `sendFetch()`,
  `snapshotAuthorizer()`, `fetchPolicyRefusal()`, `FetchPolicy`.
- `packages/workshop-backend/src/overseer.ts`: `fetchPolicy()`, `authorizeFetch()`,
  `makeFetchLoopback()`, `getWebFetchEnv()`, `ApprovalQueueImpl.getFetcher()`.
- `packages/workshop-backend/src/web-fetch.ts`: `validateWebFetchUrl()`,
  `fetchFollowingRedirects()`, the header names, and the `webFetch` tool.
- `packages/workshop-backend/src/agent.ts`: `finishTurn`'s capture of decision requests.
- `packages/workshop-shared/src/gatekeeper.ts`: `ApprovalQueue.getFetcher()`.
- Tests: `packages/workshop-backend/__tests__/fetch-loopback.test.ts` and
  `fetch-authorization.test.ts`; `packages/integration-tests/__tests__/workshop-sandbox-fetch.test.ts`
  (sandboxes and gatekeepers, through the test gatekeeper's `fetchUrl()` and `fetchInstalled()`)
  and `workshop-restricted-web-fetch.test.ts` (the `webFetch` tool).
