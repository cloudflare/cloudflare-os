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
| Code a gatekeeper hosts | `ApprovalQueue.getFetcher()` | The session's caller and execution | Asks the workspace, except about trusted hosts |

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
  not what travels with it. A gatekeeper's request to a trusted host keeps the caller's headers,
  restricted or not (see below).
- **User-agent.** Always `Cloudflare-OS/1.0`.
- **Content signals.** For an agent-driven request, the response is refused if it sets
  `Content-Signal: ai-input=no`. Agent-driven means the `webFetch` tool's requests and `fetch()`
  called directly from `executeCode`, whose fetchers `makeFetchLoopback()` mints with
  `agentDriven: true`. A gadget's requests and a gatekeeper's are not, even when
  an agent's `executeCode` call drives the gatekeeper. The signal is a site's request to comply
  with, not a security boundary, and this is a reasonable line rather than the only correct one.
  A redirect that goes back to the caller is not judged by its own signal, since it carries no
  content; the page it leads to is.
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
- **Restricted.** A workspace that has observed restricted data may fetch only the hosts an admin
  trusts with that data,
  `AdminConfig.restrictedWebFetchHosts` (none by default), and on those hosts only URLs with no
  query string and no `/cdn-cgi/` path segment.
- **Approvals.** Where `AdminConfig.restrictedWebFetchApprovals` is on, a user may approve a URL
  the trusted hosts refuse. Only an agent can ask (see below).

`fetchPolicyRefusal(policy, href)` in `fetch-loopback.ts` turns a policy into a refusal message, or
none. The host, query-string and `/cdn-cgi/` checks themselves are `validateWebFetchUrl()`'s,
given the host list.

To change the policy, change `fetchPolicy()`, `fetchPolicyRefusal()` and, for a new URL rule,
`validateWebFetchUrl()`. Callers only ever see a `Fetcher`, so none of them change.

## Deciding each request

### Asking the workspace

`FetchLoopback` calls `OverseerImpl.authorizeFetch(caller, executionId, method,
url)` on the workspace's Durable Object for every request, except a gatekeeper's request to a
trusted host (below). It:

1. reads the policy with `fetchPolicy()`;
2. refuses every request once the workspace is deleted (`ownerId` is cleared). A fetcher can
   outlive its workspace, whose wiped storage would otherwise read as unrestricted and take a
   record it must not hold;
3. refuses an agent caller whose `executionId` is no longer live or whose turn the user stopped, as
   that execution's gatekeeper sessions are refused, whichever fetcher the request came through.
   This check comes after the policy read, so it sees the state after that await;
4. applies `fetchPolicyRefusal()`, and on a refusal either refuses or, for an agent where approvals
   are on, takes the approval path (below);
5. records the allowed request in the action log, and answers whether the workspace is restricted
   (so the request carries no caller headers) and whether an approval is what allowed it.

Because the workspace decides each request when it is made, no fetcher can hold a policy that has
gone stale. Code in one `executeCode` call can read restricted data through a binding and call
`fetch()` on the next line, and a gadget's worker is cached across calls, some of which read
restricted data; each request still meets the policy as it stands.

### Trusted hosts, for gatekeepers

A container's package manager can send hundreds of requests to a registry for one install, so a
round trip to the workspace for each would cost meaningful latency, and a record of each would
fill the action log with requests nobody needs to audit. The admin's trusted hosts are the hosts
for that: package registries and the like, which an admin has judged cleared for the workspace's
data. So `ApprovalQueueImpl.getFetcher()` reads `AdminConfig.restrictedWebFetchHosts` and mints a
`FetchLoopback` that carries them as `trustedHosts`, with the queue's caller and execution.
`trustedHostAuthorizer()` allows a request to one of them itself, with no round trip and no
record, and sends any other request to the workspace as above. A URL on a trusted host that breaks
a rule a restricted workspace sets for trusted hosts, such as one with a query string, is not
treated as trusted: it goes to the workspace too.

A trusted host is allowed whether or not the workspace is restricted, so the workspace's state
does not matter to this decision, and the Fetcher never needs replacing as the workspace changes.
For the same reason the request keeps the caller's headers: everyone who sees it is cleared for
the workspace's data. What the Fetcher holds can go stale only when an admin removes a trusted
host, which reaches a Fetcher only when the gatekeeper takes a new one.

`getFetcher()` throws once the session has ended, as `requireLive()` does, and a hook firing's
queue also re-checks that its hook is still enabled. A Fetcher it returned keeps working after the
session ends, but the workspace refuses the requests it decides once an agent's execution has
ended, so a gatekeeper takes a new Fetcher for each execution it hosts code for. Requests to
trusted hosts are unaffected. Each environment a Fetcher filters must still serve one workspace, as the `write-gatekeeper`
skill requires: a Fetcher asks the workspace it was minted for, so another workspace's data must
not go out through it.

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
`finalUrl` and resolves converted HTML's links against it. Any other caller must read it too: the
response's `url` and `redirected` describe only the request the caller sent, so they name the
approved URL and say it was not redirected.

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
`#captureDecisionRequest()` and refuses with `approval-requested`. A step that asks for the same URL
again, as a retry or a parallel fetch would, gets the refusal without a second card, so the user
approves each URL once. Because an agent's execution is
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
- a gatekeeper's requests to trusted hosts. The workspace never sees them. The gatekeeper's own
  `authorizeObservation()` for the call that ran the code (the command, for a container) is the
  record of that call.

## Known limitations

- **No rate limit.** A gadget can loop requests from the deployment's addresses.
- **`wrangler dev` reaches private addresses**, for gadget code and `executeCode` as for `webFetch`.
- **A polling gadget fills the action log**, one observation per request.
- **A fixed `user-agent`** may be refused by sites or registries a container wants to reach.
- **No authenticated APIs.** With no credentials forwarded, a key-authenticated API belongs behind
  a gatekeeper.
- **No approvals without a chat turn.** A gadget, a hook or a user's session cannot ask the user
  to approve a URL.
- **Removing a trusted host reaches a gatekeeper's Fetcher only when the gatekeeper takes a new
  one.** Until then, code it hosts can still reach that host.
- **No trusted hosts by default.** Until an admin lists some, every request a container sends asks
  the workspace and is recorded, a package manager's included.

## Code map

- `packages/workshop-backend/src/fetch-loopback.ts`: `FetchLoopback`, `sendFetch()`,
  `trustedHostAuthorizer()`, `fetchPolicyRefusal()`, `FetchPolicy`.
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
